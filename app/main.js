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
const selfupdate = require('./selfupdate');
const winupdate = require('./winupdate');
const quickaction = require('./quickaction');
const { t } = require('./renderer/i18n');

let win = null;
let node = null;
let nodeError = null;
let quitting = false;
let history = null;
let tray = null;

// Was prepare() zuletzt geladen und geprueft hat, bis update:apply es
// abholt oder ein neuer prepare()-Lauf es ersetzt - die Oberflaeche
// schickt nicht das ganze Objekt zurueck, nur den Befehl, es
// einzuspielen.
let preparedUpdate = null;

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

/* ------------------------------ Dateien aus dem Finder ------------------------------ */

// "Oeffnen mit" und der Finder-Kurzbefehl (app/quickaction.js) uebergeben
// die ausgewaehlten Pfade an Electron als open-file - aber einzeln und
// dicht hintereinander, selbst wenn man zehn Dateien auf einmal markiert
// hatte. Ausserdem koennen sie eintreffen, bevor ueberhaupt ein Fenster
// steht (der allererste Start ueber den Kurzbefehl). Deshalb: sammeln,
// kurz abwarten, dann als ein Ereignis weiterreichen - flushQueuedFiles()
// verwirft nichts, wenn das Fenster noch nicht so weit ist, sondern
// wartet auf den naechsten Anstoss (den Timer oder did-finish-load,
// siehe app.whenReady() weiter unten).
let queuedFiles = [];
let flushTimer = null;

function flushQueuedFiles() {
  if (!queuedFiles.length) return;
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
  const paths = queuedFiles;
  queuedFiles = [];
  showWindow('send');
  win.webContents.send('files:add', paths);
}

function queueFiles(paths) {
  queuedFiles.push(...paths.filter(Boolean));
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueuedFiles, 250);
}

// Muss vor app.whenReady() registriert sein: macOS kann open-file schon
// auf dem Weg zum "ready"-Ereignis feuern, und ein Handler, der erst
// danach lauscht, wuerde die ersten Pfade des Starts nie zu sehen
// bekommen.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueFiles([filePath]);
});

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

/* ------------------------------ Einwilligung ------------------------------ */

// Wie lange auf eine Antwort gewartet wird, bevor abgelehnt wird. Der
// Sender haengt in dieser Zeit an einer stehenden Verbindung - das
// traegt sie, aber nicht endlos: wer nicht am Rechner sitzt, soll den
// Sender nicht eine Stunde warten lassen. Zwei Minuten sind genug, um
// vom Nebenraum zurueckzukommen.
const FRAGE_FRIST_MS = 120000;

const offeneFragen = new Map();
let frageNr = 0;

/**
 * Fragt den Menschen, ob eine angebotene Uebertragung angenommen wird.
 *
 * Abgeschaltet (confirmReceive aus) wird sofort angenommen - das ist
 * das alte Verhalten. Sonst geht die Frage als Karte ins Fenster, das
 * dafuer nach vorn kommt: eine Einwilligung, die niemand sieht, ist
 * keine. Keine Antwort binnen der Frist heisst nein - im Zweifel wird
 * nichts angenommen, nicht alles.
 */
function uebertragungErfragen(angebot) {
  if (settings.load().confirmReceive === false) return true;

  const id = `frage-${++frageNr}`;
  showWindow('receive');

  // Wurde das Fenster fuer die Frage gerade erst erzeugt (macOS,
  // Fenster war zu), ist die Seite noch nicht geladen - eine sofort
  // geschickte Frage kaeme nie an, und die Frist liefe ins Leere.
  const frageSchicken = () => win.webContents.send('receive:ask', { id, ...angebot });
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', frageSchicken);
  else frageSchicken();

  return new Promise((resolve) => {
    const frist = setTimeout(() => {
      offeneFragen.delete(id);
      resolve(false);
    }, FRAGE_FRIST_MS);

    offeneFragen.set(id, (ok) => {
      clearTimeout(frist);
      offeneFragen.delete(id);
      resolve(Boolean(ok));
    });
  });
}

ipcMain.handle('receive:answer', (_e, { id, ok } = {}) => {
  const antworten = offeneFragen.get(id);
  // Nach Ablauf der Frist ist die Frage weg - ein spaeter Klick tut
  // dann nichts mehr, statt eine fremde Frage zu beantworten.
  if (antworten) antworten(ok);
  return true;
});

