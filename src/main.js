import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RESIDENTIAL, STATUS, toScene, towerByKey } from './config.js';
import { apartments, aptsOnFloor } from './data.js';
import { buildWorld } from './world.js';
import { loadComplex } from './building.js';
import { buildFloor } from './floor.js';
import { WalkControls } from './walk.js';
import { Environment, fitSunShadow, setupRenderer } from './environment.js';
import { drawPlan, planTransform } from './plan.js';

const $ = (s) => document.querySelector(s);
const roomsText = (n) => `${n}-room`;
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
setupRenderer(renderer); // tone mapping, exposure, soft shadows (environment.js)
$('#stage').appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 6000);
// the aerial view of the marketing render: from the land side, river and bridge behind
const HOME = { pos: new THREE.Vector3(-12, 150, 190), target: new THREE.Vector3(5, 28, -5) };
// what casts the sun's shadows: the towers, podium, hotel wing and the nearby trees (scene metres)
const SHADOW_BOX = new THREE.Box3(new THREE.Vector3(-85, 0, -65), new THREE.Vector3(90, 86, 105));
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 480;
controls.maxPolarAngle = Math.PI * 0.48;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;

const world = buildWorld(scene);
// light and reflections from the HDRI (a procedural sky stands in until it has loaded)
const env = new Environment(renderer, scene, world);
fitSunShadow(world.sun, SHADOW_BOX);
requestAnimationFrame(() => env.loadHDRI());
const walk = new WalkControls(camera, canvas);

let building = null; // set once the model has loaded
const loadingEl = $('#loading');
loadComplex(apartments, (k) => (loadingEl.querySelector('b').textContent = `${Math.round(k * 100)}%`))
  .then((b) => {
    building = b;
    scene.add(b.group);
    loadingEl.hidden = true;
    refresh();
  })
  .catch((err) => {
    console.error(err);
    loadingEl.textContent = 'Could not load the 3D model.';
  });

// ---------- state ----------
const state = {
  mode: 'overview', // overview | floor | walk
  tower: null, // open tower + floor in the floor view
  floor: null,
  listTower: RESIDENTIAL[0].key, // tower shown in the floor list
  hoverHotel: false,
  apt: null,
  hoverApt: null,
  filter: { rooms: 0, availableOnly: false },
};
let dollhouse = []; // interiors shown in the cut-away floor view
let walkInterior = null;
let lastInteraction = performance.now();

const sameFloor = (a, b) => a && b && a.tower === b.tower && a.floor === b.floor;
const isOpen = (a) => a.tower === state.tower && a.floor === state.floor;
const filterActive = () => state.filter.rooms > 0 || state.filter.availableOnly;
const matches = (a) =>
  (!state.filter.rooms || a.rooms === state.filter.rooms) && (!state.filter.availableOnly || a.status === 'available');

// ---------- camera flights ----------
let tween = null;
function flyTo(pos, target, dur = 1.1) {
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), t: 0, dur };
  controls.enabled = false;
}
function azimuth() {
  return Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
}
function floorCentre(tower, floor) {
  const list = aptsOnFloor(tower, floor);
  const c = new THREE.Vector3();
  for (const a of list) c.add(building.units.get(a.id).center);
  return c.divideScalar(list.length);
}
function floorView(tower, floor) {
  const target = floorCentre(tower, floor);
  const az = azimuth();
  return { pos: target.clone().add(new THREE.Vector3(Math.sin(az) * 30, 44, Math.cos(az) * 30)), target };
}
function aptView(apt) {
  const c = building.units.get(apt.id).center;
  const target = new THREE.Vector3(c.x, c.y + 0.5, c.z);
  // from outside the facade, in line with the tower's centre and the apartment
  const t = towerByKey[apt.tower], tc = toScene(t.centre[0], t.centre[1]);
  const dir = new THREE.Vector3(c.x - tc.x, 0, c.z - tc.z).normalize();
  return { pos: target.clone().add(dir.multiplyScalar(22)).add(new THREE.Vector3(0, 26, 0)), target };
}

