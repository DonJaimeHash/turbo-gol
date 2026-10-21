/**
 * A small full-screen pass of the post chain: renders one fragment node into its own render target
 * once per frame, at a fraction of the drawing buffer, and hands the result on as a texture node.
 * It is three's own post-node pattern (LensflareNode, GTAONode...): a TempNode whose updateBefore
 * runs before any material that samples `getTextureNode()` / `getDepthNode()` draws, so a chain of
 * passes orders itself through the node graph.
 *
 * With `depthNode` the pass also writes a single-sample DepthTexture through the fragment depth
 * (`material.depthNode`, depth test always passing): the ultra tier uses that to copy the MSAA scene
 * depth into a plain half-resolution depth texture, which GTAO and SSR can sample and gather (WGSL
 * has no textureGather on a multisampled texture).
 *
 * Nothing allocates per frame: the size is compared and the renderer state object reused.
 */
import * as THREE from 'three/webgpu';
import type { Node, NodeBuilder, NodeFrame, TextureNode } from 'three/webgpu';
import { context, passTexture, vec4 } from 'three/tsl';

const _size = new THREE.Vector2();

export interface QuadPassOptions {
  /** Size relative to the drawing buffer, per axis (0.5 = half resolution). */
  readonly scaleX: number;
  readonly scaleY: number;
  /** Colour target type and format (default HalfFloat RGBA). */
  readonly type?: THREE.TextureDataType;
  readonly format?: THREE.PixelFormat;
  /** Writes a depth texture from this node (fragment depth, 0..1); the colour target is then unused. */
  readonly depthNode?: Node | null;
}

type PassLike = Parameters<typeof passTexture>[0];

export class QuadPassNode extends THREE.TempNode<'vec4'> {
  readonly renderTarget: THREE.RenderTarget;
  /** Extra scale on top of scaleX / scaleY (dynamic resolution follows the scene pass with it). */
  resolutionScale = 1;
  private readonly fragment: Node;
  private readonly depth: Node | null;
  private readonly scaleX: number;
  private readonly scaleY: number;
  private readonly material = new THREE.NodeMaterial();
  private readonly quad: THREE.QuadMesh;
  private readonly colorTexture: TextureNode;
  private readonly depthTexture: TextureNode | null;
  private state: THREE.RendererUtils.RendererState | undefined;

  constructor(name: string, fragment: Node, options: QuadPassOptions) {
    super('vec4');
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    this.fragment = fragment;
    this.depth = options.depthNode ?? null;
    this.scaleX = options.scaleX;
    this.scaleY = options.scaleY;
    const withDepth = this.depth !== null;
    this.renderTarget = new THREE.RenderTarget(1, 1, {
      depthBuffer: withDepth,
      type: options.type ?? THREE.HalfFloatType,
      format: options.format ?? THREE.RGBAFormat,
    });
    this.renderTarget.texture.name = name;
    if (withDepth) {
      const depthTexture = new THREE.DepthTexture(1, 1);
      depthTexture.name = `${name}.depth`;
      this.renderTarget.depthTexture = depthTexture;
      // Every fragment overwrites the cleared depth; colour is not needed.
      this.material.depthTest = true;
      this.material.depthWrite = true;
      this.material.depthFunc = THREE.AlwaysDepth;
      this.material.colorWrite = false;
    } else {
      this.material.depthTest = false;
      this.material.depthWrite = false;
    }
    this.material.name = name;
    this.quad = new THREE.QuadMesh(this.material);
    this.quad.name = name;
    const self = this as unknown as PassLike;
    this.colorTexture = passTexture(self, this.renderTarget.texture);
    this.depthTexture = withDepth && this.renderTarget.depthTexture !== null ? passTexture(self, this.renderTarget.depthTexture) : null;
  }

  /** The pass's colour result (sampled at the reading material's uv unless re-sampled). */
  getTextureNode(): TextureNode {
    return this.colorTexture;
  }

  /** The pass's depth result (only for passes built with `depthNode`). */
  getDepthNode(): TextureNode {
    if (this.depthTexture === null) throw new Error(`${this.renderTarget.texture.name}: no depth target`);
    return this.depthTexture;
  }

  override updateBefore(frame: NodeFrame): undefined {
    const renderer = frame.renderer as unknown as THREE.Renderer | null;
    if (renderer === null) return undefined;
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.round(_size.x * this.scaleX * this.resolutionScale));
    const h = Math.max(1, Math.round(_size.y * this.scaleY * this.resolutionScale));
    if (this.renderTarget.width !== w || this.renderTarget.height !== h) this.renderTarget.setSize(w, h);
    // (three's own post nodes pass `undefined` on their first frame too: the state is created then.)
    this.state = THREE.RendererUtils.resetRendererState(renderer, this.state as THREE.RendererUtils.RendererState);
    renderer.setRenderTarget(this.renderTarget);
    this.quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, this.state);
    return undefined;
  }

  override setup(builder: NodeBuilder): Node {
    // The same shared context three's own post nodes give their quad materials.
    const shared = (builder as unknown as { getSharedContext(): Record<string, unknown> }).getSharedContext();
    this.material.contextNode = context(shared);
    this.material.fragmentNode = this.depth !== null ? vec4(0, 0, 0, 1) : this.fragment;
    this.material.depthNode = this.depth;
    this.material.needsUpdate = true;
    return this.colorTexture;
  }

  override dispose(): void {
    this.renderTarget.dispose();
    this.material.dispose();
    super.dispose();
  }
}