/** Aus den gespeicherten Einstellungen die Optionen fuer node.open() bauen. */
function buildNodeOptions(values) {
  const opts = {
    outDir: defaultOutDir(),
    port: Number(values.port) || 0,
    trustNew: Boolean(values.trustNew),
    dedup: values.dedup !== false,
    announce: true,
    autoScan: values.autoScan !== false,
    portmap: Boolean(values.portmap),
    onApprove: uebertragungErfragen,
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
  version: require('../package.json').version,
  keysDir: storeMod.homeDir()
}));

ipcMain.handle('node:setSetting', async (_e, patch) => {
  const { values, betrifftKnoten } = settings.save(patch || {});
  if (betrifftKnoten) await restartNode();

  // Der Rundruf laesst sich am laufenden Knoten umlegen - deshalb steht
  // autoScan nicht in NODE_FELDER. Ein Neustart dafuer wuerde jede
  // laufende Uebertragung mit abreissen, fuer einen Schalter, der nur
  // einen Zeitgeber an- und ausmacht.
  if (node && Object.prototype.hasOwnProperty.call(patch || {}, 'autoScan')) {
    node.setAutoScan(values.autoScan !== false);
  }

  refreshTray();
  return values;
});

// Einmal rufen, sofort. Zurueck kommt die Geraeteliste, wie sie in
// diesem Augenblick aussieht - die Antworten auf den Ruf treffen erst
// in den naechsten Sekunden ein und kommen ueber das peers-Ereignis
// nach, genau wie sonst auch.
ipcMain.handle('node:scan', () => {
  if (node) node.scan();
  return buildPeerList();
});

// Laufende Sendungen, nach der Aufgabenkennung des Fensters. Mehrere
// gleichzeitig sind ausdruecklich erlaubt - jede hat ihren eigenen
// Anhalter und ihre eigenen Fortschrittsmeldungen (die Kennung reist in
// jedem Ereignis mit, sonst waeren zwei parallele Sendungen in der
// Anzeige nicht auseinanderzuhalten).
const laufendeSendungen = new Map();

ipcMain.handle('node:send', async (_e, { ziel, paths, id }) => {
  if (!node) return { ok: false, message: 'Der Knoten ist nicht bereit.' };

  let zielAngabe;
  try {
    zielAngabe = findZiel(ziel);
  } catch (err) {
    return { ok: false, message: err.message, code: err.code };
  }

  const anhalter = new AbortController();
  if (id) laufendeSendungen.set(id, anhalter);

  try {
    const res = await node.sendTo(zielAngabe, paths, {
      signal: anhalter.signal,
      onProgress: (e) => { if (win) win.webContents.send('send:progress', { id, ...e }); }
    });
    recordSendHistory(zielAngabe, paths, res, null);
    return res;
  } catch (err) {
    // Eine Pause ist kein Vorfall - in den Verlauf gehoeren Ergebnisse
    // und Fehlschlaege, nicht jede Unterbrechung, die gleich fortgesetzt
    // wird.
    if (err.code !== 'PAUSED') recordSendHistory(zielAngabe, paths, null, err);
    return { ok: false, message: err.message, code: err.code };
  } finally {
    if (id) laufendeSendungen.delete(id);
  }
});

/**
 * Haelt eine laufende Sendung an. `art` unterscheidet nur die
 * Begruendung, die beide Seiten zu sehen bekommen - technisch endet in
 * beiden Faellen diese Verbindung, und die Blockwiedererkennung macht
 * aus einem spaeteren erneuten Senden die Fortsetzung.
 */
ipcMain.handle('node:sendStop', (_e, { id, art } = {}) => {
  const anhalter = laufendeSendungen.get(id);
  if (!anhalter) return false;

  const pause = art === 'pause';
  anhalter.abort(Object.assign(
    new Error(pause ? 'Übertragung angehalten' : 'Übertragung abgebrochen'),
    { code: pause ? 'PAUSED' : 'STOPPED' }
  ));
  return true;
});

ipcMain.handle('node:recvStop', (_e, { from } = {}) => (node ? node.stopIncoming(from) : false));

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

/* ------------------------------ Selbstupdate ------------------------------ */

/**
 * Welcher Weg zum Selbstupdate gilt auf diesem System?
 *
 * Windows: electron-updater (app/winupdate.js) - dort verlangt der Weg
 * ueber NSIS keine Signatur. Mac: der Handbetrieb (app/selfupdate.js),
 * weil Squirrel.Mac ohne Signatur verweigert. Linux: ebenfalls
 * selfupdate.js, das dort ehrlich "geht hier nicht" meldet.
 *
 * Beide sprechen denselben Vertrag - canReplace/check/prepare/install
 * mit denselben Feldern -, deshalb genuegt hier die Auswahl. Die Griffe
 * darunter und die Oberflaeche kennen den Unterschied nicht.
 */
