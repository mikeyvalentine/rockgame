# Stone Skipping — Physics Reference

Working notes assembled from the primary literature. Everything the solver in
`src/stoneSkipping.js` does traces back to something in here. Symbols are kept in
the notation of the source paper, then mapped to code names at the bottom.

---

## 1. The core mechanism: it is planing, not surface tension

A skipping stone is a **planing hydrofoil**, not a boat floating on skin. Buoyancy and
surface tension are both far too weak to matter at throw speeds. The stone works the
way a water-ski or a flying wing works: a body inclined nose-up, moving fast, deflects
fluid downward and takes an equal-and-opposite reaction upward.

The relevant dimensionless numbers at a real throw (R ≈ 4 cm, U ≈ 10 m/s):

| Number | Definition | Value | Meaning |
|---|---|---|---|
| Reynolds | Re = UR/ν | ~4×10⁵ | inertial; viscosity irrelevant except skin friction |
| Weber | We = ρU²R/σ | ~5×10⁴ | inertial; **surface tension irrelevant** |
| Froude | F = U²/(gR) | ~250 | inertial; **gravity/buoyancy irrelevant during contact** |
| Rossby | Ro = ωτ/α | ≫1 when spinning | gyroscopic stabilisation dominates |

Consequence for the model: during the ~10–30 ms of water contact, the only force that
matters is **dynamic pressure on the wetted area**. Buoyancy is a low-speed / end-of-run
term. Surface tension can be ignored entirely.

Sources: Bocquet AJP 2003; Rosellini, Hersen, Clanet & Bocquet, JFM 543 (2005) 137.

---

## 2. Bocquet's analytic model (AJP 71, 150, 2003)

The reaction force from the water is split into a component normal to the stone face
and a tangential (friction) component:

```
F = ½ C_l ρ_w V² S_im  n̂  +  ½ C_f ρ_w V² S_im  t̂
```

- `ρ_w` water density (1000 kg/m³)
- `V` stone speed
- `S_im` **immersed area of the stone face**
- `n̂` unit normal to the stone face, `t̂` unit tangent opposing motion
- `C_l ≈ C_f ≈ 1` (order-unity; see §4 for the better-fitted value)

### 2.1 Immersed area of a circular disk

For a disk of radius `R = a/2` inclined at attack angle `θ`, with the lowest point a
depth `|z|` below the surface, the wetted chord depth along the face is `s = |z|/sin θ`,
and the wetted area is the circular segment:

```
S_im(s) = R² [ arccos(1 − s/R) − (1 − s/R)·√(1 − (1 − s/R)²) ]
```

This is the single most important geometric fact in the whole problem: **lift grows
super-linearly with penetration depth**, which is what makes the bounce a restoring,
spring-like event rather than a mush.

### 2.2 Equations of motion

Vertical (with the stone face held at fixed `θ` by spin):

```
M z̈ = −Mg + ½ ρ_w V_x0² S_im(z) C_l ( cos θ − (C_f/C_l) sin θ )
```

Horizontal:

```
M V̇_x = −½ ρ_w V² S_im(z) ( C_l sin θ + C_f cos θ )
```

### 2.3 Minimum speed to bounce

The stone bounces only if the lift impulse reverses `ż` before the disk fully submerges:

```
V_c = √( 16 M g / (π C ρ_w a²) )
```

For `M = 0.1 kg`, `a = 0.1 m`, `C ≈ 1`: `V_c ≈ 0.7 m/s` — easy. The real constraint
is angular, not translational (§3).

### 2.4 Number of bounces

Two independent ceilings; the smaller one wins.

**Velocity-limited** (the stone runs out of kinetic energy):

```
N_c = V_x0² / (2 g μ ℓ)      with dissipation length  ℓ = 2π √( 2M sin θ / (C ρ_w a) )
```

**Spin-limited** (the stone runs out of gyroscopic authority — see §3):

```
N_c ~ R φ̇₀² / g
```