// ---------- overlays ----------
function updateOverlays() {
  if (!building) return;
  if (building.hotelPick) {
    const hp = building.hotelPick;
    hp.visible = state.hoverHotel && state.mode !== 'walk';
    hp.material.color.setHex(0xffffff);
    hp.material.opacity = 0.3;
  }
  for (const a of apartments) {
    const u = building.units.get(a.id);
    let show = false, color = 0xffffff, op = 0, edges = false;
    if (state.mode === 'overview') {
      if (sameFloor(state.hoverApt, a)) {
        show = true; op = 0.4; edges = true;
        color = a === state.hoverApt ? 0xffffff : 0xdfeaf3;
      } else if (filterActive() && matches(a)) {
        show = true; color = STATUS[a.status].color; op = 0.5;
      }
    } else if (state.mode === 'floor') {
      if (isOpen(a)) {
        show = true; edges = true; color = STATUS[a.status].color;
        op = a === state.apt ? 0.3 : a === state.hoverApt ? 0.22 : 0.08;
        if (filterActive() && !matches(a)) op = 0.02;
      } else if (sameFloor(state.hoverApt, a)) {
        show = true; op = 0.35;
      }
    }
    u.overlay.visible = show;
    u.overlay.material.color.setHex(color);
    u.overlay.material.opacity = op;
    u.edges.visible = show && edges;
    u.edges.material.color.setHex(state.mode === 'floor' ? color : 0xffffff);
  }
}

// ---------- labels over apartments in floor view ----------
const labelsEl = $('#labels');
let labels = [];
function buildLabels() {
  labelsEl.innerHTML = '';
  labels = [];
  if (state.mode !== 'floor') return;
  for (const a of aptsOnFloor(state.tower, state.floor)) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.style.borderColor = STATUS[a.status].css;
    el.innerHTML = `<b>No. ${a.number}</b> <span>· ${roomsText(a.rooms)} · ${a.area} m²</span><br>${money.format(a.price)}`;
    el.onclick = () => selectApt(a);
    el.onpointerenter = () => setHover(a);
    el.onpointerleave = () => setHover(null);
    labelsEl.appendChild(el);
    labels.push({ el, apt: a });
  }
}
const tmp = new THREE.Vector3();
function updateLabels() {
  for (const { el, apt } of labels) {
    // tag above the apartment, pushed out from the tower's centre so neighbours don't overlap
    const u = building.units.get(apt.id);
    const t = towerByKey[apt.tower], tc = toScene(t.centre[0], t.centre[1]);
    const dx = u.center.x - tc.x, dz = u.center.z - tc.z, d = Math.hypot(dx, dz) || 1;
    tmp.set(u.center.x + (dx / d) * 9, u.top + 0.6, u.center.z + (dz / d) * 9).project(camera);
    const hidden = tmp.z > 1 || (filterActive() && !matches(apt));
    el.style.display = hidden ? 'none' : '';
    el.style.left = `${((tmp.x + 1) / 2) * innerWidth}px`;
    el.style.top = `${((1 - tmp.y) / 2) * innerHeight}px`;
    el.classList.toggle('hover', apt === state.hoverApt);
  }
}

// ---------- UI panels ----------
function statusChip(a) {
  const s = STATUS[a.status];
  return `<span class="status" style="color:${s.css}"><i style="background:${s.css}"></i>${s.label}</span>`;
}

