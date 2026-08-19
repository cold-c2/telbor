import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ------------------------------------------------------------------ config
const PIXEL_HEIGHT = 300;        // internal vertical resolution; width is derived from the
                                 // window aspect so pixels stay square and nothing stretches.
                                 // Lower = chunkier pixels. Raise toward 480 for a crisper look.
const FOG_COLOR  = 0xbdc2c0;     // pale desaturated grey-green haze
const SNAP_GRID  = 130.0;        // PS1 vertex-snap resolution (lower = jitterier)

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
renderer.setPixelRatio(1);
renderer.setSize(400, 300, false); // placeholder; real size set aspect-correct in onResize()
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.Fog(FOG_COLOR, 6, 46);

const camera = new THREE.PerspectiveCamera(68, 400 / 300, 0.1, 200);

// ------------------------------------------------------------------ lights (driven by the day/night cycle)
const hemi = new THREE.HemisphereLight(0xf2f4f2, 0x585850, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff6e6, 0.55);
sun.position.set(-8, 14, 6);
scene.add(sun);

// ------------------------------------------------------------------ PS1 material factory
// Patches a Lambert material to (a) snap vertices to a low-res grid in clip space
// and (b) keep textures point-sampled + fogged. Gives the jittery wobble.
function ps1Material(opts = {}) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = { value: SNAP_GRID };
    shader.vertexShader = "uniform float uSnap;\n" + shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
       vec4 snapPos = gl_Position;
       snapPos.xyz /= snapPos.w;
       snapPos.xy = floor(snapPos.xy * uSnap) / uSnap;
       snapPos.xyz *= snapPos.w;
       gl_Position = snapPos;`
    );
  };
  return m;
}

// ------------------------------------------------------------------ procedural muddy textures
function noiseTexture(base, spread, size = 32) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d");
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = (Math.random() - 0.5) * spread;
    const r = Math.max(0, Math.min(255, base[0] + n));
    const gg = Math.max(0, Math.min(255, base[1] + n));
    const b = Math.max(0, Math.min(255, base[2] + n));
    g.fillStyle = `rgb(${r|0},${gg|0},${b|0})`;
    g.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ terrain height + biome
// ONE shared height field, used by both the mesh and the analytic ground-follow.
function terrainHeight(x, z) {
  return Math.sin(x * 0.018) * 3.2 + Math.cos(z * 0.021) * 3.0   // big rolling hills
       + Math.sin(x * 0.05) * 0.8 + Math.cos(z * 0.06) * 0.7      // medium bumps
       + Math.sin((x + z) * 0.11) * 0.4;                          // fine ripple
}
const SNOW_START = 150, SNOW_FULL = 235;
function snowAmount(x, z) { const r = Math.hypot(x, z); return Math.max(0, Math.min(1, (r - SNOW_START) / (SNOW_FULL - SNOW_START))); }

// ------------------------------------------------------------------ ground (grass -> snow biome, vertex-colored)
const groundTex = noiseTexture([150, 150, 150], 34, 48);   // grey; vertex colors do the tinting
groundTex.repeat.set(95, 95);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(720, 720, 150, 150),
  ps1Material({ map: groundTex, vertexColors: true })
);
ground.rotation.x = -Math.PI / 2;
{
  const pos = ground.geometry.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const grass = new THREE.Color(0.34, 0.42, 0.22), snow = new THREE.Color(0.86, 0.9, 0.95);
  const tmpc = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), ly = pos.getY(i);
    const wx = lx, wz = -ly;                          // plane local -> world (rotation.x = -90°)
    pos.setZ(i, terrainHeight(wx, wz));
    tmpc.copy(grass).lerp(snow, snowAmount(wx, wz));
    col[i * 3] = tmpc.r; col[i * 3 + 1] = tmpc.g; col[i * 3 + 2] = tmpc.b;
  }
  ground.geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
  ground.geometry.computeVertexNormals();
}
scene.add(ground);

// ------------------------------------------------------------------ pine trees (cones + trunk)
const trunkMat = ps1Material({ map: noiseTexture([70, 52, 36], 30) });
const pineMat  = ps1Material({ map: noiseTexture([30, 48, 34], 26) });
function makePine() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 1.4, 5), trunkMat);
  trunk.position.y = 0.7; g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(1.5 - i * 0.35, 2.0, 6), pineMat);
    c.position.y = 1.6 + i * 1.15; g.add(c);
  }
  return g;
}
// --- extra tree species ---
const birchTrunkMat = ps1Material({ map: noiseTexture([222, 224, 220], 26) });
const birchLeafMat  = ps1Material({ map: noiseTexture([150, 168, 92], 30) });
const snowPineMat   = ps1Material({ map: noiseTexture([200, 210, 214], 20) });
function makePineTall(snowy) {                 // tall enough to walk under (canopy starts high)
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 3.6, 5), trunkMat);
  trunk.position.y = 1.8; g.add(trunk);
  const leaf = snowy ? snowPineMat : pineMat;
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(1.7 - i * 0.34, 2.1, 6), leaf);
    c.position.y = 3.4 + i * 1.25; g.add(c);
  }
  return g;
}
function makeBirch() {                          // thin white trunk, sparse canopy, walk under
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.2, 6), birchTrunkMat);
  trunk.position.y = 2.1; g.add(trunk);
  for (let i = 0; i < 2; i++) {
    const c = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 - i * 0.22, 0), birchLeafMat);
    c.position.y = 4.0 + i * 0.85; g.add(c);
  }
  return g;
}
// ------------------------------------------------------------------ world helpers
// analytic ground-follow (same field as the mesh) — no per-frame raycasting needed
function groundHeight(x, z) { return terrainHeight(x, z); }
// cylinder colliders {x,z,r}; the player gets pushed out of these
const colliders = [];

// ------------------------------------------------------------------ forest (mixed species, denser, snow-aware)
const forest = new THREE.Group(); scene.add(forest);
function addTree(px, pz, kind, s) {
  const snowy = snowAmount(px, pz) > 0.5;
  let t;
  if (kind === "birch") t = makeBirch();
  else if (kind === "tall") t = makePineTall(snowy);
  else { t = makePine(); if (snowy) t.traverse(o => { if (o.isMesh && o.geometry.type === "ConeGeometry") o.material = snowPineMat; }); }
  t.position.set(px, terrainHeight(px, pz), pz);
  t.scale.setScalar(s); t.rotation.y = Math.random() * Math.PI;
  forest.add(t);
  colliders.push({ x: px, z: pz, r: 0.3 * s });     // thin trunks: you can walk between & under
}
for (let i = 0; i < 340; i++) {
  const a = Math.random() * Math.PI * 2, r = 9 + Math.random() * 250;
  const px = Math.cos(a) * r, pz = Math.sin(a) * r;
  const snowy = snowAmount(px, pz) > 0.5;
  const roll = Math.random();
  const kind = snowy ? (roll < 0.85 ? "tall" : "pine")
                     : (roll < 0.4 ? "tall" : roll < 0.65 ? "birch" : "pine");
  addTree(px, pz, kind, 0.85 + Math.random() * 1.1);
}

// ------------------------------------------------------------------ the stone hut with the screaming mouth
{
  const hut = new THREE.Group();
  const stone = ps1Material({ map: noiseTexture([120, 116, 108], 44) });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.4, 8, 7, 1, false, 0, Math.PI * 2), stone);
  body.position.y = 4; hut.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2), stone);
  dome.position.y = 8; hut.add(dome);
  // mouth doorway: a dark recess with pale "teeth"
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 3.4),
    new THREE.MeshBasicMaterial({ color: 0x4a0d12, fog: true }));
  mouth.position.set(0, 3.0, 4.05); hut.add(mouth);
  const teeth = ps1Material({ color: 0xe8e2d6 });
  for (let i = 0; i < 5; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.1), teeth);
    t.position.set(-0.8 + i * 0.4, 4.45, 4.1); hut.add(t);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.1), teeth);
    b.position.set(-0.8 + i * 0.4, 1.55, 4.1); hut.add(b);
  }
  hut.position.set(22, groundHeight(22, 10), 10);
  hut.rotation.y = -0.5;
  scene.add(hut);
  colliders.push({ x: 22, z: 10, r: 4.2 });
}

// ------------------------------------------------------------------ red glyphs scrawled on the ground
{
  const glyphMat = new THREE.MeshBasicMaterial({ color: 0x8b0f0f, fog: true });
  const glyphs = new THREE.Group();
  for (let i = 0; i < 60; i++) {
    const w = 0.15 + Math.random() * 0.5;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.12), glyphMat);
    g.rotation.x = -Math.PI / 2;
    g.rotation.z = Math.random() * Math.PI;
    g.position.set(-6 + (Math.random() - 0.5) * 9, 0.05, -18 + (Math.random() - 0.5) * 9);
    glyphs.add(g);
  }
  scene.add(glyphs);
}

// ------------------------------------------------------------------ rifle (held model + first-person viewmodel)
function makeRifle() {
  const g = new THREE.Group();
  const dark = ps1Material({ color: 0x2a2a2e });
  const wood = ps1Material({ color: 0x5a3d24 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.9), dark));
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 6), dark);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.62); g.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.34), wood); stock.position.set(0, -0.03, 0.5); g.add(stock);
  // muzzle flash quad (hidden until fired)
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xffddaa, transparent: true, opacity: 0.95, fog: false, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.position.set(0, 0.02, -1.0); flash.visible = false; g.add(flash);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -1.0); g.add(muzzle);
  g.userData.muzzle = muzzle; g.userData.flash = flash;
  return g;
}

// ------------------------------------------------------------------ pale figure (the player avatar)
function makePaleFigure() {
  const g = new THREE.Group();       // origin is at the feet (y=0)
  const mat = ps1Material({ color: 0xededed });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.8, 0.3), mat); torso.position.y = 1.15; g.add(torso);
  const head  = new THREE.Group(); head.position.set(0, 1.55, 0); g.add(head);   // neck pivot
  head.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.4, 0.36), mat).translateY(0.23));
  function limb(x, y, w, h) {                    // limbs pivot from shoulder / hip
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat); mesh.position.y = -h / 2;
    pivot.add(mesh); g.add(pivot); return pivot;
  }
  const armL = limb(-0.38, 1.5, 0.16, 0.75);
  const armR = limb( 0.38, 1.5, 0.16, 0.75);
  const legL = limb(-0.15, 0.8, 0.2, 0.8);
  const legR = limb( 0.15, 0.8, 0.2, 0.8);
  const rifle = makeRifle();                     // held out front in both hands
  rifle.position.set(0.16, 1.28, -0.35); g.add(rifle);
  g.userData.limbs = { armL, armR, legL, legR, head };
  g.userData.rifle = rifle;
  g.userData.crouch = 0;
  return g;
}

const player = makePaleFigure();
player.visible = false;   // first person: hide our own body so the camera never sits inside it
scene.add(player);
const playerPos = new THREE.Vector3(0, 0, 0);
let bodyYaw = 0;          // direction the figure faces
let headYaw = 0;          // direction we're looking (mouse)
let pitch = 0;            // look up/down
let crouching = false;    // Ctrl — lower + quieter (harder for animals to see)
let curEye = 1.62;        // smoothed eye height (drops when crouched)

// ------------------------------------------------------------------ first-person look
const EYE = 1.62;                              // eye height above the feet
const HEAD_LIMIT = 50 * Math.PI / 180;         // head can lead the body this far before the body follows
camera.rotation.order = "YXZ";

// ------------------------------------------------------------------ input
const keys = {};
addEventListener("keydown", e => { keys[e.code] = true; });
addEventListener("keyup",   e => { keys[e.code] = false; });

const gate = document.getElementById("gate");
let locked = false;
function grab() { canvas.requestPointerLock?.(); if (typeof resumeAudio === "function") resumeAudio(); }
gate.addEventListener("click", grab);
canvas.addEventListener("click", () => { if (!locked) grab(); });
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  gate.classList.toggle("hidden", locked);
});
document.addEventListener("mousemove", e => {
  if (!locked) return;
  headYaw -= e.movementX * 0.0022;
  pitch    = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * 0.0020));
});

// ------------------------------------------------------------------ multiplayer
const remote = new Map(); // id -> figure
let net = null, myId = null;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  net = new WebSocket(`${proto}://${location.host}`);
  net.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === "welcome") {
      myId = m.id;
      for (const o of m.others) spawnRemote(o.id, o);
    } else if (m.t === "join") {
      spawnRemote(m.id, m);
    } else if (m.t === "move") {
      const f = remote.get(m.id);
      if (f) f.userData.target = { x: m.x, z: m.z, ry: m.ry, hy: m.hy || 0, ph: m.ph || 0, cr: m.cr || 0, fy: m.fy || 0 };
    } else if (m.t === "shot") {
      const f = remote.get(m.id); if (f) flashMuzzle(f);
    } else if (m.t === "leave") {
      const f = remote.get(m.id); if (f) { scene.remove(f); remote.delete(m.id); }
    }
    updateCount();
  };
  net.onclose = () => setTimeout(connect, 2000);
}
function spawnRemote(id, s) {
  if (remote.has(id)) return;
  const f = makePaleFigure();
  const x = s.x || 0, z = s.z || 0;
  f.position.set(x, groundHeight(x, z), z);
  f.rotation.y = s.ry || 0;
  f.userData.target = { x, z, ry: s.ry || 0, hy: s.hy || 0, ph: 0, cr: 0, fy: 0 };
  f.userData.wphase = 0; f.userData.px = x; f.userData.pz = z; f.userData.crv = 0;
  scene.add(f); remote.set(id, f);
}
function updateCount() {
  document.getElementById("count").textContent = `wanderers online: ${remote.size + 1}`;
}
connect();

