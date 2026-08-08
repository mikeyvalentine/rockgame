/**
 * Procedural skin material for the customization lab.
 *
 * The arm rig has NO UVs, so the skin surface is applied by TRIPLANAR projection
 * (three world-plane samples blended by the surface normal) using the mesh's
 * object-space position — which is stable under skinning, so the pores don't swim
 * as the arm poses. It is one self-contained ShaderMaterial (not the PBR pipeline)
 * so the two customization axes live in one place:
 *
 *   • SKIN COLOUR — the photo diffuse is reduced to neutral pore/cell DETAIL and
 *     the chosen albedo is multiplied through it, so any colour (natural or not)
 *     reads cleanly and evenly. Driven by uSkinColor.
 *
 *   • AGE — one height field feeds a tangent-free derivative bump: the map's fine
 *     pores (uPore) PLUS procedural ridged-fbm MACRO WRINKLES (uWrinkle) that only
 *     appear with age. Age also ramps AO, roughness and a sallow desaturation, so
 *     the skin reads progressively older. See createSkinMaterial().setAge().
 *
 * Lighting is a compact hemispheric-ambient + one wrapped directional (skin reads
 * soft) with a roughness-driven spec — enough to judge colour and relief; this is
 * a preview surface, not the game renderer.
 */

import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// Register the skinning includes so #include<bonesDeclaration|bonesVertex> resolve.
import "@babylonjs/core/Shaders/ShadersInclude/bonesDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/bonesVertex";

const SKIN_DIR = "/assets/skin/";
const TEX = {
    albedo: "1K-human_skin_3_diffuseOriginal.jpg",
    normal: "1K-human_skin_3_normal.jpg",
    ao: "1K-human_skin_3_ao.jpg",
    height: "1K-human_skin_3_height.jpg",
    edge: "1K-human_skin_3_edge.jpg",
    rough: "1K-human_skin_3_smoothness.jpg", // note: SMOOTHNESS — inverted in shader
};

// A believable light→dark skin locus (sRGB). The tone slider interpolates these.
export const SKIN_LOCUS = ["#ffdcc4", "#f1c39b", "#dda579", "#bd8250", "#8d5524", "#5a3620"];

const VERTEX = /* glsl */`
precision highp float;
attribute vec3 position;
attribute vec3 normal;
#include<bonesDeclaration>
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vPosO;   // object-space position — the stable triplanar coordinate
varying vec3 vNorO;   // object-space normal — triplanar blend weights
varying vec3 vPosW;   // world position — lighting + derivative bump
varying vec3 vNorW;   // world normal — lit geometry normal
void main(void) {
    vPosO = position;
    vNorO = normalize(normal);
    mat4 finalWorld = world;
    #include<bonesVertex>
    vec4 wp = finalWorld * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNorW = normalize(mat3(finalWorld) * normal);
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */`
precision highp float;
varying vec3 vPosO;
varying vec3 vNorO;
varying vec3 vPosW;
varying vec3 vNorW;

uniform sampler2D albedoMap;
uniform sampler2D aoMap;
uniform sampler2D heightMap;
uniform sampler2D edgeMap;
uniform sampler2D roughMap;

uniform vec3  uSkinColor;    // chosen albedo (sRGB)
uniform float uTexScale;     // triplanar tiles per metre
uniform float uPore;         // fine-pore bump strength
uniform float uWrinkle;      // macro-wrinkle amount (age)
uniform float uWrinkleFreq;  // macro-wrinkle frequency
uniform float uAO;           // ambient-occlusion strength
uniform float uRough;        // roughness (0 smooth .. 1 rough)
uniform float uSpec;         // specular strength
uniform float uDesat;        // age desaturation / sallow shift
uniform vec3  uLightDir;     // world direction TO the light
uniform vec3  uLightColor;
uniform vec3  uSky;          // hemispheric ambient (up)
uniform vec3  uGround;       // hemispheric ambient (down)
uniform float uAmbient;
uniform vec3  uCameraPos;

// Triplanar sample of any sampler, using the shared uvs/weights below.
vec2 uvX, uvY, uvZ; vec3 bw;
#define TRI(s) (texture2D(s, uvX)*bw.x + texture2D(s, uvY)*bw.y + texture2D(s, uvZ)*bw.z)

