/**
 * Cube baking with supersampling, the parallax proxy lookup and the RGBE face codec of the cache.
 *
 * Each face is rendered into a 2D HalfFloat target `ssaa` times larger than the face, then drawn
 * into the cube face by a full-screen quad whose single bilinear tap at the destination texel
 * centre averages exactly the 2x2 source texels (a box filter). That anti-aliases geometry AND
 * shader detail (stars, window grids, thin crane members) with one reusable 2D target, instead of
 * keeping six multisampled faces alive.
 *
 * Cache codec: while baking, the same box-filtered face is also written RGBE-encoded (8-bit
 * mantissas + a shared exponent) into an RGBA8 target and read back, 4 bytes per texel instead of
 * 8; a cached load uploads those bytes and a quad decodes them straight into the cube face, so a
 * face goes through exactly the same quad-to-face path both ways (no face orientation maths).
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import { Fn, cameraPosition, ceil, cos, cubeTexture, exp2, float, log2, max, normalize, positionWorld, round, sin, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';

export const BAKE_NEAR = 50;
export const BAKE_FAR = 400000;
/** Width of the parallax proxy lookup (azimuth samples). */
export const PROXY_WIDTH = 512;
/** Proxy radius encoding: the lookup stores R / PROXY_SCALE. */
export const PROXY_SCALE = 100000;

type V4 = Node<'vec4'>;

/** HalfFloat cube target without depth (the bake renders into a 2D scratch with depth). */
export function createCubeTarget(size: number): THREE.CubeRenderTarget {
  return new THREE.CubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
}

/** The proxy lookup: PROXY_WIDTH x 1 HalfFloat, repeat-wrapped in u = azimuth / 2pi + 0.5. */
export function createProxyLUT(): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(PROXY_WIDTH, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  rt.texture.wrapS = THREE.RepeatWrapping;
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  return rt;
}

