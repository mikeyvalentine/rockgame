/**
 * stoneSkipping.js — 6-DOF rigid-body stone skipping physics.
 *
 * Engine-agnostic ES module. No imports, no renderer types. Feed it a throw and a
 * timestep; read position + orientation quaternion out and hand them to Babylon
 * (see ./babylonAdapter.js).
 *
 * The model is documented in ../docs/PHYSICS-NOTES.md. In short:
 *
 *   - Water force is dynamic pressure on the wetted surface, p = 1/2 C_D rho (u.n)^2,
 *     with C_D = 1.4 fitted to SPH by Nagahiro & Hayakawa (PRL 94, 174501, 2005).
 *   - The wetted surface is integrated by panel quadrature over two equal-area polar
 *     face grids plus a rim ring, so roll, sideslip and edge strikes all work.
 *   - Air-facing panels are unwetted while the ventilated cavity is open
 *     (Nagahiro assumption 2). Without this, lift cancels and nothing skips.
 *   - Hydrostatic pressure is summed over the same closed surface, so buoyancy is
 *     exact and takes over automatically as the stone slows.
 *   - Torque is taken about the centre of mass from the same integral, with a full
 *     inertia tensor. Gyroscopic stabilisation, precession, wobble, tumbling and
 *     edge-catch flyaways are emergent, not scripted.
 *
 * Coordinate convention
 *   World: Y up. Handedness-neutral (pure vector math), so it drops into a Babylon
 *   scene with or without useRightHandedSystem.
 *   Body:  the stone is a disk lying in the body XZ plane. Body +Y is the face
 *          normal (the "top" of the stone). Spin is about body +Y.
 *
 * Units are SI throughout: metres, kilograms, seconds, radians internally
 * (degrees only at the throw API boundary).
 */

// The one import, and it keeps the package dependency-free: exact rigid-body
// properties of a triangle mesh, for stones supplied as real geometry rather than as
// an idealised disc. Re-exported so callers have a single entry point.
import {
  massProperties as meshMassProperties,
  shapeDescriptors as meshShapeDescriptors,
} from './meshMassProperties.js'

export {
  massProperties, principalAxes, shapeDescriptors, alignMeshToFaceAxis,
} from './meshMassProperties.js'

/* ------------------------------------------------------------------ *
 * Minimal vector / quaternion math (plain objects, no allocation-free
 * heroics — the panel loop uses scalars, which is where the cost is)
 * ------------------------------------------------------------------ */

export const V = {
  make: (x = 0, y = 0, z = 0) => ({ x, y, z }),
  clone: (a) => ({ x: a.x, y: a.y, z: a.z }),
  set: (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o },
  copy: (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o },
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  addScaled: (o, a, s) => { o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o },
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  lengthSq: (a) => a.x * a.x + a.y * a.y + a.z * a.z,
  length: (a) => Math.hypot(a.x, a.y, a.z),
  normalize: (a) => {
    const l = Math.hypot(a.x, a.y, a.z) || 1
    return { x: a.x / l, y: a.y / l, z: a.z / l }
  },
}

export const Q = {
  identity: () => ({ x: 0, y: 0, z: 0, w: 1 }),
  clone: (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w }),
  /** Right-multiply: result = a * b (apply b first, then a). */
  mul: (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }),
  fromAxisAngle: (axis, angle) => {
    const n = V.normalize(axis)
    const h = angle * 0.5
    const s = Math.sin(h)
    return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) }
  },
  normalize: (q) => {
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
  },
  conjugate: (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w }),
  /** Rotate a vector from body space into world space. */
  rotate: (q, v) => {
    const { x, y, z, w } = q
    const tx = 2 * (y * v.z - z * v.y)
    const ty = 2 * (z * v.x - x * v.z)
    const tz = 2 * (x * v.y - y * v.x)
    return {
      x: v.x + w * tx + (y * tz - z * ty),
      y: v.y + w * ty + (z * tx - x * tz),
      z: v.z + w * tz + (x * ty - y * tx),
    }
  },
  /** Rotate a vector from world space into body space. */
  rotateInverse: (q, v) => Q.rotate(Q.conjugate(q), v),
  /** Integrate orientation by a world-frame angular velocity for dt. */
  integrate: (q, omega, dt) => {
    const half = dt * 0.5
    const dq = {
      x: half * (omega.x * q.w + omega.y * q.z - omega.z * q.y),
      y: half * (omega.y * q.w + omega.z * q.x - omega.x * q.z),
      z: half * (omega.z * q.w + omega.x * q.y - omega.y * q.x),
      w: half * (-omega.x * q.x - omega.y * q.y - omega.z * q.z),
    }
    return Q.normalize({ x: q.x + dq.x, y: q.y + dq.y, z: q.z + dq.z, w: q.w + dq.w })
  },
}

/**
 * Bump on any change that alters simulation output. Shown in the demo HUD so it is
 * obvious at a glance whether the browser is running current code or a cached module.
 */
export const VERSION = '0.8.2-anchor-retune'

const UP = Object.freeze({ x: 0, y: 1, z: 0 })
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 })
const DEG = Math.PI / 180
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Fraction of the trim error `env.balanceRetention: 1` corrects at each contact.
 *
 * Measured peak, not a taste value. Sweeping the blend on the arcade profile:
 *
 *   blend    0    0.05  0.10  0.15  0.20  0.25  0.30  0.35  0.40  0.45  0.50
 *   steiner  38   44    63    67    72    78    83    86    83    78    75
 *   truscott 40   51    68    75    78    84    89    92    86    83    80
 *
 * Monotone up to 0.35 and falling after, for the reason given on `balanceRetention`:
 * an over-held stone stops being able to end its run. The stat maps onto [0, 0.35]
 * so gameplay cannot reach the falling side.
 */
const BALANCE_MAX_BLEND = 0.35

/**
 * Gyroscopic authority below which Balance is withheld entirely (see `_applyBalance`).
 * Set under the weakest playable throw — the `casual` preset's 12 rev/s works out to
 * ~0.27 — so it only ever zeroes stones that had no chance of skipping regardless.
 */
const BALANCE_AUTHORITY_KNEE = 0.25

/**
 * Solve `I w = L` for `w`, with `I` a symmetric 3x3 as {xx,yy,zz,xy,xz,yz}.
 *
 * Needed once the inertia tensor stopped being diagonal — see `_recomputeBody`. Uses
 * the cofactor inverse rather than a general solver: 3x3 symmetric is small enough
 * that the closed form is both faster and allocation-free, which matters because this
 * runs every substep of every contact.
 */