Bocquet notes the ~38-bounce records of the time fall out of these when both are
balanced. The current record (88, Kurt Steiner, 2013) sits at the extreme of the
spin-limited branch.

### 2.5 Parameter values used in the paper

`M = 0.1 kg`, `a = 0.1 m` (diameter), `V_x0 = 5–12 m/s`, `φ̇₀ = 5–14 rev/s`,
`θ ≈ 10°`, incidence `β ≈ 10°`, `C_l ≈ C_f ≈ 1`, `ρ_w = 1000 kg/m³`.

---

## 3. Gyroscopic stability — why spin is mandatory

Water pressure acts on the **wetted patch, which is at the rear/lower edge of the
stone, not at the centre of mass**. That offset produces a nose-up pitching torque
every single contact. Without spin the stone pitches up, the trailing edge digs, and
it tumbles and dives.

Spin about the face normal gives angular momentum `L = I_spin φ̇`. The hydrodynamic
torque `Γ` does not tip the stone; it **precesses** it, at rate `Ω_p = Γ / L`. Large
`L` ⇒ tiny attitude change during the short contact ⇒ the attack angle is effectively
frozen through the bounce. That frozen-attitude assumption is exactly what lets §2
and §4 be solved analytically.

Stability criterion (Bocquet):

```
φ̇₀  ≫  √( g / R )
```

For `R = 0.05 m` that is `φ̇₀ ≫ 14 rad/s ≈ 2.2 rev/s`. Real good throws are 10–65 rev/s.

**Rossby number** `Ro = ω τ / α` (JFM 2005) compares spin period to contact time `τ`.
`Ro ≫ 1` = attitude preserved = skip. `Ro ~ 1` = attitude drifts during contact =
surf/trout. `Ro → 0` = tumble and dive.

### The residual precession is the source of "wobble"
Even a well-spun stone precesses a little per bounce. Errors accumulate: the attack
angle drifts bounce to bounce, and once it drifts past the window in §5 the run ends
abruptly. This is the "it went great for six skips then suddenly knifed in" behaviour.
A 6-DOF solver reproduces it for free; an analytic per-bounce model has to fake it.

---

## 4. Nagahiro & Hayakawa, PRL 94, 174501 (2005) — the magic angle, derived

SPH simulation of a real disk–water impact, distilled into a model. Their force law
drops Bocquet's separate lift/drag split in favour of a single pressure term:

```
f = − ½ C_D S ρ (v·n)² n
```

with **`C_D ≈ 1.4`, fitted to the SPH data**. This is the coefficient the solver uses.

Non-dimensional equations of motion (`F = v₀²/(gR)` Froude, `λ = R/d` radius-to-thickness,
`σ` specific gravity, `φ` attack angle):

```
ξ̈ = −(1/F) sin φ
ζ̈ = [C_D λ / (2π σ)] ζ̇² S(z) − (1/F) cos φ
```

Minimum speed to rebound, incidence angle `θ`:

```
v_min = √(2gR)/cos(θ+φ) · { ξ̂* sin φ + σ cos φ / (C_D λ sin²φ) }^(1/2)
```

with fitting parameter `ξ̂* = 2.6` (position of the inflection point once the disk is
fully immersed).

**Why 20°:** `v_min(φ)` has a genuine minimum. As `φ → 0` the wetted area is huge and
drag kills the stone; as `φ` grows the vertical component of the pressure gets efficient
but the stone penetrates too deep before generating it. The minimum sits near 20°, and
crucially it moves only ~15% across incidence angles `θ ∈ [0°, 40°]`. **The magic angle
is robust to how you aim** — which is why "20°" is quotable advice at all.

