import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ------------------------------------------------------------------ config
const PIXEL_HEIGHT = 380;        // internal vertical resolution (PS2-ish — crisper than PS1's ~240,
                                 // still pixelated via nearest-neighbor upscale). aspect-derived width.
const FOG_COLOR  = 0xbdc2c0;     // pale desaturated grey-green haze
const SNAP_GRID  = 200.0;        // vertex-snap resolution (higher = steadier verts, more PS2 than PS1)

// deterministic world: a fixed seed means EVERY player generates the exact same land
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORLD_SEED = 20080102;
const rand = mulberry32(WORLD_SEED);   // use rand() for anything that must match across clients

// where the multiplayer + content server lives. Desktop/self-host: same origin.
// Web build (Vercel) sets window.DREAD_SERVER to the Render/home host before this loads.
const SERVER = (typeof window !== "undefined" && window.DREAD_SERVER) || location.origin;
const api = (p) => SERVER + p;

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" });
renderer.setPixelRatio(1);
renderer.setSize(400, 300, false); // placeholder; real size set aspect-correct in onResize()
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.Fog(FOG_COLOR, 6, 46);

const camera = new THREE.PerspectiveCamera(68, 400 / 300, 0.05, 200);   // near 0.05 so the ADS gun doesn't clip
scene.add(camera);   // REQUIRED: children of the camera (the first-person gun) only render if the camera is in the scene

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
function terrainHeight(x, z) {   // MUST stay identical to server.js terrainHeight (animals stand on it)
  const big  = Math.sin(x * 0.016) * 5.0 + Math.cos(z * 0.019) * 4.6;                     // broad rolling hills (taller)
  const ridge = (1.0 - Math.abs(Math.sin(x * 0.03 + Math.cos(z * 0.026) * 1.3))) * 4.2;   // ridged crests
  const med  = Math.sin(x * 0.05) * 1.0 + Math.cos(z * 0.06) * 0.9;                       // medium bumps
  const fine = Math.sin((x + z) * 0.11) * 0.45 + Math.sin(x * 0.17 - z * 0.13) * 0.25;    // fine ripple
  // SHORT CLIFFS: quantize the broad hills into 2m terraces over ~half the map
  const terr = Math.round((big * 0.5) / 2.0) * 2.0;
  const cliffMask = Math.max(0, Math.sin(x * 0.012 + 2.1) * Math.cos(z * 0.011 - 1.3));
  const terraced = big + (terr - big) * cliffMask * 0.7;
  // TALL HILL CLIFFS: a steep escarpment where a low-freq field crosses a threshold
  const esc = Math.sin(x * 0.008 - 1.7) + Math.cos(z * 0.0075 + 0.6);
  const escarp = esc > 1.0 ? (esc - 1.0) * 16 : 0;
  return terraced + ridge + med + fine + escarp;
}
// low-frequency, seeded forest-density field: some regions are dense woods, others open plains
function fbm2(x, z) {
  let v = 0, amp = 0.5, fx = x, fz = z;
  for (let o = 0; o < 3; o++) {
    v += amp * (Math.sin(fx) * Math.cos(fz * 1.13 + 1.7) + Math.sin((fx + fz) * 0.7));
    fx *= 2.03; fz *= 1.97; amp *= 0.5;
  }
  return v;
}
function forestDensity(x, z) {   // 0 (plains/clearing) .. 1 (super-dense forest)
  const n = fbm2(x * 0.0055 + 11.2, z * 0.0055 - 4.8);
  return Math.max(0, Math.min(1, 0.5 + n * 0.55));
}
const SNOW_START = 150, SNOW_FULL = 235;
function snowAmount(x, z) { const r = Math.hypot(x, z); return Math.max(0, Math.min(1, (r - SNOW_START) / (SNOW_FULL - SNOW_START))); }

// ------------------------------------------------------------------ ground (grass -> snow biome, vertex-colored)
const groundTex = noiseTexture([150, 150, 150], 34, 48);   // grey; vertex colors do the tinting
groundTex.repeat.set(95, 95);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(720, 720, 210, 210),   // higher detail so cliffs/terraces read crisply
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
    tmpc.multiplyScalar(1 - forestDensity(wx, wz) * 0.28);   // dense canopy shades the forest floor
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
  const snowy = snowAmount(px, pz) > 0.4;
  let t;
  if (kind === "birch") t = makeBirch();
  else if (kind === "tall") t = makePineTall(snowy);
  else { t = makePine(); if (snowy) t.traverse(o => { if (o.isMesh && o.geometry.type === "ConeGeometry") o.material = snowPineMat; }); }
  t.position.set(px, terrainHeight(px, pz), pz);
  t.scale.setScalar(s); t.rotation.y = rand() * Math.PI;
  const col = { x: px, z: pz, r: 0.3 * s };          // thin trunks: you can walk between & under
  colliders.push(col);
  t.userData.chop = { hp: 5, wood: 2 + Math.round(s), col };   // axe target: yields wood
  forest.add(t);
}
// density-driven scatter: SUPER-dense forest in high-forestDensity regions, real clearings in the plains
for (let i = 0; i < 2600; i++) {
  const a = rand() * Math.PI * 2, r = 8 + Math.sqrt(rand()) * 330;
  const px = Math.cos(a) * r, pz = Math.sin(a) * r;
  const dens = forestDensity(px, pz);
  if (rand() > dens * 1.15) continue;              // clearings stay open (plains); dense zones pack in tight
  const snowy = snowAmount(px, pz) > 0.4;
  const roll = rand();
  const kind = snowy ? (roll < 0.9 ? "tall" : "pine")
                     : (roll < 0.4 ? "tall" : roll < 0.65 ? "birch" : "pine");
  addTree(px, pz, kind, 0.85 + rand() * 1.1);
}

// ------------------------------------------------------------------ rocks & boulders (clustered on hillsides)
const rockMat0 = ps1Material({ map: noiseTexture([112, 110, 104], 38) });
const rocks = new THREE.Group(); scene.add(rocks);
function makeRock(big) {
  const geo = big ? new THREE.IcosahedronGeometry(1.6, 0) : new THREE.DodecahedronGeometry(0.7, 0);
  return new THREE.Mesh(geo, rockMat0);
}
for (let i = 0; i < 220; i++) {
  const a = rand() * Math.PI * 2, r = 14 + Math.sqrt(rand()) * 330;
  const px = Math.cos(a) * r, pz = Math.sin(a) * r;
  const big = rand() < 0.35, s = (big ? 0.8 : 0.6) + rand() * 1.1;
  const rk = makeRock(big); rk.scale.setScalar(s);
  rk.position.set(px, terrainHeight(px, pz) + (big ? 0.4 : 0.15) * s, pz);
  rk.rotation.set(rand() * 3, rand() * 6, rand() * 3);
  rocks.add(rk);
  colliders.push({ x: px, z: pz, r: (big ? 1.5 : 0.6) * s });
}

// ------------------------------------------------------------------ cave mouths (boulder ring around a dark, shaded recess)
const caves = new THREE.Group(); scene.add(caves);
function makeCave() {
  const g = new THREE.Group();
  const darkMat = new THREE.MeshBasicMaterial({ color: 0x090b0c, fog: true, side: THREE.DoubleSide });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), darkMat); back.position.set(0, 2, -2.4); g.add(back);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(7, 1.4, 5), rockMat0); roof.position.set(0, 4.2, -0.6); roof.rotation.x = -0.12; g.add(roof);
  for (let k = 0; k < 9; k++) {                 // a rough ring of boulders framing the entrance
    const ang = Math.PI * (0.15 + 0.7 * (k / 8)), rr = 3.2;
    const b = makeRock(true); const s = 0.9 + rand() * 0.8; b.scale.setScalar(s);
    b.position.set(Math.cos(ang) * rr, 0.6 + rand(), -Math.sin(ang) * rr * 0.8 - 0.4);
    b.rotation.set(rand() * 3, rand() * 6, rand() * 3); g.add(b);
  }
  return g;
}
for (let i = 0; i < 5; i++) {
  const a = rand() * Math.PI * 2, r = 60 + rand() * 240;
  const px = Math.cos(a) * r, pz = Math.sin(a) * r;
  const cave = makeCave();
  cave.position.set(px, terrainHeight(px, pz), pz);
  cave.rotation.y = rand() * Math.PI * 2;
  caves.add(cave);
  colliders.push({ x: px, z: pz - 2.4, r: 3.0 });   // solid back wall; the mouth stays walk-in-able
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
    const w = 0.15 + rand() * 0.5;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.12), glyphMat);
    g.rotation.x = -Math.PI / 2;
    g.rotation.z = rand() * Math.PI;
    g.position.set(-6 + (rand() - 0.5) * 9, 0.05, -18 + (rand() - 0.5) * 9);
    glyphs.add(g);
  }
  scene.add(glyphs);
}