function solveSymmetric3(I, L) {
  const { xx, yy, zz, xy, xz, yz } = I
  const c00 = yy * zz - yz * yz
  const c01 = xz * yz - xy * zz
  const c02 = xy * yz - xz * yy
  const det = xx * c00 + xy * c01 + xz * c02
  if (!(Math.abs(det) > 1e-24)) return { x: 0, y: 0, z: 0 }
  const c11 = xx * zz - xz * xz
  const c12 = xz * xy - xx * yz
  const c22 = xx * yy - xy * xy
  const inv = 1 / det
  return {
    x: (c00 * L.x + c01 * L.y + c02 * L.z) * inv,
    y: (c01 * L.x + c11 * L.y + c12 * L.z) * inv,
    z: (c02 * L.x + c12 * L.y + c22 * L.z) * inv,
  }
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/**
 * A typical good skipping stone: flat, ~9 cm across, ~1 cm thick, slate-density.
 * Matches the Bocquet AJP 2003 test case (M ~ 0.1 kg, a ~ 0.1 m).
 */
export const DEFAULT_STONE = {
  radius: 0.045,          // m — semi-major axis of the face
  thickness: 0.010,       // m — full thickness
  density: 2700,          // kg/m^3 — slate/granite. Ignored if `mass` is given.
  mass: null,             // kg — overrides density if set
  aspect: 1.0,            // face ellipse ratio. 1 = round disk, 0.7 = oblong.
  edgeRoundness: 0.5,     // 0 = sharp square rim (catches hard), 1 = fully rounded
  roughness: 1.0,         // multiplier on skin friction
  /** Fraction of the radius the centre of mass sits off-centre, in body XZ.
   *  Real stones are never balanced; this is a big source of wobble.
   *  Ignored when `mesh` is supplied — a mesh carries its own real offset. */
  comOffset: { x: 0, z: 0 },
  /**
   * OPTIONAL real geometry: `{ positions, indices }`, a closed triangle mesh in
   * metres, in body axes (Y = the face normal the stone spins about).
   *
   * When present the stone stops being an idealised disc. Mass, centre of mass and
   * the full inertia tensor are computed exactly from the mesh
   * (`meshMassProperties.js`), and the hydrodynamic panels are built from its real
   * surface, so the rock wobbles, catches and splashes as the shape it actually is.
   * `radius`/`thickness`/`aspect` are then derived from the mesh for the terms that
   * still need a scalar size, not read from the fields above.
   *
   * Costs a one-off mesh pass per stone (not per step), so set it at build time.
   */
  mesh: null,
}

/**
 * Reference `mass / radius`, kg/m — the default stone's (0.172 kg / 0.045 m).
 *
 * Used as the half-saturation point of the Balance curve, so the default stone scores
 * exactly 0.5 and the profiles' "average rock" value means what it says.
 */
const BALANCE_MR_REFERENCE = 3.82
/** CoM offset (as a fraction of radius) at which the symmetry penalty is fully paid. */
const BALANCE_COM_TOLERANCE = 0.30
/** How much of a stone's Balance a maximally off-centre CoM can take away. */
const BALANCE_COM_WEIGHT = 0.6
/** Face-ellipse deviation from round at which the roundness penalty is fully paid. */
const BALANCE_ASPECT_TOLERANCE = 0.45
/** How much of a stone's Balance a maximally oblong face can take away. */
const BALANCE_ASPECT_WEIGHT = 0.35

/**
 * BALANCE from geometry — how well this stone will hold its trim, 0..1.
 *
 * Feeds `env.balanceRetention` (set that to `'auto'` to have the sim call this).
 * Everything here is visible in the stone itself, which is the point: the player is
 * meant to read a rock by looking at it (docs/02-gathering.md), so the stat may only
 * depend on things a stone visibly IS — how big, how heavy, how lopsided, how oblong.
 *
 * ### Why `mass / radius`
 *
 * Attitude is lost to precession at rate `Omega = Gamma / L`. The disturbing torque
 * `Gamma ~ rho_w V^2 R^3` comes from the water and does not care how heavy the stone
 * is; the angular momentum resisting it, `L = (1/2) m R^2 omega`, does. So
 *
 *     Omega  ~  R / (m omega)
 *
 * and the stone-side figure of merit is `m / R`. Confirmed in this solver by sweeping
 * geometry at `balanceRetention: 0` and reading the roll angle a run dies at:
 *
 *     tiny  17 g  m/R 0.85  ->  12.6 deg      default 172 g  m/R 3.82  ->  6.7 deg
 *     very large 668 g  m/R 8.91  ->  4.4 deg
 *
 * **A tiny stone is therefore badly balanced, not well balanced** — it has too little
 * angular momentum to resist the same hit. That is also what docs/02-gathering.md
 * already assumed when it gave tiny rocks a "low ceiling"; this is the mechanism.
 *
 * ### Why thickness is NOT penalised here
 *
 * Thickness raises `m/R` and measurably improves retention (a chunky test stone ended
 * at 1.3 deg of roll, the steadiest of any tested). Thick stones are bad skippers for
 * a different reason — they are poor planing shapes and plunge — and that is already
 * paid for in the contact physics. Charging thickness again here would penalise one
 * flaw twice, and the second charge would be measurably false.
 */
export function balanceFromStone(stone = {}, meshShape = null) {
  const s = { ...DEFAULT_STONE, ...stone }
  const com = { ...DEFAULT_STONE.comOffset, ...(stone.comOffset || {}) }
  let R = s.radius
  let m = s.mass != null ? s.mass : s.density * Math.PI * R * R * s.aspect * s.thickness
  let off = Math.hypot(com.x || 0, com.z || 0)
  let oblong = 1 - s.aspect

  // Real geometry wins over the authored disc fields. Measured values, not guesses:
  // `lopsidedness` is the true centre-of-mass offset and `asymmetry` the true
  // transverse-inertia imbalance, both read off the mesh.
  if (meshShape && !meshShape.degenerate) {
    R = Math.max(meshShape.extent.x, meshShape.extent.z) / 2
    m = s.mass != null ? s.mass : meshShape.mass
    off = meshShape.lopsidedness * BALANCE_COM_TOLERANCE
    oblong = meshShape.asymmetry * BALANCE_ASPECT_TOLERANCE
  }
  if (!(R > 0) || !(m > 0)) return 0

  // Gyroscopic authority per unit disturbing torque. Saturating: doubling the mass of
  // an already-heavy stone helps less than doubling a light one, which is both the
  // right shape for the physics and the right shape for a stat.
  const mOverR = m / R
  const gyro = mOverR / (mOverR + BALANCE_MR_REFERENCE)

  // The literal balance term — an off-centre centre of mass, exactly like an
  // unbalanced wheel.
  const comTerm = 1 - BALANCE_COM_WEIGHT * clamp(off / BALANCE_COM_TOLERANCE, 0, 1)

  // An oblong face presents a different wetted patch every half turn, so the stone is
  // forced at spin frequency instead of meeting the water the same way each time.
  const roundTerm =
    1 - BALANCE_ASPECT_WEIGHT * clamp(oblong / BALANCE_ASPECT_TOLERANCE, 0, 1)

  return clamp(gyro * comTerm * roundTerm, 0, 1)
}

export const DEFAULT_ENV = {
  gravity: 9.81,              // m/s^2
  waterDensity: 1000,         // kg/m^3
  airDensity: 1.225,          // kg/m^3
  /**
   * Normal-impact (Newtonian) pressure coefficient: p = 1/2 rho C_D (u.n)^2.
   * Nagahiro & Hayakawa's SPH fit, C_D = 1.4. Correct in the steep-impact limit.
   */
  pressureCoefficient: 1.4,
  /**
   * Planing (circulatory) pressure coefficient: p += 1/2 rho C_P |u_t| (u.n).
   *
   * These two papers do NOT use the same force law, and the difference is not small.
   * Nagahiro's p ~ (u.n)^2 is Newtonian: pressure goes as sin^2(alpha). Bocquet's
   * p = 1/2 rho C_l V^2 S_im with C_l ~ 1 uses the FULL speed, so at alpha = 20 deg
   * it is roughly 4x larger. Newtonian impact theory is right for a steep slam and
   * badly under-predicts a shallow planing surface, where lift is closer to linear
   * in alpha because of circulation and unsteady added mass.
   *
   * Using the Newtonian law alone makes the stone penetrate about twice as deep as
   * Bocquet's own closed form predicts, which lengthens contact, lengthens the
   * torque lever, drops vertical restitution to ~0.45 and caps every throw at a few
   * skips.
   *
   * The cross term |u_t|(u.n) is linear in sin(alpha) and vanishes as the flow
   * becomes purely normal, so the sum reduces to Nagahiro at steep impact and
   * matches Bocquet's C_l ~ 1 at the canonical 20 deg planing condition when
   * C_P = 1.5. That is where this default comes from.
   */
  planingCoefficient: 1.5,
  /** Tangential skin friction on wetted panels. Bocquet's lumped model uses
   *  C_f ~ C_l ~ 1 because his C_f absorbs the induced (pressure) drag too. Here the
   *  induced drag already comes out of the pressure integral, so this must be the
   *  TRUE skin friction: turbulent flat plate at Re ~ 1e5-1e6, i.e. 0.003-0.006.
   *  Setting it near Bocquet's 1.0 brakes the stone before lift can build, and
   *  nothing skips. */
  frictionCoefficient: 0.005,
  /** Added mass along the face normal: m_n = m + Ca * rho_w * R^3 * immersedFraction.
   *  4/3 is the free-surface half of the unbounded-fluid disk value 8/3. */
  addedMassCoefficient: 4 / 3,
  addedInertiaCoefficient: 0.30,
  /** Depth (in radii) at which the ventilated air cavity is treated as closed and
   *  air-facing panels start getting wetted. Nagahiro assumption 2. */
  cavityCloseDepthRadii: 0.75,
  /**
   * The cavity also closes when the stone is simply too SLOW to outrun the water
   * falling in behind it, regardless of depth. Water collapses into the void at
   * roughly sqrt(2 g depth); the cavity survives only while the stone outruns that
   * by this factor.
   *
   * Depth alone is not enough. A stone drowning at 1 m/s, 12 mm down, was still
   * being treated as 91% ventilated - so the top face stayed dry, it kept generating
   * planing lift it should not have, and it never settled.
   */
  cavityCloseSpeedFactor: 6,
  /**
   * Rotational damping of a submerged disc, torque = C rho R^5 |w| w * immersedFraction,
   * applied separately to the wobble (transverse) and spin (face-normal) components.
   *
   * The panel integral does produce this damping on its own - it sees w x r in the
   * relative velocity - but pitchMomentScale then scales the transverse torque down
   * by 3x, which weakens the DAMPING just as much as the destabilising part it was
   * meant to tame. So the wobble term is applied here, outside that scaling.
   *
   * Raised from 0.6 to 3.0 when pitchMomentScale dropped to 0.05: the panel integral
   * produces wobble damping of its own, but that part IS scaled by pitchMomentScale,
   * so weakening the scale left a drowned stone ringing at 12 rad/s instead of 4.
   * This explicit term now carries damping the scaled integral no longer provides.
   *
   * Wobble damping is form drag (the rim sweeps broadside through water) and is
   * strong. Spin damping is shear-driven and is far weaker. Both scale with
   * immersedFraction, so they are negligible during a shallow planing contact and
   * only take over once the stone is genuinely in the water.
   */
  wobbleDampingCoefficient: 3.0,
  spinDampingCoefficient: 0.02,

  /* ---------------------------------------------------------------- *
   * GAME ASSIST — deliberately NOT physics. Both default to off, so the
   * out-of-the-box solver stays the validated one. See PHYSICS_PROFILES.
   *
   * Real stone skipping tops out around 88 skips (Steiner, 2013) and the
   * honest model reaches ~13 clean hops. The two things standing in the way
   * were measured, not guessed:
   *   1. vertical restitution e ~ 0.84, so hop height decays x0.70 per
   *      bounce and the stone runs out of altitude after ~13 hops;
   *   2. the attitude walks by gyroscopic precession into a nose-down bite
   *      around hop 6-10, which usually ends it before (1) does.
   * One knob each.
   * ---------------------------------------------------------------- */

  /**
   * Target vertical restitution: the floor on (upward speed leaving a bounce) /
   * (downward speed entering it). 0 = disabled (pure physics, which measures ~0.84).
   *
   * THIS is the knob that sets how many times a stone skips, because hop height
   * decays as the square of it: at 0.84 each hop is 70% as high as the last and the
   * stone runs out of altitude after ~13; at 0.95 it is 90% and you get ~45.
   *
   * Two earlier attempts are worth not repeating. A multiplicative rebound-pressure
   * gain was unstable — past ~1.25x the stone gained more than it lost per bounce and
   * the count leapt from 12 to 230 over a hair's width. An energy-loss cap was stable
   * but barely moved anything, because total energy was never the limiter. Hop height
   * was. This knob is bounded (it can only raise vy toward a fraction of what came
   * in, never above it, so the stone still decays) and reads directly as "how long
   * the run lasts".
   */
  verticalRestitution: 0,
  /**
   * Target upward speed leaving a bounce, as a fraction of the stone's current
   * speed. 0 = disabled. 0.05 at 20 m/s gives a 1 m/s rebound (~5 cm hop); at 5 m/s
   * it gives 0.25 m/s (~3 mm). So hops shrink naturally as the stone slows, and the
   * run ends when speed runs out rather than when the attitude happens to fail.
   *
   * `verticalRestitution` alone was not enough: with the attitude held steady the
   * stone settled into a 1 mm skim, and a restitution RATIO of an already-tiny
   * approach speed is still tiny. Tying the rebound to forward speed instead is what
   * keeps hops visible for the length of the run.
   */
  hopSpeedFraction: 0,
  /**
   * Extra fraction of speed removed at each bounce, on top of the physics. 0 = off.
   *
   * `hopSpeedFraction` turned out to control mid-range throws only — a champion throw
   * saturates at ~50-80 hops over ~110 m no matter how it is set, because it always
   * enters the sustained-skipping mode. This is the knob for how LONG a run is, which
   * is what actually reads as "dialled too far up". Purely subtractive, so it can
   * never extend a run.
   */
  bounceSpeedTax: 0,

  /**
   * Rate (1/s) at which the stone's attitude is nudged back toward its launch trim
   * while in contact with water. 0 = pure physics, free gyroscope.
   *
   * Scaled by immersed fraction (only acts during contact) and by spin relative to
   * `attitudeAssistRefSpin`, so spin still governs stability: an unspun stone gets no
   * help and still tumbles, which keeps the skill curve intact.
   *
   * Raised from 6 to 20 once it started targeting angular momentum instead of the
   * instantaneous face normal. The old form fought the nutation cone every substep
   * and flattened the visible wobble; the new one preserves it exactly, so strength
   * and wobble are now independent and the knob can be turned up freely.
   */
  attitudeAssist: 0,
  attitudeAssistRefSpin: 40,   // rev/s at which the assist reaches full strength
  /**
   * BALANCE — how well the stone holds its trim across a whole run. 0..1, 0 = off.
   *
   * The player-facing stat is a hidden property of the rock (docs/02-gathering.md);
   * this is the physics parameter it drives. Unlike `attitudeAssist`, which is a
   * continuous per-substep RATE applied for as long as the stone is wet, this fires
   * ONCE per contact, at the instant the stone first touches, and re-aims angular
   * momentum a fixed FRACTION of the way toward the launch trim.
   *
   * Why once-at-contact rather than a stronger `attitudeAssist`:
   *
   *   - As a rate it saturates. `frac` is clamped to 0.5/substep, so past a certain
   *     gain every substep pins at the clamp and the "nudge" becomes a snap that
   *     fights the contact physics it is embedded in. Measured: skips peak near
   *     attitudeAssist 500-2000 and then go erratic (median falls, range widens to
   *     16-89). It is not a knob that can simply be turned up.
   *   - Timing is the whole trick. Correcting at LIFTOFF aims the stone relative to a
   *     velocity that is heading UP; what governs the next bounce is attitude at
   *     CONTACT, heading down. Same correction, moved to contact start: median skips
   *     on the Steiner preset go 60 -> 83.
   *
   * Effect at max (arcade, Steiner's real 19.2 m/s throw): median ~86 skips, and
   * runs end at ~0.3 m/s instead of ~11 m/s — i.e. the stone finally dies of ENERGY,
   * which is the documented goal (PHYSICS-NOTES §11.4: "they die of attitude, not
   * energy"). That ~85 is also the independent velocity-limited ceiling implied by
   * the model's own 4.6% per-bounce loss decaying 19.2 m/s to the 2.6 m/s floor, so
   * this parameter closes the attitude gap rather than papering over it.
   *
   * Deliberately NOT monotonic past `BALANCE_MAX_BLEND`: beyond ~0.35 the stone is
   * held so rigidly it stops being able to die, skims past the run-end logic and
   * scores WORSE (and reads as "refusing to sink" — the same failure the attitude
   * hold has when left running after `runEnded`). The stat is therefore mapped onto
   * [0, BALANCE_MAX_BLEND] and cannot be dialled into that region from gameplay.
   */
  balanceRetention: 0,
  /**
   * How much of `balanceRetention` is withheld from a sloppy throw. The rock is the
   * main driver by design ("mostly the stone, a little the throw"), so a maximally
   * incoherent release still keeps 1 - this fraction of its stone's balance.
   */
  balanceThrowInfluence: 0.2,
  /**
   * Spray-root loading. On a planing surface the pressure is NOT uniform over the
   * wetted patch — it spikes at the spray root (the just-wetted forward boundary)
   * and falls off toward the trailing edge (Wagner / Savitsky planing theory; it is
   * the same physics as Nagahiro's xi* = 2.6 fitting parameter).
   *
   * Weighting each panel by 1/sqrt(eps + depth/depthMax), renormalised to preserve
   * total force, moves the centre of pressure forward toward the centre of mass.
   * Without it the whole load sits out at the trailing rim, the pitching torque is
   * 2-3x too large, the stone precesses ~30 deg per contact and no throw survives
   * more than two bounces. Smaller eps = sharper peak = shorter lever.
   */
  sprayRootEpsilon: 0.05,
  /**
   * THE ONE CALIBRATION KNOB. Scales the TILTING (transverse) component of the
   * hydrodynamic torque — the part that precesses the stone. The spin-axis component
   * is left alone, so spin decay stays physical.
   *
   * Why it exists: the attitude change per bounce is (linear impulse x lever) / L.
   * The linear impulse is pinned by kinematics and the panel integral puts the
   * centre of pressure ~0.2R behind the centre of mass, which planing theory agrees
   * with. Taken literally that predicts sustained skipping only above ~55 rev/s,
   * whereas the measured gyro-dominant transition is ~18 rot/s (Acta Mech. Sin. 37,
   * 2021) and ordinary throws at 10-30 rev/s plainly work.
   *
   * The gap lives in effects this quadrature does not resolve: the sub-atmospheric
   * ventilated cavity pulling down on the trailing edge, the spray-root pressure
   * singularity, and unsteady added-mass moments. Rather than bury a fudge inside
   * the force law, it is one honest, named factor. 0.35 puts the transition at the
   * measured ~18 rot/s. Set to 1.0 for the raw uncalibrated integral.
   */
  pitchMomentScale: 0.05,
  /** Spin (rev/s) at which the pitchMomentScale calibration is fully applied. Below
   *  this the stone progressively feels the raw hydrodynamic torque. */
  gyroCalibrationSpin: 12,
  airDragCoefficient: 1.1,    // bluff-body normal-to-face drag in air
  airFrictionCoefficient: 0.02,
  /**
   * BOW WAVE. The stone rides up on the wave it makes. Truscott (Splash Lab):
   * "it deforms the water and pushes a wave out in front of it, but the velocity of
   * the stone is much faster than the wave it creates, so it ends up rising up on
   * that wave — and this causes a little lift force."
   *
   * The model previously assumed an undisturbed flat surface (Nagahiro assumption 4),
   * so this lift did not exist. Consequence: vertical restitution came out ~0.84,
   * hop height decayed x0.70 per bounce, and runs died of ATTITUDE with most of their
   * energy intact — 9 skips on Steiner's record throw instead of 88, and 36% of the
   * distance record. Per-bounce energy loss was already correct (4.6% vs the 4.44%
   * that 88 real skips imply), so this was the missing piece, not dissipation.
   *
   * Modelled as a local rise of the effective surface that LAGS the stone's
   * penetration: it is still up while the stone is exiting, so it asymmetrically
   * helps the rebound, which is exactly the described mechanism. Driven by
   * penetration measured against the UNDISTURBED surface, so there is no feedback
   * loop between the wave and the lift it produces.
   */
  bowWaveGain: 0.6,          // crest height as a fraction of penetration depth
  bowWaveRiseTime: 0.006,    // s, time constant while building
  bowWaveFallTime: 0.045,    // s, time constant while collapsing
  bowWaveMaxRadii: 0.5,      // hard cap on crest height, in stone radii

  /** Aerodynamic Magnus in air. Small but non-zero; keeps long hops honest. */
  magnusCoefficient: 0.15,
  /**
   * Aerodynamic pitching-moment coefficient on the airborne stone:
   * tau = C_M q A R sin(alpha_air), about the axis perpendicular to velocity and the
   * face normal.
   *
   * This is why a stone ROLLS OVER ONTO ITS SIDE during a long hop. On a spinning
   * stone the pitching moment does not pitch it — it precesses it into bank. It is
   * the physical reason world-record holder Kurt Steiner aims his first touch close
   * to shore: "the longer it stays in the air the more it will roll over on its side
   * ... you can minimise that by lessening the time in the air, which is one reason
   * you want to hit close."
   *
   * Without this the model's free flight is exactly torque-free and a stone arrives
   * at its first contact with 0.0 deg of bank whether it flew half a metre or nine,
   * which erases a real and coachable skill lever.
   *
   * Kept at 0.05 since the sign correction. With the physical destabilising sign,
   * larger values drag the emergent optimum attack angle below the validated 20 deg
   * anchor (0.2 put the peak at 10 deg with 20 deg scoring 30% under best). At 0.05
   * the 5-20 deg plateau holds with 20 deg within 10% of best, an unspun plate still
   * tumbles like a falling card (125 deg over a 1.6 s fall), and roll-over still
   * grows monotonically with time in the air.
   */
  pitchMomentAirCoefficient: 0.05,
  /** Viscous spin decay in air, s^-1. */
  spinDecayAir: 0.02,
  /**
   * Aerodynamic damping of NUTATION specifically (the transverse/wobble component of
   * angular velocity), while airborne. Same mechanism as env.wobbleDampingCoefficient
   * in water - form drag on the rim as it wobbles through the fluid - just ~1000x
   * weaker because it scales with air density instead of water density.
   *
   * This did not exist before and its absence was a real defect, not a cosmetic gap:
   * with nutation UNDAMPED across free flight, a run's sensitivity to floating-point-
   * level differences compounds every bounce (the disc's exact attack angle at contact
   * depends on nutation phase, which drifts). Over 30+ bounces this became large enough
   * that Chrome and Node - running byte-identical code on the byte-identical throw -
   * diverged from 38 skips to 13. Damping nutation specifically (not spin, which should
   * persist) shrinks that divergence over a long run while barely touching the first
   * few bounces, which is also the physically correct place for it to matter least.
   *
   * Lowered 4.0 -> 2.0 (0.8.2): at 4.0 the damping over-stabilised low-attack
   * arrivals and the emergent optimum attack angle slid to ~10 deg, failing the
   * validated 20 deg anchor (headless-sweep section 3: 20 deg scored 12 against
   * 18 at 10 deg, ratio 0.67). A 4x3 matrix over this coefficient and
   * pitchMomentAirCoefficient put the anchor back at 0.86 with this value and
   * P left at its documented 0.05 calibration; halving the damping keeps most
   * of the divergence benefit it exists for. Re-measure BOTH the anchor and
   * the cross-engine divergence before touching either constant again.
   */
  wobbleDampingAirCoefficient: 2.0,
  wind: { x: 0, y: 0, z: 0 },
}

/**
 * Named tuning profiles. `documentary` is the validated physics; `game` trades
 * fidelity for the skip counts a champion throw is expected to produce.
 *
 *   new StoneSkipSim({ env: { ...DEFAULT_ENV, ...PHYSICS_PROFILES.game } })
 *   // or simply
 *   new StoneSkipSim({ profile: 'game' })
 */
export const PHYSICS_PROFILES = {
  /** Pure model. Matches every measurement in docs/PHYSICS-NOTES.md. ~13 clean hops. */
  documentary: {},
  /**
   * Measured on 0.8.2 (Steiner-preset ensemble, median of 9 jittered throws):
   * game ~27 skips over ~30 m, arcade ~40 skips over ~38 m. Earlier comments
   * here claimed ~61 m and ~115 m — those were true of an older dissipation
   * envelope and are NOT reachable on the current model by assist tuning
   * alone (bounceSpeedTax 0.02 -> 0 moves game distance only 30 -> 36 m while
   * inflating hops to ~39). If champion runs should read longer on screen,
   * that is a physics-envelope task (rebound/energy retention), not an assist
   * knob — flagged in docs/audit-2026-08-05.md.
   */
  /**
   * Restrained champion play.
   *
   * `balanceRetention` here is the value for an AVERAGE rock — the game layer
   * overwrites it per stone from the rock's hidden Balance stat, so a well-balanced
   * find reads above this and a warped one below. `documentary` leaves it at 0: the
   * stat is an admitted divergence from the literature (docs/04-physics.md's
   * "slightly above and beyond what's possible in real life"), so the honest profile
   * must not have it.
   */
  game: {
    hopSpeedFraction: 0.05,
    attitudeAssist: 20,
    attitudeAssistRefSpin: 40,
    bounceSpeedTax: 0.02,
    balanceRetention: 0.5,
  },
  /** Showpiece. */
  arcade: {
    hopSpeedFraction: 0.05,
    attitudeAssist: 32,
    attitudeAssistRefSpin: 40,
    bounceSpeedTax: 0,
    balanceRetention: 0.8,
  },
}

export const DEFAULT_SOLVER = {
  /** Panel quadrature resolution. 5x12 faces + 12 rim = 144 panels. */
  radialSamples: 5,
  angularSamples: 12,
  rimSamples: 12,
  /** Ceiling on the integration substep while any panel is wet. In practice
   *  maxTravelPerStepRadii usually binds first — see below. */
  contactSubstep: 1 / 4000,
  /**
   * Adaptive contact substep: limit how far the stone may travel in one step, as a
   * fraction of its radius. A FIXED time substep silently under-resolves fast
   * throws, because contact duration shrinks with speed while the step does not — at
   * 26 m/s and 1/4000 s the stone moves 6.5 mm per step through a contact only a few
   * mm deep, and neither clean-hop count nor distance converged under refinement.
   * Tying the step to distance travelled makes the resolution speed-independent.
   */
  maxTravelPerStepRadii: 1 / 40,
  /** Max integration substep in free flight. */
  flightSubstep: 1 / 480,
  /**
   * Fixed simulation tick used by advance(). Physics is NOT exactly dt-invariant, so
   * feeding it raw frame deltas makes the result depend on the player's frame rate:
   * the same throw scored 29-31 skips and 62-65 m across 30-240 Hz and stutter. For a
   * leaderboard that is fatal. advance() accumulates real time and runs whole ticks
   * of exactly this length, so the tick sequence is identical on every machine.
   */
  fixedTick: 1 / 240,
  /** Safety cap on substeps per step() call. Adaptive contact stepping can ask for
   *  ~20 kHz during a fast impact, so this has to be generous. */
  maxSubsteps: 4000,
  /** Speed below which a floating stone is declared stopped. */
  restSpeed: 0.35,
  /** In contact this long with no bounce peak at all = surfing, not skipping. */
  surfContactTime: 0.30,
  /** Airborne longer than this counts as a clean hop (the stone fully left the water,
   *  as opposed to chattering along attached to the surface). */
  minHopTime: 0.012,
  /**
   * THE VISIBLE-RIPPLE THRESHOLD. A bounce counts when the centre of mass's vertical
   * velocity reverses (downward to upward) while touching water AND the approach
   * speed exceeded this, in m/s.
   *
   * This is the knob that decides what a "skip" is, and it is deliberately aligned
   * with how records are actually judged. Guinness defines one skip as a forward
   * movement over the water "which sets off a visible series of concentric circles"
   * — a ripple test, not an airborne test — and a run explicitly includes the
   * terminal pitty-pats. So `skips` is the competition-comparable number, NOT
   * `cleanHops`.
   *
   * Raise it if your water sim's ripples only become visible above a bigger
   * disturbance; every bounce event carries `impulse` and `energyToWater` so you can
   * calibrate the two against each other.
   *
   * Counting full separations instead under-reports badly: once a run decays into
   * pitty-pat the stone never fully clears the water, yet those taps are bounces and
   * every record count (including Steiner's 88) includes them. Counting penetration
   * peaks instead over-reports: a spinning stone wobbles, so its rim dips
   * periodically without the stone bouncing at all. The vertical-velocity reversal
   * is the one definition that is neither.
   */
  minBounceSpeed: 0.05,
  /** Centre depth (in radii) past which the SCORING RUN is declared over. The stone
   *  keeps being simulated after this — see the settle* values below. */
  diveDepthRadii: 2.5,
  /**
   * Settling phase, after the scoring run ends. The stone still has momentum: it
   * coasts, skims and sinks. Without this the stone froze in place the instant it
   * stopped skipping, which looked like it died mid-flight.
   *
   * Kept short on purpose. This phase scores nothing, so every extra second is dead
   * time the player sits through; a 4 second sink after a 3 second run reads as the
   * stone refusing to die. Raise settleDepth/settleTimeout if you want a longer,
   * more cinematic sink.
   */
  settleDepth: 0.25,        // m below the surface before we stop simulating
  settleSpeed: 0.08,        // m/s under which the stone counts as at rest
  settleQuietTime: 0.4,     // s it must stay that slow (a floating stone never sinks)
  settleTimeout: 2.5,       // s hard cap on the coast/sink phase
  /** Substep while fully submerged and slow. No sharp impacts down there, so the
   *  4 kHz contact rate is wasted work. */
  sinkSubstep: 1 / 500,
}

/** Flat, still water at y = 0. Replace via `water` in the constructor. */
export const FLAT_WATER = () => ({
  height: 0,
  normal: { x: 0, y: 1, z: 0 },
  flow: { x: 0, y: 0, z: 0 },
})

/** Outcome enum, matching the five measured responses in Acta Mech. Sin. 37 (2021). */
export const Outcome = {
  IN_FLIGHT: 'in-flight',
  STABLE_SKIP: 'stable-skip',
  HYDROPLANING_SKIP: 'hydroplaning-skip',
  HYDROPLANING_TROUT: 'hydroplaning-trout',
  SKIPPING_TROUT: 'skipping-trout',
  DIVE: 'dive',
  TUMBLE: 'tumble',
  STOPPED: 'stopped',
  /** Solver blew up. Never expected; if you see it, the run is void. */
  NUMERICAL_FAILURE: 'numerical-failure',
}

/* ------------------------------------------------------------------ *
 * Panel set — precomputed body-space quadrature points
 * ------------------------------------------------------------------ */

/**
 * Build the quadrature. Two equal-area polar grids for the faces (offset +/- t/2
 * along body Y) plus a rim ring. Equal-area radial spacing r_j = R*sqrt((j+.5)/Nr)
 * means every sample carries identical weight, which keeps the centre-of-pressure
 * estimate unbiased — that matters, because the whole pitching torque is a
 * centre-of-pressure offset.
 */
/**
 * Hydrodynamic panels from a real mesh surface.
 *
 * The disc builder below lays panels out analytically; this one takes them from the
 * triangles the rock is actually made of, so a jagged rim really does catch, and a
 * lopsided outline really does throw its spray to one side.
 *
 * Two things have to survive decimation, because the solver's physics rests on them:
 *
 *   1. **Total area**, which sets the pressure force. Merged panels sum their areas.
 *   2. **Surface closure.** Buoyancy is not a special case in this solver — it falls
 *      out of integrating hydrostatic pressure over a closed surface, which recovers
 *      Archimedes exactly. A closed surface satisfies `sum(area * normal) = 0`, so
 *      merging is done with AREA-WEIGHTED normal sums, which preserves that identity
 *      to rounding. `meshPanelClosureError` reports it; the tests assert on it.
 *
 * Triangles are merged into buckets keyed by direction and position, so a coarse but
 * faithful surface survives at a bounded panel count — the solver's own quadrature is
 * only 144 panels, and this runs every substep of every contact.
 */
function buildMeshPanels(mesh, shape, solver) {
  const { positions, indices } = mesh
  const maxPanels = solver.meshPanelBudget ?? 192
  const c = shape.bboxCentre
  // Body Y is the face normal; a panel is "rim" when its normal lies near the face
  // plane, since those are the ones presented edge-on to the flow.
  const rimCos = solver.meshRimNormalCos ?? 0.5

  const tris = []
  for (let f = 0; f < indices.length; f += 3) {
    const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3
    const ax = positions[ia] - c.x, ay = positions[ia + 1] - c.y, az = positions[ia + 2] - c.z
    const bx = positions[ib] - c.x, by = positions[ib + 1] - c.y, bz = positions[ib + 2] - c.z
    const cx2 = positions[ic] - c.x, cy = positions[ic + 1] - c.y, cz = positions[ic + 2] - c.z
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx2 - ax, e2y = cy - ay, e2z = cz - az
    // Cross product magnitude is twice the triangle area; its direction is the normal.
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz)
    if (!(len > 1e-18)) continue
    const area = len / 2
    nx /= len; ny /= len; nz /= len
    tris.push({
      px: (ax + bx + cx2) / 3, py: (ay + by + cy) / 3, pz: (az + bz + cz) / 3,
      nx, ny, nz, area,
    })
  }
  if (!tris.length) return []

  // Winding may be inside-out; the mesh volume already told us which. Flip so every
  // normal points OUT, because the ventilation weighting keys off exactly that.
  if (shape.windingFlipped) {
    for (const t of tris) { t.nx = -t.nx; t.ny = -t.ny; t.nz = -t.nz }
  }

  // Pick the FINEST position grid that fits the panel budget, by starting fine and
  // coarsening until it fits — starting coarse and stopping at the first fit wastes
  // most of the budget (the disc came out at 64 panels against a budget of 192, and
  // its run distance sat 18% off the analytic disc it was meant to reproduce).
  // Normals are bucketed into facing classes too, so a face and the rim never merge.
  const ext = shape.extent
  for (let div = 20; div >= 1; div--) {
    const buckets = new Map()
    for (const t of tris) {
      const gx = ext.x > 0 ? Math.min(div - 1, Math.max(0, Math.floor(((t.px / ext.x) + 0.5) * div))) : 0
      const gy = ext.y > 0 ? Math.min(div - 1, Math.max(0, Math.floor(((t.py / ext.y) + 0.5) * div))) : 0
      const gz = ext.z > 0 ? Math.min(div - 1, Math.max(0, Math.floor(((t.pz / ext.z) + 0.5) * div))) : 0
      const isRim = Math.abs(t.ny) < rimCos
      // Rim panels additionally split by facing, so opposite sides of the rim (whose
      // normals would cancel) are never averaged into one useless panel.
      const dir = isRim
        ? 2 + (t.nx >= 0 ? 1 : 0) * 2 + (t.nz >= 0 ? 1 : 0)
        : (t.ny >= 0 ? 1 : 0)
      const key = ((gx * div + gy) * div + gz) * 8 + dir
      let b = buckets.get(key)
      if (!b) { b = { px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, area: 0, isRim }; buckets.set(key, b) }
      b.area += t.area
      b.px += t.px * t.area; b.py += t.py * t.area; b.pz += t.pz * t.area
      // AREA-WEIGHTED normal sum: this is what keeps sum(area*normal) == 0, i.e. what
      // keeps the decimated surface closed and buoyancy exact.
      b.nx += t.nx * t.area; b.ny += t.ny * t.area; b.nz += t.nz * t.area
    }
    if (buckets.size > maxPanels && div > 1) continue

    const panels = []
    for (const b of buckets.values()) {
      if (!(b.area > 1e-14)) continue
      const nl = Math.hypot(b.nx, b.ny, b.nz)
      if (!(nl > 1e-18)) continue
      // Scale area by how much the merged normals agreed. Panels whose normals
      // cancelled (a fold merged into one bucket) present less to the flow than their
      // raw area, and this is the term that preserves closure through the merge.
      panels.push({
        px: b.px / b.area, py: b.py / b.area, pz: b.pz / b.area,
        nx: b.nx / nl, ny: b.ny / nl, nz: b.nz / nl,
        area: nl,
        isRim: b.isRim,
      })
    }
    return panels
  }
  return []
}