/** A proxy lookup from cached half floats (same sampling state as the render target's). */
export function proxyLUTFromData(data: Uint16Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, PROXY_WIDTH, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * three re-uploads uniform groups once per node frame, and the frame id only advances inside its
 * own loop. A bake that runs before the loop starts (or in a hidden tab) would keep the previous
 * theme's uniforms: advance it explicitly.
 */
export function advanceFrame(renderer: THREE.WebGPURenderer): void {
  const nodes = (renderer as unknown as { _nodes?: { nodeFrame?: { update?: () => void } } })._nodes;
  nodes?.nodeFrame?.update?.();
}

interface Copy {
  readonly mat: THREE.MeshBasicNodeMaterial;
  readonly quad: THREE.QuadMesh;
  readonly src: ReturnType<typeof texture>;
  readonly texel: UniformNode<'vec2', THREE.Vector2>;
}

/** RGBE encode of an HDR colour into unorm8 rgba (mantissas, exponent + 128). */
function encodeRGBE(c: Node<'vec3'>): V4 {
  const cc = c.max(0.0).min(60000.0);
  const m = max(max(cc.x, cc.y), cc.z);
  const e = ceil(log2(max(m, 1e-9))).clamp(-120.0, 120.0);
  const mant = cc.div(exp2(e)).clamp(0.0, 1.0);
  return vec4(mant, e.add(128.0).div(255.0));
}

/** RGBE decode (exact texel fetch: nearest filtering). */
function decodeRGBE(t: V4): Node<'vec3'> {
  const e = round(t.w.mul(255.0)).sub(128.0);
  return t.xyz.mul(exp2(e));
}

export class CubeBaker {
  private readonly renderer: THREE.WebGPURenderer;
  private rt: THREE.RenderTarget | null = null;
  private readonly copies = new Map<number, Copy>();
  private readonly encodes = new Map<number, Copy>();
  private decode: { mat: THREE.MeshBasicNodeMaterial; quad: THREE.QuadMesh; src: ReturnType<typeof texture> } | null = null;
  private readonly camera = new THREE.CubeCamera(BAKE_NEAR, BAKE_FAR, createCubeTarget(1));

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.camera.renderTarget.dispose();
  }

  /** The supersampled scratch target for faces of `size` x `ssaa`. */
  target(size: number): THREE.RenderTarget {
    if (this.rt !== null && this.rt.width === size) return this.rt;
    if (this.rt !== null) this.rt.dispose();
    this.rt = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: false });
    for (const c of this.copies.values()) c.src.value = this.rt.texture;
    for (const c of this.encodes.values()) c.src.value = this.rt.texture;
    return this.rt;
  }

  /**
   * Box filter of the scratch target: (ssaa / 2)^2 bilinear taps, each averaging a 2x2 block, so
   * the result is an exact ssaa x ssaa box filter (1 tap for ssaa 2).
   */
  private filtered(src: ReturnType<typeof texture>, texel: UniformNode<'vec2', THREE.Vector2>, ssaa: number): V4 {
    const k = Math.max(1, ssaa / 2);
    if (ssaa <= 2) return src as unknown as V4;
    let sum: V4 | null = null;
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const o = vec2((i - (k - 1) / 2) * 2, (j - (k - 1) / 2) * 2).mul(texel);
        const t = src.sample(uv().add(o)) as unknown as V4;
        sum = sum === null ? t : sum.add(t);
      }
    }
    return (sum as V4).div(k * k);
  }

  private quadFor(map: Map<number, Copy>, ssaa: number, encode: boolean): Copy {
    let c = map.get(ssaa);
    if (c !== undefined) return c;
    const src = texture((this.rt as THREE.RenderTarget).texture);
    const texel = uniform(new THREE.Vector2(1, 1));
    const f = this.filtered(src, texel, ssaa);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.outputNode = encode ? encodeRGBE(f.xyz) : f;
    c = { mat, quad: new THREE.QuadMesh(mat), src, texel };
    map.set(ssaa, c);
    return c;
  }

  /** Make the cube camera match the renderer's coordinate system and sit at `position`. */
  private place(position: THREE.Vector3): THREE.CubeCamera {
    const cam = this.camera;
    cam.position.copy(position);
    if (cam.coordinateSystem !== this.renderer.coordinateSystem) {
      cam.coordinateSystem = this.renderer.coordinateSystem;
      cam.updateCoordinateSystem();
    }
    cam.updateMatrixWorld(true);
    return cam;
  }

  /**
   * Render `scene` from `position` into the cube `target` with ssaa x ssaa samples. With `encode`
   * (an RGBA8 target of the face size) every face is also RGBE-encoded and read back; the
   * readbacks are returned (they resolve later, in face order).
   */
  render(scene: THREE.Scene, target: THREE.CubeRenderTarget, position: THREE.Vector3, ssaa: number, encode: THREE.RenderTarget | null = null): Promise<THREE.TypedArray>[] {
    const r = this.renderer;
    advanceFrame(r);
    const rt = this.target(target.width * ssaa);
    const copy = this.quadFor(this.copies, ssaa, false);
    copy.src.value = rt.texture;
    copy.texel.value.set(1 / rt.width, 1 / rt.height);
    const enc = encode !== null ? this.quadFor(this.encodes, ssaa, true) : null;
    if (enc !== null) {
      enc.src.value = rt.texture;
      enc.texel.value.set(1 / rt.width, 1 / rt.height);
    }
    const cam = this.place(position);
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = true;
    const reads: Promise<THREE.TypedArray>[] = [];
    for (let i = 0; i < 6; i++) {
      r.setRenderTarget(rt);
      r.render(scene, cam.children[i] as THREE.Camera);
      r.setRenderTarget(target, i);
      copy.quad.render(r);
      if (enc !== null && encode !== null) {
        r.setRenderTarget(encode);
        enc.quad.render(r);
        reads.push(r.readRenderTargetPixelsAsync(encode, 0, 0, encode.width, encode.height));
      }
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    return reads;
  }

  /** The RGBE decode quad (built on first use). */
  private decoder(): { mat: THREE.MeshBasicNodeMaterial; quad: THREE.QuadMesh; src: ReturnType<typeof texture> } {
    if (this.decode === null) {
      const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      const src = texture(blank);
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.outputNode = Fn(() => vec4(decodeRGBE(src.sample(uv()) as unknown as V4), float(1.0)))();
      this.decode = { mat, quad: new THREE.QuadMesh(mat), src };
    }
    return this.decode;
  }

  /** Decode RGBE bytes (w x h x 4, rows as read back) into `target` (face `face` of a cube target). */
  private decodeInto(target: THREE.RenderTarget, face: number | null, data: Uint8Array, w: number, h: number): void {
    const r = this.renderer;
    const d = this.decoder();
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    d.src.value = t;
    const prevTarget = r.getRenderTarget();
    if (face === null) r.setRenderTarget(target);
    else r.setRenderTarget(target, face);
    d.quad.render(r);
    r.setRenderTarget(prevTarget);
    // the upload and the draw are queued in order: the texture can go once the draw is encoded
    t.dispose();
  }

  /** Write cached RGBE faces (`faces[i]`: face x face x 4 bytes, rows as read back) into `target`. */
  decodeFaces(target: THREE.CubeRenderTarget, faces: readonly Uint8Array[]): void {
    for (let i = 0; i < 6; i++) this.decodeInto(target, i, faces[i], target.width, target.width);
  }

  /** Write a cached RGBE image of the 2D `target`'s size into it (the environment's PMREM atlas). */
  decode2D(target: THREE.RenderTarget, data: Uint8Array): void {
    this.decodeInto(target, null, data, target.width, target.height);
  }

  /** RGBE-encode a 2D texture of w x h texels (exact texel centres) and read it back. */
  encode2D(src: THREE.Texture, w: number, h: number): Promise<THREE.TypedArray> {
    const r = this.renderer;
    const node = texture(src);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.outputNode = encodeRGBE((node.sample(uv()) as unknown as V4).xyz);
    const quad = new THREE.QuadMesh(mat);
    const rt = new THREE.RenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(rt);
    quad.render(r);
    r.setRenderTarget(prevTarget);
    const read = r.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
    const done = (): void => {
      rt.dispose();
      mat.dispose();
    };
    read.then(done, done);
    return read;
  }

  /** Copy one cube into another of any size (a tier switch keeps the sky until the re-bake lands). */
  copyCube(src: THREE.CubeTexture, target: THREE.CubeRenderTarget): void {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false });
    mat.outputNode = vec4(cubeTexture(src, normalize(positionWorld.sub(cameraPosition))).rgb, float(1.0));
    // well inside the cube camera's range (BAKE_NEAR .. BAKE_FAR): a sphere inside the near plane
    // is clipped away and the new cube would show only the clear colour until the re-bake lands
    const geo = new THREE.SphereGeometry(BAKE_NEAR * 20, 32, 16);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const cam = this.place(new THREE.Vector3());
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    for (let i = 0; i < 6; i++) {
      r.setRenderTarget(target, i);
      r.render(scene, cam.children[i] as THREE.Camera);
    }
    r.setRenderTarget(prevTarget);
    geo.dispose();
    mat.dispose();
  }

  /**
   * Compile the pipelines of `scene` for the scratch target without blocking (WebGPU: async
   * pipelines; WebGL2: parallel shader compile). three's WebGL2 backend finalises a parallel
   * compile only from a requestAnimationFrame poll, which never fires in a hidden tab: there the
   * compile would hang, so without a live rAF it is skipped and the first draw compiles.
   */
  async compile(scene: THREE.Scene, size: number): Promise<void> {
    const r = this.renderer;
    if (!(r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
      const rafAlive = await new Promise<boolean>((res) => {
        let fired = false;
        requestAnimationFrame(() => {
          fired = true;
          res(true);
        });
        setTimeout(() => {
          if (!fired) res(false);
        }, 150);
      });
      if (!rafAlive) return;
    }
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target(size));
    try {
      await r.compileAsync(scene, this.place(new THREE.Vector3()).children[0] as THREE.Camera);
    } finally {
      r.setRenderTarget(prev);
    }
  }

  /** Free the supersampled scratch target between bakes (re-allocated on the next bake). */
  releaseScratch(): void {
    if (this.rt !== null) this.rt.dispose();
    this.rt = null;
  }

  dispose(): void {
    this.releaseScratch();
    for (const c of this.copies.values()) c.mat.dispose();
    for (const c of this.encodes.values()) c.mat.dispose();
    this.copies.clear();
    this.encodes.clear();
    if (this.decode !== null) {
      this.decode.mat.dispose();
      (this.decode.src.value as THREE.Texture).dispose();
      this.decode = null;
    }
  }
}