float hash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
    vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i+vec3(0,0,0)), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s += a*vnoise(p); p*=2.02; a*=0.5; } return s; }
// Ridged fbm makes crease-like lines rather than blobs — reads as wrinkles.
float ridged(vec3 p){ return 1.0 - abs(2.0*fbm(p) - 1.0); }

void main(void) {
    vec3 nO = normalize(vNorO);
    bw = pow(abs(nO), vec3(4.0));
    bw /= (bw.x + bw.y + bw.z);
    uvX = vPosO.zy * uTexScale;
    uvY = vPosO.xz * uTexScale;
    uvZ = vPosO.xy * uTexScale;

    // --- height field: fine pores from the map + procedural macro wrinkles -----
    float poreH = TRI(heightMap).r - 0.5;
    float wrink = ridged(vPosO * uWrinkleFreq);
    float H = poreH * uPore + wrink * uWrinkle;

    // Tangent-free derivative bump (Mikkelsen): perturb the world normal by the
    // surface gradient of H — no UVs or tangents needed.
    vec3 N = normalize(vNorW);
    vec3 dpx = dFdx(vPosW), dpy = dFdy(vPosW);
    float dHx = dFdx(H), dHy = dFdy(H);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = (r1*dHx + r2*dHy) / max(abs(det), 1e-6);
    N = normalize(N - grad);

    // --- albedo: grayscale detail tinted by the chosen colour ------------------
    vec3 diff = TRI(albedoMap).rgb;
    float detail = dot(diff, vec3(0.299, 0.587, 0.114));
    vec3 albedo = uSkinColor * (0.72 + 0.5 * detail);
    // Age: pull toward a desaturated, slightly sallow tone.
    float g = dot(albedo, vec3(0.33));
    albedo = mix(albedo, vec3(g) * vec3(1.06, 1.0, 0.86), uDesat);

    // --- occlusion: map AO + wrinkle valleys + edge cavity ---------------------
    float ao = mix(1.0, TRI(aoMap).r, uAO);
    ao *= mix(1.0, TRI(edgeMap).r, 0.35 * uAO);
    ao *= mix(1.0, clamp(wrink + 0.35, 0.0, 1.0), uWrinkle * 0.8);

    // --- lighting: hemispheric ambient + one wrapped directional + spec --------
    vec3 L = normalize(uLightDir);
    vec3 V = normalize(uCameraPos - vPosW);
    vec3 Hh = normalize(L + V);
    float wrap = 0.5;
    float ndl = max((dot(N, L) + wrap) / (1.0 + wrap), 0.0);
    float hemi = 0.5 + 0.5 * N.y;
    vec3 ambient = mix(uGround, uSky, hemi) * uAmbient;
    float shin = mix(10.0, 60.0, 1.0 - uRough);
    float spec = pow(max(dot(N, Hh), 0.0), shin) * uSpec * (0.4 + 0.6 * ndl);

    vec3 color = albedo * ao * (ambient + uLightColor * ndl) + uLightColor * spec * ao;
    gl_FragColor = vec4(color, 1.0);
}
`;

function loadTex(scene, file) {
    const t = new Texture(SKIN_DIR + file, scene, false, false);
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    return t;
}

/** The active tone as a hex string — for the UI swatch. */
export function toneHex(t) { return toneColor(t).toHexString(); }

/** sRGB hex → Color3, and a lerp along the skin locus for the tone slider. */
function toneColor(t) {
    const n = SKIN_LOCUS.length - 1;
    const f = Math.min(0.999999, Math.max(0, t)) * n;
    const i = Math.floor(f);
    const a = Color3.FromHexString(SKIN_LOCUS[i]);
    const b = Color3.FromHexString(SKIN_LOCUS[Math.min(i + 1, n)]);
    return Color3.Lerp(a, b, f - i);
}

/**
 * Build the skin material. `skinned` meshes (the arm) get bone attributes and
 * matrices; a plain sphere leaves them off. Returns the material plus setters the
 * sliders call: setColor/setTone drive colour, setAge drives the whole age ramp.
 */
export function createSkinMaterial(scene, { skinned = false, boneCount = 0 } = {}) {
    const defines = skinned
        ? [`#define NUM_BONE_INFLUENCERS 4`, `#define BonesPerMesh ${boneCount + 1}`]
        : [`#define NUM_BONE_INFLUENCERS 0`];
    const attributes = skinned
        ? ["position", "normal", "matricesIndices", "matricesWeights"]
        : ["position", "normal"];
    const uniforms = [
        "world", "viewProjection",
        "uSkinColor", "uTexScale", "uPore", "uWrinkle", "uWrinkleFreq",
        "uAO", "uRough", "uSpec", "uDesat",
        "uLightDir", "uLightColor", "uSky", "uGround", "uAmbient", "uCameraPos",
    ];
    if (skinned) uniforms.push("mBones");

    const mat = new ShaderMaterial("skin", scene,
        { vertexSource: VERTEX, fragmentSource: FRAGMENT },
        { attributes, uniforms, samplers: ["albedoMap", "aoMap", "heightMap", "edgeMap", "roughMap"], defines });

    mat.setTexture("albedoMap", loadTex(scene, TEX.albedo));
    mat.setTexture("aoMap", loadTex(scene, TEX.ao));
    mat.setTexture("heightMap", loadTex(scene, TEX.height));
    mat.setTexture("edgeMap", loadTex(scene, TEX.edge));
    mat.setTexture("roughMap", loadTex(scene, TEX.rough));

    // Constant scene lighting for the preview.
    mat.setVector3("uLightDir", new Vector3(-0.4, 0.9, 0.5).normalize());
    mat.setColor3("uLightColor", new Color3(1.0, 0.97, 0.92));
    mat.setColor3("uSky", new Color3(0.55, 0.60, 0.68));
    mat.setColor3("uGround", new Color3(0.22, 0.20, 0.20));
    mat.setFloat("uAmbient", 0.9);

    // Bind the camera position (and, for the arm, the live bone matrices) per draw.
    mat.onBindObservable.add((mesh) => {
        const eff = mat.getEffect();
        if (!eff) return;
        eff.setVector3("uCameraPos", scene.activeCamera.globalPosition);
        if (skinned && mesh.skeleton) {
            eff.setMatrices("mBones", mesh.skeleton.getTransformMatrices(mesh));
        }
    });

    // --- customization state + setters --------------------------------------
    const state = {
        color: toneColor(0.35), // a default mid-fair tone
        age: 0,                 // 0 young .. 1 old
        texScale: 22,           // triplanar tiles per metre
    };

    function applyColor() { mat.setColor3("uSkinColor", state.color); }

    function applyAge() {
        const t = state.age;
        mat.setFloat("uPore", 0.010 + 0.045 * t);      // pores deepen with age
        mat.setFloat("uWrinkle", 0.006 * smooth(t));   // macro wrinkles emerge late
        mat.setFloat("uWrinkleFreq", 90 - 30 * t);     // and coarsen a little
        mat.setFloat("uAO", 0.45 + 0.75 * t);
        mat.setFloat("uRough", 0.42 + 0.4 * t);
        mat.setFloat("uSpec", 0.35 - 0.22 * t);
        mat.setFloat("uDesat", 0.30 * t);
    }
    function applyScale() { mat.setFloat("uTexScale", state.texScale); }
    const smooth = (x) => x * x * (3 - 2 * x);

    applyColor(); applyAge(); applyScale();

    return {
        material: mat,
        /** Natural-tone slider position, 0 (fair) .. 1 (deep). */
        setTone(t) { state.color = toneColor(t); applyColor(); },
        /** Any free colour (hex string or Color3). */
        setColor(c) { state.color = typeof c === "string" ? Color3.FromHexString(c) : c; applyColor(); },
        /** Age, 0 (young) .. 1 (old). Ramps pores, wrinkles, AO, roughness, tone. */
        setAge(t) { state.age = Math.min(1, Math.max(0, t)); applyAge(); },
        /** Triplanar detail scale (tiles per metre) — for tuning pore size. */
        setScale(v) { state.texScale = v; applyScale(); },
        state,
    };
}