// ------------------------------------------------------------------ blob contact shadows (cheap grounding)
function blobTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  grd.addColorStop(0, "rgba(0,0,0,0.5)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
const _blobTex = blobTexture();
function makeBlobShadow(radius) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: _blobTex, transparent: true, depthWrite: false, fog: true }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.04; return m;
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
  // U-shaped iron sight: tight, short, seated directly on the barrel top
  const iron = ps1Material({ color: 0x101012 });
  const postL = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.014), iron); postL.position.set(-0.032, 0.09, -0.42); g.add(postL);
  const postR = postL.clone(); postR.position.x = 0.032; g.add(postR);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.014, 0.014), iron); base.position.set(0, 0.062, -0.42); g.add(base);
  // muzzle flash quad (hidden until fired)
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xffddaa, transparent: true, opacity: 0.95, fog: false, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.position.set(0, 0.02, -1.0); flash.visible = false; g.add(flash);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -1.0); g.add(muzzle);
  g.userData.muzzle = muzzle; g.userData.flash = flash;
  return g;
}

// ------------------------------------------------------------------ axe (held model + first-person viewmodel)
function makeAxe() {
  const g = new THREE.Group();
  const wood  = ps1Material({ color: 0x6b4a2c });
  const metal = ps1Material({ color: 0x9297a0 });
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.042, 0.95, 6), wood);
  handle.rotation.x = Math.PI / 2; handle.position.set(0, 0, -0.18); g.add(handle);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.17, 0.05), metal); head.position.set(0.0, 0.07, -0.6); g.add(head);
  const blade = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.16, 3), metal);
  blade.rotation.z = -Math.PI / 2; blade.position.set(0.16, 0.07, -0.6); g.add(blade);
  const edge = new THREE.Object3D(); edge.position.set(0.18, 0.07, -0.6); g.add(edge);
  g.userData.edge = edge;
  return g;
}

// ------------------------------------------------------------------ pale figure (the player avatar)
const paleTex = noiseTexture([222, 222, 224], 22, 16);   // faint cloth grain (PS2-ish surface)
function makePaleFigure() {
  const g = new THREE.Group();       // origin is at the feet (y=0)
  const mat = ps1Material({ map: paleTex });
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
  // gun rig: a chest pivot that yaws/pitches with where the player LOOKS, rifle held inside it
  const gunPivot = new THREE.Group();
  gunPivot.position.set(0, 1.35, 0); gunPivot.rotation.order = "YXZ";
  g.add(gunPivot);
  const rifle = makeRifle();
  rifle.position.set(0.16, -0.05, -0.62);        // held out in front so the stock clears the torso
  gunPivot.add(rifle);
  // arms reach FORWARD onto the gun (+x pitches forward; ±y converges the hands on it)
  armL.rotation.order = armR.rotation.order = "YXZ";
  armL.rotation.set(1.45, -0.28, 0);             // left hand out on the fore-stock
  armR.rotation.set(1.15,  0.28, 0);             // right hand back at the grip
  // a small axe held in the right hand, shown whenever the rifle is stowed (default carry)
  const heldAxe = makeAxe(); heldAxe.scale.setScalar(0.7);
  heldAxe.position.set(0, -0.7, 0.05); heldAxe.rotation.set(-1.2, 0, 0);
  armR.add(heldAxe); heldAxe.visible = false;
  g.add(makeBlobShadow(0.5));
  g.userData.limbs = { armL, armR, legL, legR, head };
  g.userData.rifle = rifle;
  g.userData.gunPivot = gunPivot;
  g.userData.heldAxe = heldAxe;
  g.userData.crouch = 0;
  return g;
}
// the local avatar is hidden, so its shadow needs to live on its own
const playerShadow = makeBlobShadow(0.5); scene.add(playerShadow);

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
function grab() {
  if (new URLSearchParams(location.search).has("fs") && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  canvas.requestPointerLock?.(); if (typeof resumeAudio === "function") resumeAudio();
}
gate.addEventListener("click", grab);
canvas.addEventListener("click", () => { if (!locked) grab(); });
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  gate.classList.toggle("hidden", locked);
});
document.addEventListener("mousemove", e => {
  if (!locked) return;
  const sens = aiming ? 0.0013 : 0.0022;            // steadier aim when scoped in
  headYaw -= e.movementX * sens;
  pitch    = Math.max(-1.3, Math.min(1.3, pitch - e.movementY * sens));
});
// hotbar + action keys — every mouse control has a keyboard mirror (see the binds panel / BINDINGS)
let rmbAim = false;
addEventListener("keydown", (e) => {
  if (e.code === "KeyK") { e.preventDefault(); toggleBinds(); return; }        // binds panel
  if (e.code === "Tab")  { e.preventDefault(); toggleCraft(); return; }        // crafting / inventory
  if (menuOpen) { if (e.code === "Escape") closeMenus(); return; }             // menus swallow the rest
  if (editing) return;                                                          // editor has its own keys
  if (e.repeat) return;
  switch (e.code) {
    case "Digit1": setItem("axe");   break;
    case "Digit2": setItem("rifle"); break;
    case "Digit3": setItem("build"); break;
    case "KeyH":   setItem("none");  break;
    case "KeyC":   crouchToggle = !crouchToggle; break;                        // C toggles crouch (Ctrl still holds)
    case "KeyF":   primaryAction(); break;                                     // mirror of left-click
    case "KeyE":   interact();      break;                                     // pick up / eat / light fire / remove
    case "KeyR":   if (activeItem === "build") buildRot += Math.PI / 2; break; // rotate build ghost
    case "KeyX":   breakBuild(); break;                                        // break the build you're looking at
    case "BracketLeft":  if (activeItem === "build") cyclePiece(-1); break;
    case "BracketRight": if (activeItem === "build") cyclePiece(1);  break;
  }
});
addEventListener("mousedown", (e) => { if (e.button === 2 && locked && !editing) rmbAim = true; });   // hold RMB / Q to aim
addEventListener("mouseup",   (e) => { if (e.button === 2) rmbAim = false; });
addEventListener("contextmenu", (e) => e.preventDefault());

// ------------------------------------------------------------------ mobile / touch controls
const isMobile = (window.matchMedia && matchMedia("(pointer: coarse)").matches) || /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
let touchMode = false;
const touchMove = { x: 0, y: 0 };      // -1..1 joystick vector (x = strafe, y = forward/back)
if (isMobile) {
  document.body.classList.add("mobile");
  gate.textContent = "TAP TO PLAY";
  function mobileStart() { if (touchMode) return; touchMode = true; locked = true; gate.classList.add("hidden"); if (typeof resumeAudio === "function") resumeAudio(); }
  const stick = document.getElementById("stick"), knob = document.getElementById("knob");
  let moveId = null, moveOx = 0, moveOy = 0, lookId = null, lookLx = 0, lookLy = 0;
  const MAXR = 52;
  function tStart(e) {
    mobileStart();
    for (const t of e.changedTouches) {
      if (t.target && t.target.closest && t.target.closest(".btn-touch")) continue;   // buttons handle themselves
      const left = t.clientX < innerWidth * 0.5;
      if (left && moveId === null) {
        moveId = t.identifier; moveOx = t.clientX; moveOy = t.clientY;
        if (stick) { stick.style.left = (t.clientX - 60) + "px"; stick.style.top = (t.clientY - 60) + "px"; stick.style.display = "block"; }
      } else if (!left && lookId === null) { lookId = t.identifier; lookLx = t.clientX; lookLy = t.clientY; }
    }
  }
  function tMove(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - moveOx, dy = t.clientY - moveOy; const mag = Math.hypot(dx, dy);
        if (mag > MAXR) { dx = dx / mag * MAXR; dy = dy / mag * MAXR; }
        if (knob) knob.style.transform = `translate(${dx}px,${dy}px)`;
        touchMove.x = dx / MAXR; touchMove.y = dy / MAXR;
      } else if (t.identifier === lookId) {
        const dx = t.clientX - lookLx, dy = t.clientY - lookLy; lookLx = t.clientX; lookLy = t.clientY;
        headYaw -= dx * 0.005; pitch = Math.max(-1.3, Math.min(1.3, pitch - dy * 0.005));
      }
    }
  }
  function tEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; touchMove.x = 0; touchMove.y = 0; if (knob) knob.style.transform = ""; if (stick) stick.style.display = "none"; }
      else if (t.identifier === lookId) lookId = null;
    }
  }
  addEventListener("touchstart", tStart, { passive: false });
  addEventListener("touchmove", (e) => { if (touchMode) e.preventDefault(); tMove(e); }, { passive: false });
  addEventListener("touchend", tEnd); addEventListener("touchcancel", tEnd);
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("touchstart", (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false }); };
  bind("tb-fire", () => primaryAction());
  bind("tb-aim", () => { rmbAim = !rmbAim; document.getElementById("tb-aim")?.classList.toggle("on", rmbAim); });
  bind("tb-int", () => interact());
  bind("tb-crouch", () => { crouchToggle = !crouchToggle; document.getElementById("tb-crouch")?.classList.toggle("on", crouchToggle); });
  bind("tb-axe", () => setItem("axe"));
  bind("tb-gun", () => setItem("rifle"));
  bind("tb-build", () => setItem("build"));
  bind("tb-craft", () => toggleCraft());
  bind("tb-break", () => breakBuild());
  bind("tb-rot", () => { buildRot += Math.PI / 2; });
  bind("tb-cyc", () => cyclePiece(1));
}

