// Shore environment: sky/IBL, sun + fill light, sand, water, and the ground collider.
//
// The ground under the bed is flat, with gentle dunes starting well outside it.
// Nothing holds the pile in — no dish, no invisible walls — so it spreads to its
// own angle of repose, which is what a bank of pebbles actually looks like.

import {
  Color3,
  DirectionalLight,
  HDRCubeTexture,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  Quaternion,
  ShadowGenerator,
  Texture,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { fbm, makeNoise3D, mulberry32, smoothstep } from "./noise.js";
import { makeNoiseNormalTexture } from "./textures.js";

// Pointing *toward* the sun, matched to the sun in the HDR sky below. A key
// light that disagrees with the environment map is the fastest way to make a
// PBR scene look wrong: the stones would carry two sets of highlights and cast
// shadows away from the brightest part of the sky.
const SUN_DIR = [-0.35, 0.55, 0.42];
const duneNoise = makeNoise3D(mulberry32(9));

/**
 * Sand height at a point, in world units.
 * Flat under the bed, gentle dunes well outside it.
 */
export function shoreHeight(x, z, U, bedRadius) {
  const d = Math.hypot(x, z) / U; // metres from the centre
  // Mostly flat: dead flat out to two bed radii, then the faintest swell — 2 cm
  // over a couple of metres — just to keep the horizon from reading as a table.
  // Anything stronger and the far sand starts to look like a landscape rather
  // than a beach you are crouching on.
  const dunes = smoothstep(bedRadius * 2, bedRadius * 2 + 1.6, d);
  return fbm(duneNoise, (x / U) * 0.5, 0, (z / U) * 0.5, 3) * 0.02 * dunes * U;
}

/**
 * Push a ground mesh's vertices up onto the shore profile.
 *
 * The mesh MUST have been created with `updatable: true`. Babylon's Buffer.create
 * ignores updates to a non-updatable buffer entirely — no warning, no error — so
 * the displacement is dropped and the ground silently stays a flat plane. This
 * is only the visible sand now, but a dune that renders flat is still wrong, and
 * the failure is completely silent. Assert rather than trust.
 */
function displace(mesh, U, bedRadius) {
  const buffer = mesh.geometry?.getVertexBuffer(VertexBuffer.PositionKind);
  if (buffer && !buffer.isUpdatable()) {
    throw new Error(`${mesh.name}: positions are not updatable, displacement would be silently dropped`);
  }
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = shoreHeight(positions[i], positions[i + 2], U, bedRadius);
  }
  mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  mesh.createNormals(true);
}

/**
 * Static collision for the shore. Split out from buildEnvironment because it
 * touches no textures or DOM, so the headless settle test can build the same
 * ground the browser gets.
 */
export function buildGroundCollider(scene, { U, bedRadius }) {
  // A single box, top face exactly at y = 0.
  //
  // This used to be a 200x200 trimesh following the sand. That was necessary
  // when the sand had a dish in it, and it is actively harmful now that the
  // ground under the bed is flat: a convex hull resting across a grid of
  // triangles catches on the internal edges between them and gets kicked, so the
  // bed never comes to rest. Measured over 30 s of settling, the trimesh left
  // ~50 of 180 stones permanently moving and crept the pile outward from 21 cm
  // to 26 cm median radius with no sign of stopping. One box has no internal
  // edges, is exact for flat ground, and is cheaper besides.
  //
  // The dunes further out are scenery. A stone knocked that far has left, and
  // is allowed to stay left.
  const collider = new Mesh("sandCollider", scene);
  collider.position.set(0, -U * 0.5, 0);
  const groundShape = new PhysicsShapeBox(
    Vector3.Zero(), Quaternion.Identity(), new Vector3(U * 40, U, U * 40), scene
  );
  groundShape.material = { friction: 0.85, restitution: 0.02 };
  const groundBody = new PhysicsBody(collider, PhysicsMotionType.STATIC, false, scene);
  groundBody.shape = groundShape;

  // No rim walls. There used to be a ring of invisible boxes just outside the
  // dish; on flat ground they would stop the spreading pile dead along a perfect
  // circle, which looks far stranger than a few stones wandering off.
  //
  // No separate backstop either — nothing can get past a solid box.

  return collider;
}

