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
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');

const settings = require('./settings');
const historyMod = require('./history');
const nodeMod = require('../src/node/node');
const identity = require('../src/core/identity');
const meetServerMod = require('../src/meet/server');
const storeMod = require('../src/node/store');
const { t } = require('./renderer/i18n');

let win = null;
let node = null;
let nodeError = null;
let quitting = false;
let history = null;
let tray = null;

// Ordnet ein hereinkommendes "from" (aus node:event) der beglaubigten
// Anschrift und den zwischendurch gesehenen Werten zu - erst bei
// 'accepted' bekannt, gebraucht spaeter bei 'received'/'refused', um
// den Verlaufseintrag bzw. die Mitteilung mit dem richtigen Namen zu
// fuellen. Wird dort auch wieder entfernt.
const anrufInfo = new Map();

function currentLang() {
  return settings.load().lang || 'en';
}

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

/** Holt das Fenster nach vorn - legt es notfalls erst an. Optional gleich mit einer bestimmten Ansicht. */
function showWindow(view) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) win.webContents.send('window:openView', view);
}

/* ------------------------------ Menueleiste ------------------------------ */

function trayIconPath() {
  return process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'crocTemplate.png')
    : path.join(__dirname, 'assets', 'icon.png');
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

/**
 * Baut das Menueleistensymbol auf (oder ab, je nach Einstellung) und
 * die Beschriftung neu - wird nach jeder Einstellungsaenderung erneut
 * gerufen, damit ein Sprachwechsel auch das Menue erreicht.
 */
function refreshTray() {
  if (!settings.load().tray) { destroyTray(); return; }

  const lang = currentLang();
  const menu = Menu.buildFromTemplate([
    { label: t(lang, 'tray.show'), click: () => showWindow() },
    { label: t(lang, 'tray.sendFiles'), click: () => showWindow('send') },
    { type: 'separator' },
    { label: t(lang, 'tray.quit'), click: () => { quitting = true; app.quit(); } }
  ]);

  try {
    if (!tray) {
      const img = nativeImage.createFromPath(trayIconPath());
      if (process.platform === 'darwin') img.setTemplateImage(true);
      tray = new Tray(img);
      tray.on('click', () => showWindow());
    }
    tray.setToolTip('SNAPKEY');
    tray.setContextMenu(menu);
  } catch (err) {
    // Nicht jede Umgebung hat eine Menueleiste (z.B. manche Linux-
    // Fenstermanager ohne Tray-Unterstuetzung) - dann bleibt die App
    // ohne Symbol nutzbar, statt gar nicht erst zu starten.
    console.error('Menueleistensymbol liess sich nicht anlegen:', err.message);
  }
}

/* ------------------------------ Mitteilungen ------------------------------ */

/** Wer gerade hinsieht, braucht keine Mitteilung - siehe Auftrag. */
function fensterImVordergrund() {
  return Boolean(win) && win.isFocused();
}