// ------------------------------------------------------------------ multiplayer
const remote = new Map(); // id -> figure
let net = null, myId = null;
// a persistent per-browser id so the server can save & restore YOUR inventory/build/position across sessions
const PID = (() => { try { let p = localStorage.getItem("telbor_pid"); if (!p) { p = "p" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("telbor_pid", p); } return p; } catch { return "anon"; } })();
function connect() {
  net = new WebSocket(SERVER.replace(/^http/, "ws"));   // http->ws, https->wss
  net.onopen = () => { try { net.send(JSON.stringify({ t: "hello", pid: PID })); } catch {} };
  net.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === "welcome") {
      myId = m.id;
      if (m.spawn) { spawnPoint.x = m.spawn.x; spawnPoint.z = m.spawn.z; }
      for (const o of m.others) { spawnRemote(o.id, o); if (o.dead) killRemote(remote.get(o.id)); }
      setWorld(m.dayT, m.weather);
      if (m.animals) applyAnimals(m.animals);
      if (m.builds) for (const b of m.builds) addBuild(b);
    } else if (m.t === "world") {
      setWorld(m.dayT, m.weather);
    } else if (m.t === "animals") {
      applyAnimals(m.a);
    } else if (m.t === "akill") {
      dropAnimal(m.id, m.x, m.z);
    } else if (m.t === "join") {
      spawnRemote(m.id, m);
    } else if (m.t === "move") {
      const f = remote.get(m.id);
      if (f) f.userData.target = { x: m.x, z: m.z, ry: m.ry, hy: m.hy || 0, ph: m.ph || 0, cr: m.cr || 0, fy: m.fy || 0, am: m.am || 0, eq: m.eq ?? 1 };
    } else if (m.t === "shot") {
      const f = remote.get(m.id); if (f) { flashMuzzle(f); f.userData.recoil = 0.16; }   // remote muzzle climbs too
    } else if (m.t === "swing") {
      const f = remote.get(m.id); if (f) f.userData.swing = 1;                             // remote axe arc
    } else if (m.t === "hp") {
      if (m.id === myId) setLocalHp(m.hp); else { const f = remote.get(m.id); if (f) f.userData.hp = m.hp; }
    } else if (m.t === "died") {
      if (m.id === myId) onLocalDeath(m.cause); else killRemote(remote.get(m.id));
    } else if (m.t === "respawn") {
      if (m.id === myId) onLocalRespawn(m.x, m.z, m.hp); else reviveRemote(remote.get(m.id), m.x, m.z);
    } else if (m.t === "restore") {           // server handed back our saved inventory/hunger/position
      if (m.inv) Object.assign(inv, m.inv);
      if (typeof m.hunger === "number") hunger = m.hunger;
      if (typeof m.hp === "number") hp = m.hp;
      if (typeof m.x === "number") playerPos.set(m.x, 0, m.z);
      updateHotbarHUD(); updateBars();
    } else if (m.t === "build") {
      addBuild(m.b);
    } else if (m.t === "unbuild") {
      removeBuild(m.id);
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
  f.userData.netId = id; f.userData.hp = s.hp ?? 100; f.userData.recoil = 0; f.userData.swing = 0; f.userData.deadState = 0;
  scene.add(f); remote.set(id, f);
}
function remoteRoot(obj) { let o = obj; while (o) { if (o.userData && o.userData.netId != null) return o; o = o.parent; } return null; }
// remote player death: tip the body over + pool blood at the feet (reuses the animal corpse trick)
function killRemote(f) {
  if (!f || f.userData.deadState) return;
  f.userData.deadState = 1; f.rotation.z = Math.PI * 0.5;
  bloodPool(f.position.x, f.position.z);
  spawnBlood(new THREE.Vector3(f.position.x, f.position.y + 1.0, f.position.z));
}
function reviveRemote(f, x, z) {
  if (!f) return;
  f.userData.deadState = 0; f.rotation.z = 0;
  f.position.set(x, groundHeight(x, z), z);
  f.userData.target = { x, z, ry: 0, hy: 0, ph: 0, cr: 0, fy: 0, eq: 1 };
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
    ph: pitch, cr: crouching ? 1 : 0, fy: editorAlt, am: aiming && equipped ? 1 : 0, eq: equipped ? 1 : 0 }));
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
  // legs stride; arms stay in the fixed rifle-hold pose set in makePaleFigure
  L.legL.rotation.x =  sw; L.legR.rotation.x = -sw;
}

