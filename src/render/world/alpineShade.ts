/**
 * The alpine valley's patterns for the backdrop structure material (bakeMaterials.ts calls
 * `alpinePatterns` from its kind chain, so the alpine kinds share the harbour's one material and
 * pipeline; nothing here reads a theme, the preset only changes the light and the haze):
 *
 *   FOLIAGE  pine needles (live and bake): the per-vertex colour carries the tree's self-shadowing
 *            (alpine.ts pine), a clump-scale noise breaks the cones into branch masses.
 *   MEADOW   the valley floor and walls (live and bake): per-vertex meadow / forest floor / rock
 *            from alpine.ts, large drifts of lusher and drier grass and a finer patchiness.
 *   ALPINE   the baked mountains (bake only): snow above a wandering snow line where the slope can
 *            hold it (steeper faces stay bare, gullies keep snow below the line), rock with dipping
 *            strata and dark gullies, scree, alpine meadows above the tree line, forest below it.
 *            kcol.r is an albedo tint, kcol.g the slope smoothed over a few km (alpine.ts: the
 *            masks follow it, not the facet normals); kdat.x is the baked sun visibility, kdat.y
 *            the occlusion, kdat.z the forest potential.
 *
 * The live variant uses only cheap value noise (one or two taps); the bake can afford fbm (it runs
 * once per bake). No derivatives here: these branches are not in uniform control flow.
 */
import type { Node } from 'three/webgpu';
import { If, float, floor, fract, max, mix, oneMinus, saturate, smoothstep, vec2, vec3 } from 'three/tsl';
import { SNOW_Y, TREE_Y } from './alpine';
import { fbm3, hash12, vnoise } from './atmosphere';
import { KIND } from './geo';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

export interface AlpineInputs {
  readonly kind: F;
  /** World position and the (safe-normalised) world normal. */
  readonly wp: V3;
  readonly n: V3;
  readonly kcol: V4;
  readonly kdat: V4;
  /** The material's albedo and key-light visibility variables (written here). */
  readonly alb: V3;
  readonly vis: F;
  /** The per-frame variant (cheaper noise, no ALPINE: the mountains are only baked). */
  readonly live: boolean;
}