export function buildEnvironment(scene, { U, bedRadius }) {
  scene.clearColor = new Color3(0.75, 0.79, 0.82).toColor4();

  // --- sky + image-based lighting ------------------------------------------
  // A real captured sky, the same one the babylon-water scene uses. It replaces
  // a procedurally painted cube: a photographed sky carries the soft gradient
  // and colour variation that make a rough dielectric like wet stone read as
  // real, which no analytic gradient does.
  //
  // An .hdr is LINEAR and high dynamic range — the sky sits around 1-3 while the
  // sun region runs far above that — so it must be tone-mapped, not clipped.
  // look.js applies ACES for exactly that reason.
  //
  // 512 is the cube size Babylon resamples the source into. The stones are rough
  // enough that the mip chain does the work and a larger cube buys nothing.
  const envTex = new HDRCubeTexture("/assets/sky/autumn_field_puresky_4k.hdr", scene, 512);
  scene.environmentTexture = envTex;
  scene.environmentIntensity = 1.0;

  // PBR skybox rather than a StandardMaterial one: it consumes the linear HDR
  // cube correctly and leaves tone mapping to the image processing stage, so the
  // sky and everything lit by it stay on one curve. Kept well inside
  // camera.maxZ — an oversized skybox forces a far plane that wrecks depth
  // precision for the stones, which are the whole point.
  const skybox = scene.createDefaultSkybox(envTex, true, U * 28, 0);
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  // --- lights ---------------------------------------------------------------
  const sun = new DirectionalLight("sun", new Vector3(-SUN_DIR[0], -SUN_DIR[1], -SUN_DIR[2]), scene);
  // Far enough out, and with a deep enough range, to cover the whole shore
  // rather than one spot: the sifting spots span about 5 m.
  sun.position = new Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]).scale(U * 8);
  sun.intensity = 3.2;
  sun.diffuse = new Color3(1.0, 0.96, 0.89);
  sun.shadowMinZ = U * 0.3;
  sun.shadowMaxZ = U * 26;
  // Aimed by hand rather than fitted to the casters. Auto-fitting stretches the
  // shadow map over everything that casts — here the whole 5 m shore plus its
  // gravel — so 2048 texels end up covering about 12 m, and the stones you are
  // actually crouched over get a handful of texels each. focusShadows narrows it
  // to whatever is being looked at.
  sun.autoUpdateExtends = false;

  // Much weaker than it was: the HDR sky now supplies the ambient this was
  // standing in for, and leaving both at full strength flattens the stones out.
  const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  fill.intensity = 0.2;
  fill.diffuse = new Color3(0.72, 0.80, 0.92);
  fill.groundColor = new Color3(0.38, 0.34, 0.29);

  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0006;
  shadows.normalBias = 0.004;
  shadows.darkness = 0.32;

  // --- ground ---------------------------------------------------------------
  // Poly Haven "coast sand 01": diffuse, OpenGL normal, and a standalone
  // greyscale roughness map. Note that this set has no ARM/ORM map, unlike the
  // pebble set it replaced, so roughness has to be pulled out of a plain
  // greyscale image and metalness kept off it — see the flags below.
  // AUDIT #B6: subdivisions 200 -> 48. The displacement is a centimetre-scale
  // dune field; 80k triangles rendered four times a frame (shadow, prepass,
  // beauty, scribble depth) bought nothing over ~9k. If the dunes ever visibly
  // facet, raise it before suspecting anything else.
  const ground = MeshBuilder.CreateGround(
    "shore", { width: U * 10, height: U * 10, subdivisions: 48, updatable: true }, scene
  );
  displace(ground, U, bedRadius);

  // ~83 cm per tile. Sand has no features to give away the repeat at this size,
  // and it puts the ripple detail an order of magnitude below the stones so the
  // ground reads as background.
  const TILE = 12;
  const tex = (file) => {
    const t = new Texture(`/assets/ground/${file}`, scene);
    t.uScale = t.vScale = TILE;
    return t;
  };
  const shoreMat = new PBRMaterial("shoreMat", scene);
  shoreMat.albedoTexture = tex("coast_sand_01_diff_1k.jpg");
  shoreMat.bumpTexture = tex("coast_sand_01_nor_gl_1k.jpg");
  shoreMat.invertNormalMapY = false; // OpenGL convention: +Y is up
  shoreMat.bumpTexture.level = 1.0;
  // A greyscale roughness map read through the metallic slot. Babylon defaults to
  // taking roughness from the alpha channel, and metalness from blue — both wrong
  // here: a JPEG has no alpha, and blue holds the roughness value, so leaving
  // that flag on would make the wet-looking parts of the sand read as metal.
  shoreMat.metallicTexture = tex("coast_sand_01_rough_1k.jpg");
  shoreMat.useRoughnessFromMetallicTextureAlpha = false;
  shoreMat.useRoughnessFromMetallicTextureGreen = true;
  shoreMat.useMetallnessFromMetallicTextureBlue = false;
  shoreMat.useAmbientOcclusionFromMetallicTextureRed = false;
  shoreMat.metallic = 0;
  shoreMat.environmentIntensity = 0.8;
  ground.material = shoreMat;
  ground.receiveShadows = true;
  ground.isPickable = false;
  ground.freezeWorldMatrix();

  buildGroundCollider(scene, { U, bedRadius });

  // --- water ----------------------------------------------------------------
  const water = MeshBuilder.CreateGround("water", { width: U * 26, height: U * 14, subdivisions: 1 }, scene);
  water.position.set(0, -U * 0.02, U * 7.5);
  const waterMat = new PBRMaterial("waterMat", scene);
  waterMat.albedoColor = new Color3(0.06, 0.13, 0.15);
  waterMat.metallic = 0.05;
  waterMat.roughness = 0.08;
  waterMat.environmentIntensity = 1.1;
  waterMat.alpha = 0.92;
  const ripple = makeNoiseNormalTexture(scene, { size: 256, freq: 5, octaves: 3, strength: 0.9, seed: 55 });
  ripple.uScale = ripple.vScale = 22;
  waterMat.bumpTexture = ripple;
  waterMat.invertNormalMapY = true;
  water.material = waterMat;
  water.isPickable = false;
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() * 0.00002;
    ripple.uOffset = t;
    ripple.vOffset = t * 0.6;
  });

  // Tone mapping and ambient occlusion live in look.js — they are one
  // multiplicative chain and tuning them from two files is how you end up unable
  // to say why the scene is dark.

  /**
   * Point the shadow map at a place. `halfSize` is in metres — the map covers a
   * square that wide centred on `centre`, so smaller means sharper.
   */
  function focusShadows(centre, halfSize) {
    const h = halfSize * U;
    sun.orthoLeft = -h;
    sun.orthoRight = h;
    sun.orthoBottom = -h;
    sun.orthoTop = h;
    const at = centre ?? Vector3.Zero();
    sun.position.set(
      at.x + SUN_DIR[0] * U * 8,
      at.y + SUN_DIR[1] * U * 8,
      at.z + SUN_DIR[2] * U * 8
    );
  }
  focusShadows(null, 4.5);

  return { sun, fill, shadows, ground, water, skybox, focusShadows };
}