/**
 * Bake the parallax proxy: for each azimuth, the mean inverse distance of the baked skyline over 7
 * azimuths (+-6 deg) x 4 elevations (1 to 12 deg) of the small depth cube, stored as R / scale.
 * The dome then reads ONE texel per parallax iteration instead of a dozen cube taps.
 */
export function bakeProxyLUT(renderer: THREE.WebGPURenderer, depthTex: THREE.CubeTexture, rt: THREE.RenderTarget, maxR = 80000): void {
  const m = new THREE.MeshBasicNodeMaterial();
  m.outputNode = Fn(() => {
    const theta = uv().x.sub(0.5).mul(Math.PI * 2);
    let inv: Node<'float'> | null = null;
    let n = 0;
    for (const da of [-0.105, -0.07, -0.035, 0, 0.035, 0.07, 0.105]) {
      for (const e of [0.018, 0.06, 0.12, 0.2]) {
        const a = theta.add(da);
        const s = cubeTexture(depthTex, normalize(vec3(sin(a), e, cos(a)))).a;
        inv = inv === null ? s : inv.add(s);
        n++;
      }
    }
    const R = float(1000 * n).div(max(inv as Node<'float'>, (1000 * n) / maxR));
    return vec4(R.div(PROXY_SCALE), 0.0, 0.0, 1.0);
  })();
  const q = new THREE.QuadMesh(m);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  q.render(renderer);
  renderer.setRenderTarget(prev);
  m.dispose();
}