// ------------------------------------------------------------------ main loop
const FPS_CAP = 240;                 // don't let the throttle cap below the display; 120Hz+ monitors render at full rate
let last = performance.now();
let lastRender = 0;
let walkPhase = 0;
let frameCount = 0;
let clockLast = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastRender < 1000 / FPS_CAP - 0.5) return;   // fps cap
  lastRender = now;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;

  updateDay(dt); updateFx(dt); updateGore(dt); updateNetAnimals(dt);

  // --- keyboard look (a full mirror of the mouse) ---
  if (!menuOpen && !dead) {
    const kl = 1.9;
    if (keys["ArrowLeft"])  headYaw += kl * dt;
    if (keys["ArrowRight"]) headYaw -= kl * dt;
    if (keys["ArrowUp"])    pitch = Math.min(1.3, pitch + kl * dt);
    if (keys["ArrowDown"])  pitch = Math.max(-1.3, pitch - kl * dt);
  }
  aiming = (rmbAim || keys["KeyQ"]) && activeItem === "rifle" && !menuOpen && !dead;

  // --- input (movement is relative to where you're LOOKING) ---
  const menuBlock = menuOpen || dead;
  crouching = ((keys["ControlLeft"] || keys["ControlRight"]) || crouchToggle) && !editing && !dead;
  const touchMag = Math.hypot(touchMove.x, touchMove.y);
  const run = !menuBlock && ((keys["ShiftLeft"] || keys["ShiftRight"]) || (touchMode && touchMag > 0.92)) && !crouching;
  const speed = run ? 6.2 : crouching ? 1.6 : 3.1;
  let fwd = 0, str = 0;
  if (!menuBlock) {
    if (touchMode && touchMag > 0.18) { fwd = -touchMove.y; str = touchMove.x; }   // virtual joystick
    else {
      if (keys["KeyW"]) fwd += 1;
      if (keys["KeyS"]) fwd -= 1;
      if (keys["KeyD"]) str += 1;
      if (keys["KeyA"]) str -= 1;
    }
  }
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
    const beforePhase = walkPhase;
    walkPhase += dt * (run ? 13 : 8);
    if (!crouching && Math.floor(walkPhase / Math.PI) !== Math.floor(beforePhase / Math.PI))
      footstep(run, snowAmount(playerPos.x, playerPos.z) > 0.4);   // one step per half-cycle
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
  playerShadow.position.set(playerPos.x, gy + 0.05, playerPos.z);
  player.position.set(playerPos.x, gy, playerPos.z);
  player.rotation.y = bodyYaw;
  player.userData.limbs.head.rotation.y = wrapAngle(headYaw - bodyYaw);
  animateLimbs(player, moving ? Math.sin(walkPhase) * 0.5 : 0);

  // --- first-person camera: eye height (lower when crouched), follows head yaw + pitch ---
  const targetEye = crouching ? 1.0 : EYE;
  curEye += (targetEye - curEye) * Math.min(1, dt * 12);
  camera.position.set(playerPos.x, gy + curEye + editorAlt, playerPos.z);
  camera.rotation.y = headYaw;
  recoilPitch += (0 - recoilPitch) * Math.min(1, dt * 5);   // recoil kick settles back down
  camera.rotation.x = pitch + recoilPitch;

  updateViewGun(dt, moving && !crouching);
  updateSurvival(dt, run, moving);
  if (editing) editorTick();

  // --- remote figures: interpolate, stand on the ground, animate their gait ---
  for (const f of remote.values()) {
    const t = f.userData.target; if (!t) continue;
    f.userData.recoil = Math.max(0, f.userData.recoil - dt * 4);   // recoil / swing impulses decay
    f.userData.swing  = Math.max(0, f.userData.swing  - dt * 3);
    f.position.x += (t.x - f.position.x) * Math.min(1, dt * 10);
    f.position.z += (t.z - f.position.z) * Math.min(1, dt * 10);
    f.position.y = groundHeight(f.position.x, f.position.z) + (t.fy || 0);   // + fly height
    if (f.userData.deadState) continue;                                       // stay fallen; no rig/gait
    f.rotation.y += wrapAngle(t.ry - f.rotation.y) * Math.min(1, dt * 10);
    f.userData.limbs.head.rotation.y = wrapAngle((t.hy ?? t.ry) - f.rotation.y);
    f.userData.limbs.head.rotation.x = t.ph || 0;                            // look up/down
    f.userData.crv += ((t.cr ? 1 : 0) - f.userData.crv) * Math.min(1, dt * 10);
    f.scale.y = 1 - 0.32 * f.userData.crv;                                   // crouch
    const L2 = f.userData.limbs;
    if (f.userData.heldAxe) f.userData.heldAxe.visible = !t.eq;              // axe shows when the rifle is away
    // gun rig + arms track where they're looking; raised slightly on ADS; hidden when unequipped
    const rig = f.userData.gunPivot;
    if (rig) {
      const lookOff = wrapAngle((t.hy ?? t.ry) - f.rotation.y);
      rig.visible = !!t.eq;
      rig.rotation.y = lookOff;
      rig.rotation.x = (t.ph || 0) + f.userData.recoil;                      // muzzle climbs on recoil
      rig.position.y = 1.35 + (t.am ? 0.08 : 0);
      const up = (t.ph || 0) * 0.6;
      if (t.eq) {
        L2.armL.rotation.set(1.45 + up, lookOff - 0.28, 0);
        L2.armR.rotation.set(1.15 + up, lookOff + 0.28, 0);
      } else if (f.userData.swing > 0) {                                     // axe chop arc on the right arm
        const sw = Math.sin((1 - f.userData.swing) * Math.PI);
        L2.armL.rotation.set(0.4, 0, 0); L2.armR.rotation.set(-1.8 + sw * 2.6, 0, 0);
      } else {
        L2.armL.rotation.set(0, 0, 0); L2.armR.rotation.set(0, 0, 0);
      }
    }
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
camera.add(viewGun);
let viewRecoil = 0, viewBob = 0, lastFire = 0, recoilPitch = 0;
let equipped = true, aiming = false, aimT = 0;   // equipped mirrors (activeItem === "rifle"), kept in sync each frame
const FIRE_COOLDOWN = 5000;                       // 5 seconds between shots
const HIP = new THREE.Vector3(0.24, -0.2, -0.5);
const ADS = new THREE.Vector3(0.0, -0.05, -0.34);  // lines the U-sight up with screen center

// ---- first-person AXE viewmodel + swing ----
const viewAxe = makeAxe(); viewAxe.scale.setScalar(0.85);
viewAxe.position.set(0.28, -0.28, -0.45); viewAxe.rotation.set(0.2, -0.3, 0);
camera.add(viewAxe); viewAxe.visible = false;
let axeSwing = 0, lastSwing = 0;
function updateViewAxe(dt) {
  axeSwing = Math.max(0, axeSwing - dt * 3.5);
  viewAxe.visible = activeItem === "axe" && !editing && !dead;
  const s = Math.sin((1 - axeSwing) * Math.PI);      // 0..1..0 chop arc
  viewAxe.rotation.x = 0.2 + s * 1.5;                // swings down and back
  viewAxe.position.z = -0.45 - s * 0.12;
}

function updateViewGun(dt, walking) {
  equipped = activeItem === "rifle";                 // "equipped" now means the rifle is the active item
  updateViewAxe(dt);
  viewRecoil = Math.max(0, viewRecoil - dt * 6);
  aimT += ((aiming && equipped ? 1 : 0) - aimT) * Math.min(1, dt * 12);
  const canBob = walking && aimT < 0.5;
  viewBob += dt * (canBob ? 9 : 0);
  const bob = canBob ? Math.sin(viewBob) * 0.012 : 0;
  const px = HIP.x + (ADS.x - HIP.x) * aimT;
  const py = HIP.y + (ADS.y - HIP.y) * aimT + bob + viewRecoil * 0.03;   // muzzle RISES on recoil
  const pz = HIP.z + (ADS.z - HIP.z) * aimT + viewRecoil * 0.06;
  viewGun.position.set(px, py, pz);
  viewGun.scale.setScalar(0.85 - aimT * 0.3);      // shrinks toward the eye on ADS so the stock never crosses the near plane
  viewGun.rotation.x = viewRecoil * 0.28;          // barrel kicks UP
  viewGun.visible = equipped && !editing && !dead;
  const fov = 68 - aimT * 16;                      // slight zoom when aiming
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // center dot: when hip-carrying gun, when holding axe/build, or in the editor (U-sight takes over on ADS)
  const showDot = !dead && !menuOpen && ((equipped && aimT < 0.5) || activeItem === "axe" || activeItem === "build");
  document.getElementById("crosshair").classList.toggle("on", showDot || editing);
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
  if (!equipped) return;
  const now = performance.now();
  if (now - lastFire < FIRE_COOLDOWN) return;      // 5-second bolt cycle
  lastFire = now; viewRecoil = 1;
  recoilPitch = 0.16;                              // kicks the CAMERA up (recovers over the next moment)
  showFlash(viewGun);
  const mp = new THREE.Vector3(); viewGun.userData.muzzle.getWorldPosition(mp);
  spawnSmoke(mp); spawnSmoke(mp); spawnSmoke(mp);  // smoke plume out of the barrel
  gunSound();
  cooldownSound();                                 // ambient cue over the 5s reload
  // raycast down the crosshair: nearest of animal / player wins
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const aHits = raycaster.intersectObjects(animalGroup.children, true);
  const pHits = raycaster.intersectObjects([...remote.values()], true);
  const aD = aHits.length ? aHits[0].distance : Infinity;
  const pD = pHits.length ? pHits[0].distance : Infinity;
  if (net && net.readyState === 1) {
    if (pD < aD) { const f = remoteRoot(pHits[0].object); if (f && f.userData.netId != null) net.send(JSON.stringify({ t: "phit", id: f.userData.netId })); }
    else if (aHits.length) { const root = animalRoot(aHits[0].object); if (root && root.userData.aid != null) net.send(JSON.stringify({ t: "hit", id: root.userData.aid })); }
    net.send(JSON.stringify({ t: "shot" }));
  }
}
// low tense drone that fills the 5-second wait between shots
function cooldownSound() {
  const ctx = THREE.AudioContext.getContext();
  if (ctx.state !== "running") return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.setValueAtTime(70, t); osc.frequency.linearRampToValueAtTime(96, t + 4.8);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.4);
  g.gain.setValueAtTime(0.05, t + 4.2); g.gain.linearRampToValueAtTime(0.0, t + 5.0);
  osc.connect(g).connect(listener.getInput()); osc.start(t); osc.stop(t + 5.05);
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

// footstep: a short filtered noise thud; muffled crunch on snow, softer thud on grass
function footstep(running, snowy) {
  const ctx = THREE.AudioContext.getContext();
  if (ctx.state !== "running") return;
  const t = ctx.currentTime, dur = snowy ? 0.13 : 0.09;
  const buf = ctx.createBuffer(1, (ctx.sampleRate * dur) | 0, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, snowy ? 1.5 : 3);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter();
  if (snowy) { f.type = "highpass"; f.frequency.value = 1500; } else { f.type = "lowpass"; f.frequency.value = 380; }
  const g = ctx.createGain(); g.gain.value = running ? 0.16 : 0.09;
  src.connect(f).connect(g).connect(listener.getInput()); src.start(t);
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
//  DAY / NIGHT + WEATHER  (synced from the server so everyone matches)
// ==================================================================
let dayT = 0.30; const DAY_LEN = 300;
let serverDayT = null;
let fogDens = 0.15, fogTarget = 0.15;    // 0..1 fog thickness (thin by default; thickens before rain)
let rainInt = 0, rainTarget = 0;         // 0..1 rain intensity
function setWorld(dt_, w) {
  if (typeof dt_ === "number") serverDayT = dt_;
  if (w) { fogTarget = w.fog ?? fogTarget; rainTarget = w.kind === "rain" ? 1 : 0; }
}
const nightFade = document.getElementById("nightfade");
const _cNight = new THREE.Color(0x0b0f1a), _cDusk = new THREE.Color(0xcf8a55),
      _cNoon = new THREE.Color(0xbdc2c0), _cRain = new THREE.Color(0x6b7076), _cTmp = new THREE.Color();
function updateDay(dt) {
  dayT = (dayT + dt / DAY_LEN) % 1;
  if (serverDayT != null) { let d = serverDayT - dayT; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; dayT = (dayT + d * Math.min(1, dt * 2) + 1) % 1; }
  const ang = dayT * Math.PI * 2, elev = Math.sin(ang);
  sun.position.set(Math.cos(ang) * 60, elev * 60 + 2, Math.sin(ang * 0.7) * 30);
  const day = Math.max(0, elev);
  sun.intensity = (0.1 + day * 0.75) * (1 - rainInt * 0.5);
  hemi.intensity = (0.28 + day * 0.9) * (1 - rainInt * 0.3);
  const tt = (elev + 1) / 2;
  if (tt < 0.5) _cTmp.copy(_cNight).lerp(_cDusk, tt / 0.5);
  else _cTmp.copy(_cDusk).lerp(_cNoon, (tt - 0.5) / 0.5);
  _cTmp.lerp(_cRain, rainInt * 0.5);
  scene.background.copy(_cTmp); scene.fog.color.copy(_cTmp);
  // fog thickness varies with the weather
  fogDens += (fogTarget - fogDens) * Math.min(1, dt * 0.5);
  scene.fog.near = 14 - fogDens * 11;
  scene.fog.far  = 78 - fogDens * 50;
  // rain
  rainInt += (rainTarget - rainInt) * Math.min(1, dt * 0.4);
  updateRain(dt); updateRainSound();
  // the screen itself darkens with the sky
  if (nightFade) nightFade.style.opacity = (Math.max(0, -elev) * 0.6 + rainInt * 0.12).toFixed(3);
}

// --- rain: line-streak drops that follow the camera + ground splashes ---
const RAIN_N = 700, RAIN_BOX = 46;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_N * 6);
const rainVel = new Float32Array(RAIN_N);
for (let i = 0; i < RAIN_N; i++) {
  const x = (Math.random() - 0.5) * RAIN_BOX, y = Math.random() * 30, z = (Math.random() - 0.5) * RAIN_BOX;
  rainPos[i*6] = x; rainPos[i*6+1] = y; rainPos[i*6+2] = z;
  rainPos[i*6+3] = x; rainPos[i*6+4] = y - 0.6; rainPos[i*6+5] = z;
  rainVel[i] = 30 + Math.random() * 20;
}
rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaab0b8, transparent: true, opacity: 0, fog: true }));
rain.frustumCulled = false; scene.add(rain);
const splashes = [];
function updateRain(dt) {
  rain.material.opacity = rainInt * 0.5;
  rain.visible = rainInt > 0.02;
  if (rain.visible) {
    const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
    const pos = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN_N; i++) {
      const dy = rainVel[i] * dt;
      pos[i*6+1] -= dy; pos[i*6+4] -= dy;
      if (pos[i*6+1] < cy - 6) {
        const x = cx + (Math.random() - 0.5) * RAIN_BOX, z = cz + (Math.random() - 0.5) * RAIN_BOX, y = cy + 18 + Math.random() * 8;
        pos[i*6] = x; pos[i*6+1] = y; pos[i*6+2] = z;
        pos[i*6+3] = x; pos[i*6+4] = y - 0.6; pos[i*6+5] = z;
      }
    }
    rainGeo.attributes.position.needsUpdate = true;
    if (Math.random() < rainInt * 0.9) spawnSplash(cx + (Math.random() - 0.5) * 20, cz + (Math.random() - 0.5) * 20);
  }
  for (let i = splashes.length - 1; i >= 0; i--) {
    const s = splashes[i]; s.life += dt;
    s.mesh.scale.setScalar(0.2 + s.life * 3);
    s.mesh.material.opacity = Math.max(0, 0.5 * (1 - s.life / 0.5));
    if (s.life > 0.5) { scene.remove(s.mesh); splashes.splice(i, 1); }
  }
}
function spawnSplash(x, z) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.12, 8),
    new THREE.MeshBasicMaterial({ color: 0x9fb0c0, transparent: true, opacity: 0.5, fog: true }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, terrainHeight(x, z) + 0.03, z);
  scene.add(m); splashes.push({ mesh: m, life: 0 });
}
// rain sound (procedural, gated by intensity)
let rainGain = null;
function updateRainSound() {
  if (!audioStarted) return;
  if (!rainGain) {
    const ctx = THREE.AudioContext.getContext();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1000;
    rainGain = ctx.createGain(); rainGain.gain.value = 0;
    src.connect(hp).connect(rainGain).connect(listener.getInput()); src.start();
  }
  rainGain.gain.value = rainInt * 0.04;   // quiet patter, not a firehose
}

