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

// ---- shared world: time of day + weather (server owns these so everyone matches) ----
const DAY_LEN = 300;                       // seconds per full day
let dayT = 0.30;
let weather = { kind: "fog", fog: 0.7 };   // kind: clear|fog|rain ; fog: 0..1 density
let weatherTimer = 30;
setInterval(() => {
  dayT = (dayT + 1 / DAY_LEN) % 1;
  weatherTimer -= 1;
  if (weatherTimer <= 0) {
    const r = Math.random();
    if (r < 0.45) weather = { kind: "fog",   fog: 0.55 + Math.random() * 0.4 };
    else if (r < 0.75) weather = { kind: "clear", fog: 0.15 + Math.random() * 0.2 };
    else weather = { kind: "rain", fog: 0.5 + Math.random() * 0.35 };
    weatherTimer = 45 + Math.random() * 75;
  }
  broadcast({ t: "world", dayT, weather });
}, 1000);

// ---- server-authoritative animals (so everyone sees the SAME creatures in the same spots) ----
function terrainHeight(x, z) {   // must match the client's terrain
  return Math.sin(x*0.018)*3.2 + Math.cos(z*0.021)*3.0 + Math.sin(x*0.05)*0.8 + Math.cos(z*0.06)*0.7 + Math.sin((x+z)*0.11)*0.4;
}
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const arand = mulberry32(20080102);
const A_SNOW = 150;
const animals = []; let nextAid = 1;
for (let i = 0; i < 20; i++) { const a = arand()*6.283, r = 22 + arand()*120; animals.push({ id: nextAid++, kind: "deer", x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false }); }
for (let i = 0; i < 4;  i++) { const a = arand()*6.283, r = A_SNOW+20 + arand()*90; animals.push({ id: nextAid++, kind: "wendigo", x: Math.cos(a)*r, z: Math.sin(a)*r, ry: 0, heading: arand()*6.283, state: "wander", timer: arand()*3, speed: 0, dead: false }); }
function wrapA(a){ while(a>Math.PI)a-=6.28318; while(a<-Math.PI)a+=6.28318; return a; }
function animalTick(dt) {
  for (const a of animals) {
    if (a.dead) continue;
    a.timer -= dt;
    let seen = null;
    for (const [, p] of players) {
      const st = p.state, dx = st.x - a.x, dz = st.z - a.z, d = Math.hypot(dx, dz);
      let vd = a.kind === "wendigo" ? 60 : 34; if (st.cr) vd *= 0.45;
      if (d < vd && Math.abs(wrapA(Math.atan2(dz, dx) - a.heading)) < 1.1) { seen = st; break; }
    }
    if (seen) { if (a.kind === "deer") { a.state = "flee"; a.timer = 3 + arand()*2; a.heading = Math.atan2(a.z - seen.z, a.x - seen.x); } else a.state = "hunt"; }
    if (a.state === "flee") { a.speed = 9; if (a.timer <= 0) a.state = "wander"; }
    else if (a.state === "hunt") { if (seen) { a.heading = Math.atan2(seen.z - a.z, seen.x - a.x); a.speed = 3.2; } else if (a.timer <= 0) { a.state = "wander"; a.timer = 2; } }
    else { a.speed = a.kind === "wendigo" ? 1.2 : 1.6; if (a.timer <= 0) { a.heading += (Math.random()-0.5)*1.5; a.timer = 1.5 + Math.random()*3; if (Math.random() < 0.3) a.speed = 0; } }
    a.x += Math.cos(a.heading) * a.speed * dt; a.z += Math.sin(a.heading) * a.speed * dt;
    if (Math.hypot(a.x, a.z) > 340) a.heading += Math.PI;
    a.ry = Math.atan2(-Math.cos(a.heading), -Math.sin(a.heading));
  }
}
function animalsSnapshot(){ return animals.filter(a => !a.dead).map(a => ({ id: a.id, k: a.kind, x: +a.x.toFixed(2), z: +a.z.toFixed(2), ry: +a.ry.toFixed(2), s: a.state })); }
setInterval(() => { animalTick(0.1); broadcast({ t: "animals", a: animalsSnapshot() }); }, 100);

wss.on("connection", (ws) => {
  const id = nextId++;
  const state = { x: 0, y: 0, z: 0, ry: 0, hy: 0, ph: 0, cr: 0, fy: 0, name: "wanderer" };
  players.set(id, { ws, state });

  const others = [];
  for (const [oid, p] of players) if (oid !== id) others.push({ id: oid, ...p.state });
  ws.send(JSON.stringify({ t: "welcome", id, others, dayT, weather, animals: animalsSnapshot() }));
  broadcast({ t: "join", id, ...state }, id);

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "move") {
      const p = players.get(id); if (!p) return;
      Object.assign(p.state, { x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy });
      broadcast({ t: "move", id, x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy }, id);
    } else if (m.t === "shot") {
      broadcast({ t: "shot", id }, id);
      const p = players.get(id);              // scare nearby deer
      if (p) { const st = p.state; for (const a of animals) if (a.kind === "deer" && !a.dead) { const d = Math.hypot(a.x - st.x, a.z - st.z); if (d < 90) { a.state = "flee"; a.timer = 4 + Math.random()*2; a.heading = Math.atan2(a.z - st.z, a.x - st.x); } } }
    } else if (m.t === "hit") {
      const a = animals.find(x => x.id === m.id && !x.dead);
      if (a) {
        if (a.kind === "wendigo") { a.state = "flee"; a.timer = 3; }   // wendigos don't drop
        else { a.dead = true; broadcast({ t: "akill", id: a.id, x: +a.x.toFixed(2), z: +a.z.toFixed(2) }); }
      }
    }
  });

  ws.on("close", () => { players.delete(id); broadcast({ t: "leave", id }, id); });
});

server.listen(PORT, () => {
  console.log(`[dread] http://localhost:${PORT}  |  content: assets/ + maps/  |  ${players.size} online`);
});
