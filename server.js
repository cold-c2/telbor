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

wss.on("connection", (ws) => {
  const id = nextId++;
  const state = { x: 0, y: 0, z: 0, ry: 0, hy: 0, ph: 0, cr: 0, fy: 0, name: "wanderer" };
  players.set(id, { ws, state });

  const others = [];
  for (const [oid, p] of players) if (oid !== id) others.push({ id: oid, ...p.state });
  ws.send(JSON.stringify({ t: "welcome", id, others }));
  broadcast({ t: "join", id, ...state }, id);

  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "move") {
      const p = players.get(id); if (!p) return;
      Object.assign(p.state, { x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy });
      broadcast({ t: "move", id, x: m.x, y: m.y, z: m.z, ry: m.ry, hy: m.hy, ph: m.ph, cr: m.cr, fy: m.fy }, id);
    } else if (m.t === "shot") {
      broadcast({ t: "shot", id }, id);
    }
  });

  ws.on("close", () => { players.delete(id); broadcast({ t: "leave", id }, id); });
});

server.listen(PORT, () => {
  console.log(`[dread] http://localhost:${PORT}  |  content: assets/ + maps/  |  ${players.size} online`);
});