let lastSend = 0;
function sendState(now) {
  if (!net || net.readyState !== 1) return;
  if (now - lastSend < 66) return; // ~15 Hz
  lastSend = now;
  net.send(JSON.stringify({ t: "move", x: playerPos.x, y: 0, z: playerPos.z, ry: bodyYaw, hy: headYaw,
    ph: pitch, cr: crouching ? 1 : 0, fy: editorAlt }));
}

// ------------------------------------------------------------------ grain overlay
const grain = document.getElementById("grain");
const gctx = grain.getContext("2d");
let grainPool = [];        // pre-rendered noise frames; swapping one per frame is ~free
let grainIdx = 0;
function sizeGrain() {
  grain.width  = Math.max(1, Math.floor(innerWidth / 3));
  grain.height = Math.max(1, Math.floor(innerHeight / 3));
  grainPool = [];
  for (let k = 0; k < 6; k++) {
    const img = gctx.createImageData(grain.width, grain.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
    }
    grainPool.push(img);
  }
}
sizeGrain();
function drawGrain() {
  if (!grainPool.length) return;
  grainIdx = (grainIdx + 1) % grainPool.length;
  gctx.putImageData(grainPool[grainIdx], 0, 0);
}

// ------------------------------------------------------------------ resize (CSS-stretch the tiny canvas to fill)
function onResize() {
  // internal buffer is low-res (pixelation) but matches the window's aspect so nothing stretches
  const aspect = Math.max(0.1, innerWidth / Math.max(1, innerHeight));
  const h = PIXEL_HEIGHT;
  const w = Math.max(1, Math.round(h * aspect));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  sizeGrain();
}
addEventListener("resize", onResize); onResize();

