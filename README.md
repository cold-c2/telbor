# PALE FIELD — build guide

A low-res analog-horror multiplayer walking sim. Three.js + Node + Electron.

## Run it
```
npm run app
```
That launches the desktop window (boots the server + game together).

## Controls
- **WASD** move · **mouse** look · **Shift** run
- **Tab** — toggle the built-in **map editor**
- **F11** fullscreen · **F5** reload · **F12** devtools

---

## Making your own maps & content

There is **no build step**. You drop files in folders, and they show up in the game — just refresh (F5). The server scans the folders and hands the game a list of everything available.

### Folders
```
lowpoly-dread/
  assets/
    models/     <- 3D models: .glb or .gltf   (make these in Blockbench)
    audio/      <- sounds:    .mp3 .ogg .wav
    textures/   <- images:    .png .jpg
  maps/         <- your maps: .json  (the editor saves here)
```

### The workflow
1. **Make a model** in **Blockbench** (free: https://www.blockbench.net) — it's built for exactly this chunky low-poly look. Export as **glTF (.glb)** into `assets/models/`.
2. **Drop sounds** into `assets/audio/` and **textures** into `assets/textures/`.
3. **Open the game**, press **Tab** for the editor, and **place** your models / sounds / props into the world.
4. Press **P** to **save the map**. It writes to `maps/<name>.json`.
5. Ship it — everything in these folders travels with the game when it's packaged.

### The editor (press Tab)
- **Look at the ground** — a marker shows where things will drop
- **[ ] or mouse wheel** — cycle the palette (your models + built-in props + sound emitters)
- **Left click** — place the selected item
- **R** — rotate the next placement · **+ / -** — scale it
- **Space / C** — fly up / down (for an overview)
- **Backspace** — delete the nearest placed thing
- **P** — save the map to `maps/`

### Map file format (you can also hand-edit these)
```json
{
  "name": "main",
  "spawn": { "x": 0, "y": 0, "z": 0 },
  "ambient": "wind.ogg",
  "entities": [
    { "type": "model", "asset": "cabin.glb", "pos": {"x":10,"y":0,"z":4}, "rot": 0, "scale": 1, "collide": true, "radius": 3 },
    { "type": "sound", "asset": "whispers.ogg", "pos": {"x":0,"y":1,"z":-18}, "radius": 12, "volume": 1 },
    { "type": "prop",  "shape": "pine", "pos": {"x":-6,"y":0,"z":8}, "rot": 0.5, "scale": 1.4 }
  ]
}
```
- **model** — a .glb/.gltf from `assets/models/`
- **sound** — a positional 3D sound from `assets/audio/` (gets louder as you approach; `radius` = how far it carries)
- **prop** — a built-in low-poly shape (`pine`, `rock`, `boulder`, `pillar`, `box`) — no asset file needed
- **ambient** (top level) — a sound file that plays everywhere as the background bed