function updateWeg() {
  return process.platform === 'win32' ? winupdate : selfupdate;
}

ipcMain.handle('update:can', () => updateWeg().canReplace());

ipcMain.handle('update:check', () => updateWeg().check(selfupdate.configuredRepo()));

ipcMain.handle('update:fetch', async () => {
  preparedUpdate = null;
  const res = await updateWeg().prepare(selfupdate.configuredRepo(), (e) => {
    if (win) win.webContents.send('update:progress', e);
  });
  if (res.ok) preparedUpdate = res;
  // "staged"/"work"/"bundle" sind nur fuer install() gedacht - der
  // Renderer bekommt davon nichts zu sehen, nur ob es geklappt hat.
  return { ok: res.ok, version: res.version, reason: res.reason, message: res.message };
});

ipcMain.handle('update:apply', async () => {
  if (!preparedUpdate) return { ok: false, message: 'Nichts zum Einspielen vorbereitet - erst laden.' };

  // Vor dem Einspielen den Knoten selbst schliessen und das Beenden
  // freigeben. Ohne das faengt before-quit das app.quit() des Updaters
  // ab (e.preventDefault, erst den Knoten schliessen) - und
  // electron-updater wertet das als "nicht jetzt": es installiert dann
  // erst beim endgueltigen Beenden, aber OHNE den zugesagten Neustart.
  // Nachgemessen am installierten Paket: eingespielt wurde, neu
  // gestartet nicht. So herum ist das Ende sauber UND der Neustart
  // kommt.
  quitting = true;
  await closeNode();

  const res = updateWeg().install(preparedUpdate);
  preparedUpdate = null;

  if (!res.ok) {
    // Das Einspielen kam nicht zustande - dann ist das hier wieder eine
    // laufende App, kein halb beendetes Programm ohne Knoten.
    quitting = false;
    await openNode();
    refreshTray();
  }
  return res;
});

/**
 * Einmal nach dem Start still nachsehen, ob es etwas Neues gibt.
 *
 * Still heisst: kein Dialog, kein Hinweis, der sich in den Weg stellt.
 * Ein Fund landet in der Update-Karte unter den Einstellungen, und dort
 * entscheidet der Benutzer. Wer nie hinsieht, wird nie gestoert.
 *
 * Verzoegert, damit der Start nicht darauf wartet - und Fehler bleiben
 * absichtlich stumm: ohne Netz gestartet zu sein ist kein Grund fuer
 * eine Meldung, die niemand angefordert hat.
 */
const STILLE_PRUEFUNG_MS = 8000;

async function stillNachUpdateSehen() {
  try {
    const res = await updateWeg().check(selfupdate.configuredRepo());
    if (res && res.ok && res.newer && win && !win.isDestroyed()) {
      win.webContents.send('update:found', res);
    }
  } catch { /* still bleiben, siehe oben */ }
}

/* ------------------------------ Finder-Kurzbefehl ------------------------------ */

function finderStatus() {
  return { supported: quickaction.supported(), installed: quickaction.isInstalled() };
}

ipcMain.handle('finder:status', () => finderStatus());

// label kommt von der Oberflaeche, in der gerade eingestellten Sprache -
// quickaction.js selbst kennt keine Sprachen, es schreibt nur, was man
// ihm gibt.
ipcMain.handle('finder:install', (_e, label) => {
  quickaction.install(label, 'SNAPKEY');
  return finderStatus();
});

ipcMain.handle('finder:remove', () => {
  quickaction.remove();
  return finderStatus();
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

  // Holt nach, was queueFiles() schon vor diesem Zeitpunkt gesammelt
  // hat (der Start ueber den Kurzbefehl liefert seine Pfade oft, bevor
  // die Seite fertig geladen ist) - der Timer allein wuerde sie sonst
  // verlieren, weil flushQueuedFiles() vor dem Laden nichts schickt.
  win.webContents.once('did-finish-load', () => flushQueuedFiles());

  // Nicht an did-finish-load gehaengt, sondern an einen eigenen Timer:
  // die Pruefung soll nach dem Start geschehen, nicht als Teil davon.
  const nachsehen = setTimeout(stillNachUpdateSehen, STILLE_PRUEFUNG_MS);
  if (nachsehen.unref) nachsehen.unref();

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