/** Residual of `sum(area * normal)` over a panel set, normalised by total area.
 *  Zero for a closed surface; the mesh-panel tests assert it stays near zero. */
export function meshPanelClosureError(panels) {
  let sx = 0, sy = 0, sz = 0, a = 0
  for (const p of panels) {
    sx += p.nx * p.area; sy += p.ny * p.area; sz += p.nz * p.area; a += p.area
  }
  return a > 0 ? Math.hypot(sx, sy, sz) / a : 0
}

function buildPanels(stone, solver) {
  const { radius: R, thickness: h, aspect, edgeRoundness } = stone
  const { radialSamples: Nr, angularSamples: Na, rimSamples: Nrim } = solver
  const panels = []

  const faceArea = Math.PI * R * R * aspect
  const dAFace = faceArea / (Nr * Na)
  const halfT = h * 0.5

  for (const sign of [-1, 1]) {
    for (let j = 0; j < Nr; j++) {
      const r = R * Math.sqrt((j + 0.5) / Nr)
      for (let k = 0; k < Na; k++) {
        const th = (2 * Math.PI * (k + 0.5)) / Na
        panels.push({
          // body-space position of the sample
          px: r * Math.cos(th) * aspect,
          py: sign * halfT,
          pz: r * Math.sin(th),
          // outward normal in body space
          nx: 0, ny: sign, nz: 0,
          area: dAFace,
          isRim: false,
        })
      }
    }
  }

  // Rim band. A sharp rim gets its full projected area; a rounded rim presents less
  // and bites less, which is exactly the difference between a stone that
  // edge-catches and one that slides off.
  const rimScale = 1 - 0.6 * clamp(edgeRoundness, 0, 1)
  const rimArea = (2 * Math.PI * R * h * rimScale) / Nrim
  for (let k = 0; k < Nrim; k++) {
    const th = (2 * Math.PI * (k + 0.5)) / Nrim
    const c = Math.cos(th), s = Math.sin(th)
    // outward normal of an ellipse rim
    const n = V.normalize({ x: c / aspect, y: 0, z: s })
    panels.push({
      px: R * c * aspect,
      py: 0,
      pz: R * s,
      nx: n.x, ny: n.y, nz: n.z,
      area: rimArea,
      isRim: true,
    })
  }

  return panels
}