Their stated model assumptions (worth copying, they're all reasonable):
1. pressure ∝ (v·n)² (valid at Re ~ 10⁵)
2. **no force on air-facing surfaces** — the cavity behind the stone is ventilated
3. `φ` constant during impact (gyroscopic)
4. free-surface deformation negligible
5. `C_D` constant through the impact

Assumption 2 is the one game code always gets wrong. If you wet the top face of the
stone while the air cavity is still open, the lift cancels and nothing skips.

### 4.1 These two papers do not use the same force law

Worth stating loudly, because it cost a full day of debugging and it is not flagged in
either paper:

| | Bocquet 2003 | Nagahiro & Hayakawa 2005 |
|---|---|---|
| pressure | `½ C_l ρ V² S_im`, `C_l ≈ 1` | `½ C_D ρ (v·n)² S`, `C_D = 1.4` |
| velocity used | **full speed** | **normal component only** |
| scaling with α | none (α enters via `S_im` and the force direction) | `sin²α` |
| at α = 20° | — | ~4× smaller than Bocquet |

Both are defensible in their own regime. Newtonian `(v·n)²` is the right law for a
steep slam, where the flow really is being turned through a large angle. It badly
under-predicts a shallow **planing** surface, where lift is closer to *linear* in α
because of circulation and unsteady added mass — the same reason a thin aerofoil's
`C_L ≈ 2πα` rather than `∝ α²`.

Consequences of using the Newtonian law alone at skipping angles, all verified in the
solver: penetration comes out ~2× deeper than Bocquet's own closed form predicts
(15 mm vs 8 mm), contact time balloons from ~15 ms to 50–115 ms, the pitching lever
grows with the wetted patch, vertical restitution collapses to 0.45, and no throw
survives more than two or three bounces.

The solver therefore uses the sum of the two mechanisms:

```
p = ½ρ [ C_D (u·n)²  +  C_P |u_t| (u·n) ]
```

The cross term is linear in `sin α` and vanishes as the flow becomes purely normal, so
the sum reduces to Nagahiro in the steep-impact limit and reproduces Bocquet's
`C_l ≈ 1` at the canonical 20° planing condition when `C_P = 1.5`. Check, at
effective incidence 30° (20° attack + 10° descent):

```
C_D sin²α  + C_P cosα sinα  =  1.4(0.25) + 1.5(0.866)(0.5)  =  0.35 + 0.65  =  1.0  ✓
```

Simulation params: `λ = 9.1`, `σ = 2.7`, `F ∈ [4, 200]`; SPH run at `λ = 2.5`,
`ω = 65 rot/s`, 12 600 particles.

---

## 5. Experimental phase diagram (JFM 543, 2005)

Aluminium disks, `R ∈ [2.5, 5.0] cm`, `h ∈ [2.75, 5.55] mm`, `U ∈ [3.5, 5.0] m/s`,
`ω ∈ [0, 65] rot/s`, `α, β ∈ [0°, 45°]`.

**Findings to hard-code as behaviour:**

- **`U_min ≈ 2.6 m/s`** at `α = 20°, ω = 65 rot/s`. Below that, no rebound at any spin.
- **No rebound for `α > 45°`, at any spin.** Steep = knife-in, always.
- Contact time **saturates around `τ ≈ 30 ms`**; `τ_min ∝ hR/U`; dimensionally
  `τ ~ √(mR/F_lift)`.
- Contact time is **minimised at `α ≈ 20°`** — least time in the water, least dissipation.
- Three regimes in the `{U, ω}` and `{α, ω}` planes:
  - **Diving** — `ω ≈ 0`: tumbles on impact, goes under.
  - **Surfing** — moderate `ω`: attitude changes during contact, the stone oscillates
    vertically but never detaches. Long wet contact, dies fast.
  - **Skipping** — high `ω`: attitude held, clean detach, repeats.

Wikipedia / general literature adds: largest observed attack angle preceding a rebound
is **≈45°**; the practical success window for the angle of attack is roughly
**4° – 52°**, failing outside it (below 4° the stone just planes/drags out its energy,
above ~52° it plunges).

---

## 6. Three-dimensional behaviour: why stones go sideways

This is the part almost every game omits. Source: *Numerical and theoretical
investigation on three-dimensional trajectory characteristics of skipping stones*,
Acta Mechanica Sinica 37 (2021), plus *Trajectory and attitude study of a skipping
stone*, Phys. Fluids 33, 043316 (2021).

**Two competing lateral mechanisms, with a crossover:**

- **Low spin, `Ω < ~18 rot/s`** — the **Magnus effect dominates**. The spinning stone
  drags a boundary layer, pressure is asymmetric across the wetted patch, and the stone
  is pushed sideways. Deflection direction is set by the sign of the spin.
- **High spin, `Ω > ~18 rot/s`** — the **gyroscopic effect dominates**. Now the pitching
  torque from the off-centre wetted patch does not pitch the stone, it **precesses it in
  yaw**. The stone's heading walks sideways bounce by bounce, and again the direction is
  set by the sign of the spin.

Either way: **a right-handed sidearm throw (stone spinning clockwise seen from above)
curves consistently to one side, and the curve compounds over the run.** That is real,
measured, and it is the single best "feel" detail you can put in the game.

Lateral deviation scales with the group `sin(α + β)·cos α` (α attack, β incidence),
with an initial steady interval then a linear interval in `Z/D`.

**Five measured motion responses** (use these as your outcome enum):

1. **Dive** — no rebound, stone enters and goes under.
2. **Hydroplaning trout** — stays attached to the surface, porpoising, no clean flight.
3. **Hydroplaning skip** — leaves the surface but barely, very low hops.
4. **Stable skip** — the good one. Clean detach, ballistic arc, repeats.
5. **Skipping trout** — starts skipping, degrades into surface-attached porpoising as
   speed bleeds off. This is the classic terminal **"pitty-pat"**.

---

## 7. Failure modes to reproduce deliberately

| Failure | Physical cause | What the solver needs |
|---|---|---|
| **Knife-in / plunge** | attack angle > ~45–52°, or negative (nose-down) | wetted-area geometry + pressure ∝ (v·n)²; falls out automatically |
| **Tumble** | insufficient spin: pitch torque from off-centre pressure exceeds gyroscopic authority | real inertia tensor + torque about CoM, not a scalar "stability" |
| **Edge catch / violent deflection** | the stone is *rolled* (banked) so one rim corner enters first; the resulting force is off the roll axis and creates a huge yaw+roll torque | must sample the **rim**, not just the two faces |
| **Squirrel / random flyaway** | accumulated precession has drifted the attitude; a bounce arrives with large sideslip; force vector no longer lies in the flight plane | 6-DOF with world-frame angular momentum |
| **Belly flop** | attack angle ≈ 0 with high speed: enormous instantaneous wetted area, huge drag, the stone stops dead | area formula handles it |
| **Surf / stall** | speed near `U_min`, contact never terminates | buoyancy + hydrostatic term keeps it sane at low speed |
| **Pitty-pat** | speed decayed, hop time → 0, bounce interval collapses geometrically | emerges from energy loss per contact |

### 7.1 The end of the run is its own physics problem

Everything above is about the skipping phase. The *settling* phase has separate
requirements, and getting them wrong is very visible — the stone reads as glitching
rather than drowning.

Two things must happen once the stone loses the plot:

**The cavity must close.** Ventilation (§4, assumption 2) is what makes skipping work,
but it is only valid while the stone is moving fast enough to outrun the water falling
into the void behind it. Water collapses into a cavity at roughly `√(2 g depth)`. Gate
ventilation on depth *alone* and a stone drowning at 1 m/s is still treated as ~90%
ventilated: its top face stays dry, it keeps generating planing lift it has no right
to, and it never settles. The criterion has to include speed.

**The run ending is not the simulation ending.** A stone that stops skipping still has
most of its forward momentum — it skims, decelerates and sinks over the next second or
two. These are separate events and need separate flags, or the stone freezes in place
the moment it stops bouncing.

**Rotation must damp.** A submerged disc wobbling at 30 rad/s is sweeping its rim
broadside through water at `ωR ≈ 1.4 m/s`. That is form drag and it should kill the
nutation in tens of milliseconds. Spin about the face normal is shear-driven and decays
far more slowly — a real stone is still spinning as it sinks, which is correct. So the
two need separate coefficients, roughly an order of magnitude apart.

The panel integral does produce wobble damping on its own, since it sees `ω × r` in the
relative velocity. But any global scaling applied to the transverse torque to tame the
*destabilising* moment weakens the *damping* by exactly the same factor. Rate-dependent
damping therefore has to sit outside that scaling, or the calibration silently turns it
off and the stone rings forever.

---

## 8. Practical / empirical numbers

- **Records:** 88 skips — Kurt "Mountain Man" Steiner, 6 Sep 2013, Red Bridge, Allegheny
  National Forest, PA (Guinness). Distance: 121.8 m (Dougie Isaacs), 52.5 m
  (Nina Luginbuhl), 28 May 2018, Abernant Lake, Wales.
- **Competition stone spec** (World Stone Skimming Championships): sea-worn Easdale
  slate, max 3 inch (76 mm) diameter.
- **Good stone:** flat, roughly circular, ~5–10 cm across, ~1 cm thick, 100–200 g.
  Thickness ratio `λ = R/d` in the 5–10 range.
- **Good throw:** sidearm, release close to the water, ~10–20 m/s, 10–30 rev/s spin
  (elite throwers reach ~65 rev/s), stone face pitched ~20° nose-up, trajectory
  descending at ~10–20°.
- **The 20° rule is about the stone's face relative to the water, not the flight path.**
  Confusing attack angle with launch angle is the most common modelling bug.

---

## 9. Symbol → code mapping

| Paper | Code | Notes |
|---|---|---|
| `α`, `θ`, `φ` (attack) | `attackAngleDeg` | face pitch relative to water plane |
| `β` (incidence) | `elevationDeg` (negated) | flight path angle relative to water |
| `ω`, `φ̇₀` | `spinRPS` | rev/s about the face normal |
| `C_D` | `env.pressureCoefficient` | default **1.4** (Nagahiro SPH fit) |
| `C_f` | `env.frictionCoefficient` | default 0.005 (true skin friction; see §4.1) |
| `ρ_w` | `env.waterDensity` | 1000 |
| `S_im` | computed by panel quadrature | not a closed form — see §10 |
| `λ = R/d` | `radius / thickness` | |
| `σ` | `stone.density / 1000` | |
| `Ro` | `diagnostics.rossby` | |

---

## 10. Why the solver integrates panels instead of using the closed-form area

The closed-form `S_im(s)` in §2.1 assumes the disk is inclined in the flight plane only
— no roll, no sideslip, flat water. Every interesting failure in §7 violates one of
those. So the solver discretises the stone's surface (two equal-area polar face grids
plus a rim ring) and integrates:

