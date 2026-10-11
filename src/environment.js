// Image-based lighting: the San Giuseppe Bridge HDRI (Poly Haven, CC0; 1024x512, sun disc clamped)
// lights the whole scene through scene.environment and is what glass and paint reflect. The
// DirectionalLight from world.js stays the key light and the only shadow caster, so the HDRI's own
// sun is clamped away in the file (no double sun, no fireflies) and the light is balanced here.
//
// The HDRI never holds up the first frame: the scene starts with a stand-in environment rendered
// from the procedural sky (same sky colours, same ground brightness) and the HDRI is swapped in when
// it has arrived. If it can't be loaded (offline copy without it, odd host) the stand-in just stays.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { skyMaterial } from './world.js';

// The published artifact can't serve .hdr files; it gets the bytes base64-encoded in
// env/<name>.hdr.json ({ "hdr": "..." }), see scripts/make-artifact.mjs.
export const HDRI_URL = `${import.meta.env.BASE_URL}env/san_giuseppe_bridge_1k.hdr`;
// The HDRI's sun sits 0.0996 of a turn to the right of the image centre (u = 0.5996), 28.7 deg up.
const HDRI_SUN_U = 0.5996;

// Phones, tablets and small screens get the cheaper settings.
export const SMALL_DEVICE =
  matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 768;

// Light balance, in the HDRI's units (its clamped sky gives a horizontal irradiance of ~2.0).
// The sun gives ~2.6x the sky's irradiance on the ground, like the Blender scene
// (blender/complex/lighting.py), which keeps the shadow side blue-grey rather than black.
export const LIGHT = {
  env: 1.0, // scene.environmentIntensity
  sun: 7.5, // DirectionalLight intensity (irradiance on a surface facing the sun)
  exposure: 1.0,
  toneMapping: THREE.ACESFilmicToneMapping,
};

// ?debug&env=1&sun=7.5&exposure=1&tm=agx|aces&shadows=vsm|pcfsoft|pcf: try other settings without a rebuild
const DEBUG = new URLSearchParams(location.search);
if (DEBUG.has('debug')) {
  for (const k of ['env', 'sun', 'exposure']) if (DEBUG.has(k)) LIGHT[k] = +DEBUG.get(k);
  if (DEBUG.has('tm')) LIGHT.toneMapping = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping }[DEBUG.get('tm')];
}
const SHADOW_TYPE = { vsm: THREE.VSMShadowMap, pcf: THREE.PCFShadowMap, pcfsoft: THREE.PCFSoftShadowMap }[DEBUG.get('shadows')] ?? THREE.PCFSoftShadowMap;

export function setupRenderer(renderer) {
  renderer.toneMapping = LIGHT.toneMapping;
  renderer.toneMappingExposure = LIGHT.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = SHADOW_TYPE;
  // nothing in the scene moves, so the shadow map is only redrawn when something is shown, hidden,
  // added or removed (see Environment.update)
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
}

// Fit the sun's orthographic shadow camera tightly around `box` (world space) as seen from the sun.
export function fitSunShadow(sun, box, mapSize = SMALL_DEVICE ? 1024 : 2048) {
  const dir = sun.position.clone().sub(sun.target.position).normalize();
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  sun.target.position.copy(centre);
  sun.position.copy(centre).addScaledVector(dir, radius + 50);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  const view = new THREE.Matrix4().lookAt(sun.position, centre, new THREE.Vector3(0, 1, 0));
  view.setPosition(sun.position);
  view.invert();
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate(), p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
    lo.min(p);
    hi.max(p);
  }
  const cam = sun.shadow.camera;
  cam.left = lo.x;
  cam.right = hi.x;
  cam.bottom = lo.y;
  cam.top = hi.y;
  cam.near = Math.max(0.5, -hi.z - 5);
  // receivers beyond the box (shadows of the towers on the far side) are further from the sun
  cam.far = -lo.z + 150;
  cam.updateProjectionMatrix();
  if (sun.shadow.mapSize.x !== mapSize) {
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  // world size of a shadow-map texel, for the normal bias (half a texel kills acne on the facades)
  const texel = Math.max(hi.x - lo.x, hi.y - lo.y) / mapSize;
  sun.shadow.normalBias = Math.max(0.04, texel * 0.6);
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 3; // used by the PCF and VSM variants only (PCFSoft has a fixed kernel)
  sun.shadow.blurSamples = 10;
}

async function fetchHDR(url) {
  // low priority: the model is more important; the stand-in environment covers the wait
  const res = await fetch(url, { priority: 'low' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (url.endsWith('.json')) {
    const { hdr } = await res.json();
    return Uint8Array.from(atob(hdr), (c) => c.charCodeAt(0)).buffer;
  }
  return res.arrayBuffer();
}

export class Environment {
  constructor(renderer, scene, world) {
    this.renderer = renderer;
    this.scene = scene;
    this.world = world;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.state = 'fallback';
    this.shadowKey = '';

    // turn the HDRI about the vertical so that its sun lines up with ours. three.js looks an
    // equirectangular map up at u = atan2(d.z, d.x) / 2pi + 0.5 and turns the look-up direction
    // by -environmentRotation, so the rotation is the HDRI sun's angle minus ours.
    const s = world.sun.position.clone().sub(world.sun.target.position);
    const yaw = (HDRI_SUN_U - 0.5) * Math.PI * 2 - Math.atan2(s.z, s.x);
    scene.environmentRotation.set(0, yaw, 0);
    scene.environmentIntensity = LIGHT.env;
    world.sun.intensity = LIGHT.sun;
    world.sky.material.uniforms.intensity.value = LIGHT.env;

    // stand-in: the procedural sky with a sunlit ground, rendered into a PMREM (a few ms)
    const envScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), skyMaterial({ env: true }));
    envScene.add(dome);
    this.target = this.pmrem.fromScene(envScene, 0, 0.1, 100);
    dome.geometry.dispose();
    dome.material.dispose();
    scene.environment = this.target.texture;
  }

  // Load the HDRI in the background and swap it in. Resolves to true when it is in use.
  async loadHDRI(url = HDRI_URL) {
    try {
      const buffer = await fetchHDR(url);
      const loader = new RGBELoader().setDataType(THREE.HalfFloatType);
      const data = loader.parse(buffer);
      const tex = new THREE.DataTexture(data.data, data.width, data.height, THREE.RGBAFormat, data.type);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = true;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.needsUpdate = true;
      const target = this.pmrem.fromEquirectangular(tex);
      tex.dispose();
      this.target.dispose();
      this.target = target;
      this.scene.environment = target.texture;
      this.state = 'hdri';
      return true;
    } catch (err) {
      console.warn('HDRI not loaded, keeping the procedural sky environment:', err.message ?? err);
      this.state = 'fallback (HDRI failed)';
      return false;
    } finally {
      this.pmrem.dispose(); // frees its internal blur targets; the result targets stay
    }
  }

  // Call once per frame before rendering: redraws the (static) shadow map only when the set of
  // visible shadow casters has changed, e.g. floors hidden in the cut-away view or an interior added.
  update() {
    let n = 0, h = 0;
    this.scene.traverseVisible((o) => {
      if (o.castShadow && (o.isMesh || o.isInstancedMesh)) {
        n++;
        h = (h * 31 + o.id) | 0;
      }
    });
    const key = `${n}:${h}`;
    if (key !== this.shadowKey) {
      this.shadowKey = key;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }
}
