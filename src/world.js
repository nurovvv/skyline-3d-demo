// Sky, sun, trees, cars and people. Ground, roads, river and neighbours come with the model.
// Image-based light and reflections (the HDRI) are set up in environment.js.
import * as THREE from 'three';
import { CARS, PEOPLE, TREES, toScene } from './config.js';
import { addCars, addPeople, addTrees } from './props.js';

// Morning sun from the east-south-east, like on the marketing renders and in the Blender scene
// (blender/complex/lighting.py): compass azimuth 112 deg, 38 deg up.
export const SUN = { azimuth: 112, elevation: 38, color: new THREE.Color().setRGB(1.0, 0.925, 0.83) };
export function sunDirection(az = SUN.azimuth, el = SUN.elevation) {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  // site x east, y north -> scene x east, z south (see toScene), y up
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

// The visible sky (and the stand-in environment until the HDRI has loaded): a clear morning sky in
// the HDRI's units (its zenith, a hazy horizon and the glow around the sun, measured on
// san_giuseppe_bridge_2k.hdr), scaled by `intensity` and tone-mapped like the rest of the scene.
// Near and below the horizon it fades into the fog colour, so distant ground melts into the haze.
// With ENV_PASS defined it renders the environment instead: no sun disc, no fog, a sunlit ground below.
const SKY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 ground;
  uniform float intensity;
  varying vec3 vWorld;
  #ifdef USE_FOG
    uniform vec3 fogColor;
  #endif
  void main() {
    #ifdef ENV_PASS
      vec3 dir = normalize(vWorld);
    #else
      vec3 dir = normalize(vWorld - cameraPosition);
    #endif
    float e = dir.y;
    vec3 col = mix(zenith, horizon, pow(1.0 - clamp(e, 0.0, 1.0), 5.0));
    float a = acos(clamp(dot(dir, sunDir), -1.0, 1.0));
    // aureole: the HDRI's sky is ~5.5 brighter 5 deg from the sun, ~2 at 20 deg, ~0.3 at 45 deg
    col += sunColor * (7.0 * exp(-a / 0.24) + 0.25 * exp(-a / 0.9));
    #ifdef ENV_PASS
      // the HDRI's ground: sunlit pale stone (its sun disc is clamped the same way, see environment.js)
      col = mix(col, ground, smoothstep(0.02, -0.06, e));
    #else
      col += sunColor * 60.0 * smoothstep(0.0062, 0.0042, a); // the sun disc, ~0.55 deg
    #endif
    gl_FragColor = vec4(col * intensity, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #if defined( USE_FOG ) && !defined( ENV_PASS )
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 1.0 - smoothstep(-0.01, 0.16, e));
    #endif
  }`;

export function skyMaterial({ env = false } = {}) {
  return new THREE.ShaderMaterial({
    name: env ? 'Sky (environment)' : 'Sky',
    side: THREE.BackSide,
    depthWrite: false,
    fog: !env,
    defines: env ? { ENV_PASS: '' } : {},
    uniforms: {
      ...(env ? {} : THREE.UniformsUtils.clone(THREE.UniformsLib.fog)),
      sunDir: { value: sunDirection() },
      sunColor: { value: SUN.color.clone() },
      zenith: { value: new THREE.Color().setRGB(0.17, 0.26, 0.46) },
      horizon: { value: new THREE.Color().setRGB(0.5, 0.58, 0.68) },
      ground: { value: new THREE.Color().setRGB(0.3, 0.25, 0.19) },
      intensity: { value: 1 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
  });
}

export function buildWorld(scene) {
  // sky dome (drawn first, behind everything)
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), skyMaterial());
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);
  sky.userData.isSky = true;
  // haze: the same colour the sky has at the horizon
  scene.fog = new THREE.Fog(0xd4dee8, 500, 1700);

  // the key light and the only shadow caster; the sky light comes from the environment map
  // (environment.js sets the intensities, fits the shadow camera and picks the shadow-map size)
  const sun = new THREE.DirectionalLight(SUN.color, 3);
  sun.position.copy(sunDirection()).multiplyScalar(250);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  // trees, cars and people (positions from the Blender build)
  addTrees(scene, TREES.protos, TREES.list, toScene);
  addCars(scene, CARS, toScene);
  addPeople(scene, PEOPLE, toScene);

  return { sun, sky };
}