function renderFloors() {
  const t = towerByKey[state.listTower];
  let html = `<div class="tower-tabs">${RESIDENTIAL.map((r) =>
    `<button data-tower="${r.key}" class="${r.key === t.key ? 'on' : ''}">${r.label}</button>`).join('')}</div>
    <button class="overview-btn" data-act="overview">⌂ Whole complex</button><h3>${t.label} · floors</h3>`;
  for (const { floor: f } of [...t.floors].reverse()) {
    const list = aptsOnFloor(t.key, f);
    const avail = list.filter((a) => a.status === 'available' && matches(a)).length;
    const dots = list.map((a) => `<i class="${matches(a) ? '' : 'dim'}" style="background:${STATUS[a.status].css}"></i>`).join('');
    const active = state.mode !== 'overview' && state.tower === t.key && state.floor === f;
    html += `<button class="floor-btn ${active ? 'active' : ''}" data-floor="${f}">
      <span class="num">${f}</span>
      <span class="meta">${avail} available<span class="dots">${dots}</span></span>
    </button>`;
  }
  html += `<button class="floor-btn lobby" disabled><span class="num">1–${t.floors[0].floor - 1}</span><span class="meta">Lobby & retail</span></button>`;
  $('#floors').innerHTML = html;
}
$('#floors').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'overview') goOverview();
  else if (b.dataset.tower) {
    state.listTower = b.dataset.tower;
    renderFloors();
  } else if (b.dataset.floor) selectFloor(state.listTower, +b.dataset.floor);
});

function renderSide() {
  const side = $('#side');
  if (state.mode === 'overview') {
    const avail = apartments.filter((a) => a.status === 'available');
    const from = Math.min(...avail.map((a) => a.price));
    const areas = apartments.map((a) => a.area);
    side.innerHTML = `
      <h2>Choose your apartment</h2>
      <div class="sub">${RESIDENTIAL.length} residential towers · ${apartments.length} apartments · ${Math.min(...apartments.map((a) => a.rooms))}–${Math.max(...apartments.map((a) => a.rooms))} rooms</div>
      <div class="stats">
        <div class="stat"><b>${avail.length}</b><span>available</span></div>
        <div class="stat"><b>${money.format(from / 1000)}k</b><span>price from</span></div>
        <div class="stat"><b>${Math.min(...areas)}–${Math.max(...areas)}</b><span>m²</span></div>
      </div>
      <div class="label">Rooms</div>
      <div class="seg" data-filter="rooms">
        ${[0, ...new Set(apartments.map((a) => a.rooms))].sort().map((r) => `<button data-v="${r}" class="${state.filter.rooms === r ? 'on' : ''}">${r ? roomsText(r) : 'All'}</button>`).join('')}
      </div>
      <label class="toggle"><input type="checkbox" id="only-avail" ${state.filter.availableOnly ? 'checked' : ''}/> Show available only</label>
      <div class="note">Hover over a tower to see each floor, then click to look inside. Block A is the hotel. ${filterActive() ? 'Matching apartments are highlighted on the building.' : ''}</div>`;
  } else if (state.mode === 'floor' && !state.apt) {
    const list = aptsOnFloor(state.tower, state.floor);
    side.innerHTML = `
      <button class="back" data-act="overview">← Whole complex</button>
      <h2>${towerByKey[state.tower].label} · Floor ${state.floor}</h2>
      <div class="sub">${list.filter((a) => a.status === 'available').length} of ${list.length} apartments available</div>
      <div class="apt-list">
        ${list.map((a) => `
          <button class="apt-row ${filterActive() && !matches(a) ? 'muted' : ''}" data-apt="${a.id}">
            <span class="t">No. ${a.number}</span><span class="p">${money.format(a.price)}</span>
            <span class="d">${roomsText(a.rooms)} · ${a.area} m² · ${a.view}</span><span>${statusChip(a)}</span>
          </button>`).join('')}
      </div>
      <div class="note">Click an apartment on the model or in this list.</div>`;
  } else if (state.mode === 'floor' && state.apt) {
    const a = state.apt;
    side.innerHTML = `
      <button class="back" data-act="floor">← Floor ${a.floor}</button>
      <h2>Apartment No. ${a.number}</h2>
      <div class="sub">${a.towerLabel} · Floor ${a.floor}</div>
      <div>${statusChip(a)}</div>
      <canvas class="plan"></canvas>
      <div class="specs">
        <div><span>Rooms</span><b>${a.rooms}</b></div>
        <div><span>Total area</span><b>${a.area} m²</b></div>
        <div><span>Floor</span><b>${a.floor} of ${a.floors}</b></div>
        <div><span>Ceiling height</span><b>${a.ceiling} m</b></div>
        <div style="grid-column: span 2"><span>Layout</span><b>${a.summary}${a.balcony ? `, balcony ${a.balcony} m²` : ''}</b></div>
        <div style="grid-column: span 2"><span>View</span><b>${a.view}</b></div>
      </div>
      <div class="price">${money.format(a.price)}</div>
      <div class="ppm">${money.format(Math.round(a.price / a.area))} per m²</div>
      <div class="actions">
        <button class="btn primary" data-act="walk">🚶 Walk inside in 3D</button>
        <button class="btn" data-act="request">Request a viewing</button>
      </div>`;
    drawPlan(side.querySelector('.plan'), a);
  }
}
$('#side').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'overview') goOverview();
  else if (b.dataset.act === 'floor') selectFloor(state.tower, state.floor);
  else if (b.dataset.act === 'walk') enterWalk(state.apt);
  else if (b.dataset.act === 'request') toast('Demo: this would send the request to the sales team.');
  else if (b.dataset.apt) selectApt(apartments.find((a) => a.id === b.dataset.apt));
  else if (b.dataset.v !== undefined) {
    state.filter.rooms = +b.dataset.v;
    refresh();
  }
});
$('#side').addEventListener('change', (e) => {
  if (e.target.id === 'only-avail') {
    state.filter.availableOnly = e.target.checked;
    refresh();
  }
});
$('#side').addEventListener('pointerover', (e) => {
  const row = e.target.closest('[data-apt]');
  setHover(row ? apartments.find((a) => a.id === row.dataset.apt) : null);
});
$('#side').addEventListener('pointerleave', () => setHover(null));

