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
  const big  = Math.sin(x * 0.018) * 4.2 + Math.cos(z * 0.021) * 4.0;              // big rolling hills
  const ridge = (1.0 - Math.abs(Math.sin(x * 0.032 + Math.cos(z * 0.028) * 1.3))) * 3.6; // ridged crests (hilly + shade)
  const med  = Math.sin(x * 0.05) * 0.9 + Math.cos(z * 0.06) * 0.8;               // medium bumps
  const fine = Math.sin((x + z) * 0.11) * 0.4;                                     // fine ripple
  return big + ridge + med + fine;
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

// ---- synced building pieces (in-memory; reset when the server restarts) ----
const builds = [];               // { id, piece, x, y, z, ry, by }
let nextBid = 1;
const PIECES = new Set(["foundation", "wall", "doorway", "floor", "campfire"]);
// solid cylinders the ANIMALS collide with too (so nothing walks through your walls)
const buildColliders = [];       // { x, z, r, bid }
function addBuildColliders(b) {
  const dx = Math.cos(b.ry || 0), dz = -Math.sin(b.ry || 0);
  if (b.piece === "wall")        for (const o of [-1.3, 0, 1.3]) buildColliders.push({ x: b.x + dx * o, z: b.z + dz * o, r: 0.55, bid: b.id });
  else if (b.piece === "doorway") for (const o of [-1.5, 1.5])   buildColliders.push({ x: b.x + dx * o, z: b.z + dz * o, r: 0.5, bid: b.id });
  else if (b.piece === "campfire") buildColliders.push({ x: b.x, z: b.z, r: 0.6, bid: b.id });
}
function removeBuildColliders(id) { for (let i = buildColliders.length - 1; i >= 0; i--) if (buildColliders[i].bid === id) buildColliders.splice(i, 1); }

// ---- server-authoritative animals (so everyone sees the SAME creatures in the same spots) ----
const A_SNOW = 150;
const animals = []; let nextAid = 1;
for (let i = 0; i < 20; i++) { const a = arand()*6.283, r = 22 + arand()*120; animals.push({ id: nextAid++, kind: "deer", x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false }); }
for (let i = 0; i < 4;  i++) { const a = arand()*6.283, r = A_SNOW+20 + arand()*90; animals.push({ id: nextAid++, kind: "wendigo", x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false, hp: 180 }); }
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
      // ALWAYS re-route to whoever is closest — reacquire the nearest player every tick
      const np = nearestLivingPlayer(a);
      if (np.st && np.d < WENDIGO_AGGRO) {
        a.state = "hunt";
        a.heading = Math.atan2(np.st.z - a.z, np.st.x - a.x);
        a.speed = 3.6;
        if (np.d < 2.6 && now - (a.lastBite || 0) > 900) { a.lastBite = now; applyDamage(np.id, 20, "wendigo"); }
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
function animalsSnapshot(){ return animals.filter(a => !a.dead).map(a => ({ id: a.id, k: a.kind, x: +a.x.toFixed(2), z: +a.z.toFixed(2), ry: +a.ry.toFixed(2), s: a.state })); }
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
    } else if (m.t === "build") {
      if (!PIECES.has(m.piece)) return;
      const b = { id: nextBid++, piece: m.piece, x: +(+m.x).toFixed(2), y: +(+m.y).toFixed(2), z: +(+m.z).toFixed(2), ry: +(+m.ry || 0).toFixed(3), by: id };
      builds.push(b); addBuildColliders(b); if (builds.length > 4000) { const old = builds.shift(); removeBuildColliders(old.id); }
      broadcast({ t: "build", b });
    } else if (m.t === "unbuild") {
      const i = builds.findIndex(b => b.id === m.id);
      if (i >= 0 && (builds[i].by === id)) { const rid = builds[i].id; builds.splice(i, 1); removeBuildColliders(rid); broadcast({ t: "unbuild", id: rid }); }
    }
  });

  ws.on("close", () => { players.delete(id); broadcast({ t: "leave", id }, id); });
});

server.listen(PORT, () => {
  console.log(`[dread] http://localhost:${PORT}  |  content: assets/ + maps/  |  ${players.size} online`);
});