/**
 * Sane bounds for every throw input. A player aiming system reads sliders, gauges and
 * swing timers, and any of those can hand over a NaN after a divide-by-zero or an
 * unready UI element. Unchecked, a single NaN propagates into position and quaternion
 * within one substep and the run silently returns 0 skips and 0 m — no error, no clue.
 *
 * Non-finite input therefore throws immediately, naming the field. Out-of-range but
 * finite input is clamped, because that is a legitimate extreme rather than a bug.
 */
export const THROW_BOUNDS = {
  // World-class throwers release at roughly 25 m/s and 65 rev/s. The old ceilings of
  // 200 m/s / 500 rev/s were not just unreachable, they reached a regime where the
  // solver diverged on ~1% of throws and returned 1e46 m as a SCORE rather than
  // crashing. Bounds now sit above anything playable and below anything unstable.
  speed: [0, 60],
  elevationDeg: [-89, 89],
  headingDeg: [-3600, 3600],
  attackAngleDeg: [-90, 90],
  bankAngleDeg: [-180, 180],
  sideslipDeg: [-180, 180],
  spinRPS: [-200, 200],
  spinAxisTiltDeg: [-90, 90],
  spinAxisAzimuthDeg: [-3600, 3600],
  releaseHeight: [0, 100],
}