// ------------------------------------------------------------------ clock + fps HUD
const clockEl = document.getElementById("clock");
const fpsEl = document.getElementById("fps");
let fpsLast = 0;

// ------------------------------------------------------------------ movement helpers
function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
function turnToward(cur, target, t) { return cur + wrapAngle(target - cur) * Math.min(1, t); }
function animateLimbs(fig, sw) {
  const L = fig.userData.limbs;
  // opposite arm & leg swing together (natural gait)
  L.legL.rotation.x =  sw; L.legR.rotation.x = -sw;
  L.armL.rotation.x = -sw; L.armR.rotation.x =  sw;
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
let walkPhase = 0;
let frameCount = 0;
let clockLast = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;

  updateDay(dt); updateFx(dt); updateAnimals(dt);

  // --- input (movement is relative to where you're LOOKING) ---
  crouching = (keys["ControlLeft"] || keys["ControlRight"]) && !editing;
  const run = (keys["ShiftLeft"] || keys["ShiftRight"]) && !crouching;
  const speed = run ? 6.2 : crouching ? 1.6 : 3.1;
  let fwd = 0, str = 0;
  if (keys["KeyW"]) fwd += 1;
  if (keys["KeyS"]) fwd -= 1;
  if (keys["KeyD"]) str += 1;
  if (keys["KeyA"]) str -= 1;
  const moving = fwd || str;

  const sinY = Math.sin(headYaw), cosY = Math.cos(headYaw);
  if (moving) {
    // forward = look direction (-sin,-cos); strafe = right (cos,-sin)
    let dx = -sinY * fwd + cosY * str;
    let dz = -cosY * fwd - sinY * str;
    const len = Math.hypot(dx, dz); dx /= len; dz /= len;
    let nx = playerPos.x + dx * speed * dt;
    let nz = playerPos.z + dz * speed * dt;
    // push out of colliders (trees / hut)
    const PR = 0.4;
    for (let it = 0; it < 2; it++) for (const c of colliders) {
      const ex = nx - c.x, ez = nz - c.z, d = Math.hypot(ex, ez), min = c.r + PR;
      if (d < min && d > 1e-4) { nx = c.x + (ex / d) * min; nz = c.z + (ez / d) * min; }
    }
    playerPos.x = nx; playerPos.z = nz;
    // walking: body turns to face where you're looking
    bodyYaw = turnToward(bodyYaw, headYaw, dt * 10);
    walkPhase += dt * (run ? 13 : 8);
  } else {
    // standing still: free-look — head leads, body only follows past HEAD_LIMIT
    const off = wrapAngle(headYaw - bodyYaw);
    if (off >  HEAD_LIMIT) bodyYaw = headYaw - HEAD_LIMIT;
    if (off < -HEAD_LIMIT) bodyYaw = headYaw + HEAD_LIMIT;
  }

  // editor lets you fly up for an overview
  if (editing) {
    if (keys["Space"]) editorAlt += 10 * dt;
    if (keys["KeyC"])  editorAlt = Math.max(0, editorAlt - 10 * dt);
  } else editorAlt = 0;

  // keep the (hidden) avatar synced for networking; drive its walk cycle
  const gy = groundHeight(playerPos.x, playerPos.z);
  player.position.set(playerPos.x, gy, playerPos.z);
  player.rotation.y = bodyYaw;
  player.userData.limbs.head.rotation.y = wrapAngle(headYaw - bodyYaw);
  animateLimbs(player, moving ? Math.sin(walkPhase) * 0.5 : 0);

  // --- first-person camera: eye height (lower when crouched), follows head yaw + pitch ---
  const targetEye = crouching ? 1.0 : EYE;
  curEye += (targetEye - curEye) * Math.min(1, dt * 12);
  camera.position.set(playerPos.x, gy + curEye + editorAlt, playerPos.z);
  camera.rotation.y = headYaw;
  camera.rotation.x = pitch;

  updateViewGun(dt, moving && !crouching);
  if (editing) editorTick();

  // --- remote figures: interpolate, stand on the ground, animate their gait ---
  for (const f of remote.values()) {
    const t = f.userData.target; if (!t) continue;
    f.position.x += (t.x - f.position.x) * Math.min(1, dt * 10);
    f.position.z += (t.z - f.position.z) * Math.min(1, dt * 10);
    f.position.y = groundHeight(f.position.x, f.position.z) + (t.fy || 0);   // + fly height
    f.rotation.y += wrapAngle(t.ry - f.rotation.y) * Math.min(1, dt * 10);
    f.userData.limbs.head.rotation.y = wrapAngle((t.hy ?? t.ry) - f.rotation.y);
    f.userData.limbs.head.rotation.x = t.ph || 0;                            // look up/down
    f.userData.crv += ((t.cr ? 1 : 0) - f.userData.crv) * Math.min(1, dt * 10);
    f.scale.y = 1 - 0.32 * f.userData.crv;                                   // crouch
    const spd = Math.hypot(f.position.x - f.userData.px, f.position.z - f.userData.pz) / Math.max(dt, 1e-3);
    f.userData.px = f.position.x; f.userData.pz = f.position.z;
    const rMoving = spd > 0.3;
    if (rMoving) f.userData.wphase += dt * (spd > 5 ? 13 : 8);
    animateLimbs(f, rMoving ? Math.sin(f.userData.wphase) * 0.5 : 0);
  }

  sendState(now);

  // --- render every frame (smooth 60fps); the pixelation is a resolution trick, not a fps cap ---
  renderer.render(scene, camera);
  drawGrain();
  frameCount++;
  if (now - clockLast > 250) {              // clock/HUD text only needs a few updates a second
    clockLast = now;
    const d = new Date();
    clockEl.textContent = String(d.getHours()).padStart(2,"0") + ":" +
                          String(d.getMinutes()).padStart(2,"0") + ":" +
                          String(d.getSeconds()).padStart(2,"0");
  }
  if (now - fpsLast > 500) {                 // live fps readout
    fpsEl.textContent = "fps " + Math.round((frameCount * 1000) / (now - fpsLast));
    frameCount = 0; fpsLast = now;
  }
}
// ==================================================================
//  GUN  — first-person rifle: shoot, muzzle flash, smoke, sound
// ==================================================================
const viewGun = makeRifle(); viewGun.scale.setScalar(0.85);
viewGun.position.set(0.24, -0.2, -0.5); camera.add(viewGun);
let viewRecoil = 0, viewBob = 0, lastFire = 0;