// ==================================================================
//  ANIMALS  — deer flee (cone of sight, crouch = stealth); wendigos hunt
// ==================================================================
const animalGroup = new THREE.Group(); scene.add(animalGroup);
const netAnimals = new Map();   // id -> render record (positions come from the server)
const corpses = [];             // dropped deer lingering before cleanup
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
  g.add(makeBlobShadow(0.85));
  g.userData.legs = legs; return g;
}
// variant looks: stalker = tall/thin/black, brute = short/wide/grey, screamer = pale with a gaping maw
const WEN_LOOK = {
  stalker:  { col: 0x141416, sc: 1.0,  bodyW: 0.4, bodyH: 1.5, ant: 0x8a8a80 },
  brute:    { col: 0x2a2422, sc: 1.25, bodyW: 0.7, bodyH: 1.5, ant: 0x6a3020 },
  screamer: { col: 0xb9b3a6, sc: 1.05, bodyW: 0.34, bodyH: 1.6, ant: 0xe8e2d6 },
};
function makeWendigo(variant) {                     // tall, dark, skinny figure (variant tweaks size/colour)
  const L = WEN_LOOK[variant] || WEN_LOOK.stalker;
  const g = new THREE.Group();
  const dark = ps1Material({ color: L.col });
  const wbody = new THREE.Mesh(new THREE.BoxGeometry(L.bodyW, L.bodyH, 0.28 * L.sc), dark); wbody.position.y = 2.35; g.add(wbody);
  const whead = new THREE.Mesh(new THREE.BoxGeometry(0.3 * L.sc, 0.42, 0.3 * L.sc), dark); whead.position.y = 3.25; g.add(whead);
  if (variant === "screamer") { const maw = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.08), new THREE.MeshBasicMaterial({ color: 0x4a0d12, fog: true })); maw.position.set(0, 3.2, 0.16 * L.sc); g.add(maw); }
  const antMat = ps1Material({ color: L.ant });
  for (const s of [-1, 1]) { const a = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.7 * L.sc, 4), antMat); a.position.set(s * 0.12, 3.65, 0); a.rotation.z = s * 0.4; g.add(a); }
  // limbs pivot from the joint (shoulder / hip) and hang DOWN — same rig as makePaleFigure's limb(),
  // so the stride code swings them from the hip instead of sliding a centered box.
  function wlimb(x, y, w, h) {
    const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), dark); mesh.position.y = -h / 2;
    pivot.add(mesh); g.add(pivot); return pivot;
  }
  const aw = 0.12 * L.sc, lw = 0.16 * L.sc;
  wlimb(-0.34 * L.sc, 3.0, aw, 1.5);               // arms hang from the shoulders
  wlimb( 0.34 * L.sc, 3.0, aw, 1.5);
  const legs = [ wlimb(-0.14 * L.sc, 1.65, lw, 1.65), wlimb(0.14 * L.sc, 1.65, lw, 1.65) ];   // legs swing from the hips (feet stay grounded)
  g.add(makeBlobShadow(0.55 * L.sc));
  g.userData.legs = legs; return g;
}
function animalRoot(obj) { let o = obj; while (o && o.parent !== animalGroup) o = o.parent; return o; }
// render the snapshot the server sends (spawn/update/despawn)
function applyAnimals(list) {
  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    let r = netAnimals.get(s.id);
    if (!r) {
      const mesh = (s.k === "wendigo") ? makeWendigo(s.v) : makeDeer();
      mesh.userData.aid = s.id; mesh.position.set(s.x, terrainHeight(s.x, s.z), s.z);
      animalGroup.add(mesh);
      r = { mesh, kind: s.k, tx: s.x, tz: s.z, tr: s.ry, px: s.x, pz: s.z, phase: 0 };
      netAnimals.set(s.id, r);
    }
    r.tx = s.x; r.tz = s.z; r.tr = s.ry;
  }
  for (const [id, r] of netAnimals) if (!seen.has(id)) { animalGroup.remove(r.mesh); netAnimals.delete(id); }
}
function updateNetAnimals(dt) {
  for (const r of netAnimals.values()) {
    const m = r.mesh;
    m.position.x += (r.tx - m.position.x) * Math.min(1, dt * 8);
    m.position.z += (r.tz - m.position.z) * Math.min(1, dt * 8);
    m.position.y = terrainHeight(m.position.x, m.position.z);
    m.rotation.y += wrapAngle(r.tr - m.rotation.y) * Math.min(1, dt * 8);
    const spd = Math.hypot(m.position.x - r.px, m.position.z - r.pz) / Math.max(dt, 1e-3);
    r.px = m.position.x; r.pz = m.position.z;
    if (spd > 0.1) { r.phase += dt * Math.min(spd, 10) * 2; const sw = Math.sin(r.phase) * 0.5, L = m.userData.legs; if (L) { L[0].rotation.x = sw; L[1].rotation.x = -sw; if (L[2]) L[2].rotation.x = -sw; if (L[3]) L[3].rotation.x = sw; } }
  }
  for (let i = corpses.length - 1; i >= 0; i--) { corpses[i].t -= dt; if (corpses[i].t <= 0) { animalGroup.remove(corpses[i].mesh); corpses.splice(i, 1); } }
}
// server confirmed a kill: blood + tip the deer over into a corpse
function dropAnimal(id, x, z) {
  spawnBlood(new THREE.Vector3(x, terrainHeight(x, z) + 1.0, z));
  bloodPool(x, z);
  const r = netAnimals.get(id); if (!r) return;
  const m = r.mesh; netAnimals.delete(id);
  const wound = new THREE.Mesh(new THREE.SphereGeometry(0.11, 5, 4), new THREE.MeshBasicMaterial({ color: 0x4a0808 }));
  wound.position.set(0, 1.0, 0.2); m.add(wound);
  m.rotation.z = Math.PI * 0.48;
  corpses.push({ mesh: m, t: 34 });
}
// pixel blood: red flecks that arc out and fall, then a pool that lingers 34s
const gore = [];
function spawnBlood(pos) {
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11),
      new THREE.MeshBasicMaterial({ color: 0x8a0d0d, transparent: true, opacity: 0.95, fog: true, side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3 + 1, (Math.random() - 0.5) * 3);
    scene.add(m); gore.push({ mesh: m, life: 0, ttl: 1.3, grav: true });
  }
}
function bloodPool(x, z) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.12, 12),
    new THREE.MeshBasicMaterial({ color: 0x5a0a0a, transparent: true, opacity: 0.85, fog: true }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, terrainHeight(x, z) + 0.04, z);
  scene.add(m); gore.push({ mesh: m, life: 0, ttl: 34, pool: true });
}
function updateGore(dt) {
  for (let i = gore.length - 1; i >= 0; i--) {
    const p = gore[i]; p.life += dt;
    if (p.grav) {
      p.mesh.userData.vel.y -= 9 * dt;
      p.mesh.position.addScaledVector(p.mesh.userData.vel, dt);
      const gh = terrainHeight(p.mesh.position.x, p.mesh.position.z);
      if (p.mesh.position.y < gh + 0.02) { p.mesh.position.y = gh + 0.02; p.mesh.userData.vel.set(0, 0, 0); }
      p.mesh.quaternion.copy(camera.quaternion);
    }
    if (p.pool) p.mesh.scale.setScalar(1 + Math.min(p.life, 3) * 2.5);   // spreads, then holds
    if (p.life > p.ttl - 2) p.mesh.material.opacity = Math.max(0, (p.pool ? 0.85 : 0.95) * (p.ttl - p.life) / 2);
    if (p.life > p.ttl) { scene.remove(p.mesh); gore.splice(i, 1); }
  }
}
// (animal AI now lives on the server — see server.js; the client only renders snapshots)

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
  audioLoader.load(api("/assets/audio/" + name), (buf) => {
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
  audioLoader.load(api("/assets/audio/" + e.asset), (buf) => {
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
  gltfLoader.load(api("/assets/models/" + e.asset), (gltf) => { ps1ify(gltf.scene); groundAndPlace(gltf.scene, e, true); },
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
async function loadManifest() { try { manifest = await (await fetch(api("/api/manifest"))).json(); } catch {} buildPalette(); }
async function loadMap(name) { try { const r = await fetch(api("/api/maps/" + name)); if (r.ok) currentMap = await r.json(); } catch {} applyMap(); }

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
    const r = await fetch(api("/api/maps/" + (currentMap.name || "main")),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(currentMap) });
    const j = await r.json(); flash(j.ok ? "saved maps/" + j.name + ".json" : "save failed");
  } catch { flash("save failed"); }
}

addEventListener("keydown", (e) => {
  if (e.code === "Backquote") { e.preventDefault(); toggleEditor(); return; }   // map editor (moved off Tab, which now opens crafting)
  if (!editing) return;
  if (e.code === "BracketLeft")  { selIndex = (selIndex - 1 + palette.length) % palette.length; rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "BracketRight") { selIndex = (selIndex + 1) % palette.length; rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "KeyR") { placeRot += Math.PI / 8; updateEditorHUD(); }
  else if (e.code === "Equal" || e.code === "NumpadAdd") { placeScale = Math.min(6, placeScale + 0.2); rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "Minus" || e.code === "NumpadSubtract") { placeScale = Math.max(0.2, placeScale - 0.2); rebuildGhost(); updateEditorHUD(); }
  else if (e.code === "Backspace") { e.preventDefault(); deleteNearest(); }
  else if (e.code === "KeyP") { saveMap(); }
});
addEventListener("wheel", (e) => {
  if (editing) { selIndex = (selIndex + (e.deltaY > 0 ? 1 : -1) + palette.length) % palette.length; rebuildGhost(); updateEditorHUD(); return; }
  if (activeItem === "build") cyclePiece(e.deltaY > 0 ? 1 : -1);   // scroll cycles build pieces
}, { passive: true });
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !locked) return;
  if (editing) { placeSelected(); return; }
  primaryAction();                                   // left-click = use active item (also bound to F)
});