function refresh() {
  renderFloors();
  renderSide();
  updateOverlays();
  $('#hint').textContent =
    state.mode === 'overview' ? 'Drag to rotate · Scroll to zoom · Click a floor' : 'Click an apartment · Drag to rotate · Scroll to zoom';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function setHover(a) {
  if (state.hoverApt === a) return;
  state.hoverApt = a;
  updateOverlays();
  document.querySelectorAll('.apt-row').forEach((r) => r.classList.toggle('hover', a && r.dataset.apt === a.id));
}

// ---------- navigation ----------
function clearDollhouse() {
  dollhouse.forEach((d) => d.dispose());
  dollhouse = [];
}

function goOverview() {
  clearDollhouse();
  building?.showAll();
  Object.assign(state, { mode: 'overview', tower: null, floor: null, apt: null, hoverApt: null });
  buildLabels();
  flyTo(HOME.pos, HOME.target, 1.3);
  refresh();
}

function selectFloor(tower, floor) {
  if (!building) return;
  if (state.tower !== tower || state.floor !== floor || state.mode !== 'floor') {
    clearDollhouse();
    building.showUpTo(tower, floor);
    const d = buildFloor(tower, floor, aptsOnFloor(tower, floor));
    scene.add(d.group);
    dollhouse.push(d);
  }
  Object.assign(state, { mode: 'floor', tower, floor, listTower: tower, apt: null, hoverHotel: false });
  controls.autoRotate = false;
  const v = floorView(tower, floor);
  flyTo(v.pos, v.target);
  buildLabels();
  refresh();
}

function selectApt(a) {
  if (state.mode !== 'floor' || !isOpen(a)) selectFloor(a.tower, a.floor);
  state.apt = a;
  const v = aptView(a);
  flyTo(v.pos, v.target);
  refresh();
}

function fade(fn) {
  const f = $('#fade');
  f.classList.add('on');
  setTimeout(() => {
    fn();
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  }, 380);
}

function enterWalk(a) {
  fade(() => {
    clearDollhouse();
    labelsEl.innerHTML = '';
    labels = [];
    building.showAll(a.tower, a.floor);
    walkInterior = buildFloor(a.tower, a.floor, aptsOnFloor(a.tower, a.floor), a);
    scene.add(walkInterior.group);
    state.mode = 'walk';
    state.hoverApt = null;
    updateOverlays();
    tween = null;
    controls.enabled = false;
    camera.fov = 72;
    camera.near = 0.05;
    camera.updateProjectionMatrix();
    walk.start(walkInterior, scene);
    $('#ext-ui').hidden = true;
    $('#walk-ui').hidden = false;
    $('#walk-title').innerHTML = `<b>No. ${a.number}</b> · ${roomsText(a.rooms)} · ${a.area} m² · Floor ${a.floor} · ${money.format(a.price)}`;
    prepareMinimap(a);
  });
}

function exitWalk() {
  const a = walkInterior.apt;
  fade(() => {
    walk.stop();
    walkInterior.dispose();
    walkInterior = null;
    camera.fov = 38;
    camera.near = 0.5;
    camera.updateProjectionMatrix();
    controls.enabled = true;
    $('#ext-ui').hidden = false;
    $('#walk-ui').hidden = true;
    state.mode = 'overview';
    selectFloor(a.tower, a.floor);
    selectApt(a);
    const v = aptView(a);
    camera.position.copy(v.pos);
    controls.target.copy(v.target);
    tween = null;
    controls.enabled = true;
  });
}
$('#exit-walk').onclick = exitWalk;
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (state.mode === 'walk') exitWalk();
    else if (state.mode === 'floor' && state.apt) selectFloor(state.tower, state.floor);
    else if (state.mode === 'floor') goOverview();
  }
});

