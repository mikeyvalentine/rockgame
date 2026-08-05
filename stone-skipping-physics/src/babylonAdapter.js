/**
 * babylonAdapter.js — thin bridge from the engine-agnostic solver to Babylon.js.
 *
 * The physics core knows nothing about Babylon. This file is the only place that
 * touches BABYLON types, so the solver stays unit-testable headless.
 *
 * Usage:
 *
 *   import * as BABYLON from '@babylonjs/core'
 *   import { StoneSkipSim, THROW_PRESETS } from './stoneSkipping.js'
 *   import { BabylonStone } from './babylonAdapter.js'
 *
 *   const sim = new StoneSkipSim({
 *     stone: { radius: 0.045, thickness: 0.01 },
 *     water: (x, z, t) => myWaterSim.sample(x, z, t),   // <- your sim plugs in here
 *   })
 *   const stone = new BabylonStone(scene, sim, { BABYLON })
 *   sim.throwStone(THROW_PRESETS.perfect)
 *   scene.onBeforeRenderObservable.add(() => stone.update(engine.getDeltaTime() / 1000))
 *
 * Note on handedness: the solver is handedness-neutral (Y-up, pure vector math).
 * It works in either Babylon mode. If you use the default left-handed system, a
 * positive spinRPS reads as clockwise from above rather than counter-clockwise —
 * cosmetic only, but flip `spinRPS` if the curve direction looks wrong to you.
 */

/**
 * Wraps a StoneSkipSim and drives a Babylon mesh from it.
 */
export class BabylonStone {
  /**
   * @param {object} scene   BABYLON.Scene
   * @param {object} sim     StoneSkipSim instance
   * @param {object} [opts]
   * @param {object}  opts.BABYLON   the BABYLON namespace (passed in so this file
   *                                 needs no import and no bundler config)
   * @param {object} [opts.mesh]     an existing mesh to drive. If omitted, a disc
   *                                 proxy is created from the sim's stone geometry.
   * @param {boolean}[opts.trail]    draw a trail line (debug)
   * @param {Function}[opts.onSkip]  (event) => void
   * @param {Function}[opts.onImpact](event) => void
   * @param {Function}[opts.onOutcome](event) => void
   * @param {number} [opts.maxSubDelta=0.05] clamp on the frame delta handed to the
   *                 solver, so an alt-tab stall doesn't teleport the stone.
   */
  constructor(scene, sim, opts = {}) {
    const B = opts.BABYLON
    if (!B) throw new Error('BabylonStone: pass the BABYLON namespace as opts.BABYLON')
    this.B = B
    this.scene = scene
    this.sim = sim
    this.maxSubDelta = opts.maxSubDelta ?? 0.05
    this.onSkip = opts.onSkip
    this.onImpact = opts.onImpact
    this.onOutcome = opts.onOutcome

    this.mesh = opts.mesh || this._makeProxyMesh()
    this.mesh.rotationQuaternion = this.mesh.rotationQuaternion || B.Quaternion.Identity()

    this.trailPoints = opts.trail ? [] : null
    this.trailMesh = null

    this.sync()
  }

  _makeProxyMesh() {
    const B = this.B
    const s = this.sim.stone
    // Babylon's cylinder axis is +Y, which is exactly the solver's body face normal.
    const mesh = B.MeshBuilder.CreateCylinder('stone', {
      diameterTop: s.radius * 2,
      diameterBottom: s.radius * 2,
      height: s.thickness,
      tessellation: 32,
    }, this.scene)
    if (s.aspect !== 1) mesh.scaling.x = s.aspect
    return mesh
  }

  /** Copy solver state onto the mesh without advancing physics. */
  sync() {
    const st = this.sim.state
    this.mesh.position.set(st.position.x, st.position.y, st.position.z)
    this.mesh.rotationQuaternion.set(
      st.orientation.x, st.orientation.y, st.orientation.z, st.orientation.w
    )
  }

  /**
   * Advance physics and update the mesh.
   * @param {number} dt seconds since last frame
   * @returns {Array<object>} the solver events from this frame
   */
  update(dt) {
    // AUDIT #B5: advance(), not step(). step(rawFrameDelta) is the exact
    // frame-rate-dependent path the solver's own docs call fatal for a
    // leaderboard (29-31 skips across 30-240Hz on one identical throw);
    // advance() accumulates real time and runs whole fixed ticks.
    const events = this.sim.advance(Math.min(dt, this.maxSubDelta))
    this.sync()

    for (const e of events) {
      if (e.type === 'impact' && this.onImpact) this.onImpact(e)
      else if (e.type === 'skip' && this.onSkip) this.onSkip(e)
      else if (e.type === 'outcome' && this.onOutcome) this.onOutcome(e)
    }

    if (this.trailPoints) {
      const st = this.sim.state
      this.trailPoints.push(new this.B.Vector3(st.position.x, st.position.y, st.position.z))
      if (this.trailPoints.length > 2) {
        this.trailMesh = this.B.MeshBuilder.CreateLines('stoneTrail', {
          points: this.trailPoints,
          instance: this.trailMesh,
          updatable: true,
        }, this.scene)
      }
    }

    return events
  }

  /** Reset and throw again. Accepts the same params as StoneSkipSim.throwStone. */
  throwStone(params) {
    this.sim.throwStone(params)
    if (this.trailPoints) this.trailPoints.length = 0
    this.sync()
    return this
  }

  dispose() {
    this.mesh.dispose()
    if (this.trailMesh) this.trailMesh.dispose()
  }
}

/**
 * Build a water sampler callback from a Babylon heightmap-ish source. Provided as a
 * placeholder so the solver has something to talk to before your real water sim lands
 * — swap it out for the real one.
 *
 * @param {object} cfg
 * @param {number} [cfg.level=0]        still water plane height
 * @param {number} [cfg.amplitude=0]    wave amplitude, m
 * @param {number} [cfg.wavelength=3]   m
 * @param {number} [cfg.speed=1.2]      m/s
 * @param {object} [cfg.direction]      {x, z} unit-ish wave direction
 * @param {object} [cfg.flow]           {x, y, z} bulk current
 * @returns {Function} (x, z, t) => { height, normal, flow }
 */
export function makeGerstnerWater(cfg = {}) {
  const level = cfg.level ?? 0
  const A = cfg.amplitude ?? 0
  const L = cfg.wavelength ?? 3
  const c = cfg.speed ?? 1.2
  const dir = cfg.direction ?? { x: 1, z: 0 }
  const flow = cfg.flow ?? { x: 0, y: 0, z: 0 }
  const dl = Math.hypot(dir.x, dir.z) || 1
  const dx = dir.x / dl, dz = dir.z / dl
  const k = (2 * Math.PI) / L

  return (x, z, t) => {
    if (A === 0) return { height: level, normal: { x: 0, y: 1, z: 0 }, flow }
    const phase = k * (dx * x + dz * z) - k * c * t
    const height = level + A * Math.sin(phase)
    const slope = A * k * Math.cos(phase)
    // surface normal of y = f(x,z)
    const nx = -slope * dx
    const nz = -slope * dz
    const inv = 1 / Math.hypot(nx, 1, nz)
    return {
      height,
      normal: { x: nx * inv, y: inv, z: nz * inv },
      flow,
    }
  }
}