function updateViewGun(dt, walking) {
  viewRecoil = Math.max(0, viewRecoil - dt * 6);
  viewBob += dt * (walking ? 9 : 0);
  const bob = walking ? Math.sin(viewBob) * 0.012 : 0;
  viewGun.position.set(0.24, -0.2 + bob - viewRecoil * 0.04, -0.5 + viewRecoil * 0.06);
  viewGun.rotation.x = -viewRecoil * 0.3;
  viewGun.visible = !editing;
}
function showFlash(rifle) {
  const fl = rifle.userData.flash; if (!fl) return;
  fl.visible = true; fl.rotation.z = Math.random() * Math.PI;
  setTimeout(() => { fl.visible = false; }, 60);
}
function flashMuzzle(fig) {                        // remote player fired
  const rifle = fig.userData.rifle; if (!rifle) return;
  showFlash(rifle);
  const mp = new THREE.Vector3(); rifle.userData.muzzle.getWorldPosition(mp); spawnSmoke(mp);
}
function fire() {
  const now = performance.now();
  if (now - lastFire < 180) return;               // fire rate
  lastFire = now; viewRecoil = 1;
  showFlash(viewGun);
  const mp = new THREE.Vector3(); viewGun.userData.muzzle.getWorldPosition(mp); spawnSmoke(mp);
  gunSound();
  // raycast for a hit on an animal
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObjects(animalGroup.children, true);
  if (hits.length) { const root = animalRoot(hits[0].object); if (root) killAnimal(root); }
  alertAnimals();
  if (net && net.readyState === 1) net.send(JSON.stringify({ t: "shot" }));
}
function gunSound() {
  const ctx = THREE.AudioContext.getContext();
  if (ctx.state !== "running") return;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, (ctx.sampleRate * 0.3) | 0, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1800;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  src.connect(lp).connect(g).connect(listener.getInput()); src.start(t);
  const osc = ctx.createOscillator(); osc.type = "square";
  osc.frequency.setValueAtTime(180, t); osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  const og = ctx.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  osc.connect(og).connect(listener.getInput()); osc.start(t); osc.stop(t + 0.14);
}