```
dF_i = −( ½ C_D ρ_w max(0, u_i·n_i)²  +  ρ_w g depth_i ) · w_i · n_i · dA_i
       − ½ C_f ρ_w |u_t,i| u_t,i dA_i
dΓ_i = (r_i − p) × dF_i
```

where `u_i = v + ω×(r_i − p) − u_water`, `n_i` is the outward surface normal, and `w_i`
is the **ventilation weight** implementing Nagahiro assumption 2: a panel whose outward
normal points away from the water gets `w = 0` while the air cavity is open, ramping to
`1` once the stone is deep enough for the cavity to close.

Summing hydrostatic pressure over the closed immersed surface recovers Archimedes
exactly, so buoyancy is not a separate special case — it is the same integral, and it
takes over automatically as speed decays. Torque about the centre of mass is likewise
just the same integral, which is where gyroscopic stability, precession, tumble and the
edge-catch flyaway all come from without any of them being scripted.

Added mass is applied as a direction-dependent effective mass along the face normal,
`m_n = m + C_a ρ_w R³ · immersedFraction` with `C_a = 4/3` (half the unbounded-fluid
disk value 8/3, the standard free-surface halving), plus an added pitch inertia term.
This is what keeps the impact stable at sane timesteps.

---

## Sources

- Lydéric Bocquet, *The physics of stone skipping*, Am. J. Phys. **71**, 150 (2003) — [arXiv:physics/0210015](https://arxiv.org/abs/physics/0210015) · [AIP](https://pubs.aip.org/aapt/ajp/article/71/2/150/1055910/The-physics-of-stone-skipping)
- C. Clanet, F. Hersen, L. Bocquet, *Secrets of successful stone-skipping*, Nature **427**, 29 (2004) — [Nature](https://www.nature.com/articles/427029a)
- Rosellini, Hersen, Clanet & Bocquet, *Skipping stones*, J. Fluid Mech. **543**, 137 (2005) — [PDF](https://ilm-perso.univ-lyon1.fr/~lbocquet/JFM_skippingstones.pdf) · [HAL](https://hal.science/hal-00014781v1)
- S. Nagahiro & Y. Hayakawa, *Theoretical and numerical approach to "magic angle" of stone skipping*, Phys. Rev. Lett. **94**, 174501 (2005) — [arXiv:physics/0411125](https://arxiv.org/abs/physics/0411125) · [PRL](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.94.174501)
- *Numerical and theoretical investigation on three-dimensional trajectory characteristics of skipping stones*, Acta Mech. Sin. **37** (2021) — [Springer](https://link.springer.com/article/10.1007/s10409-021-09026-x)
- *Trajectory and attitude study of a skipping stone*, Phys. Fluids **33**, 043316 (2021) — [AIP](https://pubs.aip.org/aip/pof/article-abstract/33/4/043316/1064417/Trajectory-and-attitude-study-of-a-skipping-stone)
- *An experimental study of non-spinning stone-skipping process*, Exp. Therm. Fluid Sci. (2021) — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0894177720308177)
- *Numerical investigation on the cavity dynamics and deviation characteristics of skipping stones*, J. Fluids Struct. (2021) — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0889974621000840)
- *How do stones skip?*, Physics World — [physicsworld.com](https://physicsworld.com/a/how-do-stones-skip/)
- *Stone skipping*, Wikipedia (records, competition specs) — [wikipedia](https://en.wikipedia.org/wiki/Stone_skipping)


---

## 11. Field measurements: Utah State Splash Lab / Kurt Steiner

From the WIRED "Almost Impossible" episode with Tad Truscott (Splash Lab, Utah State)
and world-record holder Kurt Steiner. These are *measured human* numbers and they are
the tightest external check the model has, because none of them were used to build it.

| Quantity | Measured | Model |
|---|---|---|
| Energy of a 93 mph / 2900 rpm throw | "close to 164 J" | **156.5 J** (148.4 translational + 8.0 rotational) |
| Steiner max arm speed | 50 mph = 22.4 m/s | — |
| Steiner's actual 88-skip record throw | 43 mph = **19.2 m/s** | `THROW_PRESETS.recordAttempt` |
| Truscott human spin ceiling | 2800–3000 rpm = **47–50 rev/s** | presets held below this |
| Truscott projected limit | 300–350 skips at 41.6 m/s | `THROW_PRESETS.truscottLimit` |
| Steiner's own estimate of the limit | ~200 skips | — |

The energy agreement to within 5% independently validates the default stone's mass
(172 g) and spin inertia (1.74e-4 kg m²).

**It also caught the presets being superhuman.** `recordAttempt` was 26 m/s at 65 rev/s
— faster than Steiner's maximum arm speed and spinnier than Truscott's theoretical
human ceiling. Now 19.2 m/s at 47 rev/s, the real throw.

### 11.1 Roll-over in flight — the one mechanism that was missing

Steiner, on why he aims his first touch close to shore:

> "the longer it stays in the air the more it will roll over on its side ... you can
> minimise that by lessening the time in the air, which is one reason you want to hit
> close."

The model did not do this at all. Free flight was exactly torque-free, so a stone
arrived at its first contact with 0.0–0.2° of bank whether it had flown half a metre or
nine. The missing term is the **aerodynamic pitching moment**, which on a spinning
stone does not pitch it but precesses it into bank:

```
tau = C_M q A R sin(alpha_air),   axis = normalise(n x vHat)
```

Two implementation traps, both hit and both fixed:

1. **Scale with `sin(alpha) = -(n·vHat)`, not `|n x vHat|`.** The cross-product
   magnitude is `cos(alpha)` — it peaks at *zero* attack angle, the opposite of the
   real behaviour, and it dragged the model's optimum from 20° down to 0°.
2. **Keep `C_M` at or below ~0.2.** Above ~0.35 it starts distorting neighbouring
   physics: the spin gradient inverts (10 rev/s out-scoring 45 rev/s) and the magic
   angle drifts.

At `C_M = 0.2` a stone reaches its first touch with 0.3° of bank after a half-metre
flight and 6.3° after nine metres — a 20× spread. "Hit close" is now a real lever.

### 11.2 Where the model still falls short: total distance

Dougie Isaacs' official distance record is **121.8 m**. Searching the human-achievable
envelope (≤22.4 m/s, ≤50 rev/s):

| Profile | Best distance | Fraction of the record |
|---|---|---|
| `documentary` | 44 m | 36% |
| `game` | 45 m | 37% |
| `arcade` | 55 m | 45% |

Even at Truscott's theoretical 41.6 m/s ceiling, `documentary` reaches only 90 m (74%).

**Update after the bow-wave term:** 52 m (43%) and 12-21 skips on the record throw.
The paragraph below still describes the residual gap correctly, but the cause is now
pinned precisely — see §11.4.

**The model under-ranges by roughly 2.3×.** Per-bounce mechanics match the literature
well (contact time, penetration depth, loss vs attack angle), so the deficit is
cumulative: the stone bleeds speed faster over a long run than a real one does. This is
the same root cause as the skip-count ceiling in §7.1 — vertical restitution and the
attitude walk — and it is the largest open gap in the model.

### 11.3 What video footage can and cannot give us

Five clips were analysed (`videos/`), including the 60 fps Steiner 88-skip record.
Frame-level extraction ran into hard limits worth recording so it is not re-attempted
blindly:

- **Temporal resolution.** 88 skips in ~10 s means the terminal pitty-pats arrive
  faster than one per frame at 60 fps. The late skips are *physically uncountable* from
  this footage; only the first ~10 are resolvable.
- **No scale reference.** Oblique receding view, no object of known size in frame, so
  pixels cannot be converted to metres — no velocity or distance extraction.
- **Overlay and glint contamination.** A naive brightest-pixel tracker locks onto the
  on-screen counter; foam-area differencing picks up camera motion.

What *would* be usable: static camera, side-on, with a metre rule or other known-length
object in frame, ideally 240 fps or higher. Failing that, the published Splash Lab
figures in §11 are worth more than any amount of consumer footage.


### 11.4 The gap is attitude, not energy — measured against Bocquet

Comparing the three sources directly at Steiner's real throw (19.2 m/s, 47 rev/s, 20°):

| | Energy lost per bounce | Bounces |
|---|---|---|
| Bocquet closed form (§2.4) | 0.49% | 203 |
| **Implied by the real 88 skips** | **4.44%** | **88** |
| This model | 4.6% | 12–21 |

The 4.44% figure is just arithmetic: 19.2 m/s decaying to the 2.6 m/s rebound floor
over 88 bounces requires 95.56% energy retention each time. **Our dissipation is
essentially exact.** Bocquet's analytic result is the optimistic outlier, because it
assumes a frozen attack angle and no attitude drift.

So the shortfall is not dissipation. Instrumenting a run to its end:

```
speed at run end   11.1 m/s     (rebound floor is 2.6 — four times the margin)
attack at run end   0.6 deg     (launched at 20)
bank at run end   -24.4 deg
outcome           skipping-trout
```

The stone has rolled onto its side and flattened out with most of its energy intact.
Every remaining discrepancy — skip count, total distance, the bistability cliff near
52 rev/s — is the same defect: **the attitude walk terminates runs prematurely.**

Anyone picking this up should attack the attitude dynamics during the surface-attached
phase, and should not bother tuning dissipation, `pitchMomentScale`, or the assist
knobs — all three were tried and all three trade one symptom for another.


---

## 12. Pre-integration audit (v0.8.0)

Full pass over the physics against every source in this document plus two papers not
previously ingested: *Experimental results and mathematical formulation of non-spinning
stone-skipping* (Sci. Rep. 12, 2022) and *Attitude motion and nonlinear free-surface
deformation of stone-skipping over shallow water* (Phys. Fluids, 2024, abstract only).
Everything below is now locked by permanent regression tests.

### Defects found and fixed

1. **Mirror-symmetry violation (assist handedness).** A clockwise (negative-spin)
   stone carries L along −n; the attitude assist steered L toward +n regardless,
   trying to flip the spin axis 180°. Every left-handed throw was quietly mangled
   (6 skips vs 13, curve gone). Fixed by targeting the hemisphere L occupies.
   drift(−ω) now equals −drift(+ω) exactly, both profiles.

2. **Aerodynamic pitching moment had the wrong sign.** It weathervaned the stone
   toward zero attack; thin-plate theory (centre of pressure at quarter-chord) says
   pitch-UP, destabilising — which is why unspun plates tumble like falling cards and
   why the Sci Rep 2022 discs show attack GROWING through a skip. Sign flipped;
   magnitude reduced 0.2 → 0.05 because the destabilising form drags the emergent
   optimum attack angle below the validated 20° anchor at larger values.

3. **The pitchMomentScale calibration now fades out at low spin**
   (`gyroCalibrationSpin`, 12 rev/s). The effects it compensates — cavity suction,
   spray-root, unsteady added-mass — belong to gyro-stabilised planing; an unspun
   stone feels the raw integral and tumbles honestly.

### Verified clean (game profile — the ship configuration)

- 20° sits in the top band of the attack plateau; steep cutoff and speed floor hold.
- Spin gradient monotone 0 → 65 rev/s; zero spin and nose-down score 0.
- Lateral curve direction flips exactly with spin sign.
- Free flight conserves |L| to 4e-13 % and the nutation cone to 3e-13 deg.
- Assists inject no net energy: mechanical energy at successive liftoffs is
  non-increasing over a full run.
- Torque-order audit: hydro torque → calibration split → water damping → air terms;
  gravity acts at the CoM (no spurious torque); buoyancy righting arises from the
  panel integral.

### Known limitations confirmed by the audit

- **Non-spinning shallow-angle skipping of small discs is not reproduced.** Sci Rep
  2022: a 9 g, 3 cm disc at α=5° skips 4–7 times unspun; we tumble or dive at any
  calibration. Same §11.4 attitude-overdrive root cause. Regime is far outside
  gameplay inputs.
- **In the game profile the effective optimum attack is 10–15°, not 20°.** The assist
  removes the stability penalty of shallow attack, and shallow attack genuinely loses
  less energy per bounce (9–11% vs 19%). Not scandalous — Bocquet's own max-bounce
  examples use θ=10°; the 20° magic is a minimum-bounce-SPEED result that dominates
  near the threshold — but players will discover 10–15° as the meta.
- `comOffset` shifts the centre of mass without the parallel-axis inertia correction;
  fine at the default 0 and small offsets.
