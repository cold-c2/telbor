// Low-poly dread — static server + content pipeline + multiplayer relay
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8770;

// ---- content folders (auto-created, so you can just drop files in) ----
const ASSETS = path.join(__dirname, "assets");
const MAPS   = path.join(__dirname, "maps");
const DIRS = {
  models:   path.join(ASSETS, "models"),   // .glb / .gltf   (Blockbench, etc.)
  audio:    path.join(ASSETS, "audio"),    // .mp3 / .ogg / .wav
  textures: path.join(ASSETS, "textures"), // .png / .jpg
};
for (const d of [ASSETS, MAPS, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

const app = express();
// allow the web build (hosted on another origin, e.g. Vercel) to reach this server
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "16mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(ASSETS));
app.use("/three", express.static(path.join(__dirname, "node_modules/three/build")));
app.use("/three/addons", express.static(path.join(__dirname, "node_modules/three/examples/jsm")));

const EXT = { models: /\.(glb|gltf)$/i, audio: /\.(mp3|ogg|wav)$/i, textures: /\.(png|jpe?g)$/i };
const listDir = (dir, rx) => { try { return fs.readdirSync(dir).filter(f => rx.test(f)); } catch { return []; } };

// everything currently sitting in the content folders (the "compile" step is just: refresh)
app.get("/api/manifest", (req, res) => {
  res.json({
    models:   listDir(DIRS.models, EXT.models),
    audio:    listDir(DIRS.audio, EXT.audio),
    textures: listDir(DIRS.textures, EXT.textures),
    maps:     listDir(MAPS, /\.json$/i).map(f => f.replace(/\.json$/i, "")),
  });
});
// read a map
app.get("/api/maps/:name", (req, res) => {
  const p = path.join(MAPS, path.basename(req.params.name) + ".json");
  if (!fs.existsSync(p)) return res.status(404).json({ error: "not found" });
  res.sendFile(p);
});
// save a map (the editor posts here)
app.post("/api/maps/:name", (req, res) => {
  const name = path.basename(req.params.name).replace(/[^a-z0-9_\-]/gi, "");
  if (!name) return res.status(400).json({ error: "bad name" });
  fs.writeFileSync(path.join(MAPS, name + ".json"), JSON.stringify(req.body, null, 2));
  res.json({ ok: true, name });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let nextId = 1;
const players = new Map();

function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}
function sendTo(id, obj) { const p = players.get(id); if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }

// ---- shared world: time of day + weather (server owns these so everyone matches) ----
// Weather is a state machine so FOG is a rain PRECURSOR, not an ever-present haze:
//   clear (thin fog) --> fog rolls in (thickening) --> rain (with fog) --> clears back to clear.
const DAY_LEN = 300;                       // seconds per full day
let dayT = 0.30;
let weather = { kind: "clear", fog: 0.15 };
let wxState = "clear", wxTimer = 40;
function stepWeather() {
  wxTimer -= 1;
  if (wxTimer > 0) {
    // gentle drift within the current state
    if (wxState === "fog")   weather.fog = Math.min(0.9, weather.fog + 0.03);   // fog thickens ahead of rain
    if (wxState === "clear") weather.fog = 0.12 + Math.sin(Date.now() / 9000) * 0.05;
    return;
  }
  if (wxState === "clear") {            // maybe start a fog build-up that precedes rain
    if (Math.random() < 0.6) { wxState = "fog"; weather = { kind: "fog", fog: 0.35 }; wxTimer = 22 + Math.random() * 12; }
    else { wxTimer = 30 + Math.random() * 40; }                                  // stay clear a while
  } else if (wxState === "fog") {       // fog has gathered -> rain breaks
    wxState = "rain"; weather = { kind: "rain", fog: 0.6 + Math.random() * 0.25 }; wxTimer = 40 + Math.random() * 50;
  } else {                              // rain passes -> skies clear
    wxState = "clear"; weather = { kind: "clear", fog: 0.15 }; wxTimer = 45 + Math.random() * 60;
  }
}
setInterval(() => {
  dayT = (dayT + 1 / DAY_LEN) % 1;
  stepWeather();
  broadcast({ t: "world", dayT, weather });
}, 1000);

// ---- server-authoritative terrain (MUST match public/main.js terrainHeight) ----
function terrainHeight(x, z) {
  const big  = Math.sin(x * 0.016) * 5.0 + Math.cos(z * 0.019) * 4.6;              // broad rolling hills (taller)
  const ridge = (1.0 - Math.abs(Math.sin(x * 0.03 + Math.cos(z * 0.026) * 1.3))) * 4.2; // ridged crests
  const med  = Math.sin(x * 0.05) * 1.0 + Math.cos(z * 0.06) * 0.9;               // medium bumps
  const fine = Math.sin((x + z) * 0.11) * 0.45 + Math.sin(x * 0.17 - z * 0.13) * 0.25;  // fine ripple
  // SHORT CLIFFS: quantize the broad hills into 2m terraces over ~half the map
  const terr = Math.round((big * 0.5) / 2.0) * 2.0;
  const cliffMask = Math.max(0, Math.sin(x * 0.012 + 2.1) * Math.cos(z * 0.011 - 1.3));
  const terraced = big + (terr - big) * cliffMask * 0.7;
  // TALL HILL CLIFFS: a steep escarpment where a low-freq field crosses a threshold
  const esc = Math.sin(x * 0.008 - 1.7) + Math.cos(z * 0.0075 + 0.6);
  const escarp = esc > 1.0 ? (esc - 1.0) * 16 : 0;
  return terraced + ridge + med + fine + escarp;
}
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const arand = mulberry32(20080102);

// ---- combat / health ----
const SPAWN = { x: 0, z: 0 };
function applyDamage(id, amount, cause) {
  const p = players.get(id); if (!p) return;
  const st = p.state; if (st.dead) return;
  st.hp = Math.max(0, st.hp - amount);
  broadcast({ t: "hp", id, hp: st.hp });
  if (st.hp <= 0) {
    st.dead = true; st.deadUntil = Date.now() + 5000;
    broadcast({ t: "died", id, x: +st.x.toFixed(2), z: +st.z.toFixed(2), cause: cause || "" });
  }
}
function respawnDue() {
  const now = Date.now();
  for (const [id, p] of players) {
    const st = p.state;
    if (st.dead && now >= st.deadUntil) {
      st.dead = false; st.hp = 100; st.x = SPAWN.x; st.z = SPAWN.z;
      broadcast({ t: "respawn", id, x: SPAWN.x, z: SPAWN.z, hp: 100 });
    }
  }
}

// ---- synced building pieces ----
const builds = [];               // { id, piece, x, y, z, ry, by }
let nextBid = 1;
const PIECES = new Set(["foundation", "wall", "doorway", "floor", "campfire", "block", "pillar", "roof", "window", "halfwall", "ramp"]);
// solid cylinders the ANIMALS collide with too (so nothing walks through your walls)
const buildColliders = [];       // { x, z, r, bid }
function addBuildColliders(b) {
  const dx = Math.cos(b.ry || 0), dz = -Math.sin(b.ry || 0);
  if (b.piece === "wall" || b.piece === "window" || b.piece === "halfwall") for (const o of [-1.3, 0, 1.3]) buildColliders.push({ x: b.x + dx * o, z: b.z + dz * o, r: 0.55, bid: b.id });
  else if (b.piece === "doorway") for (const o of [-1.5, 1.5]) buildColliders.push({ x: b.x + dx * o, z: b.z + dz * o, r: 0.5, bid: b.id });
  else if (b.piece === "campfire") buildColliders.push({ x: b.x, z: b.z, r: 0.6, bid: b.id });
  else if (b.piece === "block") buildColliders.push({ x: b.x, z: b.z, r: 0.75, bid: b.id });
  else if (b.piece === "pillar") buildColliders.push({ x: b.x, z: b.z, r: 0.4, bid: b.id });
  // foundation / floor / roof / ramp are walkable — no collider
}
function removeBuildColliders(id) { for (let i = buildColliders.length - 1; i >= 0; i--) if (buildColliders[i].bid === id) buildColliders.splice(i, 1); }

// ---- persistence: builds + per-player data saved to disk, loaded on boot ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const WORLD_FILE = path.join(DATA_DIR, "world.json");
const playerData = new Map();    // pid -> { inv, hunger, hp, x, z, ry }
function loadWorld() {
  try {
    const j = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
    if (Array.isArray(j.builds)) for (const b of j.builds) { builds.push(b); addBuildColliders(b); if (b.id >= nextBid) nextBid = b.id + 1; }
    if (j.players) for (const [pid, d] of Object.entries(j.players)) playerData.set(pid, d);
    console.log(`[dread] loaded ${builds.length} builds, ${playerData.size} player records from ${WORLD_FILE}`);
  } catch { /* first run: no save yet */ }
}
let saveTimer = null;
function saveWorld() {
  saveTimer = null;
  for (const [, p] of players) if (p.pid) {                 // fold live state into the record before writing
    const d = playerData.get(p.pid) || {};
    d.hp = p.state.hp; d.x = p.state.x; d.z = p.state.z; d.ry = p.state.ry; playerData.set(p.pid, d);
  }
  try { fs.writeFileSync(WORLD_FILE, JSON.stringify({ builds, players: Object.fromEntries(playerData) })); }
  catch (e) { console.warn("[dread] save failed:", e.message); }
}
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(saveWorld, 2000); }
loadWorld();
setInterval(saveWorld, 15000);                               // periodic snapshot (also captures positions)

// ---- server-authoritative animals (so everyone sees the SAME creatures in the same spots) ----
const A_SNOW = 150;
const animals = []; let nextAid = 1;
// wendigo variants — each hunts differently
const WVARIANTS = {
  stalker:  { hp: 120, huntSpeed: 4.7, dmg: 13, aggro: 220, bite: 700 },   // fast, fragile, relentless
  brute:    { hp: 340, huntSpeed: 2.6, dmg: 42, aggro: 150, bite: 1200 },  // slow tank, huge hits
  screamer: { hp: 150, huntSpeed: 3.4, dmg: 12, aggro: 240, bite: 900 },   // calls other wendigos to you
};
for (let i = 0; i < 20; i++) { const a = arand()*6.283, r = 22 + arand()*120; animals.push({ id: nextAid++, kind: "deer", x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false }); }
const wkinds = ["stalker", "brute", "screamer", "stalker", "brute", "screamer"];
for (let i = 0; i < wkinds.length; i++) {
  const a = arand()*6.283, r = A_SNOW+20 + arand()*90, v = wkinds[i], W = WVARIANTS[v];
  animals.push({ id: nextAid++, kind: "wendigo", v, x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false, hp: W.hp, maxhp: W.hp });
}
function wrapA(a){ while(a>Math.PI)a-=6.28318; while(a<-Math.PI)a+=6.28318; return a; }
const WENDIGO_AGGRO = 170;              // wendigos lock onto any living player within this range
function nearestLivingPlayer(a) {
  let best = null, bd = Infinity, bid = null;
  for (const [pid, p] of players) {
    const st = p.state; if (st.dead) continue;
    const d = Math.hypot(st.x - a.x, st.z - a.z);
    if (d < bd) { bd = d; best = st; bid = pid; }
  }
  return { st: best, d: bd, id: bid };
}
function animalTick(dt) {
  const now = Date.now();
  for (const a of animals) {
    if (a.dead) continue;
    a.timer -= dt;
    if (a.kind === "wendigo") {
      const W = WVARIANTS[a.v] || WVARIANTS.stalker;
      // ALWAYS re-route to whoever is closest — reacquire the nearest player every tick
      const np = nearestLivingPlayer(a);
      const alerted = a.alertUntil && a.alertUntil > now;   // a screamer called this one in
      if (np.st && (np.d < W.aggro || alerted)) {
        a.state = "hunt";
        a.heading = Math.atan2(np.st.z - a.z, np.st.x - a.x);
        a.speed = W.huntSpeed * (alerted ? 1.25 : 1);
        // screamer: on sighting a player, call every wendigo in earshot to the same hunt
        if (a.v === "screamer" && now - (a.lastScream || 0) > 4000) {
          a.lastScream = now;
          for (const o of animals) if (o.kind === "wendigo" && o !== a && !o.dead && Math.hypot(o.x - a.x, o.z - a.z) < 130) o.alertUntil = now + 5000;
        }
        if (np.d < 2.6 && now - (a.lastBite || 0) > W.bite) { a.lastBite = now; applyDamage(np.id, W.dmg, "wendigo"); }
      } else {                                    // nobody near: prowl
        a.state = "wander"; a.speed = 1.3;
        if (a.timer <= 0) { a.heading += (Math.random() - 0.5) * 1.2; a.timer = 1.5 + Math.random() * 3; if (Math.random() < 0.25) a.speed = 0; }
      }
    } else {                                      // deer: skittish, flee when they see you
      let seen = null;
      for (const [, p] of players) {
        const st = p.state; if (st.dead) continue;
        const dx = st.x - a.x, dz = st.z - a.z, d = Math.hypot(dx, dz);
        let vd = 34; if (st.cr) vd *= 0.45;
        if (d < vd && Math.abs(wrapA(Math.atan2(dz, dx) - a.heading)) < 1.1) { seen = st; break; }
      }
      if (seen) { a.state = "flee"; a.timer = 3 + arand() * 2; a.heading = Math.atan2(a.z - seen.z, a.x - seen.x); }
      if (a.state === "flee") { a.speed = 9; if (a.timer <= 0) a.state = "wander"; }
      else { a.speed = 1.6; if (a.timer <= 0) { a.heading += (Math.random() - 0.5) * 1.5; a.timer = 1.5 + Math.random() * 3; if (Math.random() < 0.3) a.speed = 0; } }
    }
    a.x += Math.cos(a.heading) * a.speed * dt; a.z += Math.sin(a.heading) * a.speed * dt;
    // push out of solid builds so nothing walks through walls
    const ar = a.kind === "wendigo" ? 0.6 : 0.5;
    for (let it = 0; it < 2; it++) for (const c of buildColliders) {
      const ex = a.x - c.x, ez = a.z - c.z, d = Math.hypot(ex, ez), min = c.r + ar;
      if (d < min && d > 1e-4) { a.x = c.x + (ex / d) * min; a.z = c.z + (ez / d) * min; }
    }
    if (Math.hypot(a.x, a.z) > 340) a.heading += Math.PI;
    a.ry = Math.atan2(-Math.cos(a.heading), -Math.sin(a.heading));
  }
}
function animalsSnapshot(){ return animals.filter(a => !a.dead).map(a => ({ id: a.id, k: a.kind, v: a.v, x: +a.x.toFixed(2), z: +a.z.toFixed(2), ry: +a.ry.toFixed(2), s: a.state })); }
setInterval(() => { animalTick(0.1); respawnDue(); broadcast({ t: "animals", a: animalsSnapshot() }); }, 100);

wss.on("connection", (ws) => {
  const id = nextId++;
  const state = { x: 0, y: 0, z: 0, ry: 0, hy: 0, ph: 0, cr: 0, fy: 0, am: 0, eq: 1, hp: 100, dead: false, deadUntil: 0, name: "wanderer" };
  players.set(id, { ws, state });

  const others = [];
  for (const [oid, p] of players) if (oid !== id) others.push({ id: oid, ...p.state });
  ws.send(JSON.stringify({ t: "welcome", id, others, dayT, weather, animals: animalsSnapshot(), builds, spawn: SPAWN }));
  broadcast({ t: "join", id, ...state }, id);

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    const p = players.get(id); if (!p) return;
    if (m.t === "move") {
      Object.assign(p.state, { x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy, am: m.am, eq: m.eq });
      broadcast({ t: "move", id, x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy, am: m.am, eq: m.eq }, id);
    } else if (m.t === "shot") {
      broadcast({ t: "shot", id }, id);
      const st = p.state;                     // scare nearby deer
      for (const a of animals) if (a.kind === "deer" && !a.dead) { const d = Math.hypot(a.x - st.x, a.z - st.z); if (d < 90) { a.state = "flee"; a.timer = 4 + Math.random()*2; a.heading = Math.atan2(a.z - st.z, a.x - st.x); } }
    } else if (m.t === "swing") {
      broadcast({ t: "swing", id }, id);      // relay axe swing so others see the arm arc
    } else if (m.t === "hit") {
      const a = animals.find(x => x.id === m.id && !x.dead);
      if (a) {
        if (a.kind === "wendigo") {
          a.hp -= 60;                                                    // wendigos take ~3 rifle rounds
          if (a.hp <= 0) { a.dead = true; broadcast({ t: "akill", id: a.id, x: +a.x.toFixed(2), z: +a.z.toFixed(2) }); }
        } else { a.dead = true; broadcast({ t: "akill", id: a.id, x: +a.x.toFixed(2), z: +a.z.toFixed(2) }); }
      }
    } else if (m.t === "phit") {              // shooter claims a hit on another player
      const tgt = players.get(m.id); if (!tgt || tgt.state.dead) return;
      const s = p.state, ts = tgt.state, d = Math.hypot(ts.x - s.x, ts.z - s.z);
      if (d < 140) applyDamage(m.id, 60, "shot");   // ~2 rifle hits to down a player
    } else if (m.t === "starve") {            // client-tracked hunger drains its OWN hp (self only)
      applyDamage(id, 4, "starve");
    } else if (m.t === "hello") {             // client identifies with a persistent id -> restore saved data
      if (typeof m.pid === "string" && m.pid.length <= 64) {
        p.pid = m.pid;
        const d = playerData.get(m.pid);
        if (d) {
          if (typeof d.hp === "number" && d.hp > 0) p.state.hp = d.hp;
          if (typeof d.x === "number") { p.state.x = d.x; p.state.z = d.z; p.state.ry = d.ry || 0; }
          ws.send(JSON.stringify({ t: "restore", inv: d.inv || null, hunger: d.hunger, hp: p.state.hp, x: p.state.x, z: p.state.z }));
        }
      }
    } else if (m.t === "save") {              // client pushes its inventory + hunger to be persisted
      if (p.pid) { const d = playerData.get(p.pid) || {}; if (m.inv) d.inv = m.inv; if (typeof m.hunger === "number") d.hunger = m.hunger; playerData.set(p.pid, d); scheduleSave(); }
    } else if (m.t === "build") {
      if (!PIECES.has(m.piece)) return;
      const b = { id: nextBid++, piece: m.piece, x: +(+m.x).toFixed(2), y: +(+m.y).toFixed(2), z: +(+m.z).toFixed(2), ry: +(+m.ry || 0).toFixed(3), by: id };
      builds.push(b); addBuildColliders(b); if (builds.length > 8000) { const old = builds.shift(); removeBuildColliders(old.id); }
      broadcast({ t: "build", b }); scheduleSave();
    } else if (m.t === "unbuild") {           // anyone can break a build
      const i = builds.findIndex(b => b.id === m.id);
      if (i >= 0) { const rid = builds[i].id; builds.splice(i, 1); removeBuildColliders(rid); broadcast({ t: "unbuild", id: rid }); scheduleSave(); }
    }
  });

  ws.on("close", () => { saveWorld(); players.delete(id); broadcast({ t: "leave", id }, id); });
});

server.listen(PORT, () => {
  console.log(`[dread] http://localhost:${PORT}  |  content: assets/ + maps/  |  ${players.size} online`);
});
