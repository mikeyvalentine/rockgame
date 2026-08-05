/**
 * Mesh-stone validation. Run:  node test/mesh-audit.mjs
 *
 * The claim under test is that supplying real geometry does not change the physics,
 * only the shape it is applied to. So the anchor case is a MESH OF THE DEFAULT DISC:
 * if the solver is fed a cylinder matching `DEFAULT_STONE`, everything it derives —
 * mass, inertia, face area, and the trajectory itself — must land on the analytic
 * disc it replaces. Anything else means the mesh path is measuring something the
 * disc path is not.
 *
 * Then the interesting half: warped meshes must actually behave differently, or the
 * whole exercise bought nothing.
 */

import {
  StoneSkipSim, THROW_PRESETS, DEFAULT_STONE,
  massProperties, shapeDescriptors, principalAxes, alignMeshToFaceAxis,
  meshPanelClosureError, balanceFromStone,
} from '../src/stoneSkipping.js'

let failures = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pad(label, 44)} ${detail}`)
}
const rel = (a, b) => (Math.abs(b) > 1e-30 ? Math.abs(a - b) / Math.abs(b) : Math.abs(a - b))

/** Closed elliptic cylinder: radius R (x), R*aspect (z), full thickness h, N sides. */
function cylinder(R, h, N = 96, aspect = 1, taper = 0) {
  const positions = [], indices = []
  const half = h / 2
  positions.push(0, half, 0)   // 0 top centre
  positions.push(0, -half, 0)  // 1 bottom centre
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N
    const x = R * Math.cos(th), z = R * aspect * Math.sin(th)
    // `taper` thins one side, making a wedge — a lopsided stone.
    const t = half * (1 - taper * (0.5 + 0.5 * Math.cos(th)))
    positions.push(x, t, z)
    positions.push(x, -t, z)
  }
  const top = (i) => 2 + 2 * (i % N)
  const bot = (i) => 3 + 2 * (i % N)
  for (let i = 0; i < N; i++) {
    indices.push(0, top(i), top(i + 1))           // top fan
    indices.push(1, bot(i + 1), bot(i))           // bottom fan
    indices.push(top(i), bot(i), bot(i + 1))      // rim
    indices.push(top(i), bot(i + 1), top(i + 1))
  }
  return { positions, indices }
}

console.log('\n=== 1. Mass properties of a disc mesh vs the closed form ===')
{
  const R = DEFAULT_STONE.radius, h = DEFAULT_STONE.thickness, rho = DEFAULT_STONE.density
  const mesh = cylinder(R, h, 256)
  const mp = massProperties(mesh.positions, mesh.indices, rho)
  const volA = Math.PI * R * R * h
  const massA = volA * rho
  // Solid cylinder: I_spin = m R^2 / 2 about the axis, m(3R^2 + h^2)/12 transverse.
  const IyyA = massA * R * R / 2
  const IxxA = massA * (3 * R * R + h * h) / 12

  check('volume matches pi R^2 h', rel(mp.volume, volA) < 2e-3,
    `${mp.volume.toExponential(4)} vs ${volA.toExponential(4)} (${(rel(mp.volume, volA) * 100).toFixed(3)}%)`)
  check('I_yy matches m R^2 / 2', rel(mp.inertia.yy, IyyA) < 3e-3,
    `${mp.inertia.yy.toExponential(4)} vs ${IyyA.toExponential(4)}`)
  check('I_xx matches m(3R^2+h^2)/12', rel(mp.inertia.xx, IxxA) < 3e-3,
    `${mp.inertia.xx.toExponential(4)} vs ${IxxA.toExponential(4)}`)
  check('products of inertia vanish for a disc',
    Math.abs(mp.inertia.xy) + Math.abs(mp.inertia.xz) + Math.abs(mp.inertia.yz) < 1e-12 * massA,
    `sum ${(Math.abs(mp.inertia.xy) + Math.abs(mp.inertia.xz) + Math.abs(mp.inertia.yz)).toExponential(2)}`)
  check('centre of mass is the origin', Math.hypot(mp.com.x, mp.com.y, mp.com.z) < 1e-9 * R)

  const sd = shapeDescriptors(mesh.positions, mesh.indices, rho)
  check('face area matches pi R^2', rel(sd.faceArea, Math.PI * R * R) < 2e-3,
    `${sd.faceArea.toExponential(4)} vs ${(Math.PI * R * R).toExponential(4)}`)
}

console.log('\n=== 2. A disc MESH reproduces the analytic disc, end to end ===')
{
  const R = DEFAULT_STONE.radius, h = DEFAULT_STONE.thickness
  const mesh = cylinder(R, h, 256)
  const discSim = new StoneSkipSim({})
  const meshSim = new StoneSkipSim({ stone: { mesh } })

  check('mass agrees', rel(meshSim.mass, discSim.mass) < 3e-3,
    `${(meshSim.mass * 1000).toFixed(2)} g vs ${(discSim.mass * 1000).toFixed(2)} g`)
  check('spin inertia agrees', rel(meshSim.inertiaBody.yy, discSim.inertiaBody.yy) < 5e-3,
    `${meshSim.inertiaBody.yy.toExponential(4)} vs ${discSim.inertiaBody.yy.toExponential(4)}`)
  check('effective radius agrees', rel(meshSim.effRadius, discSim.effRadius) < 2e-3,
    `${meshSim.effRadius.toFixed(5)} vs ${discSim.effRadius.toFixed(5)}`)
  check('face area agrees', rel(meshSim.faceArea, discSim.faceArea) < 3e-3,
    `${meshSim.faceArea.toExponential(4)} vs ${discSim.faceArea.toExponential(4)}`)

  const run = (sim) => {
    sim.throwStone(THROW_PRESETS.steinerThrow)
    const r = sim.simulate({ maxTime: 40 })
    return { skips: r.skips, dist: r.runDistance, hops: sim.cleanHops }
  }
  const a = run(new StoneSkipSim({}))
  const b = run(new StoneSkipSim({ stone: { mesh } }))
  console.log(`        analytic disc: ${a.skips} skips / ${a.hops} hops / ${a.dist.toFixed(1)} m`)
  console.log(`        disc as mesh:  ${b.skips} skips / ${b.hops} hops / ${b.dist.toFixed(1)} m`)
  // Skip count is chaotic (README "Known limitations"), so distance carries the
  // assertion. This was 18% off until the panel builder was fixed to use the FINEST
  // grid that fits the budget rather than the first one that did; it converges to
  // ~2% by 128 panels and does not improve after 240, which is the mesh's own limit.
  check('run distance lands within 8% of the disc', rel(b.dist, a.dist) < 0.08,
    `${(rel(b.dist, a.dist) * 100).toFixed(1)}% apart`)

  // Total panel area is what sets the pressure force, so it has to survive
  // decimation. True surface of the cylinder, sharp-edged: 2*pi*R^2 + 2*pi*R*h.
  const trueArea = 2 * Math.PI * R * R + 2 * Math.PI * R * h
  const panelArea = meshSim.panels.reduce((s, p) => s + p.area, 0)
  check('panel area matches the real surface area', rel(panelArea, trueArea) < 0.01,
    `${panelArea.toExponential(4)} vs ${trueArea.toExponential(4)} (${(rel(panelArea, trueArea) * 100).toFixed(2)}%)`)
}

console.log('\n=== 3. Panel set stays closed and bounded ===')
{
  const budget = 192
  for (const [label, mesh] of [
    ['disc 256-gon', cylinder(0.045, 0.010, 256)],
    ['oblong', cylinder(0.045, 0.010, 128, 0.5)],
    ['wedge (taper 0.7)', cylinder(0.045, 0.012, 128, 1, 0.7)],
  ]) {
    const sim = new StoneSkipSim({ stone: { mesh } })
    const err = meshPanelClosureError(sim.panels)
    // Buoyancy in this solver is not special-cased -- it falls out of integrating
    // pressure over a CLOSED surface. If decimation broke closure, Archimedes breaks.
    check(`${label}: sum(area*normal) ~ 0`, err < 0.02, `error ${err.toExponential(2)}`)
    check(`${label}: panel count within budget`, sim.panels.length <= budget,
      `${sim.panels.length} panels`)
    check(`${label}: has both face and rim panels`,
      sim.panels.some((p) => p.isRim) && sim.panels.some((p) => !p.isRim),
      `${sim.panels.filter((p) => p.isRim).length} rim`)
  }
}

console.log('\n=== 4. Buoyancy still recovers Archimedes from mesh panels ===')
{
  // Sum hydrostatic pressure over the panel set with the stone fully submerged at a
  // fixed depth. For a closed surface that integral is exactly rho*g*V, whatever the
  // panel layout -- so this is the real test that decimation kept the surface closed.
  const mesh = cylinder(0.045, 0.010, 128)
  const sim = new StoneSkipSim({ stone: { mesh } })
  const rho = 1000, g = 9.81, depth = 1.0
  let fy = 0
  for (const p of sim.panels) fy += -rho * g * (depth - p.py) * p.ny * p.area
  const exact = rho * g * sim.volume
  check('panel integral recovers rho*g*V', rel(fy, exact) < 0.02,
    `${fy.toFixed(4)} N vs ${exact.toFixed(4)} N (${(rel(fy, exact) * 100).toFixed(2)}%)`)
}

console.log('\n=== 5. Warped stones must actually behave differently ===')
{
  const round = cylinder(0.045, 0.010, 128)
  const oblong = cylinder(0.045, 0.010, 128, 0.45)
  const wedge = cylinder(0.045, 0.012, 128, 1, 0.8)

  const sdR = shapeDescriptors(round.positions, round.indices, 2700)
  const sdO = shapeDescriptors(oblong.positions, oblong.indices, 2700)
  const sdW = shapeDescriptors(wedge.positions, wedge.indices, 2700)
  console.log(`        round:  flatness ${sdR.flatness.toFixed(3)}  asym ${sdR.asymmetry.toFixed(3)}  lopsided ${sdR.lopsidedness.toFixed(3)}`)
  console.log(`        oblong: flatness ${sdO.flatness.toFixed(3)}  asym ${sdO.asymmetry.toFixed(3)}  lopsided ${sdO.lopsidedness.toFixed(3)}`)
  console.log(`        wedge:  flatness ${sdW.flatness.toFixed(3)}  asym ${sdW.asymmetry.toFixed(3)}  lopsided ${sdW.lopsidedness.toFixed(3)}`)

  check('oblong reads asymmetric, round does not', sdO.asymmetry > 0.3 && sdR.asymmetry < 0.02)
  check('wedge reads lopsided, round does not', sdW.lopsidedness > 0.05 && sdR.lopsidedness < 1e-6)

  const bR = balanceFromStone({ mesh: round }, sdR)
  const bO = balanceFromStone({ mesh: oblong }, sdO)
  const bW = balanceFromStone({ mesh: wedge }, sdW)
  console.log(`        balance:  round ${bR.toFixed(3)}   oblong ${bO.toFixed(3)}   wedge ${bW.toFixed(3)}`)
  check('a warped stone scores lower balance than a round one', bO < bR && bW < bR)

  // Attitude at the end of a run is the direct read on wobble.
  const endBank = (mesh) => {
    const sim = new StoneSkipSim({ stone: { mesh } })
    sim.throwStone(THROW_PRESETS.steinerThrow)
    sim.simulate({ maxTime: 40 })
    return Math.abs(sim.getDiagnostics().bankAngleDeg)
  }
  const bankR = endBank(round), bankO = endBank(oblong)
  console.log(`        end bank: round ${bankR.toFixed(1)} deg   oblong ${bankO.toFixed(1)} deg`)
  check('shape changes the trajectory at all', Math.abs(bankR - bankO) > 0.5,
    `${Math.abs(bankR - bankO).toFixed(1)} deg apart`)
}

console.log('\n=== 6. Orientation handling ===')
{
  const mesh = cylinder(0.045, 0.010, 128, 0.6)
  const sd = shapeDescriptors(mesh.positions, mesh.indices, 2700)
  // Tip the mesh well off its face axis, then re-align it.
  const rot = mesh.positions.slice()
  const ca = Math.cos(0.7), sa = Math.sin(0.7)
  for (let i = 0; i < rot.length; i += 3) {
    const y = rot[i + 1] * ca - rot[i + 2] * sa
    const z = rot[i + 1] * sa + rot[i + 2] * ca
    rot[i + 1] = y; rot[i + 2] = z
  }
  const aligned = alignMeshToFaceAxis(rot, mesh.indices, 2700)
  const sdA = shapeDescriptors(aligned, mesh.indices, 2700)
  check('alignMeshToFaceAxis restores the face axis',
    rel(sdA.extent.y, sd.extent.y) < 0.02,
    `thickness ${sdA.extent.y.toFixed(5)} vs ${sd.extent.y.toFixed(5)}`)
  check('alignment preserves flatness', rel(sdA.flatness, sd.flatness) < 0.02,
    `${sdA.flatness.toFixed(4)} vs ${sd.flatness.toFixed(4)}`)

  const pa = principalAxes(sd.inertia)
  check('principal moments come back descending',
    pa.moments[0] >= pa.moments[1] && pa.moments[1] >= pa.moments[2],
    pa.moments.map((m) => m.toExponential(2)).join(' >= '))
}

console.log('\n=== 7. Degenerate input falls back instead of exploding ===')
{
  const open = { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] } // single tri
  const sim = new StoneSkipSim({ stone: { mesh: open } })
  check('open mesh falls back to the disc', sim.mass > 0 && Number.isFinite(sim.inertiaBody.yy),
    `mass ${(sim.mass * 1000).toFixed(1)} g`)
  const empty = new StoneSkipSim({ stone: { mesh: { positions: [], indices: [] } } })
  check('empty mesh falls back to the disc', empty.mass > 0 && empty.panels.length > 0,
    `${empty.panels.length} panels`)
  sim.throwStone(THROW_PRESETS.decent)
  const r = sim.simulate({ maxTime: 20 })
  check('fallback stone still simulates', Number.isFinite(r.runDistance), `${r.runDistance.toFixed(1)} m`)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL MESH CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
