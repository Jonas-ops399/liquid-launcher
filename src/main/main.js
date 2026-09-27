// src/main/main.js
// Electron main process — app lifecycle + window creation.
//
// SECURITY (siehe Sicherheits-Checkliste im Projekt-Briefing):
// - contextIsolation: true  -> Renderer kann NICHT direkt auf Node/Electron-APIs zugreifen
// - nodeIntegration: false  -> kein `require()` im UI-Code möglich
// - sandbox: true           -> zusätzliche OS-Level-Sandbox für den Renderer-Prozess
// Das UI kommuniziert ausschließlich über das window.launcher-Objekt, das preload.js
// kontrolliert über contextBridge exponiert (siehe preload.js).

const { app, BrowserWindow, shell, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerIpcHandlers } = require('./ipc-handlers');
const { stopAllProcesses } = require('./process');

let mainWindow = null;

const DEFAULT_BOUNDS = { width: 1360, height: 860 };
const MIN_BOUNDS = { width: 1040, height: 680 };

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf-8');
    const state = JSON.parse(raw);
    // Nur sinnvolle, aktuell erreichbare Werte übernehmen (falls z.B. ein
    // zweiter Monitor entfernt wurde, seitdem die App zuletzt lief).
    const displays = screen.getAllDisplays();
    const fitsOnScreen = typeof state.x === 'number' && typeof state.y === 'number'
      ? displays.some(d => state.x >= d.bounds.x - 50 && state.x < d.bounds.x + d.bounds.width
                        && state.y >= d.bounds.y - 50 && state.y < d.bounds.y + d.bounds.height)
      : false;
    return {
      width: Math.max(state.width || DEFAULT_BOUNDS.width, MIN_BOUNDS.width),
      height: Math.max(state.height || DEFAULT_BOUNDS.height, MIN_BOUNDS.height),
      ...(fitsOnScreen ? { x: state.x, y: state.y } : {})
    };
  } catch {
    return DEFAULT_BOUNDS;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch {
    // Nicht kritisch — beim nächsten Start wird einfach die Standardgröße genutzt.
  }
}

function createWindow() {
  const bounds = loadWindowState();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    backgroundColor: '#0f1230',
    autoHideMenuBar: true, // kein klassisches File/Edit/View-Menü, passt zum UI-Stil
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Verhindert, dass das UI beliebige lokale Dateien via file:// nachladen kann
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Größe/Position bei jeder Änderung merken (leicht entprellt), plus sicher
  // beim Schließen — damit "verschieben/Größe ändern" auch über Neustarts
  // hinweg erhalten bleibt.
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', saveWindowState);

  // Externe Links (z.B. spätere "Mehr erfahren"-Links im UI) im System-Browser öffnen,
  // nicht in einem neuen Electron-Fenster mit vollen Rechten.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Navigation innerhalb des Fensters auf die eigene App-Datei beschränken.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol !== 'file:') {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

// ---------- Fenstersteuerung fürs Einstellungen-Panel im UI ----------
function registerWindowHandlers() {
  ipcMain.handle('window:getBounds', () => {
    return mainWindow ? mainWindow.getBounds() : null;
  });

  ipcMain.handle('window:setSize', (event, width, height) => {
    if (!mainWindow) return;
    const w = Math.max(Math.round(width) || MIN_BOUNDS.width, MIN_BOUNDS.width);
    const h = Math.max(Math.round(height) || MIN_BOUNDS.height, MIN_BOUNDS.height);
    mainWindow.setSize(w, h);
    return mainWindow.getBounds();
  });

  ipcMain.handle('window:setPosition', (event, x, y) => {
    if (!mainWindow) return;
    mainWindow.setPosition(Math.round(x), Math.round(y));
    return mainWindow.getBounds();
  });

  ipcMain.handle('window:center', () => {
    if (!mainWindow) return;
    mainWindow.center();
    return mainWindow.getBounds();
  });

  ipcMain.handle('window:resetSize', () => {
    if (!mainWindow) return;
    mainWindow.setSize(DEFAULT_BOUNDS.width, DEFAULT_BOUNDS.height);
    mainWindow.center();
    return mainWindow.getBounds();
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  registerWindowHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Läuft gerade eine Instanz, wird der JVM mit beendet. Ohne das bleibt nach
// dem Schließen des Launchers ein Java-Prozess ohne Fenster zurück, der
// Speicher und Rechenzeit belegt.
let cleanedUp = false;
app.on('before-quit', (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  stopAllProcesses().finally(() => app.quit());
});

// IPC-Handler für auth / instances / mods / servers / skins / settings
// werden in ipc-handlers.js registriert (siehe registerIpcHandlers() oben).
// instances:* ist dort bereits ein lauffähiger Demo-Stub, der Rest wartet auf
// die Backend-Implementierung (Team 2) bzw. Prozess-Implementierung (Team 3).
// window:* (Größe/Position) ist hier direkt implementiert und voll funktionsfähig.