// ==================================================================
//  SURVIVAL  — inventory, hotbar, health, hunger, chopping, building, crafting, cooking
// ==================================================================
const inv = { wood: 0, rawMeat: 0, cookedMeat: 0, stone: 0 };
let activeItem = "axe";                 // axe | rifle | build | none  (you SPAWN with the axe)
let hp = 100; const maxHp = 100;
let hunger = 100; const maxHunger = 100;
let dead = false, starveT = 0, hurtFlash = 0;
let crouchToggle = false;
let menuOpen = false, craftOpen = false, bindsOpen = false;
const spawnPoint = { x: 0, z: 0 };

// ---- item switching ----
function setItem(it) {
  activeItem = it;
  if (it !== "rifle") { rmbAim = false; }
  if (it === "build") rebuildBuildGhost(); else buildGhost.visible = false;
  updateHotbarHUD();
}

function primaryAction() {
  if (dead || menuOpen || editing) return;
  if (activeItem === "rifle") fire();
  else if (activeItem === "axe") swingAxe();
  else if (activeItem === "build") placeBuild();
}

// ---- axe: swing, chop trees for wood, chip rocks for stone ----
function treeRoot(obj) { let o = obj; while (o && o.parent !== forest) o = o.parent; return o; }
function swingAxe() {
  const now = performance.now();
  if (now - lastSwing < 550) return;
  lastSwing = now; axeSwing = 1;
  if (net && net.readyState === 1) net.send(JSON.stringify({ t: "swing" }));
  chopSound();
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const tHits = raycaster.intersectObjects(forest.children, true);
  if (tHits.length && tHits[0].distance < 3.6) {
    const tree = treeRoot(tHits[0].object);
    if (tree && tree.userData.chop) { spawnChips(tHits[0].point); if (--tree.userData.chop.hp <= 0) fellTree(tree); return; }
  }
  const rHits = raycaster.intersectObjects(rocks.children, true);
  if (rHits.length && rHits[0].distance < 3.2) { spawnChips(rHits[0].point); if (Math.random() < 0.5) { inv.stone++; updateHotbarHUD(); } }
}
function fellTree(tree) {
  const c = tree.userData.chop.col; const ci = colliders.indexOf(c); if (ci >= 0) colliders.splice(ci, 1);
  inv.wood += tree.userData.chop.wood; updateHotbarHUD(); showToast("+" + tree.userData.chop.wood + " wood");
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.4, 6), trunkMat);
  stump.position.set(tree.position.x, terrainHeight(tree.position.x, tree.position.z) + 0.2, tree.position.z);
  scene.add(stump);
  forest.remove(tree);
}
function spawnChips(pos) {
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x6b4a2c, transparent: true, opacity: 0.95, fog: true, side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 2.5, Math.random() * 2 + 1, (Math.random() - 0.5) * 2.5);
    scene.add(m); gore.push({ mesh: m, life: 0, ttl: 0.8, grav: true });
  }
}
function chopSound() {
  const ctx = THREE.AudioContext.getContext(); if (ctx.state !== "running") return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  o.connect(g).connect(listener.getInput()); o.start(t); o.stop(t + 0.18);
}
function eatSound() {
  const ctx = THREE.AudioContext.getContext(); if (ctx.state !== "running") return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(140, t); o.frequency.linearRampToValueAtTime(90, t + 0.2);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  o.connect(g).connect(listener.getInput()); o.start(t); o.stop(t + 0.26);
}

// ---- interact (E): loot meat / light+cook at campfire / eat ----
function nearestBuild(range) {
  let best = null, bd = range;
  for (const rec of buildRecords.values()) { const d = Math.hypot(rec.x - playerPos.x, rec.z - playerPos.z); if (d < bd) { bd = d; best = rec; } }
  return best;
}
function interact() {
  if (dead || menuOpen || editing) return;
  for (const c of corpses) {
    if (c.looted) continue;
    if (Math.hypot(c.mesh.position.x - playerPos.x, c.mesh.position.z - playerPos.z) < 3) { c.looted = true; inv.rawMeat += 2; updateHotbarHUD(); showToast("+2 raw meat"); return; }
  }
  const cf = nearestBuild(3.0);
  if (cf && cf.piece === "campfire") {
    if (!cf.lit) { if (inv.wood >= 1) { inv.wood--; cf.lit = true; cf.fuel = 40; lightCampfire(cf); updateHotbarHUD(); showToast("campfire lit"); } else showToast("need 1 wood"); return; }
    if (inv.rawMeat > 0) { inv.rawMeat--; cf.cookQueue++; updateHotbarHUD(); showToast("cooking meat..."); return; }
    showToast("no raw meat");
    return;
  }
  if (eatCooked()) return;
  if (inv.rawMeat > 0) showToast("cook it at a campfire first");
}
function eatCooked() {
  if (inv.cookedMeat > 0) { inv.cookedMeat--; hunger = Math.min(maxHunger, hunger + 35); updateHotbarHUD(); eatSound(); showToast("ate cooked meat"); return true; }
  return false;
}

// ---- health / hunger / death ----
function setLocalHp(v) { const dmg = v < hp; hp = v; if (dmg) hurtFlash = 1; updateBars(); }
function onLocalDeath(cause) {
  dead = true; hurtFlash = 1; updateBars();
  const el = document.getElementById("deathscreen");
  if (el) { el.querySelector(".cause").textContent = cause === "wendigo" ? "the wendigo took you" : cause === "starve" ? "you starved" : "you were killed"; el.classList.add("on"); }
  document.exitPointerLock?.();
}
function onLocalRespawn(x, z, nhp) {
  dead = false; hp = nhp ?? maxHp; hunger = maxHunger; starveT = 0;
  playerPos.set(x, 0, z); pitch = 0; crouchToggle = false;
  setItem("axe");
  const el = document.getElementById("deathscreen"); if (el) el.classList.remove("on");
  updateBars(); updateHotbarHUD();
}