// muzzle smoke puffs (billboarded, expand + fade)
const fx = [];
function spawnSmoke(pos) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4),
    new THREE.MeshBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.5, depthWrite: false }));
  m.position.copy(pos); m.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.6, (Math.random() - 0.5) * 0.3);
  scene.add(m); fx.push({ mesh: m, life: 0 });
}
function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i]; p.life += dt;
    p.mesh.position.addScaledVector(p.mesh.userData.vel, dt);
    p.mesh.scale.setScalar(1 + p.life * 3);
    p.mesh.material.opacity = Math.max(0, 0.5 * (1 - p.life / 1.2));
    p.mesh.quaternion.copy(camera.quaternion);
    if (p.life > 1.2) { scene.remove(p.mesh); fx.splice(i, 1); }
  }
}

// ==================================================================
//  DAY / NIGHT CYCLE
// ==================================================================
let dayT = 0.30; const DAY_LEN = 300;             // seconds for a full day
const _cNight = new THREE.Color(0x0b0f1a), _cDusk = new THREE.Color(0xcf8a55), _cNoon = new THREE.Color(0xbdc2c0), _cTmp = new THREE.Color();
function updateDay(dt) {
  dayT = (dayT + dt / DAY_LEN) % 1;
  const ang = dayT * Math.PI * 2, elev = Math.sin(ang);
  sun.position.set(Math.cos(ang) * 60, elev * 60 + 2, Math.sin(ang * 0.7) * 30);
  const day = Math.max(0, elev);
  sun.intensity = 0.1 + day * 0.75;
  hemi.intensity = 0.28 + day * 0.9;
  const tt = (elev + 1) / 2;
  if (tt < 0.5) _cTmp.copy(_cNight).lerp(_cDusk, tt / 0.5);
  else _cTmp.copy(_cDusk).lerp(_cNoon, (tt - 0.5) / 0.5);
  scene.background.copy(_cTmp); scene.fog.color.copy(_cTmp);
}

