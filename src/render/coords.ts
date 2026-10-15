/**
 * The ONLY place that converts sim coordinates (x side, y length, z up; car local
 * +x forward / +y right / +z up) into three.js coordinates (y up, right handed).
 *
 *   three = (sim.x, sim.z, sim.y)
 *
 * This swap preserves handedness (the sim frame is left-handed), so nothing is mirrored. A car model
 * built in three.js local space must therefore use **+x forward, +y up, +z right**.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';

const _m = new Matrix4();
const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();

/** Write a sim position/vector into a three.js Vector3. */
export function simToThree(out: Vector3, x: number, y: number, z: number): Vector3 {
  return out.set(x, z, y);
}

/** Read a sim vec3 from a state buffer at float offset `off` into a three.js Vector3. */
export function simVecFromBuf(out: Vector3, buf: Float32Array, off: number): Vector3 {
  return out.set(buf[off], buf[off + 2], buf[off + 1]);
}

/** Interpolated sim vec3 (prev→cur by alpha) from two state buffers into a three.js Vector3. */
export function simVecLerpFromBuf(out: Vector3, prev: Float32Array, cur: Float32Array, off: number, alpha: number): Vector3 {
  const b = 1 - alpha;
  return out.set(
    prev[off] * b + cur[off] * alpha,
    prev[off + 2] * b + cur[off + 2] * alpha,
    prev[off + 1] * b + cur[off + 1] * alpha,
  );
}

/**
 * Convert a RocketSim RotMat (9 floats at `off`: forward xyz, right xyz, up xyz, sim coords) into a
 * three.js quaternion for an object whose local frame is +x forward, +y up, +z right.
 */
export function simRotMatToQuat(out: Quaternion, buf: Float32Array, off: number): Quaternion {
  simVecFromBuf(_f, buf, off);
  simVecFromBuf(_r, buf, off + 3);
  simVecFromBuf(_u, buf, off + 6);
  _m.makeBasis(_f, _u, _r); // local x = forward, local y = up, local z = right
  return out.setFromRotationMatrix(_m);
}

/** Convert a three.js position back to sim coordinates (for debug/UI). */
export function threeToRl(out: Vector3, v: Vector3): Vector3 {
  return out.set(v.x, v.z, v.y);
}
