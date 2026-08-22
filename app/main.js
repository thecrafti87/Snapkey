'use strict';

/* =================================================================
   Der Hauptprozess der Oberflaeche.

   Haelt genau einen SNAPKEY-Knoten offen und reicht seine Ereignisse
   ans Fenster weiter. Aendert sich etwas an den Einstellungen, das den
   Knoten betrifft, wird er sauber geschlossen und neu geoeffnet - das
   ist ehrlicher, als seinen laufenden Zustand nachtraeglich zu
   verbiegen (siehe restartNode).

   Der Kern selbst weiss nichts von Electron: hier wird nur verdrahtet,
   was in src/node/node.js schon fertig ist.
   ================================================================= */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');

const settings = require('./settings');
const nodeMod = require('../src/node/node');
const identity = require('../src/core/identity');
const meetServerMod = require('../src/meet/server');
const storeMod = require('../src/node/store');

let win = null;
let node = null;
let nodeError = null;
let quitting = false;

/* ------------------------------- Fenster ------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 760,
    minWidth: 880,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0d0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 21 },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Externe Verweise gehoeren in den Systembrowser, nicht ins Fenster.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

/* -------------------------------- Knoten -------------------------------- */

function defaultOutDir() {
  const configured = settings.load().outDir;
  if (configured && fs.existsSync(configured)) return configured;
  try {
    return app.getPath('downloads');
  } catch {
    return os.homedir();
  }
}

/** Aus den gespeicherten Einstellungen die Optionen fuer node.open() bauen. */
function buildNodeOptions(values) {
  const opts = {
    outDir: defaultOutDir(),
    port: Number(values.port) || 0,
    trustNew: Boolean(values.trustNew),
    dedup: values.dedup !== false,
    announce: true,
    portmap: Boolean(values.portmap),
    onEvent: (e) => { if (win) win.webContents.send('node:event', e); }
  };
  // Leere Zeichenketten NICHT weiterreichen - sonst wird der eigene
  // Vorgabewert des Kerns (os.hostname()) uebersteuert durch nichts.
  if (values.name) opts.name = values.name;
  if (values.meetHost) {
    opts.meet = {
      host: values.meetHost,
      port: Number(values.meetPort) || meetServerMod.DEFAULT_PORT,
      pass: values.meetPass || ''
    };
  }
  return opts;
}

async function openNode() {
  const opts = buildNodeOptions(settings.load());
  try {
    node = await nodeMod.open(opts);
    nodeError = null;
  } catch (err) {
    node = null;
    nodeError = err.message;
  }
}

async function closeNode() {
  if (!node) return;
  const laufend = node;
  node = null;
  try {
    await laufend.close();
  } catch {
    // Wird sowieso gleich neu geoeffnet oder die App beendet - ein
    // Fehler beim Schliessen soll das nicht aufhalten.
  }
}

async function restartNode() {
  await closeNode();
  await openNode();
}

/** Gefundene und schon gekoppelte Gegenstellen zusammengefuehrt. */
function buildPeerList() {
  if (!node) return [];
  const liste = new Map();

  for (const p of node.store.peers.list()) {
    liste.set(p.address, { address: p.address, name: p.name || null, host: null, port: null, gekoppelt: true });
  }
  for (const p of node.peers) {
    const vorhanden = liste.get(p.address);
    liste.set(p.address, {
      address: p.address,
      name: (vorhanden && vorhanden.name) || p.name || null,
      host: p.host,
      port: p.port,
      gekoppelt: Boolean(vorhanden)
    });
  }
  return [...liste.values()];
}

/**
 * Findet, wohin gesendet werden soll.
 *
 * `ziel` ist entweder schon eine vollstaendige Zielangabe (aus der
 * Geraeteliste ausgewaehlt, mit host/port) oder eine von Hand
 * eingegebene Anschrift/Name als Zeichenkette. Dieselbe Wegewahl wie
 * in bin/snapkey.js: erst das eigene Netz (die Geraetesuche laeuft
 * ohnehin staendig mit), sonst der Treffpunkt, wenn einer eingerichtet
 * ist.
 */