// ==================================================================
//  ANIMALS  — deer flee (cone of sight, crouch = stealth); wendigos hunt
// ==================================================================
const animalGroup = new THREE.Group(); scene.add(animalGroup);
const animals = [];
function makeDeer() {
  const g = new THREE.Group();
  const hide = ps1Material({ color: 0x8a5a34 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 1.3), hide); body.position.y = 1.0; g.add(body);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.6, 0.3), hide); neck.position.set(0, 1.35, -0.7); neck.rotation.x = -0.5; g.add(neck);
  const dhead = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.5), hide); dhead.position.set(0, 1.65, -0.95); g.add(dhead);
  const legs = [];
  for (const [lx, lz] of [[-0.18, -0.5], [0.18, -0.5], [-0.18, 0.5], [0.18, 0.5]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), hide); leg.position.set(lx, 0.5, lz); g.add(leg); legs.push(leg);
  }
  g.userData.legs = legs; return g;
}
function makeWendigo() {                            // tall, dark, skinny figure
  const g = new THREE.Group();
  const dark = ps1Material({ color: 0x141416 });
  const wbody = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.28), dark); wbody.position.y = 2.2; g.add(wbody);
  const whead = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.3), dark); whead.position.y = 3.15; g.add(whead);
  const antMat = ps1Material({ color: 0x8a8a80 });
  for (const s of [-1, 1]) { const a = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.7, 4), antMat); a.position.set(s * 0.12, 3.55, 0); a.rotation.z = s * 0.4; g.add(a); }
  const legs = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 0.12), dark); arm.position.set(s * 0.32, 2.1, 0); g.add(arm);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.6, 0.14), dark); leg.position.set(s * 0.14, 0.8, 0); g.add(leg); legs.push(leg);
  }
  g.userData.legs = legs; return g;
}
function spawnAnimals() {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2, r = 25 + Math.random() * 110, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const g = makeDeer(); g.position.set(x, terrainHeight(x, z), z); animalGroup.add(g);
    animals.push({ g, kind: "deer", state: "wander", heading: Math.random() * 6.28, timer: Math.random() * 3, speed: 0, phase: 0 });
  }
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2, r = 150 + Math.random() * 70, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const g = makeWendigo(); g.position.set(x, terrainHeight(x, z), z); animalGroup.add(g);
    animals.push({ g, kind: "wendigo", state: "wander", heading: Math.random() * 6.28, timer: Math.random() * 3, speed: 0, phase: 0 });
  }
}
function animalRoot(obj) { let o = obj; while (o && o.parent !== animalGroup) o = o.parent; return o; }
function killAnimal(root) {
  const idx = animals.findIndex(a => a.g === root); if (idx < 0) return;
  if (animals[idx].kind === "wendigo") { animals[idx].state = "flee"; animals[idx].timer = 3; return; }
  animalGroup.remove(root); animals.splice(idx, 1);
}
function alertAnimals() {
  for (const a of animals) {
    if (a.kind !== "deer") continue;
    const d = Math.hypot(a.g.position.x - playerPos.x, a.g.position.z - playerPos.z);
    if (d < 90) { a.state = "flee"; a.timer = 4 + Math.random() * 2; a.heading = Math.atan2(a.g.position.z - playerPos.z, a.g.position.x - playerPos.x); }
  }
}
function canSee(a) {
  const dx = playerPos.x - a.g.position.x, dz = playerPos.z - a.g.position.z, d = Math.hypot(dx, dz);
  let viewDist = a.kind === "wendigo" ? 60 : 34;
  if (crouching) viewDist *= 0.45;                 // crouching = much harder to spot
  if (d > viewDist) return false;
  return Math.abs(wrapAngle(Math.atan2(dz, dx) - a.heading)) < 1.1;   // ~63° half-cone of sight
}
function updateAnimals(dt) {
  for (const a of animals) {
    a.timer -= dt;
    if (a.state !== "flee" && canSee(a)) {
      if (a.kind === "deer") { a.state = "flee"; a.timer = 3 + Math.random() * 2; a.heading = Math.atan2(a.g.position.z - playerPos.z, a.g.position.x - playerPos.x); }
      else a.state = "hunt";
    }
    if (a.kind === "wendigo" && a.state === "hunt" && !canSee(a) && a.timer <= 0) { a.state = "wander"; a.timer = 2; }
    if (a.state === "flee") { a.speed = 9; if (a.timer <= 0) { a.state = "wander"; a.timer = 2; } }
    else if (a.state === "hunt") { a.heading = Math.atan2(playerPos.z - a.g.position.z, playerPos.x - a.g.position.x); a.speed = 3.2; }
    else { a.speed = a.kind === "wendigo" ? 1.2 : 1.6; if (a.timer <= 0) { a.heading += (Math.random() - 0.5) * 1.5; a.timer = 1.5 + Math.random() * 3; if (Math.random() < 0.3) a.speed = 0; } }
    const nx = a.g.position.x + Math.cos(a.heading) * a.speed * dt;
    const nz = a.g.position.z + Math.sin(a.heading) * a.speed * dt;
    a.g.position.set(nx, terrainHeight(nx, nz), nz);
    a.g.rotation.y = Math.atan2(-Math.cos(a.heading), -Math.sin(a.heading));
    if (a.speed > 0.1) { a.phase += dt * a.speed * 2; const sw = Math.sin(a.phase) * 0.5, L = a.g.userData.legs; if (L) { L[0].rotation.x = sw; L[1].rotation.x = -sw; if (L[2]) L[2].rotation.x = -sw; if (L[3]) L[3].rotation.x = sw; } }
    if (Math.hypot(nx, nz) > 340) a.heading += Math.PI;
  }
}
spawnAnimals();

// ==================================================================
//  AUDIO  — spatial 3D sound + a free procedural wind bed
// ==================================================================
const listener = new THREE.AudioListener();
camera.add(listener);
const audioLoader = new THREE.AudioLoader();
const worldSounds = [];
let ambientAudio = null;
let audioStarted = false;

function resumeAudio() {
  const ctx = THREE.AudioContext.getContext();
  if (ctx.state !== "running") ctx.resume();
  if (!audioStarted) { audioStarted = true; startWind(); }
  refreshAmbient();
  for (const s of worldSounds) if (s.buffer && !s.isPlaying) { try { s.play(); } catch {} }
}

function startWind() {
  const ctx = THREE.AudioContext.getContext();
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;                                   // brown noise -> low wind rumble
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.98 * b + 0.02 * w; d[i] = b * 3.5; }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420;
  const g = ctx.createGain(); g.gain.value = 0.06;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;   // slow gusts
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.04;
  lfo.connect(lfoGain).connect(g.gain);
  src.connect(lp).connect(g).connect(listener.getInput());
  src.start(); lfo.start();
}

