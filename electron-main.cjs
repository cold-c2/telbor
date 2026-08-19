// Desktop shell: boots the multiplayer server, then opens the game in a native window.
const { app, BrowserWindow } = require("electron");
const { fork } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 8770;
let serverProc = null;
let win = null;

function startServer() {
  serverProc = fork(path.join(__dirname, "server.js"), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
}

// wait until the server answers before loading, so we never flash a blank page
function waitForServer(cb, tries = 0) {
  const req = http.get(`http://localhost:${PORT}`, (res) => { res.resume(); cb(); });
  req.on("error", () => {
    if (tries > 60) return cb();
    setTimeout(() => waitForServer(cb, tries + 1), 100);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: "#060606",
    autoHideMenuBar: true,
    title: "PALE FIELD",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}`);

  // F11 toggles fullscreen, F12 opens devtools
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") win.setFullScreen(!win.isFullScreen());
    if (input.key === "F12") win.webContents.toggleDevTools();
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) win.webContents.reload();
  });
}

app.whenReady().then(() => {
  startServer();
  waitForServer(createWindow);
});

function shutdown() { if (serverProc) { serverProc.kill(); serverProc = null; } }
app.on("before-quit", shutdown);
app.on("window-all-closed", () => { shutdown(); if (process.platform !== "darwin") app.quit(); });