function benachrichtigen(title, body, onClick) {
  if (!settings.load().notify) return;
  if (fensterImVordergrund()) return;
  if (!Notification.isSupported()) return;

  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
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
    onEvent: handleNodeEvent
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

/* -------------------------------- Verlauf -------------------------------- */

/** Den zu einer Anschrift bekannten Namen holen - null, wenn es keinen gibt. */
function nameFuer(address) {
  if (!address || !node) return null;
  const bekannt = node.store.peers.get(address);
  return (bekannt && bekannt.name) || null;
}

function anrufEintrag(von) {
  let e = anrufInfo.get(von);
  if (!e) { e = {}; anrufInfo.set(von, e); }
  return e;
}

function recordSendHistory(zielAngabe, paths, res, err) {
  if (!history) return;
  const address = (zielAngabe && zielAngabe.address) || null;
  history.add({
    kind: 'send',
    peer: address,
    name: nameFuer(address) || (zielAngabe && zielAngabe.name) || null,
    paths: (paths || []).slice(),
    files: res ? res.files : undefined,
    bytes: res ? res.bytes : undefined,
    sent: res ? res.sent : undefined,
    route: res ? res.route : undefined,
    ok: res ? Boolean(res.ok) : false,
    error: err ? err.message : (res && !res.ok && res.missing && res.missing.length
      ? `Fehlt noch: ${res.missing.join(', ')}`
      : undefined)
  });
  if (win) win.webContents.send('history:changed');
}

function recordReceiveHistory(address, info, e) {
  if (!history) return;
  const res = e.result || {};
  history.add({
    kind: 'receive',
    peer: address,
    name: nameFuer(address),
    files: info.files,
    bytes: info.bytes,
    had: res.had,
    recovered: res.recovered,
    outDir: e.outDir,
    ok: Boolean(res.ok),
    error: !res.ok && res.missing && res.missing.length ? `Fehlt noch: ${res.missing.join(', ')}` : undefined
  });
  if (win) win.webContents.send('history:changed');
}

/* ------------------------------ Knotenereignisse ------------------------------ */

/**
 * Alles, was der Kern ueber eingehende Anrufe meldet, laeuft hier
 * durch, bevor es ans Fenster weitergeht: Verlauf mitschreiben,
 * Mitteilungen ausloesen - beides ganz ohne Zutun der Oberflaeche,
 * die kann ja gerade zu sein.
 */
function handleNodeEvent(e) {
  if (e.type === 'accepted') {
    anrufEintrag(e.from).address = e.address;
  }

  if (e.type === 'offered') {
    const info = anrufEintrag(e.from);
    info.files = e.files;
    info.bytes = e.bytes;
  }

  if (e.type === 'received') {
    const info = anrufInfo.get(e.from) || {};
    anrufInfo.delete(e.from);
    recordReceiveHistory(info.address || null, info, e);
    if (e.result && e.result.ok) {
      const lang = currentLang();
      benachrichtigen(
        t(lang, 'notify.receivedTitle'),
        t(lang, 'notify.receivedBody', nameFuer(info.address) || info.address || '?'),
        () => showWindow('receive')
      );
    }
  }

  if (e.type === 'refused') {
    anrufInfo.delete(e.from);
    const lang = currentLang();
    benachrichtigen(
      t(lang, 'notify.refusedTitle'),
      t(lang, 'notify.refusedBody', e.message || ''),
      () => showWindow('receive')
    );
  }

  if (e.type === 'message') {
    const lang = currentLang();
    const wer = nameFuer(e.address) || e.address;
    benachrichtigen(
      t(lang, 'notify.messageTitle', wer),
      t(lang, 'notify.messageBody', e.text),
      () => showWindow('messages')
    );
  }

  if (win) win.webContents.send('node:event', e);
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
  refreshTray();
  return values;
});

ipcMain.handle('node:send', async (_e, { ziel, paths }) => {
  if (!node) return { ok: false, message: 'Der Knoten ist nicht bereit.' };

  let zielAngabe;
  try {
    zielAngabe = findZiel(ziel);
  } catch (err) {
    return { ok: false, message: err.message, code: err.code };
  }

  try {
    const res = await node.sendTo(zielAngabe, paths, {
      onProgress: (e) => { if (win) win.webContents.send('send:progress', e); }
    });
    recordSendHistory(zielAngabe, paths, res, null);
    return res;
  } catch (err) {
    recordSendHistory(zielAngabe, paths, null, err);
    return { ok: false, message: err.message, code: err.code };
  }
});

ipcMain.handle('node:say', async (_e, { ziel, texte }) => {
  if (!node) return { ok: false, message: 'Der Knoten ist nicht bereit.' };
  try {
    const zielAngabe = findZiel(ziel);
    const res = await node.say(zielAngabe, texte);
    return res;
  } catch (err) {
    return { ok: false, message: err.message, code: err.code };
  }
});

/** Gespraechspartner: aus messages.peers() ergaenzt um gekoppelte Geraete ohne Verlauf. */
ipcMain.handle('node:chats', () => {
  if (!node) return [];
  const liste = new Map();

  for (const p of node.store.peers.list()) {
    liste.set(p.address, { address: p.address, name: p.name || null, anzahl: 0, letzte: null, gekoppelt: true });
  }
  for (const m of node.messages.peers()) {
    const vorhanden = liste.get(m.address);
    liste.set(m.address, {
      address: m.address,
      name: (vorhanden && vorhanden.name) || null,
      anzahl: m.anzahl,
      letzte: m.letzte,
      gekoppelt: Boolean(vorhanden)
    });
  }
  return [...liste.values()];
});

ipcMain.handle('node:messages', (_e, address) => (node ? node.messages.forPeer(address) : []));

ipcMain.handle('history:list', () => (history ? history.list() : []));
ipcMain.handle('history:clear', () => (history ? history.clear() : []));

ipcMain.handle('window:show', () => { showWindow(); return true; });

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
  history = historyMod.open(app.getPath('userData'));

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png')); } catch { /* im Test ohne Dock */ }
  }

  // Erst der Knoten, dann das Fenster: openNode() wirft nie (Fehler
  // landen in nodeError), und so sieht die Seite beim ersten Abfragen
  // von node:state schon den echten Stand - kein Wettlauf mit einem
  // Rundruf, der vielleicht erst in Sekunden das naechste Mal meldet.
  await openNode();
  createWindow();
  refreshTray();

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
  destroyTray();
  if (quitting || !node) return;
  e.preventDefault();
  quitting = true;
  closeNode().finally(() => app.quit());
});