function refreshAmbient() {
  if (!audioStarted) return;
  if (ambientAudio) { try { ambientAudio.stop(); } catch {} ambientAudio = null; }
  const name = currentMap && currentMap.ambient;
  if (!name) return;
  ambientAudio = new THREE.Audio(listener);
  audioLoader.load("/assets/audio/" + name, (buf) => {
    ambientAudio.setBuffer(buf); ambientAudio.setLoop(true); ambientAudio.setVolume(0.5);
    if (THREE.AudioContext.getContext().state === "running") ambientAudio.play();
  });
}

function spawnSound(e) {
  const holder = new THREE.Object3D();
  holder.position.set(e.pos.x, groundHeight(e.pos.x, e.pos.z) + (e.pos.y ?? 1), e.pos.z);
  const s = new THREE.PositionalAudio(listener);
  const r = e.radius || 10;
  s.setRefDistance(r * 0.35); s.setMaxDistance(r); s.setRolloffFactor(1.4);
  s.setDistanceModel("linear"); s.setLoop(true); s.setVolume(e.volume ?? 1);
  audioLoader.load("/assets/audio/" + e.asset, (buf) => {
    s.setBuffer(buf); worldSounds.push(s);
    if (audioStarted && THREE.AudioContext.getContext().state === "running") { try { s.play(); } catch {} }
  });
  holder.add(s); holder.userData.entity = e; placed.add(holder);
}

// ==================================================================
//  CONTENT  — manifest, models, maps  (drop files in folders -> refresh)
// ==================================================================
const gltfLoader = new GLTFLoader();
const placed = new THREE.Group(); scene.add(placed);
const rockMat = ps1Material({ map: noiseTexture([112, 110, 104], 38) });
let manifest = { models: [], audio: [], textures: [], maps: [] };
let currentMap = { name: "main", spawn: { x: 0, y: 0, z: 0 }, ambient: null, entities: [] };

function makeProp(shape) {
  switch (shape) {
    case "pine":    return makePine();
    case "rock":    return new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), rockMat);
    case "boulder": return new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 0), rockMat);
    case "pillar":  return new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 4, 6), rockMat);
    default:        return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), rockMat);
  }
}
// keep loaded textures point-sampled so models match the muddy PS1 look
function ps1ify(obj) {
  obj.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.minFilter = THREE.NearestFilter; m.map.needsUpdate = true; }
    }
  });
}
// drop an object onto the terrain (lowest point rests on the ground) + optional collider
function groundAndPlace(o, e, defaultCollide) {
  const s = e.scale || 1; o.scale.setScalar(s); o.rotation.y = e.rot || 0;
  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  const lift = isFinite(box.min.y) ? -box.min.y : 0;
  o.position.set(e.pos.x, groundHeight(e.pos.x, e.pos.z) + lift + (e.pos.y || 0), e.pos.z);
  o.userData.entity = e; placed.add(o);
  const collide = e.collide ?? defaultCollide;
  if (collide) {
    const half = Math.max(0.4, (box.max.x - box.min.x) / 2);
    const c = { x: e.pos.x, z: e.pos.z, r: e.radius || half, dyn: true };
    colliders.push(c); e._col = c;
  }
}
function spawnModel(e) {
  gltfLoader.load("/assets/models/" + e.asset, (gltf) => { ps1ify(gltf.scene); groundAndPlace(gltf.scene, e, true); },
    undefined, (err) => console.warn("model load failed:", e.asset, err));
}
function spawnProp(e) { groundAndPlace(makeProp(e.shape), e, e.shape !== "box"); }
function spawnEntity(e) {
  if (e.type === "model") spawnModel(e);
  else if (e.type === "sound") spawnSound(e);
  else spawnProp(e);
}

function clearPlaced() {
  for (const s of worldSounds) { try { s.stop(); } catch {} }
  worldSounds.length = 0;
  if (ambientAudio) { try { ambientAudio.stop(); } catch {} ambientAudio = null; }
  while (placed.children.length) placed.remove(placed.children[0]);
  for (let i = colliders.length - 1; i >= 0; i--) if (colliders[i].dyn) colliders.splice(i, 1);
}
function applyMap() {
  clearPlaced();
  for (const e of (currentMap.entities || [])) spawnEntity(e);
  const sp = currentMap.spawn || { x: 0, y: 0, z: 0 };
  playerPos.set(sp.x, 0, sp.z);
  refreshAmbient();
  updateEditorHUD();
}
async function loadManifest() { try { manifest = await (await fetch("/api/manifest")).json(); } catch {} buildPalette(); }
async function loadMap(name) { try { const r = await fetch("/api/maps/" + name); if (r.ok) currentMap = await r.json(); } catch {} applyMap(); }

// ==================================================================
//  EDITOR  — press Tab; place models / props / sounds; save maps
// ==================================================================
let editing = false, editorAlt = 0;
let palette = [], selIndex = 0, placeRot = 0, placeScale = 1, edMsg = "";
const raycaster = new THREE.Raycaster();
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.4, fog: false, depthWrite: false });
const ghost = new THREE.Group(); ghost.visible = false; scene.add(ghost);
let ghostLift = 0;
function rebuildGhost() {
  while (ghost.children.length) ghost.remove(ghost.children[0]);
  const it = palette[selIndex]; if (!it) return;
  let o;
  if (it.kind === "prop") { o = makeProp(it.shape); o.traverse(m => { if (m.isMesh) m.material = ghostMat; }); }
  else if (it.kind === "model") o = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 1), ghostMat);
  else { o = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.9, 16), ghostMat); o.rotation.x = -Math.PI / 2; }
  o.scale.setScalar(placeScale);
  o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o);
  ghostLift = isFinite(box.min.y) ? -box.min.y : 0;
  ghost.add(o);
}