// ---------- mini-map ----------
const mini = $('#minimap canvas');
let miniBg = null, miniT = null;
function prepareMinimap(a) {
  const off = document.createElement('canvas');
  off.width = mini.clientWidth; // drawPlan sizes by CSS px when the canvas isn't in the page
  off.height = mini.clientHeight;
  drawPlan(off, a, { pad: 6, labels: false });
  miniBg = off;
  miniT = planTransform(a, mini.clientWidth, mini.clientHeight, 6);
}
function drawMinimap() {
  if (!miniBg || !walk.enabled) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = mini.clientWidth, h = mini.clientHeight;
  if (mini.width !== Math.round(w * dpr)) {
    mini.width = Math.round(w * dpr);
    mini.height = Math.round(h * dpr);
  }
  const g = mini.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, mini.width, mini.height);
  g.drawImage(miniBg, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = walk.localState();
  const x = miniT.px(s.x), y = miniT.py(s.y);
  const ang = Math.atan2(-s.dy, s.dx);
  g.fillStyle = 'rgba(31, 95, 139, 0.25)';
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y, 30, ang - 0.6, ang + 0.6);
  g.closePath();
  g.fill();
  g.fillStyle = '#1f5f8b';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 5, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

// ---------- joystick (touch screens) ----------
const joy = $('#joystick'), knob = joy.querySelector('.knob');
let joyId = null;
const joyMove = (e) => {
  const r = joy.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 10, d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  walk.setJoystick(dx / max, dy / max);
};
joy.addEventListener('pointerdown', (e) => { joyId = e.pointerId; joy.setPointerCapture(joyId); joyMove(e); });
joy.addEventListener('pointermove', (e) => e.pointerId === joyId && joyMove(e));
const joyEnd = () => { joyId = null; knob.style.transform = ''; walk.setJoystick(0, 0); };
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);
addEventListener('pointerdown', (e) => {
  lastInteraction = performance.now();
  if (e.pointerType === 'touch') document.body.classList.add('touch');
});
addEventListener('wheel', () => (lastInteraction = performance.now()), { passive: true });