/** Write albedo and visibility for the alpine kinds (call inside the structure material's kind chain). */
export function alpinePatterns({ kind, wp, n, kcol, kdat, alb, vis, live }: AlpineInputs): void {
  If(kind.lessThan(KIND.FOLIAGE + 0.5), () => {
    // branch masses and the gaps between them (one tap live, a second finer one in the bake), and
    // the shelves of drooping branches: each layer lit on top, dark in its own shade underneath
    let clump: F = vnoise(wp.mul(0.016));
    if (!live) clump = clump.mul(0.65).add(vnoise(wp.mul(0.05)).mul(0.35));
    const shelf = smoothstep(0.0, 0.55, fract(wp.y.div(105.0).add(clump.mul(0.9))));
    alb.assign(kcol.rgb.mul(clump.mul(0.7).add(0.5)).mul(shelf.mul(0.5).add(0.62)).mul(kdat.y));
    vis.assign(kdat.x);
  })
    .ElseIf(kind.lessThan(KIND.MEADOW + 0.5), () => {
      const drift = vnoise(vec3(wp.xz.mul(0.0007), 3.1));
      const patch = vnoise(wp.mul(0.0042));
      const lush = mix(vec3(1.08, 1.0, 0.86), vec3(0.9, 1.04, 1.08), drift);
      alb.assign(kcol.rgb.mul(lush).mul(patch.mul(0.3).add(0.85)).mul(kdat.y));
      vis.assign(kdat.x);
    })
    .Else(() => {
      if (live) return;
      const h = wp.y;
      // 0 flat .. 1 vertical: mostly the smoothed slope, a little of the facet's own
      const slope = mix(oneMinus(saturate(n.y)), kcol.g, 0.8).toVar();
      const big = fbm3(wp.mul(0.00021)).toVar();
      const mid = vnoise(wp.mul(0.0017)).toVar();
      // (every pattern here is >= ~4 cube texels at the massif's distance: the cube is magnified
      // 2-4x on screen, and texel-sized contrast would read as blocky camouflage)
      const fine = vnoise(wp.mul(0.0024)).toVar();
      // rock: dipping strata warped by the large noise, dark gullies running down the faces
      const t = h.add(wp.x.mul(0.22)).sub(wp.z.mul(0.08)).add(big.sub(0.5).mul(2600.0)).div(520.0);
      const ti = floor(t);
      const band = mix(hash12(vec2(ti, 5.0)), hash12(vec2(ti.add(1.0), 5.0)), smoothstep(0.55, 1.0, fract(t)));
      const rockBase = mix(vec3(0.065, 0.063, 0.062), vec3(0.17, 0.158, 0.142), band.mul(0.7).add(mid.mul(0.3)));
      const gully = smoothstep(0.55, 0.9, vnoise(vec3(wp.x.mul(0.0012), wp.y.mul(0.00022), wp.z.mul(0.0012)))).toVar();
      const rock = rockBase.mul(fine.mul(0.35).add(0.8)).mul(oneMinus(gully.mul(0.45)));
      // scree on the gentler ground among the rock
      const scree = vec3(0.15, 0.145, 0.14).mul(fine.mul(0.25).add(0.85));
      const screeM = oneMinus(smoothstep(0.3, 0.5, slope));
      // alpine meadow above the forest, forest (patches from kdat.z) below the tree line
      const treeLine = float(TREE_Y).add(big.sub(0.5).mul(3200.0)).add(mid.sub(0.5).mul(900.0)).toVar();
      const meadow = mix(vec3(0.06, 0.09, 0.03), vec3(0.1, 0.105, 0.05), mid);
      const grassM = oneMinus(smoothstep(0.28, 0.46, slope.add(mid.sub(0.5).mul(0.15)))).mul(oneMinus(smoothstep(treeLine.add(1800.0), treeLine.add(3600.0), h)));
      const forestM = oneMinus(smoothstep(treeLine.sub(500.0), treeLine.add(400.0), h))
        .mul(oneMinus(smoothstep(0.45, 0.62, slope)))
        .mul(smoothstep(0.3, 0.46, kdat.z.add(mid.sub(0.5).mul(0.3))));
      const forest = vec3(0.018, 0.034, 0.017).mul(fine.mul(0.8).add(0.5));
      // snow above a wandering line where the slope holds it (steeper higher up); couloirs below
      const snowLine = float(SNOW_Y).add(big.sub(0.5).mul(3600.0)).add(mid.sub(0.5).mul(1300.0)).toVar();
      const above = smoothstep(snowLine.sub(900.0), snowLine.add(900.0), h);
      const maxSlope = mix(float(0.3), float(0.56), smoothstep(snowLine, snowLine.add(9000.0), h));
      // (gullies hold snow on faces too steep elsewhere: white couloirs streak the dark rock)
      const holds = oneMinus(smoothstep(maxSlope.sub(0.1), maxSlope.add(0.08), slope.add(mid.sub(0.5).mul(0.16)).sub(gully.mul(0.22)))).toVar();
      const couloir = gully.mul(smoothstep(snowLine.sub(2600.0), snowLine, h)).mul(holds.mul(0.4).add(0.6)).mul(0.85);
      const snow = max(above.mul(holds), couloir);
      const snowCol = vec3(0.78, 0.8, 0.84).mul(fine.mul(0.06).add(0.94));
      const c = mix(rock, scree, screeM.mul(0.6)).toVar();
      c.assign(mix(c, meadow, grassM));
      c.assign(mix(c, forest, forestM));
      c.assign(mix(c, snowCol, snow));
      alb.assign(c.mul(kcol.r).mul(kdat.y));
      vis.assign(kdat.x);
    });
}