function buildPalette() {
  palette = [
    { kind: "prop", shape: "pine", label: "Pine tree" },
    { kind: "prop", shape: "rock", label: "Rock" },
    { kind: "prop", shape: "boulder", label: "Boulder" },
    { kind: "prop", shape: "pillar", label: "Pillar" },
    { kind: "prop", shape: "box", label: "Box" },
  ];
  for (const m of (manifest.models || [])) palette.push({ kind: "model", asset: m, label: "▸ " + m });
  for (const a of (manifest.audio || [])) palette.push({ kind: "sound", asset: a, label: "♪ " + a });
  if (selIndex >= palette.length) selIndex = 0;
  updateEditorHUD();
}
function updateEditorHUD() {
  const it = palette[selIndex];
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("ed-asset", it ? it.label : "—");
  set("ed-rot", Math.round((placeRot * 180 / Math.PI) % 360) + "°");
  set("ed-scale", placeScale.toFixed(1));
  set("ed-count", (currentMap.entities ? currentMap.entities.length : 0) + (edMsg ? "   " + edMsg : ""));
}
function flash(msg) { edMsg = msg; updateEditorHUD(); setTimeout(() => { edMsg = ""; updateEditorHUD(); }, 1600); }

function toggleEditor() {
  editing = !editing;
  document.getElementById("editor").classList.toggle("on", editing);
  document.getElementById("crosshair").classList.toggle("on", editing);
  ghost.visible = false;
  if (editing) rebuildGhost();
  updateEditorHUD();
}
function editorTick() {
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hit = raycaster.intersectObjects([ground, ...placed.children], true)[0];   // ground OR placed objects (stacking)
  if (hit) {
    ghost.position.set(hit.point.x, hit.point.y + ghostLift, hit.point.z);
    ghost.rotation.y = placeRot;
    ghost.visible = true; ghost.userData.point = hit.point.clone();
  } else ghost.visible = false;
}
function placeSelected() {
  if (!ghost.visible || !ghost.userData.point) return;
  const p = ghost.userData.point, it = palette[selIndex]; if (!it) return;
  const yOff = +(p.y - groundHeight(p.x, p.z)).toFixed(2);   // height above terrain -> lets you stack
  const e = { pos: { x: +p.x.toFixed(2), y: yOff, z: +p.z.toFixed(2) }, rot: placeRot, scale: placeScale };
  if (it.kind === "prop") { e.type = "prop"; e.shape = it.shape; }
  else if (it.kind === "model") { e.type = "model"; e.asset = it.asset; e.collide = true; }
  else { e.type = "sound"; e.asset = it.asset; e.radius = 12; e.volume = 1; e.pos.y = yOff + 1; }
  currentMap.entities.push(e); spawnEntity(e); updateEditorHUD();
}
function deleteNearest() {
  if (!ghost.userData.point) return;
  const p = ghost.userData.point; let best = -1, bd = 9;
  currentMap.entities.forEach((e, i) => { const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  const e = currentMap.entities[best];
  for (const o of [...placed.children]) if (o.userData.entity === e) placed.remove(o);
  if (e._col) { const idx = colliders.indexOf(e._col); if (idx >= 0) colliders.splice(idx, 1); }
  currentMap.entities.splice(best, 1); updateEditorHUD();
}
async function saveMap() {
  try {
    const r = await fetch("/api/maps/" + (currentMap.name || "main"),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(currentMap) });
    const j = await r.json(); flash(j.ok ? "saved maps/" + j.name + ".json" : "save failed");
  } catch { flash("save failed"); }
}

addEventListener("keydown", (e) => {
  if (e.code === "Tab") { e.preventDefault(); toggleEditor(); return; }
  if (!editing) return;
  if (e.code === "BracketLeft")  { selIndex = (selIndex - 1 + palette.length) % palette.length; rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "BracketRight") { selIndex = (selIndex + 1) % palette.length; rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "KeyR") { placeRot += Math.PI / 8; updateEditorHUD(); }
  else if (e.code === "Equal" || e.code === "NumpadAdd") { placeScale = Math.min(6, placeScale + 0.2); rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "Minus" || e.code === "NumpadSubtract") { placeScale = Math.max(0.2, placeScale - 0.2); rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "Backspace") { e.preventDefault(); deleteNearest(); }
  else if (e.code === "KeyP") { saveMap(); }
});
addEventListener("wheel", (e) => { if (!editing) return; selIndex = (selIndex + (e.deltaY > 0 ? 1 : -1) + palette.length) % palette.length; rebuildGhost(); updateEditorHUD(); }, { passive: true });
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !locked) return;
  if (editing) placeSelected(); else fire();
});

// ------------------------------------------------------------------ boot the content pipeline
(async () => { await loadManifest(); await loadMap("main"); })();

requestAnimationFrame(frame);

// debug handle (harmless; lets tooling force a render while the tab is hidden)
window.__dread = { renderer, scene, camera, THREE, get map() { return currentMap; }, get manifest() { return manifest; } };
