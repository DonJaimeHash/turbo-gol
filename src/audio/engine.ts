/**
 * The engine-sound model: a virtual combustion engine driven by the car's speed and inputs. Pure
 * (no Web Audio, runs in node: tests/engine-audio.test.mjs); Audio.ts turns its output into sound.
 *
 * A V8-like engine with three virtual gears. On the ground the rpm follows the wheel speed through
 * the current gear and drops when it shifts up; at a standstill the throttle revs it a little
 * (clutch slip); in the air the wheels spin free, so the throttle revs it toward FREE_REV_RPM. The
 * rpm slews at a limited rate, which is what makes a shift sound like one. `load` (0..1) is how
 * hard the engine works: the throttle, more while the car is still gaining speed or boosting, less
 * when it only holds the throttle-limited top speed. A throttle against the direction of travel
 * is the brake (RocketSim brakes with it until the car stops): no load, no clutch slip.
 *
 * Gears are laid out so the speed most of a match is played at (MAX_DRIVE_SPEED 1410 uu/s, full
 * throttle without boost) sits low in 3rd (~3900 rpm) rather than at a droning redline; boost then
 * pulls 3rd up toward the redline. Speeds are uu/s, |speed| (reversing uses the same gears).
 */

export const IDLE_RPM = 850;
export const REDLINE_RPM = 6000;
/** Throttle fully pressed with the wheels off the ground. */
export const FREE_REV_RPM = 5200;
/** A standstill with the throttle pressed revs this much above idle (1st gear clutch slip). */
const SLIP_RPM = 1300;
/** rpm per second the engine can climb / fall: a 2000 rpm shift drop takes 0.2 s. */
const RPM_UP_RATE = 14000;
const RPM_DOWN_RATE = 10000;
/** Shift down this far (uu/s) below a gear's start: no hunting at a gear boundary. */
const DOWNSHIFT_HYSTERESIS = 50;
/** Above this forward speed (uu/s) a throttle the other way brakes instead of driving. */
const BRAKE_MIN_SPEED = 100;
/** Acceleration (uu/s^2) that counts as full load (boosting is ~990 on top of the throttle). */
const FULL_LOAD_ACCEL = 900;
/** Load while only holding the throttle at a steady speed. */
const CRUISE_LOAD = 0.55;

/** [start speed, rpm at the start, rpm at the end] per gear; each gear ends where the next starts. */
const GEARS: readonly (readonly [number, number, number])[] = [
  [0, IDLE_RPM, 5400],
  [550, 3200, 5600],
  [1250, 3500, 5900],
];
const TOP_SPEED = 2300;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** rpm of gear `g` at `speed` (uu/s, >= 0), on the ground with the clutch closed. */
export function gearRpm(g: number, speed: number): number {
  const gear = GEARS[g];
  const end = g + 1 < GEARS.length ? GEARS[g + 1][0] : TOP_SPEED;
  const f = (speed - gear[0]) / (end - gear[0]);
  return gear[1] + (gear[2] - gear[1]) * clamp(f, 0, 1.15);
}

export class EngineModel {
  /** Current rpm (slewed). */
  rpm = IDLE_RPM;
  /** Current gear, 0-based. */
  gear = 0;
  /** 0..1, see the file comment. */
  load = 0;
  /** True on the step that shifted up (Audio dips the volume for a moment). */
  shifted = false;
  private lastSpeed = 0;
  private accel = 0;

  reset(): void {
    this.rpm = IDLE_RPM;
    this.gear = 0;
    this.load = 0;
    this.shifted = false;
    this.lastSpeed = 0;
    this.accel = 0;
  }

  /**
   * Advance by `dt` seconds. `speed` uu/s along the car's nose (negative when rolling backwards;
   * only its size picks the gear), `throttle` -1..1.
   */
  step(dt: number, speed: number, throttle: number, grounded: boolean, boosting: boolean): void {
    this.shifted = false;
    const s = Math.abs(speed);
    const braking = grounded && s > BRAKE_MIN_SPEED && throttle * speed < 0;
    const thr = braking ? 0 : clamp(Math.abs(throttle), 0, 1);
    if (dt > 0) {
      const a = (s - this.lastSpeed) / dt;
      // Smooth the acceleration estimate (contact noise, frame jitter).
      this.accel += (a - this.accel) * Math.min(1, dt * 8);
    }
    this.lastSpeed = s;

    // Gear from the wheel speed (kept while airborne: the car lands in the gear it left in).
    if (grounded) {
      let g = this.gear;
      while (g + 1 < GEARS.length && s >= GEARS[g + 1][0]) g++;
      while (g > 0 && s < GEARS[g][0] - DOWNSHIFT_HYSTERESIS) g--;
      if (g > this.gear) this.shifted = true;
      this.gear = g;
    }

    let target: number;
    if (grounded) {
      target = gearRpm(this.gear, s);
      if (this.gear === 0) target = Math.max(target, IDLE_RPM + SLIP_RPM * thr);
    } else {
      target = IDLE_RPM + (FREE_REV_RPM - IDLE_RPM) * (boosting ? Math.max(thr, 0.6) : thr);
    }
    target = clamp(target, IDLE_RPM, REDLINE_RPM);
    const maxStep = (target > this.rpm ? RPM_UP_RATE : RPM_DOWN_RATE) * Math.max(0, dt);
    this.rpm += clamp(target - this.rpm, -maxStep, maxStep);

    // Load: the throttle, harder while gaining speed (or boosting), lighter when only cruising.
    let work = boosting ? 1 : clamp(CRUISE_LOAD + ((1 - CRUISE_LOAD) * this.accel) / FULL_LOAD_ACCEL, CRUISE_LOAD, 1);
    if (!grounded) work = Math.max(work, 0.75);
    this.load = boosting ? 1 : thr * work;
  }
}
