// The complex (three towers, podium, surroundings), loaded from the Blender export.
// Floors of every tower are separate objects so they can be hidden for the cut-away view,
// and every apartment has an invisible pick volume used for hovering and highlighting.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MODEL_URL, toScene, towerByKey } from './config.js';
import { groundTexture } from './textures.js';
import { FACADE_MAPS } from './facade_maps.js';

const GROUND = {
  Grass: 'grass', Lawn: 'grass', Asphalt: 'asphalt', Paving: 'paving', Sidewalk: 'paving', 'Deck paving': 'deck',
  Cobble: 'cobble', 'Deck stone': 'stone', 'Pool mosaic': 'mosaic', 'Copper screen': 'copper', 'Rubber blue': 'rubber',
  Promenade: 'promenade',
  ...FACADE_MAPS,
};
const groundTex = {};

// Glass stays opaque (no transparency sorting) and mirror-smooth; what it shows comes from the Fresnel
// reflection of the HDRI environment. Reflectance at normal incidence (F0) is that of coated double
// glazing rather than a single 4 % pane, so facades read as glass from afar like on the renders;
// at grazing angles Fresnel takes every pane to a full mirror of the sky. Water is n = 1.33 (2 %).
const GLASS_LOOK = {
  'Window glass': { f0: 0.09, roughness: 0.04 },
  'Curtain glass': { f0: 0.1, roughness: 0.03 },
  'Shop glass': { f0: 0.08, roughness: 0.04 },
  'Shop window': { f0: 0.07, roughness: 0.06 },
  'Gallery glass': { f0: 0.06, roughness: 0.08 },
  'Pool water': { f0: 0.02, roughness: 0.03 },
  River: { f0: 0.02, roughness: 0.14 },
};
const MATTE = new Set(['Leaves', 'Leaves light', 'Shrub', 'Grass', 'Lawn', 'Trunk', 'Embankment', 'Asphalt']);

function tuneMaterial(m) {
  const g = GROUND[m.name];
  if (g) {
    groundTex[g] ??= groundTexture(g);
    m.map = groundTex[g];
    m.color.set(0xffffff);
    m.needsUpdate = true;
  }
  const glass = GLASS_LOOK[m.name];
  if (glass) {
    m.metalness = 0;
    m.roughness = glass.roughness;
    m.transparent = false;
    if (m.isMeshPhysicalMaterial) {
      // F0 = ((ior - 1) / (ior + 1))^2 * specularColor = 0.04 * specularColor for ior 1.5
      m.ior = 1.5;
      m.specularIntensity = 1;
      m.specularColor.setScalar(glass.f0 / 0.04);
    }
    // a texture (facade_maps.js) carries its own look, e.g. rooms and curtains behind the pane;
    // plain panes keep the Blender tint, a little lighter as tinted glass looks in daylight
    if (!m.map && !['River', 'Pool water', 'Gallery glass'].includes(m.name)) m.color.offsetHSL(0, -0.03, 0.04);
  }
  if (m.name.startsWith('Stained')) m.emissiveIntensity = 0.25;
  if (m.name === 'Railing glass' || m.name === 'Railing glass dark' || m.name === 'Neighbour') {
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.roughness = Math.min(m.roughness, 0.05);
  }
  // metals: plausible anodised aluminium / steel, not chrome
  if (m.metalness >= 0.5) m.roughness = THREE.MathUtils.clamp(m.roughness, 0.28, 0.5);
  // solar panels are glass-covered cells, not metal
  if (m.name === 'Solar panel') {
    m.metalness = 0;
    m.roughness = 0.12;
  }
  // foliage, lawns, bark, earth and asphalt: no sheen (the environment's sky would shine off them)
  if (MATTE.has(m.name)) m.roughness = 1;
}

// The published artifact page can't serve .glb files, so it gets the same bytes base64-encoded
// in a JSON file ({ "glb": "..." }); everywhere else the .glb is loaded directly.
async function loadModel(loader, url, onProgress) {
  if (!url.endsWith('.json')) return loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const { glb } = await (await fetch(url)).json();
  const bytes = Uint8Array.from(atob(glb), (c) => c.charCodeAt(0));
  return loader.parseAsync(bytes.buffer, '');
}

export async function loadComplex(apartments, onProgress) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loadModel(loader, MODEL_URL, onProgress);
  const root = gltf.scene;
  const o = toScene(0, 0);
  root.position.set(o.x, 0, o.z);

  const towers = {}; // key -> { floors: { n: { slab, walls } }, roof }
  const tower = (k) => (towers[k] ??= { floors: {}, roof: null });
  const picks = [];
  const tuned = new Set();

  root.traverse((obj) => {
    const d = obj.userData;
    if (d.pick) {
      picks.push(obj);
      return;
    }
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      for (const m of [obj.material].flat()) {
        if (!tuned.has(m)) {
          tuneMaterial(m);
          tuned.add(m);
        }
        if (m.transparent) obj.castShadow = false;
      }
    }
    if (d.tower && d.part === 'roof') tower(d.tower).roof = obj;
    else if (d.tower && d.floor) {
      const f = (tower(d.tower).floors[d.floor] ??= {});
      f[d.part === 'walls' ? 'walls' : 'slab'] = obj;
    }
  });

  // pick volumes -> highlight overlays
  const units = new Map();
  let hotelPick = null;
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  for (const mesh of picks) {
    mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    mesh.renderOrder = 10;
    mesh.visible = false;
    mesh.castShadow = mesh.receiveShadow = false;
    const d = mesh.userData;
    if (d.hotel) {
      mesh.userData.hotel = towerByKey[d.tower];
      hotelPick = mesh;
      continue;
    }
    const id = `${d.tower}${d.floor}-${d.unit}`;
    const apt = apartments.find((a) => a.id === id);
    if (!apt) continue;
    mesh.userData.apt = apt;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 35),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.95 }),
    );
    edges.renderOrder = 11;
    edges.visible = false;
    mesh.add(edges);
    box.setFromObject(mesh);
    const c = box.getCenter(new THREE.Vector3());
    units.set(apt.id, { overlay: mesh, edges, center: new THREE.Vector3(c.x, apt.baseY, c.z), top: box.max.y });
  }

  const each = (fn) => {
    for (const [k, t] of Object.entries(towers)) {
      for (const [n, f] of Object.entries(t.floors)) fn(k, +n, f, t);
    }
  };
  const setVisible = (o, v) => o && (o.visible = v);

  return {
    group: root,
    towers,
    units,
    hotelPick,
    pickables: [...units.values()].map((u) => u.overlay).concat(hotelPick ? [hotelPick] : []),
    // Cut-away: hide everything above `floor` in `towerKey` and open up that floor.
    showUpTo(towerKey, floor) {
      each((k, n, f, t) => {
        const above = k === towerKey && n > floor;
        setVisible(f.slab, !above);
        setVisible(f.walls, !above && !(k === towerKey && n === floor));
        setVisible(t.roof, k !== towerKey);
      });
    },
    // Everything visible, except the walls of an apartment floor someone is walking around in.
    showAll(openTower = null, openFloor = null) {
      each((k, n, f, t) => {
        setVisible(f.slab, true);
        setVisible(f.walls, !(k === openTower && n === openFloor));
        setVisible(t.roof, true);
      });
    },
  };
}
