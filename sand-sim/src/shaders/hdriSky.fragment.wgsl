// Static HDRI skybox: one LUT lookup along the view ray.
//
// The LUT is a CPU-downsampled copy of the HDR equirect, in exactly the
// convention `dirToLatLong` expects — so the visible sky, the sand's ambient
// specular, the SH irradiance and the aerial-perspective inscatter all read
// the *same texture* through the *same mapping* and cannot disagree about
// where the sun is. The sun disc is baked into the HDRI and comes for free.

#include<snowNoise>
#include<snowAtmosphere>

varying vDir: vec3f;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform envIntensity: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let dir = normalize(input.vDir);
    let col = textureSample(skyLUT, skyLUTSampler, dirToLatLong(dir)).rgb;
    fragmentOutputs.color = vec4f(col * uniforms.envIntensity, 1.0);
}