function updateSurvival(dt, run, moving) {
  if (!dead) {
    hunger = Math.max(0, hunger - dt * (run && moving ? 0.28 : 0.14));   // drains slowly; running burns a bit faster (~12min idle)
    if (hunger <= 0) { starveT += dt; if (starveT > 2) { starveT = 0; if (net && net.readyState === 1) net.send(JSON.stringify({ t: "starve" })); } }
    else starveT = 0;
  }
  hurtFlash = Math.max(0, hurtFlash - dt * 1.5);
  const hurt = document.getElementById("hurt"); if (hurt) hurt.style.opacity = (hurtFlash * 0.5).toFixed(3);
  // campfires burn / cook
  for (const rec of buildRecords.values()) {
    if (rec.piece !== "campfire" || !rec.lit) continue;
    rec.fuel -= dt; if (rec.fuel <= 0) { extinguish(rec); continue; }
    if (rec.flame) { rec.flame.quaternion.copy(camera.quaternion); rec.flame.scale.setScalar(0.85 + Math.sin(performance.now() * 0.02) * 0.2); }
    if (rec.cookQueue > 0) { rec.cookT += dt; if (rec.cookT > 4) { rec.cookT = 0; rec.cookQueue--; inv.cookedMeat++; updateHotbarHUD(); showToast("meat cooked!"); } }
  }
  updateBars(); updateBuildGhost(); updatePrompt();
}

// ---- building: shaped pieces, socket/grid snap, server-synced ----
const buildMat = ps1Material({ map: noiseTexture([124, 92, 58], 24) });   // planks
const buildMatDark = ps1Material({ color: 0x4a3520 });
const BUILD_PIECES = ["foundation", "wall", "doorway", "window", "halfwall", "floor", "roof", "ramp", "pillar", "block", "campfire"];
const PIECE_COST = { foundation: 10, wall: 5, doorway: 6, window: 6, halfwall: 3, floor: 8, roof: 8, ramp: 7, pillar: 4, block: 2, campfire: 5 };
let buildPiece = "foundation", buildRot = 0, buildTarget = null;
const buildings = new THREE.Group(); scene.add(buildings);
const buildRecords = new Map();
const buildGhostMat = new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.4, fog: false, depthWrite: false });
const buildGhost = new THREE.Group(); buildGhost.visible = false; scene.add(buildGhost);

function makeBuildPiece(piece) {
  const g = new THREE.Group();
  if (piece === "foundation") {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 4), buildMat); slab.position.y = 0.15; g.add(slab);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.3), buildMatDark); p.position.set(sx * 1.85, 0.4, sz * 1.85); g.add(p); }
  } else if (piece === "floor") {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4), buildMat); slab.position.y = 0.1; g.add(slab);
  } else if (piece === "wall") {
    const w = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2), buildMat); w.position.y = 1.5; g.add(w);
  } else if (piece === "doorway") {
    for (const sx of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3, 0.2), buildMat); post.position.set(sx * 1.5, 1.5, 0); g.add(post); }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(4, 0.7, 0.2), buildMat); lintel.position.set(0, 2.65, 0); g.add(lintel);
  } else if (piece === "window") {
    for (const sx of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3, 0.2), buildMat); post.position.set(sx * 1.5, 1.5, 0); g.add(post); }
    const top = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 0.2), buildMat); top.position.set(0, 2.55, 0); g.add(top);
    const bot = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 0.2), buildMat); bot.position.set(0, 0.45, 0); g.add(bot);
  } else if (piece === "halfwall") {
    const w = new THREE.Mesh(new THREE.BoxGeometry(4, 1.4, 0.2), buildMat); w.position.y = 0.7; g.add(w);
  } else if (piece === "roof") {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4), buildMatDark); slab.position.y = 0.1; g.add(slab);
  } else if (piece === "ramp") {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 5.7), buildMat); slab.rotation.x = -Math.atan2(3, 4); slab.position.y = 1.5; g.add(slab);
  } else if (piece === "pillar") {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 3, 6), buildMat); p.position.y = 1.5; g.add(p);
  } else if (piece === "block") {
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), buildMat); b.position.y = 0.5; g.add(b);
  } else if (piece === "campfire") {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.14, 5, 8), rockMat0); ring.rotation.x = Math.PI / 2; ring.position.y = 0.14; g.add(ring);
    for (let i = 0; i < 4; i++) { const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5), buildMatDark); log.position.y = 0.18; log.rotation.set(0, i * 0.8, Math.PI / 2 - 0.2 + i * 0.12); g.add(log); }
  }
  return g;
}
function rebuildBuildGhost() {
  while (buildGhost.children.length) buildGhost.remove(buildGhost.children[0]);
  const g = makeBuildPiece(buildPiece); g.traverse(o => { if (o.isMesh) o.material = buildGhostMat; }); buildGhost.add(g);
}
function cyclePiece(dir) {
  const i = (BUILD_PIECES.indexOf(buildPiece) + dir + BUILD_PIECES.length) % BUILD_PIECES.length;
  buildPiece = BUILD_PIECES[i]; rebuildBuildGhost(); updateHotbarHUD();
}
function nearestBuildOf(piece, px, pz, range) {
  let best = null, bd = range;
  for (const rec of buildRecords.values()) { if (rec.piece !== piece) continue; const d = Math.hypot(rec.x - px, rec.z - pz); if (d < bd) { bd = d; best = rec; } }
  return best;
}
function computeBuildSnap() {
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hit = raycaster.intersectObjects([ground, ...buildings.children], true)[0];
  let px = playerPos.x - Math.sin(headYaw) * 4, pz = playerPos.z - Math.cos(headYaw) * 4, hy = null;
  if (hit && hit.distance < 14) { px = hit.point.x; pz = hit.point.z; hy = hit.point.y; }
  const P = buildPiece;
  if (P === "campfire" || P === "ramp") return { x: +px.toFixed(2), y: terrainHeight(px, pz), z: +pz.toFixed(2), ry: buildRot };
  if (P === "block") {                        // 1m grid, stacks on whatever you look at
    const gy = hy != null ? Math.round(hy) : Math.round(terrainHeight(px, pz));
    return { x: Math.round(px), y: gy, z: Math.round(pz), ry: 0 };
  }
  if (P === "pillar") { const gx = Math.round(px / 2) * 2, gz = Math.round(pz / 2) * 2; return { x: gx, y: terrainHeight(gx, gz), z: gz, ry: 0 }; }
  if (P === "foundation" || P === "floor" || P === "roof") {
    const gx = Math.round(px / 4) * 4, gz = Math.round(pz / 4) * 4;
    if (P === "foundation") return { x: gx, y: terrainHeight(gx, gz), z: gz, ry: 0 };
    const f = nearestBuildOf("foundation", gx, gz, 1.0);
    const base = (f ? f.y : terrainHeight(gx, gz)) + (P === "roof" ? 3.1 : 3);
    return { x: gx, y: base, z: gz, ry: 0 };
  }
  // wall / doorway / window / halfwall snap to nearest foundation edge (socket-style)
  const near = nearestBuildOf("foundation", px, pz, 4.5);
  if (near) {
    const edges = [ { x: near.x, z: near.z + 2, ry: 0 }, { x: near.x, z: near.z - 2, ry: 0 },
                    { x: near.x + 2, z: near.z, ry: Math.PI / 2 }, { x: near.x - 2, z: near.z, ry: Math.PI / 2 } ];
    let best = edges[0], bd = Infinity;
    for (const e of edges) { const d = Math.hypot(e.x - px, e.z - pz); if (d < bd) { bd = d; best = e; } }
    return { x: best.x, y: near.y, z: best.z, ry: best.ry };
  }
  return { x: +px.toFixed(2), y: terrainHeight(px, pz), z: +pz.toFixed(2), ry: buildRot };
}
function updateBuildGhost() {
  if (activeItem !== "build" || menuOpen || dead || !locked) { buildGhost.visible = false; return; }
  const s = computeBuildSnap(); buildTarget = s;
  buildGhost.position.set(s.x, s.y, s.z); buildGhost.rotation.y = s.ry; buildGhost.visible = true;
}
function placeBuild() {
  if (!buildGhost.visible || !buildTarget) return;
  const cost = PIECE_COST[buildPiece];
  if (inv.wood < cost) { showToast("need " + cost + " wood"); return; }
  inv.wood -= cost; updateHotbarHUD();
  if (net && net.readyState === 1) net.send(JSON.stringify({ t: "build", piece: buildPiece, x: buildTarget.x, y: buildTarget.y, z: buildTarget.z, ry: buildTarget.ry }));
}
function breakBuild() {                       // look at any build piece and remove it (refunds half the wood)
  if (dead || menuOpen || editing) return;
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObjects(buildings.children, true);
  if (!hits.length || hits[0].distance > 8) { showToast("look at a build to break it"); return; }
  let o = hits[0].object; while (o && (o.userData.bid == null)) o = o.parent;
  if (o && o.userData.bid != null) {
    const rec = buildRecords.get(o.userData.bid);
    const refund = rec ? Math.floor((PIECE_COST[rec.piece] || 0) * 0.5) : 0;
    if (refund) { inv.wood += refund; updateHotbarHUD(); }
    if (net && net.readyState === 1) net.send(JSON.stringify({ t: "unbuild", id: o.userData.bid }));
    showToast("broke " + (rec ? rec.piece : "build") + (refund ? " (+" + refund + " wood)" : ""));
  }
}
function pushWallColliders(rec) {
  const dirx = Math.cos(rec.ry), dirz = -Math.sin(rec.ry); rec.cols = [];
  for (const o of [-1.3, 0, 1.3]) { const c = { x: rec.x + dirx * o, z: rec.z + dirz * o, r: 0.55 }; colliders.push(c); rec.cols.push(c); }
}
function addBuild(b) {
  if (buildRecords.has(b.id)) return;
  const mesh = makeBuildPiece(b.piece); mesh.position.set(b.x, b.y, b.z); mesh.rotation.y = b.ry || 0; mesh.userData.bid = b.id;
  buildings.add(mesh);
  const rec = { id: b.id, piece: b.piece, mesh, x: b.x, y: b.y, z: b.z, ry: b.ry || 0, by: b.by, lit: false, fuel: 0, cookQueue: 0, cookT: 0, cols: [] };
  buildRecords.set(b.id, rec);
  if (b.piece === "wall" || b.piece === "window" || b.piece === "halfwall") pushWallColliders(rec);
  else if (b.piece === "doorway") { const dirx = Math.cos(rec.ry), dirz = -Math.sin(rec.ry); for (const o of [-1.5, 1.5]) { const c = { x: b.x + dirx * o, z: b.z + dirz * o, r: 0.5 }; colliders.push(c); rec.cols.push(c); } }
  else if (b.piece === "campfire") { const c = { x: b.x, z: b.z, r: 0.6 }; colliders.push(c); rec.cols.push(c); }
  else if (b.piece === "block") { const c = { x: b.x, z: b.z, r: 0.72 }; colliders.push(c); rec.cols.push(c); }
  else if (b.piece === "pillar") { const c = { x: b.x, z: b.z, r: 0.4 }; colliders.push(c); rec.cols.push(c); }
}
function removeBuild(id) {
  const rec = buildRecords.get(id); if (!rec) return;
  buildings.remove(rec.mesh);
  for (const c of rec.cols) { const i = colliders.indexOf(c); if (i >= 0) colliders.splice(i, 1); }
  buildRecords.delete(id);
}
function lightCampfire(rec) {
  if (rec.flame) return;
  const flame = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.85),
    new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0.9, fog: false, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.y = 0.5; rec.mesh.add(flame); rec.flame = flame;
  const light = new THREE.PointLight(0xff8030, 1.4, 12); light.position.y = 0.7; rec.mesh.add(light); rec.light = light;
}
function extinguish(rec) {
  if (rec.flame) { rec.mesh.remove(rec.flame); rec.flame = null; }
  if (rec.light) { rec.mesh.remove(rec.light); rec.light = null; }
  rec.lit = false;
}