// ---------- picking on the building ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tooltip = $('#tooltip');
// What is under the pointer: { apt } for an apartment, { hotel } for the hotel tower, or null.
function pick(e) {
  if (!building) return null;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hidden = (o) => {
    const a = o.userData.apt;
    return state.mode === 'floor' && a && a.tower === state.tower && a.floor > state.floor;
  };
  const hit = ray.intersectObjects(building.pickables.filter((o) => !hidden(o)), false)[0];
  return hit ? hit.object.userData : null;
}
function setHoverHotel(on) {
  if (state.hoverHotel === on) return;
  state.hoverHotel = on;
  updateOverlays();
}
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointermove', (e) => {
  if (state.mode === 'walk' || e.pointerType === 'touch') return;
  if (e.buttons) {
    tooltip.style.opacity = 0;
    return;
  }
  const hit = pick(e);
  const a = hit?.apt ?? null;
  setHover(a);
  setHoverHotel(!!hit?.hotel && state.mode === 'overview');
  canvas.style.cursor = a ? 'pointer' : '';
  const place = () => {
    tooltip.style.left = `${e.clientX + 16}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
    tooltip.style.opacity = 1;
  };
  if (a && (state.mode === 'overview' || !isOpen(a))) {
    const list = aptsOnFloor(a.tower, a.floor);
    const avail = list.filter((x) => x.status === 'available');
    const from = avail.length ? `from ${money.format(Math.min(...avail.map((x) => x.price)))}` : 'sold out';
    tooltip.innerHTML = `<b>${a.towerLabel} · Floor ${a.floor}</b><br>${avail.length} of ${list.length} available · ${from}`;
    place();
  } else if (hit?.hotel && state.mode === 'overview') {
    tooltip.innerHTML = `<b>${hit.hotel.label}</b><br>Hotel · ${hit.hotel.levels} floors`;
    place();
  } else tooltip.style.opacity = 0;
});
canvas.addEventListener('pointerleave', () => {
  tooltip.style.opacity = 0;
  if (state.mode !== 'walk') {
    setHover(null);
    setHoverHotel(false);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (state.mode === 'walk' || !down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6;
  down = null;
  if (moved) return;
  const hit = pick(e);
  if (hit?.hotel && state.mode === 'overview') return toast(`${hit.hotel.label} is the hotel; its rooms are not part of this sale.`);
  const a = hit?.apt;
  if (!a) return;
  tooltip.style.opacity = 0;
  if (state.mode === 'overview' || !isOpen(a)) selectFloor(a.tower, a.floor);
  else selectApt(a);
});

// ---------- loop ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (tween) {
    tween.t += dt;
    const k = ease(Math.min(1, tween.t / tween.dur));
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    controls.target.lerpVectors(tween.t0, tween.t1, k);
    if (k >= 1) {
      tween = null;
      controls.enabled = true;
    }
  }
  if (state.mode === 'walk') {
    walk.update(dt);
    drawMinimap();
  } else {
    // idle "attract mode" for showroom screens
    controls.autoRotate = state.mode === 'overview' && performance.now() - lastInteraction > 20000;
    if (!tween) controls.update();
    else camera.lookAt(controls.target);
    if (building) updateLabels();
  }
  env.update();
  renderer.render(scene, camera);
});

refresh();
// start slowly spinning right away
lastInteraction = -1e9;

// ?debug exposes the viewer for automated screenshots and measurements
if (new URLSearchParams(location.search).has('debug')) {
  window.__viewer = {
    renderer, scene, camera, controls, world, env,
    get building() { return building; },
    envState: () => env.state,
    hold() { lastInteraction = performance.now() + 1e9; }, // no idle auto-rotation
  };
}