function validateThrow(p) {
  for (const [key, [lo, hi]] of Object.entries(THROW_BOUNDS)) {
    // null coerces to 0, which would silently accept an unset field as a real value
    const v = p[key] === null ? NaN : Number(p[key])
    if (!Number.isFinite(v)) {
      throw new TypeError(
        `throwStone: ${key} must be a finite number, got ${JSON.stringify(p[key])}. ` +
        `A NaN here silently produces a 0-skip, 0-metre run rather than an error.`)
    }
    p[key] = clamp(v, lo, hi)
  }
  const o = p.origin || (p.origin = { x: 0, z: 0 })
  for (const axis of ['x', 'z']) {
    const v = Number(o[axis])
    if (!Number.isFinite(v)) {
      throw new TypeError(`throwStone: origin.${axis} must be a finite number, got ${JSON.stringify(o[axis])}`)
    }
    o[axis] = v
  }
  return p
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

export class StoneSkipSim {
  /**
   * @param {object}   [opts]
   * @param {object}   [opts.stone]  see DEFAULT_STONE
   * @param {object}   [opts.env]    see DEFAULT_ENV
   * @param {object}   [opts.solver] see DEFAULT_SOLVER
   * @param {Function} [opts.water]  (x, z, t) => { height, normal, flow }
   *        Injected so your water sim can drive it. Defaults to a flat plane at y=0.
   */
  constructor(opts = {}) {
    this.stone = { ...DEFAULT_STONE, ...(opts.stone || {}) }
    this.stone.comOffset = { ...DEFAULT_STONE.comOffset, ...((opts.stone || {}).comOffset || {}) }
    const profile = PHYSICS_PROFILES[opts.profile || 'documentary']
    if (opts.profile && !profile) {
      throw new Error(`Unknown profile "${opts.profile}". Use one of: ` +
        Object.keys(PHYSICS_PROFILES).join(', '))
    }
    this.profile = opts.profile || 'documentary'
    this.env = { ...DEFAULT_ENV, ...profile, ...(opts.env || {}) }
    this.env.wind = { ...DEFAULT_ENV.wind, ...((opts.env || {}).wind || {}) }
    this.solver = { ...DEFAULT_SOLVER, ...(opts.solver || {}) }
    this.water = opts.water || FLAT_WATER

    this._recomputeBody()

    this.state = {
      position: V.make(),
      velocity: V.make(),
      orientation: Q.identity(),
      /** World-frame angular momentum. Integrating L rather than omega is what makes
       *  gyroscopic precession come out right without hand-written Euler equations. */
      angularMomentum: V.make(),
      angularVelocity: V.make(),
      time: 0,
    }

    /**
     * Total bounces, INCLUDING the surface-attached chatter at the end of a run.
     * WARNING: this is not a numerically converged quantity. Refining the contact
     * substep from 1/2000 to 1/60000 moves it between 10 and 87 for the same throw,
     * because the sizzle is a chaotic marginally-resolved regime. `cleanHops` and
     * `runDistance` DO converge (+/-1.5 m, +/-2 hops over that same range).
     * Score on those. See README 'Known limitations'.
     */
    this.skips = 0
    /**
     * Raw count of contacts that raised a visible ripple. `skips` is this minus one,
     * per the Guinness rule ("...minus either the first or the last of the circles"),
     * so the final plunk does not score.
     */
    this.ripples = 0
    /**
     * Subset of ripples where the stone fully left the water. NOT a competition
     * metric — no rulebook distinguishes airborne hops from pitty-pats. Exposed
     * because it is the numerically stable one; see README.
     */
    this.cleanHops = 0
    this.outcome = Outcome.IN_FLIGHT
    /** Scoring run over (stone stopped skipping). Physics continues — see settling. */
    this.runEnded = false
    /** Physics complete: the stone has sunk or come to rest. Stop calling step(). */
    this.finished = false
    this.settleReason = null
    this._runDistance = 0
    this._runTime = 0
    this._runEndTime = Infinity
    this._quietFor = 0
    this._lastQuietCheck = 0
    this._vyContactApproach = 0
    this._accumulator = 0
    this.alpha = 0
    this._bowWave = 0
    this._displacedVolume = 0
    /** Seconds of simulation discarded by advance() catch-up clamping. */
    this.droppedTime = 0
    this.lastError = null
    // ceiling for the divergence guard; tightened per-throw in throwStone()
    this._divergenceSpeedSq = 1e6
    /**
     * False once any time has been dropped. A run with `replayable === false` will
     * NOT reproduce under server-side re-simulation — do not submit it as a score.
     */
    this.replayable = true
    this.contacts = []       // { index, time, duration, speedIn, speedOut, attackDeg, ... }
    this._contact = null
    this._lastLiftoffTime = -Infinity
    this._airborne = true
    this._initialAttack = 0
    this._distanceTravelled = 0
    this._pendingHop = false
    this._resetBounceDetector()
  }

  _resetBounceDetector() {
    this._vyPrev = 0
    this._vyApproach = 0
    this._lastBounceTime = -Infinity
  }

  /**
   * Distance while the scoring run was live — the number to score on.
   *
   * A getter, not a frozen field: it used to be written only in finish(), so any run
   * cut off by a time limit (thrown steeply upward, say) reported 0 m no matter how
   * far it had actually gone. Now it tracks live and freezes when the run ends.
   */
  get runDistance() {
    return this.runEnded ? this._runDistance : this._distanceTravelled
  }
  /** Duration of the scoring run. Same freeze-on-end behaviour as runDistance. */
  get runTime() {
    return this.runEnded ? this._runTime : this.state.time
  }

  /** Minimum time between counted bounces, s. Rejects wobble chatter. */
  get _minBounceInterval() { return 0.006 }

  /**
   * A bounce = the centre of mass's vertical velocity reversing while wet.
   * `pen` is the deepest penetration of any panel this substep (<= 0 means dry).
   */
  _trackBounce(pen, events) {
    const vy = this.state.velocity.y
    // Deepest approach since the LAST COUNTED BOUNCE. Not reset on every upward
    // flicker: a spinning stone's wobble modulates vy fast enough to chop a single
    // descent into many sub-oscillations, and resetting on each one hides the bounce.
    if (vy < this._vyApproach) this._vyApproach = vy

    if (!this.runEnded && pen > 0 && this._vyPrev < 0 && vy >= 0 &&
        -this._vyApproach >= this.solver.minBounceSpeed &&
        this.state.time - this._lastBounceTime > this._minBounceInterval) {
      this.ripples++
      this.skips = Math.max(0, this.ripples - 1)
      this._lastBounceTime = this.state.time
      const d = this.getDiagnostics()
      events.push({
        type: 'bounce',
        count: this.skips,
        ripple: this.ripples,
        time: this.state.time,
        penetration: pen,
        approachSpeed: -this._vyApproach,
        /** Vertical momentum arriving at the surface, kg*m/s. Splash/ripple scale. */
        impulse: this.mass * -this._vyApproach,
        /** Kinetic energy handed to the water this bounce, J. */
        energyToWater: 0.5 * this.mass * this._vyApproach * this._vyApproach,
        speed: d.speed,
        attackAngleDeg: d.attackAngleDeg,
        position: V.clone(this.state.position),
        /** false once the run has decayed into surface-attached chatter */
        clean: this._airborne || this.state.time - this._lastLiftoffTime < 0.05,
      })
      this._vyApproach = 0
    }
    this._vyPrev = vy
  }

  /** Recompute mass, inertia and the panel set. Call after mutating `stone`. */
  _recomputeBody() {
    const s = this.stone
    if (s.mesh && s.mesh.positions && s.mesh.indices && s.mesh.indices.length >= 3) {
      this._recomputeFromMesh(s)
    } else {
      this._recomputeFromDisc(s)
    }
    /** This stone's Balance, 0..1. Used when `env.balanceRetention === 'auto'`. */
    this.stoneBalance = balanceFromStone(s, this.meshShape)

    // scratch for the two-pass panel integration (allocated once, reused per substep)
    const n = this.panels.length
    this._scratch = {
      wx: new Float64Array(n), wy: new Float64Array(n), wz: new Float64Array(n),
      nx: new Float64Array(n), ny: new Float64Array(n), nz: new Float64Array(n),
      depth: new Float64Array(n), weight: new Float64Array(n),
      wet: new Uint8Array(n),
    }
  }

  /**
   * Real geometry: mass, centre of mass and inertia measured off the mesh.
   *
   * The mesh is taken in the orientation it is given, with body Y the face normal the
   * player spins about — deliberately NOT re-aligned to the rock's principal axes.
   * For a well-formed stone those coincide; for a warped one they do not, and that
   * mismatch is exactly why a warped stone wobbles. Re-aligning would quietly delete
   * the effect by making the spin axis principal by construction. Callers holding a
   * scan in arbitrary orientation should run it through `alignMeshToFaceAxis()` first,
   * which is a deliberate act rather than a silent one.
   */
  _recomputeFromMesh(s) {
    const mp = meshMassProperties(s.mesh.positions, s.mesh.indices, s.density)
    if (mp.degenerate) {
      // Not a closed solid — fall back rather than divide by zero downstream.
      this._recomputeFromDisc(s)
      return
    }
    const shape = meshShapeDescriptors(s.mesh.positions, s.mesh.indices, s.density)
    this.meshShape = shape

    this.volume = mp.volume
    // An explicit mass still wins, as it does for a disc; the mesh then supplies only
    // the DISTRIBUTION. Inertia scales linearly with mass, so rescaling is exact.
    const scale = s.mass != null && mp.mass > 0 ? s.mass / mp.mass : 1
    this.mass = s.mass != null ? s.mass : mp.mass
    this.effectiveDensity = this.mass / this.volume
    this.inertiaBody = {
      xx: mp.inertia.xx * scale, yy: mp.inertia.yy * scale, zz: mp.inertia.zz * scale,
      xy: mp.inertia.xy * scale, xz: mp.inertia.xz * scale, yz: mp.inertia.yz * scale,
    }

    // Panels are built in a frame centred on the bounding box, matching the disc case
    // (panels straddle the origin, and `comBody` carries the offset to the real CoM).
    const c = shape.bboxCentre
    this.comBody = { x: mp.com.x - c.x, y: mp.com.y - c.y, z: mp.com.z - c.z }

    // Scalar size, for the terms that still need one (added mass, bow wave, air drag).
    // span is sorted descending; body Y is the face normal, so its extent is thickness.
    const ext = shape.extent
    this.effRadius = Math.max(ext.x, ext.z) / 2
    this.effThickness = ext.y
    this.effAspect = ext.x > 0 && ext.z > 0 ? Math.min(ext.x, ext.z) / Math.max(ext.x, ext.z) : 1
    // Real projected area of the face, not pi*R^2 of a circle it is not.
    this.faceArea = shape.faceArea > 0
      ? shape.faceArea
      : Math.PI * this.effRadius * this.effRadius * this.effAspect

    this.panels = buildMeshPanels(s.mesh, shape, this.solver)
  }

  /** The idealised elliptic disc — unchanged, and still the default. */
  _recomputeFromDisc(s) {
    this.meshShape = null
    const R = s.radius, h = s.thickness
    const volume = Math.PI * R * R * s.aspect * h
    this.volume = volume
    this.mass = s.mass != null ? s.mass : s.density * volume
    this.effectiveDensity = this.mass / volume

    // Solid elliptic cylinder about its centroid. a = R (body X), b = R*? — we treat
    // the ellipse semi-axes as (R*aspect, R) in body (x, z).
    const a = R * s.aspect, b = R
    const m = this.mass
    // Inertia about the CENTRE OF MASS, as a full symmetric tensor
    // I_ij = integral( |r|^2 delta_ij - r_i r_j ) dm.
    //
    // The elliptic-cylinder formulae are about the GEOMETRIC centre, but rotation is
    // integrated about the centre of mass. When `comOffset` moves those apart the
    // tensor has to move with it — the parallel-axis theorem:
    //
    //     I_cm = I_geo - m ( |d|^2 delta_ij - d_i d_j )
    //
    // Without it an off-centre stone kept the spin inertia of a perfectly balanced
    // one, so `comOffset` was inert: sweeping it 0 -> 0.2R left skips pinned at 12.
    // (Flagged in PHYSICS-NOTES section 12 as the missing correction.) The dominant
    // consequence is on `yy`: a stone whose mass sits off-axis has LESS inertia about
    // its own spin axis, so the same spin buys less angular momentum, so the same
    // hydrodynamic torque precesses it faster — an unbalanced stone wanders sooner.
    const dx = s.comOffset.x * R, dy = 0, dz = s.comOffset.z * R
    const d2 = dx * dx + dy * dy + dz * dz
    this.inertiaBody = {
      xx: m * (3 * b * b + h * h) / 12 - m * (d2 - dx * dx),
      yy: m * (a * a + b * b) / 4 - m * (d2 - dy * dy),
      zz: m * (3 * a * a + h * h) / 12 - m * (d2 - dz * dz),
      // Products of inertia. Non-zero only when the offset has BOTH in-plane
      // components, which is when the body's principal axes stop lining up with the
      // body frame at all.
      xy: m * dx * dy,
      xz: m * dx * dz,
      yz: m * dy * dz,
    }
    this.panels = buildPanels(s, this.solver)
    this.faceArea = Math.PI * R * R * s.aspect
    this.comBody = { x: s.comOffset.x * R, y: 0, z: s.comOffset.z * R }
    this.effRadius = R
    this.effThickness = h
    this.effAspect = s.aspect
  }

  /**
   * Set up a throw. Every real-world parameter is here.
   *
   * @param {object} t
   * @param {number} [t.speed=12]              m/s, release speed
   * @param {number} [t.elevationDeg=-10]      flight-path angle. NEGATIVE = aimed
   *        downward at the water (the normal case). This is the incidence angle beta.
   * @param {number} [t.headingDeg=0]          compass heading of the throw, about world Y
   * @param {number} [t.attackAngleDeg=20]     stone face pitch above the WATER PLANE.
   *        The "magic angle" is 20 deg. NOT the same as elevation — this is the single
   *        most commonly conflated pair in stone-skipping code.
   * @param {number} [t.bankAngleDeg=0]        roll about the flight direction. Non-zero
   *        means one rim corner enters first: this is how you get edge catches and
   *        violent off-axis deflections.
   * @param {number} [t.sideslipDeg=0]         stone yawed relative to its flight path
   * @param {number} [t.spinRPS=15]            rev/s about the face normal. Positive =
   *        counter-clockwise seen from above the stone's top face.
   * @param {number} [t.spinAxisTiltDeg=0]     spin axis tilted off the face normal.
   *        This seeds nutation/wobble; a couple of degrees is realistic for a hand throw.
   * @param {number} [t.spinAxisAzimuthDeg=0]  direction of that tilt
   * @param {number} [t.releaseHeight=0.35]    m above the water surface
   * @param {object} [t.origin]                {x, z} release point. y comes from
   *        releaseHeight above the local water height.
   */
  throwStone(t = {}) {
    const p = {
      speed: 12,
      elevationDeg: -10,
      headingDeg: 0,
      attackAngleDeg: 20,
      bankAngleDeg: 0,
      sideslipDeg: 0,
      spinRPS: 15,
      spinAxisTiltDeg: 0,
      spinAxisAzimuthDeg: 0,
      releaseHeight: 0.35,
      origin: { x: 0, z: 0 },
      ...t,
    }
    validateThrow(p)
    this.throwParams = p
    // Divergence ceiling: far above anything a real throw reaches, far below blow-up.
    this._divergenceSpeedSq = Math.pow(p.speed * 4 + 50, 2)

    const heading = p.headingDeg * DEG
    const elev = p.elevationDeg * DEG

    // Flight direction
    const dir = {
      x: Math.cos(elev) * Math.cos(heading),
      y: Math.sin(elev),
      z: Math.cos(elev) * Math.sin(heading),
    }

    const w0 = this._water(p.origin.x, p.origin.z, 0)
    const pos = V.make(p.origin.x, w0.height + p.releaseHeight, p.origin.z)

    // Orientation: start with the face normal pointing straight up, then
    //   1. yaw to the heading (+ sideslip)
    //   2. pitch the face up by the attack angle, about the horizontal axis
    //      perpendicular to the heading
    //   3. bank about the flight direction
    const yaw = Q.fromAxisAngle({ x: 0, y: 1, z: 0 }, -(heading + p.sideslipDeg * DEG))
    // after yaw, the stone's body +X points along the heading; pitching nose-up is a
    // rotation about the body Z axis mapped to world
    const pitchAxis = { x: -Math.sin(heading), y: 0, z: Math.cos(heading) }
    const pitch = Q.fromAxisAngle(pitchAxis, p.attackAngleDeg * DEG)
    const bank = Q.fromAxisAngle(dir, p.bankAngleDeg * DEG)
    const q = Q.normalize(Q.mul(bank, Q.mul(pitch, yaw)))

    // Spin about the face normal, optionally tilted to seed wobble
    const faceNormal = Q.rotate(q, { x: 0, y: 1, z: 0 })
    const inPlaneA = Q.rotate(q, { x: 1, y: 0, z: 0 })
    const inPlaneB = Q.rotate(q, { x: 0, y: 0, z: 1 })
    const tilt = p.spinAxisTiltDeg * DEG
    const az = p.spinAxisAzimuthDeg * DEG
    const spinAxis = V.normalize({
      x: faceNormal.x * Math.cos(tilt) + (inPlaneA.x * Math.cos(az) + inPlaneB.x * Math.sin(az)) * Math.sin(tilt),
      y: faceNormal.y * Math.cos(tilt) + (inPlaneA.y * Math.cos(az) + inPlaneB.y * Math.sin(az)) * Math.sin(tilt),
      z: faceNormal.z * Math.cos(tilt) + (inPlaneA.z * Math.cos(az) + inPlaneB.z * Math.sin(az)) * Math.sin(tilt),
    })
    const omega = V.scale(spinAxis, p.spinRPS * 2 * Math.PI)

    this.state.position = pos
    this.state.velocity = V.scale(dir, p.speed)
    this.state.orientation = q
    this.state.angularVelocity = omega
    this.state.angularMomentum = this._inertiaTimesOmega(q, omega)
    this.state.time = 0

    /**
     * Total bounces, INCLUDING the surface-attached chatter at the end of a run.
     * WARNING: this is not a numerically converged quantity. Refining the contact
     * substep from 1/2000 to 1/60000 moves it between 10 and 87 for the same throw,
     * because the sizzle is a chaotic marginally-resolved regime. `cleanHops` and
     * `runDistance` DO converge (+/-1.5 m, +/-2 hops over that same range).
     * Score on those. See README 'Known limitations'.
     */
    this.skips = 0
    /**
     * Raw count of contacts that raised a visible ripple. `skips` is this minus one,
     * per the Guinness rule ("...minus either the first or the last of the circles"),
     * so the final plunk does not score.
     */
    this.ripples = 0
    /**
     * Subset of ripples where the stone fully left the water. NOT a competition
     * metric — no rulebook distinguishes airborne hops from pitty-pats. Exposed
     * because it is the numerically stable one; see README.
     */
    this.cleanHops = 0
    this.outcome = Outcome.IN_FLIGHT
    /** Scoring run over (stone stopped skipping). Physics continues — see settling. */
    this.runEnded = false
    /** Physics complete: the stone has sunk or come to rest. Stop calling step(). */
    this.finished = false
    this.settleReason = null
    this._runDistance = 0
    this._runTime = 0
    this._runEndTime = Infinity
    this._quietFor = 0
    this._lastQuietCheck = 0
    this._vyContactApproach = 0
    this._accumulator = 0
    this.alpha = 0
    this._bowWave = 0
    this._displacedVolume = 0
    /** Seconds of simulation discarded by advance() catch-up clamping. */
    this.droppedTime = 0
    this.lastError = null
    // ceiling for the divergence guard; tightened per-throw in throwStone()
    this._divergenceSpeedSq = 1e6
    /**
     * False once any time has been dropped. A run with `replayable === false` will
     * NOT reproduce under server-side re-simulation — do not submit it as a score.
     */
    this.replayable = true
    this.contacts.length = 0
    this._contact = null
    this._lastLiftoffTime = -Infinity
    this._airborne = true
    this._pendingHop = false
    this._resetBounceDetector()
    this._launchPos = V.clone(pos)
    this._distanceTravelled = 0
    this._initialAttack = this.getDiagnostics().attackAngleDeg
    this._maxTiltSeen = 0

    return this
  }

  /**
   * How much game assist this stone has earned, 0..1.
   *
   * Based on the LAUNCH spin, not the instantaneous spin: a tumbling stone picks up
   * plenty of rotation about its own face normal during a contact, so gating on the
   * live value let a zero-spin throw earn assist and skip twice, which is exactly the
   * behaviour the gate exists to prevent.
   *
   * Then multiplied by gyroscopic coherence - spin versus wobble - so a stone that
   * has genuinely lost the plot stops being rescued.
   */
  _assistAuthority(faceNormalWorld) {
    if (!this.throwParams) return 0
    const launch = Math.abs(this.throwParams.spinRPS ?? 0)
    if (launch <= 0) return 0
    const base = clamp(launch / this.env.attitudeAssistRefSpin, 0, 1)
    const w = this.state.angularVelocity
    const spin = Math.abs(V.dot(w, faceNormalWorld))
    const wobble = V.length(V.sub(w, V.scale(faceNormalWorld, V.dot(w, faceNormalWorld))))
    const coherence = spin / (spin + wobble + 1e-6)
    return base * coherence
  }

  /**
   * Water sampling with a guard. The callback is supplied by the host, and a water
   * sim that is still loading legitimately returns undefined — which used to throw
   * from deep inside the panel loop and kill the frame. Missing normal/flow default
   * sensibly; a non-finite height falls back to the last good value.
   */
  _water(x, z, t) {
    const w = this.water(x, z, t)
    if (!w || !Number.isFinite(w.height)) {
      if (!this._warnedWater) {
        this._warnedWater = true
        this.lastWaterError = 'water callback returned no usable height; using y=0'
      }
      return { height: this._lastGoodHeight || 0, normal: UP, flow: ZERO }
    }
    this._lastGoodHeight = w.height
    const n = w.normal
    return {
      height: w.height,
      normal: (n && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z) &&
        (n.x || n.y || n.z)) ? n : UP,
      flow: (w.flow && Number.isFinite(w.flow.x)) ? w.flow : ZERO,
    }
  }

  /** I_world * omega, with I_world = R I_body R^T. */
  /**
   * BALANCE — re-aim angular momentum a fixed fraction toward the launch trim, once,
   * at the moment of contact. See `env.balanceRetention`.
   *
   * Geometry is deliberately identical to the attitude hold's: target `L` rather than
   * the instantaneous face normal (so the nutation cone, i.e. the visible wobble, is
   * preserved exactly), and target the hemisphere `L` already occupies (so a
   * clockwise stone is not asked to flip its spin axis 180 degrees — the handedness
   * defect fixed in the v0.8.0 audit). Orientation, omega and L are rotated by the
   * SAME quaternion, which makes this a rigid re-aim: |L| is unchanged, no energy is
   * injected, and the stone still decays and still dies.
   */
  _applyBalance() {
    const env = this.env
    // `'auto'` derives the stat from the stone's own geometry (see balanceFromStone),
    // which is how the game supplies it: the rock IS the stat. A number overrides it,
    // which is what the profiles and the demo sliders use.
    const stat = env.balanceRetention === 'auto' ? this.stoneBalance : env.balanceRetention
    if (!(stat > 0) || this.runEnded || !this.throwParams) return
    const st = this.state
    const hMag = Math.hypot(st.velocity.x, st.velocity.z)
    // Below this there is no meaningful heading to trim against, and the stone is
    // settling rather than skipping.
    if (hMag <= 0.5) return

    const faceNormalWorld = Q.rotate(st.orientation, { x: 0, y: 1, z: 0 })
    const authority = this._assistAuthority(faceNormalWorld)
    // Hard viability gate FIRST. No balance is a rock stat good enough to rescue a
    // stone with no gyroscopic authority: an unspun stone must still tumble and score
    // zero, or the skill curve the assists exist to protect is gone. Caught by the
    // suite's "no-spin still fails" check — a plain (1 - influence*(1-authority))
    // factor floors at 0.8 and handed an unspun stone most of its rock's balance.
    // The knee sits below the weakest real throw (12 rev/s -> authority ~0.27), so
    // this only ever zeroes stones that were never going to skip anyway.
    const gate = clamp(authority / BALANCE_AUTHORITY_KNEE, 0, 1)
    if (gate <= 0) return
    // Then, within the viable band: mostly the stone, a little the throw.
    const throwFactor = gate * (1 - env.balanceThrowInfluence * (1 - authority))
    const blend = clamp(stat, 0, 1) * BALANCE_MAX_BLEND * throwFactor
    if (blend <= 0) return

    const hHat = { x: st.velocity.x / hMag, y: 0, z: st.velocity.z / hMag }
    const trim = (this.throwParams.attackAngleDeg ?? 20) * DEG
    const nDes = V.normalize({
      x: -hHat.x * Math.sin(trim),
      y: Math.cos(trim),
      z: -hHat.z * Math.sin(trim),
    })
    const Lmag = V.length(st.angularMomentum)
    if (Lmag <= 1e-9) return
    const Ldir = V.scale(st.angularMomentum, 1 / Lmag)
    const tgt = V.dot(Ldir, nDes) >= 0 ? nDes : V.scale(nDes, -1)
    const axis = V.cross(Ldir, tgt)
    const sinA = V.length(axis)
    if (sinA <= 1e-6) return
    const angle = Math.atan2(sinA, clamp(V.dot(Ldir, tgt), -1, 1))
    const corr = Q.fromAxisAngle(V.scale(axis, 1 / sinA), angle * blend)
    st.orientation = Q.normalize(Q.mul(corr, st.orientation))
    st.angularVelocity = Q.rotate(corr, st.angularVelocity)
    st.angularMomentum = Q.rotate(corr, st.angularMomentum)
  }

  _inertiaTimesOmega(q, omega) {
    const ob = Q.rotateInverse(q, omega)
    const I = this.inertiaBody
    return Q.rotate(q, {
      x: I.xx * ob.x + I.xy * ob.y + I.xz * ob.z,
      y: I.xy * ob.x + I.yy * ob.y + I.yz * ob.z,
      z: I.xz * ob.x + I.yz * ob.y + I.zz * ob.z,
    })
  }

  /** I_world^-1 * L, with an optional added-inertia inflation while immersed. */
  _omegaFromMomentum(q, L, immersedFrac) {
    const Lb = Q.rotateInverse(q, L)
    const I = this.inertiaBody
    const add = this.env.addedInertiaCoefficient * this.env.waterDensity *
      Math.pow(this.effRadius, 5) * immersedFrac
    // Added inertia loads the TRANSVERSE axes only — along the spin axis it is
    // negligible, as before. With a full tensor that is a diagonal inflation.
    const ob = solveSymmetric3(
      { ...I, xx: I.xx + add, zz: I.zz + add },
      Lb,
    )
    return Q.rotate(q, ob)
  }

  /**
   * Advance the simulation by dt seconds. Internally substeps: fine while wet,
   * coarse in flight. Returns the events produced during this call.
   *
   * @param {number} dt seconds
   * @returns {Array<object>} events: {type: 'impact'|'liftoff'|'skip'|'outcome', ...}
   */
  step(dt) {
    const events = []
    if (this.finished || !(dt > 0)) return events

    let remaining = dt
    let guard = 0
    while (remaining > 1e-9 && guard++ < this.solver.maxSubsteps && !this.finished) {
      const wet = !this._airborne
      let base = wet ? this.solver.contactSubstep : this.solver.flightSubstep
      if (wet) {
        // resolve the contact by distance travelled, not by wall-clock
        const sp = V.length(this.state.velocity)
        if (sp > 1e-3) {
          base = Math.min(base, this.solver.maxTravelPerStepRadii * this.effRadius / sp)
        }
      }
      // once the stone is fully under and slow there are no sharp impacts left, so
      // the fine contact rate is wasted on the sink
      const sinking = this.runEnded && this._fullySubmerged &&
        V.lengthSq(this.state.velocity) < 4
      const h = Math.min(remaining, sinking ? this.solver.sinkSubstep : base)
      this._substep(h, events)
      remaining -= h
    }
    return events
  }

  _substep(dt, events) {
    const st = this.state
    const env = this.env
    const q = st.orientation

    // --- world position of the centre of mass (the body origin is the geometric
    //     centre; the CoM may be offset, which is a real wobble source) ---
    const comWorld = V.add(st.position, Q.rotate(q, this.comBody))

    // --- gather water state under the stone once per substep ---
    const w = this._water(comWorld.x, comWorld.z, st.time)
    const surfaceNormal = w.normal ? V.normalize(w.normal) : { x: 0, y: 1, z: 0 }
    const flow = w.flow || { x: 0, y: 0, z: 0 }
    // Effective surface the stone rides on = still water + its own bow wave.
    const surfaceY = w.height + this._bowWave

    // --- panel integration ---
    const R = this.effRadius
    const cavityDepth = env.cavityCloseDepthRadii * R
    const centreDepth = surfaceY - comWorld.y

    let Fx = 0, Fy = 0, Fz = 0
    let Tx = 0, Ty = 0, Tz = 0
    let wetArea = 0, wetCount = 0

    const faceNormalWorld = Q.rotate(q, { x: 0, y: 1, z: 0 })
    const omega = st.angularVelocity
    // How much game assist this stone has earned (0 in documentary; gated on launch
    // spin and gyroscopic coherence so an unspun stone gets nothing).
    const assistAuthority = this._assistAuthority(faceNormalWorld)
    const halfRhoCd = 0.5 * env.waterDensity * env.pressureCoefficient
    const halfRhoCp = 0.5 * env.waterDensity * env.planingCoefficient
    const halfRhoCf = 0.5 * env.waterDensity * env.frictionCoefficient * this.stone.roughness

    // ---- pass 1: geometry. Find which panels are wet, how deep, and build the
    //      spray-root pressure weighting (normalised so it redistributes load
    //      without changing the total). ----
    const sc = this._scratch
    let depthMax = 0
    // Depth of the HIGHEST point of the stone: the minimum depth over all panels,
    // negative while any part of the stone is still above the surface. This is the
    // right measure for "has the water closed over it", which depthMax is not.
    let depthTop = Infinity
    for (let i = 0; i < this.panels.length; i++) {
      const pn = this.panels[i]
      const rw = Q.rotate(q, { x: pn.px, y: pn.py, z: pn.pz })
      const wy = st.position.y + rw.y
      const depth = surfaceY - wy
      if (depth < depthTop) depthTop = depth
      sc.wet[i] = depth > 0 ? 1 : 0
      if (!sc.wet[i]) continue
      sc.wx[i] = st.position.x + rw.x
      sc.wy[i] = wy
      sc.wz[i] = st.position.z + rw.z
      sc.depth[i] = depth
      const nw = Q.rotate(q, { x: pn.nx, y: pn.ny, z: pn.nz })
      sc.nx[i] = nw.x; sc.ny[i] = nw.y; sc.nz[i] = nw.z
      if (depth > depthMax) depthMax = depth
      wetCount++
      wetArea += pn.area
    }

    if (wetCount > 0) {
      const eps = env.sprayRootEpsilon
      const invDMax = depthMax > 1e-9 ? 1 / depthMax : 0
      let sumWA = 0
      for (let i = 0; i < this.panels.length; i++) {
        if (!sc.wet[i]) continue
        const pn = this.panels[i]
        // rim panels are edge-on to the flow; the spray-root argument does not apply
        const w = pn.isRim ? 1 : 1 / Math.sqrt(eps + sc.depth[i] * invDMax)
        sc.weight[i] = w
        sumWA += w * pn.area
      }
      const norm = sumWA > 1e-12 ? wetArea / sumWA : 1
      for (let i = 0; i < this.panels.length; i++) {
        if (sc.wet[i]) sc.weight[i] *= norm
      }
    }

    // ---- cavity state: how much pressure an air-facing panel actually feels ----
    // The cavity closes either because the stone is deep, or because it is too slow
    // to outrun the water collapsing into the void behind it. Whichever closes it
    // first wins.
    let ventAirFacing = 1
    if (wetCount > 0) {
      const byDepth = clamp(centreDepth / cavityDepth, 0, 1) ** 2
      const vRel = Math.hypot(
        st.velocity.x - flow.x, st.velocity.y - flow.y, st.velocity.z - flow.z)
      const collapse = Math.sqrt(2 * env.gravity * Math.max(0, depthTop))
      const outrun = collapse > 1e-6
        ? clamp(vRel / (env.cavityCloseSpeedFactor * collapse), 0, 1)
        : 1
      ventAirFacing = clamp(Math.max(byDepth, 1 - outrun), 0, 1)
    }

    // ---- pass 2: forces and torques ----
    for (let i = 0; i < this.panels.length; i++) {
      if (!sc.wet[i]) continue
      const pn = this.panels[i]
      const wx = sc.wx[i], wy = sc.wy[i], wz = sc.wz[i]
      const depth = sc.depth[i]
      const nw = { x: sc.nx[i], y: sc.ny[i], z: sc.nz[i] }

      // Ventilation: an air-facing panel gets no pressure while the cavity is open.
      // `ventAirFacing` was computed once for this substep from BOTH the depth and
      // the speed criteria — see above.
      const facing = V.dot(nw, surfaceNormal)     // >0 = pointing up out of the water
      const vent = facing > 0 ? ventAirFacing : 1
      if (vent <= 0) continue

      // relative velocity of this bit of stone surface w.r.t. the water
      const lever = { x: wx - comWorld.x, y: wy - comWorld.y, z: wz - comWorld.z }
      const rot = V.cross(omega, lever)
      const ux = st.velocity.x + rot.x - flow.x
      const uy = st.velocity.y + rot.y - flow.y
      const uz = st.velocity.z + rot.z - flow.z

      const un = ux * nw.x + uy * nw.y + uz * nw.z

      // tangential slip, needed both for the planing term and for skin friction
      const utx = ux - un * nw.x
      const uty = uy - un * nw.y
      const utz = uz - un * nw.z
      const utMag = Math.hypot(utx, uty, utz)

      // dynamic pressure: only compressive (panel advancing into the fluid),
      // shaped by the spray-root weighting from pass 1. Newtonian impact term plus
      // the planing/circulatory cross term — see env.planingCoefficient.
      const pDyn = un > 0
        ? (halfRhoCd * un * un + halfRhoCp * utMag * un) * sc.weight[i]
        : 0
      // hydrostatic: summed over the closed wetted surface this is exactly buoyancy
      const pStat = env.waterDensity * env.gravity * depth

      const pTotal = (pDyn + pStat) * vent * pn.area
      // pressure pushes along -n
      let fx = -pTotal * nw.x
      let fy = -pTotal * nw.y
      let fz = -pTotal * nw.z

      // tangential skin friction
      if (utMag > 1e-6) {
        const ft = halfRhoCf * utMag * pn.area * vent
        fx -= ft * utx
        fy -= ft * uty
        fz -= ft * utz
      }

      Fx += fx; Fy += fy; Fz += fz
      Tx += lever.y * fz - lever.z * fy
      Ty += lever.z * fx - lever.x * fz
      Tz += lever.x * fy - lever.y * fx

    }

    const immersedFrac = this.panels.length ? wetCount / this.panels.length : 0
    this._fullySubmerged = wetCount > 0 && depthTop > 0

    // --- bow wave update. Target is set by penetration below the UNDISTURBED
    //     surface (depthMax already includes the current crest, so subtract it),
    //     which keeps the wave from feeding on the lift it creates. ---
    {
      const penUndisturbed = Math.max(0, depthMax - this._bowWave)
      const target = Math.min(
        env.bowWaveGain * penUndisturbed,
        env.bowWaveMaxRadii * this.effRadius)
      const tau = target > this._bowWave ? env.bowWaveRiseTime : env.bowWaveFallTime
      this._bowWave += (target - this._bowWave) * Math.min(1, dt / Math.max(1e-6, tau))
      if (this._bowWave < 1e-6) this._bowWave = 0
      this._displacedVolume = penUndisturbed * this.faceArea
    }
    const wasAirborne = this._airborne
    const nowWet = wetCount > 0
    this._airborne = !nowWet

    // --- calibrate the tilting part of the hydrodynamic torque (see
    //     env.pitchMomentScale). Split about the face normal so the spin-axis
    //     component, i.e. real spin decay, passes through untouched. ---
    if (wetCount > 0 && env.pitchMomentScale !== 1) {
      const nAxis = faceNormalWorld
      const along = Tx * nAxis.x + Ty * nAxis.y + Tz * nAxis.z
      // The calibration compensates effects of GYRO-STABILISED planing (ventilated
      // cavity suction, spray root, unsteady added-mass moments). None of them apply
      // to a slow-spinning stone, so the reduction fades in with spin: an unspun
      // stone feels the raw integral, pitches nose-up through contact and dives
      // within a few touches - the Sci Rep 2022 non-spinning observations.
      const spinNow = Math.abs(V.dot(st.angularVelocity, nAxis)) / (2 * Math.PI)
      const gcal = clamp(spinNow / env.gyroCalibrationSpin, 0, 1)
      const k = 1 - (1 - env.pitchMomentScale) * gcal
      Tx = along * nAxis.x + (Tx - along * nAxis.x) * k
      Ty = along * nAxis.y + (Ty - along * nAxis.y) * k
      Tz = along * nAxis.z + (Tz - along * nAxis.z) * k
    }

    // --- rotational damping of a submerged disc. Applied AFTER pitchMomentScale so
    //     the calibration cannot weaken it: without this the stone keeps spinning
    //     and wobbling at 30 rad/s indefinitely once it drowns, which reads as the
    //     stone snapping and glitching in the water instead of settling. ---
    if (immersedFrac > 0) {
      const nAxis = faceNormalWorld
      const w = st.angularVelocity
      const spinRate = V.dot(w, nAxis)
      const wtx = w.x - spinRate * nAxis.x
      const wty = w.y - spinRate * nAxis.y
      const wtz = w.z - spinRate * nAxis.z
      const wtMag = Math.hypot(wtx, wty, wtz)
      const R5 = Math.pow(R, 5) * env.waterDensity * immersedFrac

      // wobble (transverse): form drag, strong
      if (wtMag > 1e-6) {
        const kw = env.wobbleDampingCoefficient * R5 * wtMag
        Tx -= kw * wtx
        Ty -= kw * wty
        Tz -= kw * wtz
      }
      // spin (about the face normal): shear driven, weak
      const ks = env.spinDampingCoefficient * R5 * Math.abs(spinRate) * spinRate
      Tx -= ks * nAxis.x
      Ty -= ks * nAxis.y
      Tz -= ks * nAxis.z
    }

    // --- air forces (always on; negligible when wet, but cheap and correct) ---
    {
      const relAir = {
        x: st.velocity.x - env.wind.x,
        y: st.velocity.y - env.wind.y,
        z: st.velocity.z - env.wind.z,
      }
      const sp = V.length(relAir)
      if (sp > 1e-4) {
        const nHat = faceNormalWorld
        const vn = V.dot(relAir, nHat)
        // projected area: face area seen edge-on shrinks to the rim strip
        const projArea = this.faceArea * Math.abs(vn) / sp +
          2 * this.effRadius * this.effThickness * Math.sqrt(Math.max(0, 1 - (vn / sp) ** 2))
        const drag = 0.5 * env.airDensity * env.airDragCoefficient * projArea * sp
        Fx -= drag * relAir.x
        Fy -= drag * relAir.y
        Fz -= drag * relAir.z

        // Magnus: F ~ Cm * rho * R^3 * (omega x v)
        const m = V.cross(omega, relAir)
        const km = env.magnusCoefficient * env.airDensity * Math.pow(this.effRadius, 3)
        Fx += km * m.x
        Fy += km * m.y
        Fz += km * m.z
      }
      // Aerodynamic pitching moment -> precesses into roll over a long hop.
      if (env.pitchMomentAirCoefficient !== 0 && sp > 0.5) {
        const vHat = { x: relAir.x / sp, y: relAir.y / sp, z: relAir.z / sp }
        const nHat = faceNormalWorld
        // axis perpendicular to both; magnitude of the cross product is |sin(angle)|
        const axis = V.cross(nHat, vHat)
        const axLen = V.length(axis)
        if (axLen > 1e-6) {
          const q = 0.5 * env.airDensity * sp * sp
          // Scale with sin(angle of attack) = -(n . vHat), NOT with |n x vHat|.
          // |n x vHat| is cos(alpha): it PEAKS at zero attack angle, which is exactly
          // backwards and dragged the model's optimum from 20 deg down to 0 deg.
          const sinAlpha = -V.dot(nHat, vHat)
          // NEGATIVE: thin-plate theory puts the centre of pressure ahead of the
          // centre (quarter-chord), so the moment at positive attack is pitch-UP,
          // destabilising. This is why an unspun plate tumbles like a falling card,
          // and why the Sci Rep 2022 disks show attack angle GROWING through a
          // non-spinning skip. The previous +sign weathervaned the stone toward zero
          // attack instead, nosing unspun throws into the water before first contact.
          const mag = -env.pitchMomentAirCoefficient * q * this.faceArea *
            this.effRadius * sinAlpha
          Tx += (axis.x / axLen) * mag
          Ty += (axis.y / axLen) * mag
          Tz += (axis.z / axLen) * mag
        }
      }

      // Nutation damping in air: quadratic form drag on the TRANSVERSE component only,
      // same functional form as the water-phase wobbleDampingCoefficient term, scaled
      // by air density instead of water density. Spin about the face normal is left to
      // spinDecayAir below, which is deliberately much gentler - spin should persist.
      if (env.wobbleDampingAirCoefficient > 0) {
        const spinRate = V.dot(omega, faceNormalWorld)
        const wtx = omega.x - spinRate * faceNormalWorld.x
        const wty = omega.y - spinRate * faceNormalWorld.y
        const wtz = omega.z - spinRate * faceNormalWorld.z
        const wtMag = Math.hypot(wtx, wty, wtz)
        if (wtMag > 1e-6) {
          const kw = env.wobbleDampingAirCoefficient * Math.pow(this.effRadius, 5) *
            env.airDensity * wtMag
          Tx -= kw * wtx
          Ty -= kw * wty
          Tz -= kw * wtz
        }
      }

      // spin bleed in air
      Tx -= env.spinDecayAir * st.angularMomentum.x
      Ty -= env.spinDecayAir * st.angularMomentum.y
      Tz -= env.spinDecayAir * st.angularMomentum.z
    }

    // --- gravity ---
    Fy -= this.mass * env.gravity

    // --- integrate linear motion with direction-dependent added mass ---
    const mAdd = env.addedMassCoefficient * env.waterDensity * Math.pow(R, 3) * immersedFrac
    const mNormal = this.mass + mAdd
    const nHat = faceNormalWorld
    const Fn = Fx * nHat.x + Fy * nHat.y + Fz * nHat.z
    const ax = (Fx - Fn * nHat.x) / this.mass + (Fn / mNormal) * nHat.x
    const ay = (Fy - Fn * nHat.y) / this.mass + (Fn / mNormal) * nHat.y
    const az = (Fz - Fn * nHat.z) / this.mass + (Fn / mNormal) * nHat.z

    st.velocity.x += ax * dt
    st.velocity.y += ay * dt
    st.velocity.z += az * dt

    const dx = st.velocity.x * dt, dy = st.velocity.y * dt, dz = st.velocity.z * dt
    st.position.x += dx
    st.position.y += dy
    st.position.z += dz
    this._distanceTravelled += Math.hypot(dx, dz)

    // --- integrate angular motion via world-frame angular momentum ---
    st.angularMomentum.x += Tx * dt
    st.angularMomentum.y += Ty * dt
    st.angularMomentum.z += Tz * dt
    st.angularVelocity = this._omegaFromMomentum(st.orientation, st.angularMomentum, immersedFrac)
    st.orientation = Q.integrate(st.orientation, st.angularVelocity, dt)
    // keep L consistent with the (possibly added-inertia-inflated) omega
    if (immersedFrac === 0) {
      st.angularMomentum = this._inertiaTimesOmega(st.orientation, st.angularVelocity)
    }

    // --- GAME ASSIST: nudge attitude back toward the launch trim while wet. ---
    // A restoring TORQUE would not work here: on a gyroscope torque precesses the
    // spin axis 90 degrees away instead of restoring it. So this corrects the
    // orientation directly and rebuilds angular momentum to match.
    // Not while settling: the assists exist to keep a LIVE run going. Left on
    // afterwards the attitude hold keeps the stone trimmed for planing and it skims
    // for 6-7 seconds of dead time after a 2 second run, which reads as the stone
    // refusing to die.
    if (env.attitudeAssist > 0 && immersedFrac > 0 && this.throwParams && !this.runEnded) {
      const authority = assistAuthority
      const hMag = Math.hypot(st.velocity.x, st.velocity.z)
      if (authority > 0 && hMag > 0.5) {
        const hHat = { x: st.velocity.x / hMag, y: 0, z: st.velocity.z / hMag }
        const trim = (this.throwParams.attackAngleDeg ?? 20) * DEG
        // face normal that gives `trim` degrees nose-up and zero bank
        const nDes = V.normalize({
          x: -hHat.x * Math.sin(trim),
          y: Math.cos(trim),
          z: -hHat.z * Math.sin(trim),
        })
        // Aim the ANGULAR MOMENTUM at the trim, not the instantaneous face normal.
        //
        // Nutation is the symmetry axis coning around L; the death spiral is L itself
        // drifting. Targeting the face normal conflates them — it fights the cone on
        // every substep and flattens the visible wobble to nothing, which is what
        // made the game profile look dead next to documentary. Targeting L corrects
        // only the secular drift, and because the whole state is then rotated
        // rigidly, the cone angle is preserved exactly and the wobble survives.
        const Lmag = V.length(st.angularMomentum)
        if (Lmag > 1e-9) {
          const Ldir = V.scale(st.angularMomentum, 1 / Lmag)
          // A clockwise (negative-spin) stone carries L along -n. Steering that L
          // toward +nDes tries to flip the spin axis 180 degrees - it mangled every
          // left-handed throw (6 skips vs 13, drift curve gone) and broke the exact
          // mirror symmetry between +spin and -spin. Target the hemisphere L is in.
          const tgt = V.dot(Ldir, nDes) >= 0 ? nDes : V.scale(nDes, -1)
          const axis = V.cross(Ldir, tgt)
          const sinA = V.length(axis)
          if (sinA > 1e-6) {
            const angle = Math.atan2(sinA, clamp(V.dot(Ldir, tgt), -1, 1))
            const frac = clamp(env.attitudeAssist * authority * immersedFrac * dt, 0, 0.5)
            const corr = Q.fromAxisAngle(V.scale(axis, 1 / sinA), angle * frac)
            // rotate orientation, omega and L by the SAME rotation: rigid re-aim
            st.orientation = Q.normalize(Q.mul(corr, st.orientation))
            st.angularVelocity = Q.rotate(corr, st.angularVelocity)
            st.angularMomentum = Q.rotate(corr, st.angularMomentum)
          }
        }
      }
    }

    // --- divergence guard. Cheap, and the alternative is a nonsense score: an
    //     unstable run used to report 1e46 m instead of failing. ---
    const p = st.position, v = st.velocity
    if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
          Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) ||
        Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5 || Math.abs(p.z) > 1e5 ||
        V.lengthSq(v) > this._divergenceSpeedSq) {
      this.outcome = Outcome.NUMERICAL_FAILURE
      this.runEnded = true
      this.finished = true
      this.replayable = false
      this.lastError = 'solver diverged; run is void'
      events.push({ type: 'outcome', outcome: this.outcome, skips: this.skips,
        ripples: this.ripples, cleanHops: this.cleanHops, time: st.time,
        distance: this._distanceTravelled, contacts: this.contacts.length })
      return
    }

    st.time += dt

    // --- bounce counting, from the penetration peak rather than full separation ---
    this._trackBounce(depthMax, events)

    // --- contact bookkeeping & events ---
    if (nowWet && wasAirborne) {
      // BALANCE. Fires here, before the diagnostics snapshot below, so `attackDegIn`
      // records the attitude the contact is actually resolved with rather than the
      // pre-correction one. See `env.balanceRetention` for why this is a one-shot at
      // contact start instead of a stronger `attitudeAssist` rate.
      this._applyBalance()
      const d = this.getDiagnostics()
      this._contact = {
        index: this.contacts.length,
        startTime: st.time,
        speedIn: d.speed,
        attackDegIn: d.attackAngleDeg,
        incidenceDegIn: d.incidenceAngleDeg,
        bankDegIn: d.bankAngleDeg,
        sideslipDegIn: d.sideslipAngleDeg,
        spinRPSIn: d.spinRPS,
        maxDepth: 0,
        position: V.clone(st.position),
      }
      this._vyContactApproach = 0
      events.push({ type: 'impact', ...this._contact })
    }
    if (this._contact) {
      // deepest point of the stone below the surface, not the centre — during a
      // shallow planing contact the centre stays above water the whole time
      this._contact.maxDepth = Math.max(this._contact.maxDepth, depthMax)
      if (st.velocity.y < this._vyContactApproach) this._vyContactApproach = st.velocity.y
    }
    if (!nowWet && !wasAirborne && this._contact) {
      const d = this.getDiagnostics()
      const c = this._contact
      c.duration = st.time - c.startTime

      // GAME ASSIST: hold vertical restitution up to the target, so hop height decays
      // slowly enough to give a long run. Gated on spin authority, and never raises
      // vy above the speed it came in with, so the stone still loses altitude.
      const eTarget = env.verticalRestitution
      const hopFrac = env.hopSpeedFraction
      if ((eTarget > 0 || hopFrac > 0) && !this.runEnded) {
        const auth = this._assistAuthority(Q.rotate(st.orientation, { x: 0, y: 1, z: 0 }))
        if (auth > 0) {
          const sp = V.length(st.velocity)
          const byRatio = eTarget > 0 ? -this._vyContactApproach * eTarget : 0
          const bySpeed = hopFrac > 0 ? sp * hopFrac : 0
          const want = Math.min(Math.max(byRatio, bySpeed) * auth, sp * 0.9)
          if (st.velocity.y < want && sp > 1e-6) {
            // ENERGY-NEUTRAL: buy the extra hop height out of forward speed rather
            // than adding it. Total speed can then never increase, so the stone
            // still decays and the run still ends.
            //
            // Adding it outright is what the first two attempts did, and both ran
            // away: at hopSpeedFraction 0.01 the stone sustained micro-hops for
            // 334 m over 45 s because tiny hops cost almost no forward speed while
            // the assist kept topping vy back up every bounce.
            const hMagOld = Math.hypot(st.velocity.x, st.velocity.z)
            const hMagNew = Math.sqrt(Math.max(0, sp * sp - want * want))
            const k = hMagOld > 1e-6 ? hMagNew / hMagOld : 0
            st.velocity.x *= k
            st.velocity.z *= k
            st.velocity.y = want
          }
        }
      }

      if (env.bounceSpeedTax > 0) {
        const k = 1 - clamp(env.bounceSpeedTax, 0, 0.9)
        st.velocity.x *= k; st.velocity.y *= k; st.velocity.z *= k
      }

      c.speedOut = V.length(st.velocity)
      c.energyLoss = 1 - (c.speedOut * c.speedOut) / Math.max(1e-9, c.speedIn * c.speedIn)
      c.attackDegOut = d.attackAngleDeg
      c.endTime = st.time
      if (!this.runEnded) this.contacts.push(c)
      this._contact = null
      this._lastLiftoffTime = st.time
      this._pendingHop = true
      // A contact the stone flew away from is a bounce by definition. If the
      // velocity-reversal detector missed it (a very gentle touch can reverse vy by
      // less than minBounceSpeed), record it here so cleanHops can never exceed
      // skips.
      // A contact the stone flew away from counts as a bounce even if the velocity
      // reversal was too gentle for the detector. Guarded by the same debounce
      // interval and a minimum bite, otherwise surface chatter near the end of a run
      // fires this every few milliseconds and inflates the score with contacts that
      // were never really bounces.
      if (!this.runEnded && this._lastBounceTime < c.startTime &&
          st.time - this._lastBounceTime > this._minBounceInterval &&
          c.maxDepth > 0.01 * this.effRadius) {
        this.ripples++
        this.skips = Math.max(0, this.ripples - 1)
        this._lastBounceTime = st.time
        this._vyApproach = 0
        events.push({
          type: 'bounce',
          count: this.skips,
          ripple: this.ripples,
          time: st.time,
          penetration: c.maxDepth,
          approachSpeed: -this._vyContactApproach,
          impulse: this.mass * -this._vyContactApproach,
          energyToWater: 0.5 * this.mass * this._vyContactApproach * this._vyContactApproach,
          speed: d.speed,
          attackAngleDeg: d.attackAngleDeg,
          position: V.clone(st.position),
          clean: true,
        })
      }
      events.push({ type: 'liftoff', ...c })
    }

    this._classify(events)
  }

  /** Regime / termination detection. */
  _classify(events) {
    const st = this.state
    const R = this.effRadius
    const d = this.getDiagnostics()

    // A clean hop is a liftoff followed by real airtime. Counted one at a time and
    // cancelled if the stone re-touches first, so surface chatter is not promoted
    // into a string of hops.
    if (this._pendingHop && !this.runEnded) {
      if (!this._airborne) {
        this._pendingHop = false
      } else if (st.time - this._lastLiftoffTime >= this.solver.minHopTime) {
        this._pendingHop = false
        // Only count it if that contact also registered as a bounce. Micro-grazes
        // clear the water without ever qualifying as a tap, and counting them here
        // let cleanHops run to 1214 against a tap count of 42.
        const last = this.contacts[this.contacts.length - 1]
        if (!last || this._lastBounceTime < last.startTime) return
        this.cleanHops++
        events.push({
          type: 'hop',
          count: this.cleanHops,
          time: last.endTime,
          duration: last.duration,
          speedIn: last.speedIn,
          speedOut: last.speedOut,
          energyLoss: last.energyLoss,
          position: last.position,
        })
      }
    }

    // Once the scoring run is over the stone keeps being simulated — it still has
    // momentum, so it coasts, skims, waterlogs and sinks. Ending the physics here
    // would freeze it dead in the air the instant it stopped skipping.
    if (this.runEnded) return this._checkSettled(events)

    const finish = (outcome) => {
      this.outcome = outcome
      this.runEnded = true
      this._runEndTime = st.time
      /** Distance at the moment the scoring run ended, EXCLUDING the coast/sink.
       *  Use this for scoring; `distance` keeps counting while the stone coasts. */
      this._runDistance = this._distanceTravelled
      this._runTime = st.time
      events.push({
        type: 'outcome',
        outcome,
        skips: this.skips,
        ripples: this.ripples,
        cleanHops: this.cleanHops,
        time: st.time,
        distance: this._distanceTravelled,
        contacts: this.contacts.length,
      })
    }

    // tumbled: the face normal has fallen far from where it started AND the stone
    // has lost most of its gyroscopic authority about the face axis
    const tilt = Math.abs(d.faceTiltDeg)
    this._maxTiltSeen = Math.max(this._maxTiltSeen, tilt)
    if (tilt > 75 && Math.abs(d.rossby) < 1.5) return finish(Outcome.TUMBLE)

    // sunk
    const w = this._water(st.position.x, st.position.z, st.time)
    if (w.height - st.position.y > this.solver.diveDepthRadii * R) {
      return finish(this.skips === 0 ? Outcome.DIVE : Outcome.SKIPPING_TROUT)
    }

    // Stuck to the surface: in continuous contact AND not bouncing. Terminating on
    // contact duration alone would kill every run the moment it entered pitty-pat,
    // which is precisely the phase that racks up the big skip counts.
    if (this._contact) {
      const stuckFor = st.time - Math.max(this._contact.startTime, this._lastBounceTime)
      if (stuckFor > this.solver.surfContactTime) {
        if (d.speed < this.solver.restSpeed) return finish(Outcome.STOPPED)
        // "Trout" means surface-attached. A stone already a full radius under is not
        // hydroplaning, it is on its way down — otherwise a clean knife-in gets
        // mislabelled whenever it stalls just short of the dive depth threshold.
        if (w.height - st.position.y > R) {
          return finish(this.skips === 0 ? Outcome.DIVE : Outcome.SKIPPING_TROUT)
        }
        return finish(this.skips === 0 ? Outcome.HYDROPLANING_TROUT : Outcome.SKIPPING_TROUT)
      }
    }

    // run out of energy
    if (d.speed < this.solver.restSpeed && !this._airborne) {
      if (this.skips === 0) return finish(Outcome.DIVE)
      return finish(Outcome.STOPPED)
    }
  }

  /**
   * Settling phase. The scoring run is over but the stone is still a physical object:
   * it coasts on whatever momentum it has left, skims, waterlogs and sinks. Physics
   * stops only once it is genuinely done — deep under, or floating at rest.
   */
  _checkSettled(events) {
    const st = this.state
    const s = this.solver
    const speed = V.length(st.velocity)
    const w = this._water(st.position.x, st.position.z, st.time)
    const depth = w.height - st.position.y

    let done = false
    let reason = null

    if (depth > s.settleDepth) {
      done = true; reason = 'sunk'
    } else if (speed < s.settleSpeed && Math.abs(st.velocity.y) < s.settleSpeed) {
      // floating or grounded and quiescent — needs to hold for a moment so a stone
      // pausing at the top of a hop is not mistaken for having come to rest
      this._quietFor = (this._quietFor || 0) + (st.time - (this._lastQuietCheck ?? st.time))
      if (this._quietFor > s.settleQuietTime) { done = true; reason = 'at-rest' }
    } else {
      this._quietFor = 0
    }
    this._lastQuietCheck = st.time

    if (st.time - this._runEndTime > s.settleTimeout) { done = true; reason = 'timeout' }

    if (done) {
      this.finished = true
      this.settleReason = reason
      events.push({
        type: 'settled',
        reason,
        time: st.time,
        depth,
        distance: this._distanceTravelled,
        coastTime: st.time - this._runEndTime,
        outcome: this.outcome,
        skips: this.skips,
      })
    }
  }

  /**
   * Live readouts. Cheap enough to call every frame for a HUD, and this is where the
   * gameplay-relevant quantities live.
   */
  getDiagnostics() {
    const st = this.state
    const q = st.orientation
    const speed = V.length(st.velocity)
    const vHat = speed > 1e-6 ? V.scale(st.velocity, 1 / speed) : { x: 1, y: 0, z: 0 }

    const n = Q.rotate(q, { x: 0, y: 1, z: 0 })   // face normal
    const fwd = Q.rotate(q, { x: 1, y: 0, z: 0 }) // body forward, IN the face plane

    // Attitude must be measured against the face normal, never against a body axis
    // lying in the face plane — those spin at `spinRPS` and would make the attack
    // angle oscillate at 30 Hz instead of reading the actual pitch.
    const hMag = Math.hypot(st.velocity.x, st.velocity.z)
    const hHat = hMag > 1e-6
      ? { x: st.velocity.x / hMag, y: 0, z: st.velocity.z / hMag }
      : { x: 1, y: 0, z: 0 }
    // right-hand side vector of the flight path, in the horizontal plane
    const sHat = { x: -hHat.z, y: 0, z: hHat.x }

    // attack: how far the face normal leans BACKWARD along the ground track.
    // Positive = nose-up = the planing configuration.
    const attack = Math.asin(clamp(-V.dot(n, hHat), -1, 1))
    // bank/roll: face normal leaning sideways out of the flight plane
    const bank = Math.asin(clamp(V.dot(n, sHat), -1, 1))
    // incidence: flight path angle relative to the water plane (negative = descending)
    const incidence = Math.asin(clamp(vHat.y, -1, 1))
    // how far the face normal has fallen from vertical, unsigned
    const faceTilt = Math.acos(clamp(n.y, -1, 1))
    // effective aerodynamic angle of attack: face plane vs. the actual velocity.
    // This is (attack + |incidence|) for a descending stone — it is what the water
    // sees, and what governs whether this contact bounces or knifes in.
    const effectiveAttack = Math.asin(clamp(-V.dot(n, vHat), -1, 1))
    // sideslip: only meaningful for a non-circular stone; a disk has no preferred
    // in-plane heading.
    const sideslip = Math.atan2(fwd.z, fwd.x) - Math.atan2(vHat.z, vHat.x)

    const spinAboutFace = V.dot(st.angularVelocity, n)
    const wobble = V.length(V.sub(st.angularVelocity, V.scale(n, spinAboutFace)))

    // contact time estimate tau ~ sqrt(m R / F_lift), Rossby = omega * tau / alpha
    const alpha = Math.max(2 * DEG, Math.abs(attack))
    const tau = 0.03  // JFM 2005: contact time saturates near 30 ms
    const rossby = (spinAboutFace * tau) / alpha

    const w = this._water(st.position.x, st.position.z, st.time)

    return {
      speed,
      velocity: V.clone(st.velocity),
      position: V.clone(st.position),
      heightAboveWater: st.position.y - w.height,
      attackAngleDeg: attack / DEG,
      effectiveAttackDeg: effectiveAttack / DEG,
      incidenceAngleDeg: incidence / DEG,
      faceTiltDeg: faceTilt / DEG,
      bankAngleDeg: bank / DEG,
      sideslipAngleDeg: ((sideslip / DEG) % 360 + 540) % 360 - 180,
      spinRPS: spinAboutFace / (2 * Math.PI),
      wobbleRadPerSec: wobble,
      /** Ro >> 1: attitude frozen through contact -> skips. Ro ~ 1: surfs. Ro -> 0: tumbles. */
      rossby,
      airborne: this._airborne,
      skips: this.skips,
      outcome: this.outcome,
      distance: this._distanceTravelled,
      time: st.time,
      /** Froude number of the current speed. */
      froude: (speed * speed) / (this.env.gravity * this.effRadius),
    }
  }

  /**
   * Closed-form sanity estimates from Bocquet, AJP 71, 150 (2003). Useful for tuning
   * and for a pre-throw "will this work?" readout; the solver does not use them.
   */
  getAnalyticEstimates(attackAngleDeg = 20) {
    const { gravity: g, waterDensity: rho, pressureCoefficient: C } = this.env
    const a = 2 * this.effRadius
    const M = this.mass
    const theta = attackAngleDeg * DEG

    // minimum speed for the stone not to fully submerge during the collision
    const vCritical = Math.sqrt((16 * M * g) / (Math.PI * C * rho * a * a))
    // dissipation length
    const ell = 2 * Math.PI * Math.sqrt((2 * M * Math.sin(theta)) / (C * rho * a))
    const v0 = V.length(this.state.velocity) || (this.throwParams ? this.throwParams.speed : 12)
    const mu = Math.sin(theta) * C + Math.cos(theta) * this.env.frictionCoefficient
    const nVelocityLimited = (v0 * v0) / (2 * g * Math.max(1e-6, mu) * ell)
    // gyroscopic stability floor and spin-limited bounce count
    const spinFloor = Math.sqrt(g / this.effRadius) / (2 * Math.PI)  // rev/s
    const spinRPS = this.throwParams ? this.throwParams.spinRPS : 15
    const phiDot = spinRPS * 2 * Math.PI
    const nSpinLimited = (this.effRadius * phiDot * phiDot) / g

    return {
      criticalSpeed: vCritical,
      dissipationLength: ell,
      maxBouncesVelocityLimited: nVelocityLimited,
      maxBouncesSpinLimited: nSpinLimited,
      maxBounces: Math.min(nVelocityLimited, nSpinLimited),
      minimumSpinRPS: spinFloor,
      /** JFM 2005: measured floor, alpha=20 deg, omega=65 rot/s. */
      empiricalMinimumSpeed: 2.6,
      /** Nagahiro & Hayakawa: no rebound above this, at any spin. */
      maximumAttackAngleDeg: 45,
    }
  }

  /**
   * Frame-rate-independent driver. Call this with the real frame delta instead of
   * step() in anything score-bearing: it accumulates time and only ever advances the
   * physics in whole `solver.fixedTick` increments, so a 30 Hz machine, a 240 Hz
   * machine and a stuttering one all produce bit-identical runs.
   *
   * `sim.alpha` is left holding the leftover fraction of a tick (0..1) for render
   * interpolation, if you want to smooth the mesh between ticks.
   *
   * @param {number} realDt seconds since the last frame
   * @returns {Array<object>} events produced this frame
   */
  advance(realDt) {
    const tick = this.solver.fixedTick
    if (!(realDt > 0)) return []
    // Clamp the catch-up burst: a backgrounded tab can hand back tens of seconds and
    // the alternative is a multi-second hitch. But dropped time makes this run diverge
    // from a server re-simulation of the same throw, so it is recorded rather than
    // swallowed — a leaderboard must not treat such a run as authoritative, or an
    // alt-tab reads as cheating.
    const budget = tick * 600
    const wanted = (this._accumulator || 0) + realDt
    if (wanted > budget) {
      this.droppedTime += wanted - budget
      this.replayable = false
    }
    this._accumulator = Math.min(wanted, budget)
    const events = []
    while (this._accumulator >= tick && !this.finished) {
      events.push(...this.step(tick))
      this._accumulator -= tick
    }
    this.alpha = this._accumulator / tick
    return events
  }

  /**
   * Cheap order-sensitive checksum of the run state. Two runs that agree here almost
   * certainly followed the same trajectory — enough to spot a client replaying with
   * different physics, a different tick, or a tampered score.
   *
   * NOT a security boundary on its own: validate a submitted score by re-simulating
   * the throw parameters server-side and comparing this.
   */
  checksum() {
    const st = this.state
    const vals = [
      st.position.x, st.position.y, st.position.z,
      st.velocity.x, st.velocity.y, st.velocity.z,
      st.orientation.x, st.orientation.y, st.orientation.z, st.orientation.w,
      st.time, this.ripples, this.cleanHops, this._distanceTravelled,
    ]
    let h = 0x811c9dc5
    for (const v of vals) {
      // quantise before hashing so the last bits of float noise do not flip the hash
      const q = Math.round(v * 1e6)
      h ^= q & 0xffffffff
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  /**
   * Current water disturbance, for a water sim to render. The stone model owns this
   * and does not read anything back, so the two never fight: stone physics stays
   * authoritative and the surface is free to look however you like.
   *
   * @returns {{x, z, crestHeight, displacedVolume, radius, contact, speed, impulse}}
   *   crestHeight     m, height of the bow-wave crest the stone is riding
   *   displacedVolume m^3, water currently pushed aside
   *   radius          m, rough footprint to spread the disturbance over
   *   contact         true while the stone is touching water
   */
  getDisturbance() {
    const st = this.state
    const sp = V.length(st.velocity)
    return {
      x: st.position.x,
      z: st.position.z,
      crestHeight: this._bowWave,
      displacedVolume: this._displacedVolume,
      radius: this.effRadius * (1 + 2 * this._bowWave / this.effRadius),
      contact: !this._airborne,
      speed: sp,
      impulse: this.mass * Math.max(0, -this._vyContactApproach),
    }
  }

  /** Run to completion headlessly. Returns a summary. */
  simulate({ maxTime = 30, dt = 1 / 240, collectPath = false, pathEvery = 1 / 120 } = {}) {
    const events = []
    const path = []
    let nextSample = 0
    while (!this.finished && this.state.time < maxTime) {
      events.push(...this.step(dt))
      if (collectPath && this.state.time >= nextSample) {
        path.push({
          t: this.state.time,
          p: V.clone(this.state.position),
          q: Q.clone(this.state.orientation),
        })
        nextSample = this.state.time + pathEvery
      }
    }
    if (!this.finished) {
      this.outcome = this.outcome === Outcome.IN_FLIGHT ? Outcome.STOPPED : this.outcome
    }
    return {
      outcome: this.outcome,
      skips: this.skips,
      ripples: this.ripples,
      cleanHops: this.cleanHops,
      /** Distance while still skipping — the scoring number. */
      runDistance: this.runDistance,
      runTime: this.runTime,
      /** Total including the coast and sink after the run ended. */
      distance: this._distanceTravelled,
      settleReason: this.settleReason,
      time: this.state.time,
      contacts: this.contacts,
      events,
      path,
      /** Lateral drift from the throw plane — the Magnus/gyro curve of section 6. */
      lateralDrift: this._lateralDrift(),
    }
  }

  _lateralDrift() {
    if (!this.throwParams) return 0
    const h = this.throwParams.headingDeg * DEG
    const dx = this.state.position.x - this._launchPos.x
    const dz = this.state.position.z - this._launchPos.z
    // component perpendicular to the intended heading
    return dx * -Math.sin(h) + dz * Math.cos(h)
  }
}

/** Convenience: build, throw, and run in one call. */
export function simulateThrow(throwParams = {}, opts = {}) {
  const sim = new StoneSkipSim(opts)
  sim.throwStone(throwParams)
  return { sim, result: sim.simulate(opts.run || {}) }
}

/* ------------------------------------------------------------------ *
 * Throw presets — calibrated to the literature, useful as game difficulty
 * tiers and as regression fixtures.
 * ------------------------------------------------------------------ */

/**
 * Human-readable descriptions for the presets, for a UI dropdown.
 *
 * Preset names describe the THROW, never the outcome. `perfect` and `recordAttempt`
 * were the old names and both misled: the second holds the input parameters of the
 * 88-skip record, and the model produces 12 from them, so the name promised a result
 * it cannot deliver. See README "Known limitations" for why.
 */
export const PRESET_LABELS = {
  casual:        'casual — 11 m/s, 12 rev/s',
  decent:        'decent — 14 m/s, 28 rev/s',
  strong:        'strong — 18 m/s, 45 rev/s',
  steinerThrow:  "Steiner's throw — 19.2 m/s, 47 rev/s (in reality: 88 skips)",
  truscottLimit: 'Truscott limit — 41.6 m/s, 48 rev/s (projected: 300–350)',
  knifeIn:       'knife-in — 55° attack, plunges',
  noSpin:        'no spin — tumbles',
  noseDown:      'nose-down — digs in',
  bellyFlop:     'belly flop — 1° attack',
  edgeCatch:     'edge catch — 35° bank',
  wobbler:       'wobbler — 18° spin-axis tilt',
  tooSlow:       'too slow — 2 m/s, below the rebound floor',
}

export const THROW_PRESETS = {
  /**
   * The textbook throw: magic angle, hard spin, shallow descent, low release.
   * Was 14 m/s / 28 rev/s, which scored 4 skips and did not deserve the name — the
   * model rewards spin steeply and 28 rev/s is a club-level throw, not a great one.
   */
  strong: {
    speed: 18, elevationDeg: -3, attackAngleDeg: 20, spinRPS: 45,
    bankAngleDeg: 0, sideslipDeg: 0, spinAxisTiltDeg: 0, releaseHeight: 0.18,
  },
  /** An ordinary decent throw. This is what the old `perfect` actually was. */
  decent: {
    speed: 14, elevationDeg: -4, attackAngleDeg: 20, spinRPS: 28,
    bankAngleDeg: 0, sideslipDeg: 0, spinAxisTiltDeg: 0, releaseHeight: 0.25,
  },
  /**
   * Kurt Steiner's actual 88-skip world-record throw, as measured by Utah State's
   * Splash Lab: 43 mph = 19.2 m/s. His maximum arm speed is 50 mph = 22.4 m/s, so
   * nothing above that is humanly reachable. Spin held under Truscott's stated
   * ceiling of 2800-3000 rpm (47-50 rev/s).
   *
   * The old values here were 26 m/s / 65 rev/s — faster and spinnier than any human
   * has ever thrown a stone.
   */
  steinerThrow: {
    speed: 19.2, elevationDeg: -2, attackAngleDeg: 20, spinRPS: 47,
    bankAngleDeg: 0, spinAxisTiltDeg: 1, releaseHeight: 0.12,
  },
  /**
   * Truscott's projected physical limit for a human: a 93 mph (41.6 m/s) throw at
   * 2800-3000 rpm, ~164 J, which he estimates would give 300-350 skips. Not
   * achievable by anyone alive; included as the upper bookend for calibration.
   */
  truscottLimit: {
    speed: 41.6, elevationDeg: -2, attackAngleDeg: 20, spinRPS: 48,
    bankAngleDeg: 0, spinAxisTiltDeg: 1, releaseHeight: 0.12,
  },
  /** Casual throw: too much elevation, released too high, modest spin, some wobble. */
  casual: {
    speed: 11, elevationDeg: -14, attackAngleDeg: 27, spinRPS: 12,
    bankAngleDeg: 4, spinAxisTiltDeg: 4, releaseHeight: 0.6,
  },
  /** Steep entry — past the ~45 deg rebound limit. Knifes in. */
  knifeIn: {
    speed: 14, elevationDeg: -25, attackAngleDeg: 55, spinRPS: 30, releaseHeight: 0.5,
  },
  /** No spin at all. Tumbles and dives, per JFM 2005. */
  noSpin: {
    speed: 14, elevationDeg: -10, attackAngleDeg: 20, spinRPS: 0, releaseHeight: 0.4,
  },
  /** Nose-down. The leading edge digs; violent stop. */
  noseDown: {
    speed: 14, elevationDeg: -10, attackAngleDeg: -8, spinRPS: 25, releaseHeight: 0.4,
  },
  /** Flat as a board. Huge wetted area, belly-flops and drags to a halt. */
  bellyFlop: {
    speed: 14, elevationDeg: -6, attackAngleDeg: 1, spinRPS: 25, releaseHeight: 0.3,
  },
  /** Heavily banked: one rim corner enters first. Edge catch, flies off-line. */
  edgeCatch: {
    speed: 14, elevationDeg: -10, attackAngleDeg: 20, spinRPS: 25,
    bankAngleDeg: 35, releaseHeight: 0.4,
  },
  /** Badly wobbled release. Precession compounds; ends unpredictably. */
  wobbler: {
    speed: 13, elevationDeg: -10, attackAngleDeg: 20, spinRPS: 8,
    spinAxisTiltDeg: 18, spinAxisAzimuthDeg: 40, releaseHeight: 0.4,
  },
  /** Below the measured 2.6 m/s rebound floor. Just plops in. */
  tooSlow: {
    speed: 2.0, elevationDeg: -10, attackAngleDeg: 20, spinRPS: 30, releaseHeight: 0.2,
  },
}

export default StoneSkipSim