// ---- HUD ----
function updateBars() {
  const h = document.getElementById("healthbar"); if (h) h.style.width = Math.max(0, (hp / maxHp) * 100).toFixed(0) + "%";
  const g = document.getElementById("hungerbar"); if (g) g.style.width = Math.max(0, (hunger / maxHunger) * 100).toFixed(0) + "%";
}
function updateHotbarHUD() {
  const el = document.getElementById("hotbar"); if (!el) return;
  const name = activeItem === "build" ? ("BUILD: " + buildPiece + " (" + PIECE_COST[buildPiece] + "w)")
             : activeItem === "rifle" ? "RIFLE" : activeItem === "axe" ? "AXE" : "— hands —";
  el.innerHTML = `<b>${name}</b> &nbsp; ⌾ wood ${inv.wood} · meat ${inv.rawMeat}/${inv.cookedMeat}🔥 · stone ${inv.stone}`;
}
let toastTimer = 0;
function showToast(msg) { const el = document.getElementById("toast"); if (!el) return; el.textContent = msg; el.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), 1500); }
function updatePrompt() {
  let msg = "";
  for (const c of corpses) { if (!c.looted && Math.hypot(c.mesh.position.x - playerPos.x, c.mesh.position.z - playerPos.z) < 3) { msg = "[E] take meat"; break; } }
  if (!msg) { const cf = nearestBuild(3.0); if (cf && cf.piece === "campfire") msg = cf.lit ? (inv.rawMeat > 0 ? "[E] cook meat" : (inv.cookedMeat > 0 ? "[E] eat" : "")) : "[E] light fire (1 wood)"; }
  if (!msg && inv.cookedMeat > 0) msg = "[E] eat cooked meat";
  const el = document.getElementById("prompt"); if (el) { el.textContent = msg; el.style.opacity = msg ? "1" : "0"; }
}

// ---- crafting menu (Tab) + binds panel (K) ----
const BINDINGS = [
  ["Move", "W A S D"], ["Look", "Arrow Keys / Mouse"], ["Run", "Shift"], ["Crouch", "Ctrl hold / C toggle"],
  ["Use / Attack", "Left-Click / F"], ["Aim rifle", "Right-Click / Q"], ["Interact · Eat", "E"],
  ["Axe", "1"], ["Rifle", "2"], ["Build mode", "3"], ["Holster", "H"],
  ["Crafting / Inventory", "Tab"], ["Build: rotate", "R"], ["Build: cycle piece", "[ ]  /  Wheel"],
  ["Binds panel", "K"], ["Map editor", "` backtick"],
];
function closeMenus() { craftOpen = false; bindsOpen = false; menuOpen = false; document.getElementById("craft")?.classList.remove("on"); document.getElementById("binds")?.classList.remove("on"); }
function toggleBinds() {
  bindsOpen = !bindsOpen; if (bindsOpen) craftOpen = false;
  menuOpen = bindsOpen || craftOpen;
  const el = document.getElementById("binds");
  if (el) { el.classList.toggle("on", bindsOpen); if (bindsOpen) el.querySelector(".rows").innerHTML = BINDINGS.map(b => `<div class="row"><span>${b[0]}</span><b>${b[1]}</b></div>`).join(""); }
  document.getElementById("craft")?.classList.toggle("on", craftOpen);
  if (menuOpen) document.exitPointerLock?.();
}
function toggleCraft() {
  craftOpen = !craftOpen; if (craftOpen) bindsOpen = false;
  menuOpen = craftOpen || bindsOpen;
  document.getElementById("binds")?.classList.remove("on");
  const el = document.getElementById("craft");
  if (el) { el.classList.toggle("on", craftOpen); if (craftOpen) renderCraft(); }
  if (menuOpen) document.exitPointerLock?.();
}
function renderCraft() {
  const el = document.getElementById("craft"); if (!el) return;
  const body = el.querySelector(".body");
  const pieceRows = BUILD_PIECES.map(p => {
    const cost = PIECE_COST[p], ok = inv.wood >= cost;
    return `<button class="craftbtn ${ok ? "" : "no"}" data-piece="${p}">${p} <span>${cost} wood</span></button>`;
  }).join("");
  body.innerHTML =
    `<div class="inv">wood <b>${inv.wood}</b> · stone <b>${inv.stone}</b> · raw meat <b>${inv.rawMeat}</b> · cooked <b>${inv.cookedMeat}</b></div>
     <div class="sec">BUILD  <small>(select a piece, then place with Left-Click / F · rotate R · cycle [ ])</small></div>
     <div class="grid">${pieceRows}</div>
     <div class="sec">CONSUME</div>
     <div class="grid">
       <button class="craftbtn ${inv.cookedMeat > 0 ? "" : "no"}" data-act="eat">eat cooked meat <span>+35 hunger</span></button>
     </div>
     <div class="hint">meat comes from shot deer (walk up, press E). cook raw meat at a lit campfire.</div>`;
  body.querySelectorAll("[data-piece]").forEach(b => b.onclick = () => { buildPiece = b.dataset.piece; setItem("build"); closeMenus(); });
  body.querySelectorAll("[data-act='eat']").forEach(b => b.onclick = () => { eatCooked(); renderCraft(); updateBars(); });
}
document.getElementById("bindsBtn")?.addEventListener("click", toggleBinds);
for (const pid of ["craft", "binds"]) { const p = document.getElementById(pid); if (p) p.addEventListener("mousedown", e => { if (e.target === p) closeMenus(); }); }

rebuildBuildGhost(); updateHotbarHUD(); updateBars();
// push inventory + hunger to the server every 8s so it can persist YOUR data
setInterval(() => { if (net && net.readyState === 1) net.send(JSON.stringify({ t: "save", inv, hunger })); }, 8000);

// ------------------------------------------------------------------ boot the content pipeline
(async () => { await loadManifest(); await loadMap("main"); })();

requestAnimationFrame(frame);

// debug handle (harmless; lets tooling force a render while the tab is hidden)
window.__dread = { renderer, scene, camera, THREE, get map() { return currentMap; }, get manifest() { return manifest; } };