function findZiel(ziel) {
  if (ziel && typeof ziel === 'object' && (ziel.host || ziel.meet)) return ziel;

  const text = (ziel && typeof ziel === 'object' ? ziel.address : ziel) || '';
  const alsAnschrift = identity.parseAddress(text);

  const gefunden = node.find(alsAnschrift || text);
  if (gefunden) return gefunden;

  const values = settings.load();
  if (values.meetHost && alsAnschrift) {
    return {
      address: alsAnschrift,
      meet: { host: values.meetHost, port: Number(values.meetPort) || meetServerMod.DEFAULT_PORT, pass: values.meetPass || '' }
    };
  }

  throw new Error(alsAnschrift
    ? `"${text}" wurde im eigenen Netz nicht gefunden - kein Treffpunkt eingerichtet.`
    : `"${text}" wurde im eigenen Netz nicht gefunden.`);
}

/* ---------------------------------- IPC ---------------------------------- */

ipcMain.handle('node:state', () => ({
  me: node ? { address: node.me.address, uri: node.me.uri, fingerprint: node.me.fingerprint } : null,
  port: node ? node.port : null,
  external: node ? node.external : null,
  running: Boolean(node),
  outDir: node ? node.outDir : null,
  error: nodeError
}));

ipcMain.handle('node:peers', () => buildPeerList());

ipcMain.handle('node:settings', () => ({
  values: settings.load(),
  defaults: settings.DEFAULTS,
  userData: app.getPath('userData'),
  // Zusaetzlich zum vorgeschriebenen Vertrag, fuer die Fassung und den
  // Hinweis am Ende der Einstellungen ("wo die Schluessel liegen").
  version: app.getVersion(),
  keysDir: storeMod.homeDir()
}));

ipcMain.handle('node:setSetting', async (_e, patch) => {
  const { values, betrifftKnoten } = settings.save(patch || {});
  if (betrifftKnoten) await restartNode();
  return values;
});

ipcMain.handle('node:send', async (_e, { ziel, paths }) => {
  if (!node) return { ok: false, message: 'Der Knoten ist nicht bereit.' };
  try {
    const zielAngabe = findZiel(ziel);
    const res = await node.sendTo(zielAngabe, paths, {
      onProgress: (e) => { if (win) win.webContents.send('send:progress', e); }
    });
    return res;
  } catch (err) {
    return { ok: false, message: err.message, code: err.code };
  }
});

ipcMain.handle('node:pair', (_e, address) => {
  if (node) {
    const gefunden = node.peers.find((p) => p.address === address);
    if (gefunden) node.store.peers.remember(gefunden.address, gefunden.pub, gefunden.name);
  }
  return buildPeerList();
});

ipcMain.handle('node:forget', (_e, address) => {
  if (node) node.store.peers.forget(address);
  return buildPeerList();
});

ipcMain.handle('dialog:pickFiles', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Dateien oder Ordner zum Senden auswaehlen',
    buttonLabel: 'Auswaehlen',
    properties: ['openFile', 'openDirectory', 'multiSelections']
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:pickFolder', async (_e, current) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Zielordner auswaehlen',
    buttonLabel: 'Auswaehlen',
    defaultPath: current || defaultOutDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('fs:stat', (_e, paths) => (paths || []).map((p) => {
  try {
    const st = fs.statSync(p);
    return { path: p, name: path.basename(p), size: st.size, dir: st.isDirectory() };
  } catch {
    return { path: p, name: path.basename(p), size: 0, dir: false, missing: true };
  }
}));

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

ipcMain.handle('shell:reveal', (_e, target) => {
  if (!target) return false;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) shell.openPath(target);
    else shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
});

/* -------------------------------- Start/Ende -------------------------------- */

app.whenReady().then(async () => {
  settings.init(app.getPath('userData'));

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png')); } catch { /* im Test ohne Dock */ }
  }

  // Erst der Knoten, dann das Fenster: openNode() wirft nie (Fehler
  // landen in nodeError), und so sieht die Seite beim ersten Abfragen
  // von node:state schon den echten Stand - kein Wettlauf mit einem
  // Rundruf, der vielleicht erst in Sekunden das naechste Mal meldet.
  await openNode();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Der Knoten haelt einen UDP-Socket und ggf. eine Treffpunkt-Verbindung
// offen - ohne dieses Abwarten wuerde ein hartes Beenden sie einfach
// abreissen statt sich abzumelden (siehe discovery.js: der Rundruf
// verschickt zum Abschied noch ein "bye").
app.on('before-quit', (e) => {
  if (quitting || !node) return;
  e.preventDefault();
  quitting = true;
  closeNode().finally(() => app.quit());
});
