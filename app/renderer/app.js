'use strict';

/* =================================================================
   SNAPKEY - Oberflaechenlogik.

   Kein Zustand ueber das Fenster hinaus - was der Hauptprozess weiss
   (Knoten, Geraete, Einstellungen), wird hier nur gespiegelt und bei
   jeder Aenderung frisch abgeholt. Der Knoten selbst laeuft druebe im
   Hauptprozess (app/main.js); hier wird nur verdrahtet, was er meldet.
   ================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = window.snapkey;

const state = {
  lang: DEFAULT_LANG,
  running: false,
  error: null,
  me: null,             // {address, uri, fingerprint}
  outDir: '',
  files: [],             // [{path, name, size, dir}]
  peers: [],              // [{address, name, host, port, gekoppelt}]
  jobs: new Map(),         // id -> Karte samt Zustand
  settings: {},
  defaults: {},
  userData: '',
  keysDir: '',
  version: '',
  meetNote: null,
  portmapNote: null,
  finder: { supported: false, installed: false },

  chats: [],               // [{address, name, anzahl, letzte, gekoppelt}]
  chatSelected: null,       // Anschrift, mit der die Nachrichtenansicht gerade offen ist
  chatMessages: new Map(),   // Anschrift -> entry[] (Zwischenspeicher, damit ein Wechsel nicht jedesmal neu holt)
  chatUnread: new Set(),     // Anschriften mit ungesehener Nachricht, waehrend man bei einem anderen Chat stand
  chatSending: false,

  history: [],              // entry[] aus history:list, neueste zuerst

  update: {
    can: null,        // {ok, reason?} von update:can - ob der Tausch technisch moeglich waere
    result: null,      // {ok, current, latest, newer, url} oder {ok:false, reason} von update:check
    busy: false,        // waehrend check() oder fetch() laeuft
    phase: null,          // 'download' | 'unpack' | null, waehrend fetch() laeuft
    pct: 0,                 // Ladefortschritt in Prozent
    ready: false,             // prepare() ist durch, update:apply kann kommen
    fail: null                 // {reason, message} vom letzten fehlgeschlagenen fetch()
  }
};

const T = (key, ...args) => t(state.lang, key, ...args);

/* ----------------------------- Helfer ----------------------------- */

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString(state.lang, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function formatDateTime(iso) {
  try { return new Date(iso).toLocaleString(state.lang, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return ''; }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-on'), 3200);
}

/* ----------------------------- Sprache ----------------------------- */

function buildLangPicker(box) {
  box.textContent = '';
  LANGS.forEach(({ code, label }) => {
    const btn = el('button', 'seg__btn', label);
    btn.type = 'button';
    btn.dataset.lang = code;
    btn.addEventListener('click', () => setLang(code));
    box.append(btn);
  });
}

function applyLang() {
  document.documentElement.lang = state.lang;

  $$('[data-i18n]').forEach((n) => { n.textContent = T(n.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((n) => { n.placeholder = T(n.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach((n) => { n.title = T(n.dataset.i18nTitle); });

  $$('#langPick .seg__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.lang === state.lang));
  $$('#langPickSettings .seg__btn').forEach((b) => b.classList.toggle('is-on', b.dataset.lang === state.lang));

  renderAll();
}

async function setLang(code) {
  state.lang = code;
  applyLang();
  state.settings = await api.setSetting({ lang: code });
}

/* ------------------------------ Rundgang ------------------------------ */

function renderNodeStatus() {
  const pill = $('#nodeStatus');
  const text = $('#nodeStatusText');
  if (state.running) {
    pill.dataset.state = 'ok';
    text.textContent = (state.me && state.me.address) || T('app.running');
  } else {
    pill.dataset.state = 'bad';
    text.textContent = state.error ? T('app.error', state.error) : T('app.offline');
  }
}

function renderMyAddress() {
  const box = $('#myAddress');
  box.textContent = '';
  if (!state.me) return;

  const woerter = state.me.uri.split(':')[1].split('-');
  woerter.forEach((w, i) => {
    if (i > 0) box.append(el('span', 'beacon__dash', '-'));
    box.append(el('span', 'beacon__word', w));
  });
  $('#myFingerprint').textContent = T('recv.fingerprint', state.me.fingerprint);
}

/* ------------------------------- Geraete ------------------------------- */

function renderDeviceSelect() {
  const sel = $('#sendDeviceSelect');
  const vorher = sel.value;
  sel.textContent = '';

  const leer = el('option', null, T('send.deviceNone'));
  leer.value = '';
  sel.append(leer);

  state.peers
    .slice()
    .sort((a, b) => (a.name || a.address).localeCompare(b.name || b.address))
    .forEach((p) => {
      const label = p.name || p.address;
      const opt = el('option', null, p.host ? label : `${label} (${T('dev.offline')})`);
      opt.value = p.address;
      sel.append(opt);
    });

  if ([...sel.options].some((o) => o.value === vorher)) sel.value = vorher;
}

/**
 * Der Schalter und sein Hinweis. Bewusst auf der Geraeteseite und nicht
 * bei den Einstellungen: hier sieht man, was er bewirkt - die Liste
 * darunter.
 */
function renderScanControls() {
  const an = state.settings.autoScan !== false;

  $('#devAutoScan').checked = an;

  const note = $('#devScanNote');
  note.textContent = T(an ? 'dev.scanOn' : 'dev.scanOff');
  note.dataset.tone = an ? 'good' : '';
}

function renderDevices() {
  renderScanControls();

  const box = $('#deviceList');
  box.textContent = '';

  const liste = state.peers.slice().sort((a, b) => (a.name || a.address).localeCompare(b.name || b.address));
  $('#deviceEmpty').hidden = liste.length > 0;

  liste.forEach((p) => {
    const card = el('div', 'card');

    const head = el('div', 'card__head');
    head.append(el('span', 'card__name', p.name || p.address));

    const acts = el('div', 'card__acts');
    if (!p.gekoppelt) {
      const pairBtn = el('button', 'card__icon', T('dev.pairMark'));
      pairBtn.type = 'button';
      pairBtn.title = T('dev.pairTitle');
      pairBtn.dataset.pair = p.address;
      acts.append(pairBtn);
    }
    const forgetBtn = el('button', 'card__icon', T('dev.forgetMark'));
    forgetBtn.type = 'button';
    forgetBtn.title = T('dev.forgetTitle');
    forgetBtn.dataset.forget = p.address;
    acts.append(forgetBtn);
    head.append(acts);
    card.append(head);

    const code = el('button', 'card__code', `snapkey:${p.address}`);
    code.type = 'button';
    code.dataset.copy = `snapkey:${p.address}`;
    card.append(code);

    card.append(el('p', 'card__note', p.host ? T('dev.online', `${p.host}:${p.port}`) : T('dev.offline')));
    card.append(el('p', 'card__note', p.gekoppelt ? T('dev.paired') : T('dev.notPaired')));

    box.append(card);
  });
}

async function refreshPeers() {
  state.peers = await api.peers();
  renderDevices();
  renderDeviceSelect();
}

/* ------------------------------ Nachrichten ------------------------------ */

function renderChatList() {
  const box = $('#chatWho');
  box.textContent = '';

  // Wer zuletzt geschrieben hat, steht oben; wem man noch nie
  // geschrieben hat (letzte === null), kommt alphabetisch dahinter.
  const liste = state.chats.slice().sort((a, b) => {
    if (a.letzte && b.letzte) return b.letzte.localeCompare(a.letzte);
    if (a.letzte) return -1;
    if (b.letzte) return 1;
    return (a.name || a.address).localeCompare(b.name || b.address);
  });

  liste.forEach((c) => {
    const btn = el('button', 'chat__name');
    btn.type = 'button';
    btn.dataset.address = c.address;
    btn.classList.toggle('is-on', c.address === state.chatSelected);

    const top = el('span', 'chat__nameTop');
    top.append(el('b', null, c.name || c.address));
    if (state.chatUnread.has(c.address)) top.append(el('span', 'chat__new', '●'));
    btn.append(top);
    btn.append(el('span', 'chat__meta', c.letzte ? `${c.anzahl} · ${formatDateTime(c.letzte)}` : ''));

    btn.addEventListener('click', () => selectChat(c.address));
    box.append(btn);
  });
}

function renderChatLog() {
  const box = $('#chatLog');
  box.textContent = '';
  if (!state.chatSelected) return;

  const msgs = state.chatMessages.get(state.chatSelected) || [];
  if (!msgs.length) {
    box.append(el('p', 'chat__hollow', T('msg.chatEmpty')));
    return;
  }

  msgs.forEach((m) => {
    const bubble = el('div', 'bubble');
    bubble.dataset.dir = m.dir;
    bubble.append(document.createTextNode(m.text));
    bubble.append(el('time', null, formatTime(m.at)));
    box.append(bubble);
  });

  box.scrollTop = box.scrollHeight;
}

/** Holt den Verlauf mit einer Gegenstelle und zeigt ihn, falls es noch immer der ausgewaehlte Chat ist. */
async function loadChatMessages(address) {
  const msgs = await api.messages(address);
  state.chatMessages.set(address, msgs);
  if (state.chatSelected === address) renderChatLog();
}

async function selectChat(address) {
  state.chatSelected = address;
  state.chatUnread.delete(address);
  $('#chatError').textContent = '';
  renderChatList();
  await loadChatMessages(address);
}

function renderMessagesView() {
  const hatChats = state.chats.length > 0;
  $('#msgEmpty').hidden = hatChats;
  $('#chatBox').hidden = !hatChats;
  if (!hatChats) return;

  if (!state.chatSelected || !state.chats.some((c) => c.address === state.chatSelected)) {
    state.chatSelected = state.chats[0].address;
  }
  renderChatList();
  if (state.chatMessages.has(state.chatSelected)) renderChatLog();
  else loadChatMessages(state.chatSelected);
}

async function refreshChats() {
  state.chats = await api.chats();
  renderMessagesView();
}

/**
 * Beide Listen neu holen, die an derselben Frage haengen: wer ist
 * gekoppelt?
 *
 * Gekoppelt wird nicht nur durch den Knopf auf der Geraeteseite. Eine
 * angenommene Uebertragung koppelt (siehe pruefen() in
 * src/node/node.js), und wer an eine von Hand eingetippte Anschrift
 * sendet, ebenso (zielPruefen() dort). Beide Wege liefen bisher nur
 * durch refreshPeers() - in den Nachrichten stand danach weiter "noch
 * kein Geraet gekoppelt", obwohl auf der Geraeteseite eins als
 * gekoppelt gefuehrt wurde. Bis zum Neustart, dann war es da.
 *
 * Deshalb hier zusammen und nicht an jeder Stelle einzeln: die naechste
 * Stelle, die koppelt, vergisst sonst wieder die Haelfte.
 */
async function refreshGekoppelte() {
  await refreshPeers();
  await refreshChats();
}

async function onChatSend() {
  if (state.chatSending) return;
  const address = state.chatSelected;
  if (!address) return;

  const feld = $('#chatInput');
  const text = feld.value.trim();
  if (!text) return;

  state.chatSending = true;
  feld.value = '';
  $('#chatError').textContent = '';

  const res = await api.say(address, [text]);

  if (!res || res.ok === false) {
    const meldung = (res && res.message) || T('msg.sendFailed');
    $('#chatError').textContent = meldung;
    toast(meldung, 'bad');
    feld.value = text;   // nichts verschlucken - der Text bleibt stehen, zum erneuten Versuch
  } else {
    await loadChatMessages(address);
    await refreshChats();
  }

  state.chatSending = false;
  feld.focus();
}

/* -------------------------------- Dateien ------------------------------- */

function renderFileList() {
  const box = $('#fileList');
  box.textContent = '';

  state.files.forEach((f) => {
    const chip = el('li', 'chip');
    chip.append(el('b', null, f.name));
    chip.append(el('span', null, f.dir ? T('send.folderTag') : bytes(f.size)));

    const rm = el('button', null, '×');
    rm.type = 'button';
    rm.title = T('send.remove');
    rm.addEventListener('click', () => {
      state.files = state.files.filter((x) => x.path !== f.path);
      renderFileList();
    });
    chip.append(rm);

    box.append(chip);
  });

  const sum = $('#sendSum');
  if (!state.files.length) {
    sum.textContent = '';
  } else {
    const summe = state.files.reduce((n, f) => n + (f.dir ? 0 : f.size), 0);
    sum.textContent = T('send.summary', state.files.length, bytes(summe));
  }
}

function addPaths(paths) {
  api.statPaths(paths).then((stats) => {
    const bekannt = new Set(state.files.map((f) => f.path));
    stats.forEach((s) => {
      if (s.missing || bekannt.has(s.path)) return;
      state.files.push(s);
      bekannt.add(s.path);
    });
    renderFileList();
  });
}

/* --------------------------- Uebertragungskarten -------------------------- */

const ROUTE_KEY = { lan: 'job.routeLan', direct: 'job.routeDirect', relay: 'job.routeRelay' };

function jobPercent(job) {
  if (job.state === 'done') return 100;
  if (job.kind === 'send') {
    if (!job.planSend) return 0;
    return Math.min(100, Math.round(((job.doneBlocks || 0) / job.planSend) * 100));
  }
  if (job.kind === 'receive') {
    if (!job.needChunks) return 0;
    return Math.min(100, Math.round(((job.doneChunks || 0) / job.needChunks) * 100));
  }
  return 0;
}

/**
 * Was an einer Karte NICHT durch blosses Nachfuehren zu aendern ist.
 *
 * Solange diese Kennung gleich bleibt, hat die Karte dieselben Bausteine
 * und wird in renderJobs() nur nachgefuehrt statt neu gebaut. Aendert
 * sie sich (fertig geworden, Fehler dazugekommen, Groesse erstmals
 * bekannt), wird die Karte einmal frisch gebaut - das ist der seltene
 * Fall, und einmal blinzeln beim Zustandswechsel ist kein Flackern.
 */
function jobShape(job) {
  return [
    job.state,
    job.kind,
    Boolean(job.error),
    Boolean(job.outDir),
    Boolean(job.route),
    Boolean(job.totalBytes),
    // Die Sprache gehoert dazu: Zustandswort und Weg-Beschriftung stehen
    // fest in der Karte. Ohne diesen Teil bliebe nach einem
    // Sprachwechsel mitten in der Uebertragung die alte Sprache stehen -
    // beim Vollneubau von frueher konnte das nicht passieren.
    state.lang
  ].join('|');
}

function jobEl(job) {
  const card = el('div', 'job');
  card.dataset.state = job.state;
  card.dataset.kind = job.kind === 'refused' ? 'receive' : job.kind;
  card.dataset.jobId = String(job.id);
  card.dataset.shape = jobShape(job);

  const top = el('div', 'job__top');
  top.append(el('span', 'job__name', job.title || job.id));
  const stateKey = job.state === 'running' ? 'job.stateRunning'
    : job.state === 'asking' ? 'job.stateAsking'
      : job.state === 'paused' ? 'job.statePaused'
        : (job.state === 'done' ? 'job.stateDone' : 'job.stateFailed');
  top.append(el('span', 'job__state', T(stateKey)));
  card.append(top);

  // Die Einwilligungs-Frage: was kommt, von wem, wie gross - und die
  // beiden Antworten. Kein Balken, es laueft ja noch nichts.
  if (job.state === 'asking' && job.frage) {
    const f = job.frage;

    const was = el('div', 'job__read');
    was.append(el('span', null, T('job.offer', f.files, bytes(f.bytes))));
    card.append(was);

    if (f.names && f.names.length) {
      const namen = el('div', 'job__read');
      namen.append(el('span', null, f.names.join(' · ') + (f.files > f.names.length ? ' …' : '')));
      card.append(namen);
    }

    const acts = el('div', 'job__acts');
    const ja = el('button', 'btn btn--go btn--sm', T('job.accept'));
    ja.type = 'button';
    ja.addEventListener('click', () => {
      api.receiveAnswer(f.id, true);
      // Nicht auf das naechste Kernereignis warten: der Klick soll
      // sofort sichtbar Wirkung haben, sonst drueckt man zweimal.
      job.state = 'running';
      job.frage = null;
      renderJobs();
    });
    const nein = el('button', 'btn btn--ghost btn--sm', T('job.decline'));
    nein.type = 'button';
    nein.addEventListener('click', () => {
      api.receiveAnswer(f.id, false);
      // Der Kern meldet gleich 'refused' - die Karte bekommt ihren
      // Endzustand von dort, mitsamt der Begruendung.
    });
    acts.append(ja, nein);
    card.append(acts);

    return card;
  }

  if (job.kind !== 'refused') {
    const pct = jobPercent(job);

    const meter = el('div', 'job__meter');
    const fill = el('div', 'job__fill');
    fill.style.width = `${pct}%`;
    meter.append(fill);
    card.append(meter);

    const read = el('div', 'job__read');
    read.append(el('span', 'pct', `${pct}%`));
    if (job.totalBytes) {
      const gezeigt = job.state === 'done' ? job.totalBytes : (job.doneBytes || 0);
      read.append(el('span', 'job__bytes', `${bytes(gezeigt)} / ${bytes(job.totalBytes)}`));
    }
    if (job.state === 'running') read.append(el('span', 'job__tempo', tempoText(job)));
    if (job.route) read.append(el('span', null, T('job.routeLabel', T(ROUTE_KEY[job.route] || job.route))));
    card.append(read);

    if (job.state === 'done' && job.kind === 'send') {
      const wiederverwendet = (job.planTotal && job.planSend !== undefined) ? job.planTotal - job.planSend : 0;
      const extra = el('div', 'job__read');
      extra.append(el('span', null, wiederverwendet > 0
        ? T('job.sentReused', job.resultSent || 0, wiederverwendet)
        : T('job.sent', job.resultSent || 0)));
      card.append(extra);
    }

    if (job.state === 'done' && job.kind === 'receive') {
      const extra = el('div', 'job__read');
      extra.append(el('span', null, T('job.received', job.taken || 0, job.had || 0)));
      if (job.recovered) extra.append(el('span', null, T('job.recovered', job.recovered)));
      card.append(extra);
    }
  }

  // Die Zuegel: eine laufende Sendung laesst sich anhalten (Pause,
  // fortsetzbar) oder abbrechen; ein laufender Empfang nur abbrechen -
  // fortsetzen kann von hier aus niemand, das muss der Sender tun.
  // "Anhalten" heisst technisch beides Mal: diese Verbindung endet,
  // und die Blockwiedererkennung macht aus dem naechsten Anlauf die
  // Fortsetzung. Verloren geht nichts.
  if (job.state === 'running') {
    const acts = el('div', 'job__acts');
    if (job.kind === 'send') {
      const pauseBtn = el('button', 'btn btn--ghost btn--sm', T('job.pause'));
      pauseBtn.type = 'button';
      pauseBtn.addEventListener('click', () => api.sendStop(job.id, 'pause'));
      acts.append(pauseBtn);

      const stopBtn = el('button', 'btn btn--ghost btn--sm', T('job.stop'));
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', () => api.sendStop(job.id, 'stop'));
      acts.append(stopBtn);
    } else if (job.kind === 'receive') {
      const stopBtn = el('button', 'btn btn--ghost btn--sm', T('job.stop'));
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', () => api.recvStop(job.id));
      acts.append(stopBtn);
    }
    if (acts.childElementCount) card.append(acts);
  }

  // Pausiert: fortsetzen oder die Karte verwerfen. Verwerfen loescht
  // nur die Karte - was schon drueben liegt, bleibt dort und wird beim
  // naechsten Senden an dieselbe Stelle wiederverwendet.
  if (job.state === 'paused' && job.kind === 'send') {
    const acts = el('div', 'job__acts');
    const weiterBtn = el('button', 'btn btn--go btn--sm', T('job.resume'));
    weiterBtn.type = 'button';
    weiterBtn.addEventListener('click', () => sendeLauf(job));
    const wegBtn = el('button', 'btn btn--ghost btn--sm', T('job.discard'));
    wegBtn.type = 'button';
    wegBtn.addEventListener('click', () => {
      state.jobs.delete(job.id);
      renderJobs();
    });
    acts.append(weiterBtn, wegBtn);
    card.append(acts);
  }

  if (job.error) card.append(el('div', 'job__err', job.error));

  if (job.state === 'done' && job.outDir) {
    const acts = el('div', 'job__acts');
    const btn = el('button', 'btn btn--ghost btn--sm', T('job.reveal'));
    btn.type = 'button';
    btn.addEventListener('click', () => api.reveal(job.outDir));
    acts.append(btn);
    card.append(acts);
  }

  return card;
}

/** Fuehrt die Zahlen einer bestehenden Karte nach, ohne sie anzufassen. */
function jobElNachfuehren(card, job) {
  const pct = jobPercent(job);

  const fill = card.querySelector('.job__fill');
  if (fill) fill.style.width = `${pct}%`;

  const pctEl = card.querySelector('.pct');
  if (pctEl) pctEl.textContent = `${pct}%`;

  const bytesEl = card.querySelector('.job__bytes');
  if (bytesEl && job.totalBytes) {
    const gezeigt = job.state === 'done' ? job.totalBytes : (job.doneBytes || 0);
    bytesEl.textContent = `${bytes(gezeigt)} / ${bytes(job.totalBytes)}`;
  }

  const tempoEl = card.querySelector('.job__tempo');
  if (tempoEl) tempoEl.textContent = tempoText(job);
}

/**
 * Bringt eine Kartenspalte auf den Stand der Aufgaben - OHNE sie
 * abzureissen.
 *
 * Frueher stand hier textContent = '' und ein Neubau jeder Karte. Bei
 * einem gemessenen Fortschrittstakt von 76 ms hiess das: dreizehnmal
 * je Sekunde wurden Balken, Texte und Knoepfe weggeworfen und neu
 * erzeugt - das war das Flackern waehrend einer Uebertragung. Jetzt
 * wird eine Karte nur neu gebaut, wenn sich ihr Aufbau aendert (siehe
 * jobShape); sonst werden nur die Zahlen nachgefuehrt.
 */
function jobBoxAbgleichen(box, jobs) {
  const vorhanden = new Map();
  for (const kind of box.children) vorhanden.set(kind.dataset.jobId, kind);

  const gewollt = jobs.map((job) => {
    const karte = vorhanden.get(String(job.id));
    if (karte && karte.dataset.shape === jobShape(job)) {
      jobElNachfuehren(karte, job);
      return karte;
    }
    return jobEl(job);
  });

  const bleiben = new Set(gewollt);
  for (const karte of vorhanden.values()) {
    if (!bleiben.has(karte)) karte.remove();
  }

  // Reihenfolge herstellen, aber nur dort eingreifen, wo sie nicht
  // stimmt - ein insertBefore auf die eigene Position ist zwar
  // harmlos, aber jeder unnoetige Eingriff ist einer zu viel.
  gewollt.forEach((karte, i) => {
    if (box.children[i] !== karte) box.insertBefore(karte, box.children[i] || null);
  });
}

function renderJobs() {
  const alle = [...state.jobs.values()].sort((a, b) => b.ts - a.ts);

  jobBoxAbgleichen($('#sendJobs'), alle.filter((j) => j.kind === 'send'));

  const recvJobs = alle.filter((j) => j.kind === 'receive' || j.kind === 'refused');
  jobBoxAbgleichen($('#recvJobs'), recvJobs);
  $('#recvEmpty').hidden = recvJobs.length > 0;
}

function ensureJob(id, kind) {
  let job = state.jobs.get(id);
  if (!job) {
    job = { id, kind, state: 'running', title: id, ts: Date.now() };
    state.jobs.set(id, job);
  }
  return job;
}

/**
 * Haelt fest, wie schnell es gerade vorangeht.
 *
 * Gleitendes Fenster von drei Sekunden statt Gesamtschnitt: der
 * Gesamtschnitt schleppt den langsamen Anfang (Handschlag, Plan) ewig
 * mit und zeigt nach einer Stau-Minute noch lange Unsinn. Das Fenster
 * sagt, was die Leitung JETZT tut - das ist die Zahl, nach der man
 * entscheidet, ob man wartet oder abbricht.
 */
function merkeTempo(job) {
  const jetzt = performance.now();
  if (!job.tempoProben) job.tempoProben = [];
  job.tempoProben.push({ t: jetzt, b: job.doneBytes || 0 });
  while (job.tempoProben.length > 2 && jetzt - job.tempoProben[0].t > 3000) job.tempoProben.shift();

  const erste = job.tempoProben[0];
  const dt = (jetzt - erste.t) / 1000;
  // Unter 300 ms Messstrecke ist die Zahl nur Rauschen - dann lieber
  // die letzte stehen lassen als eine zappelnde anzeigen.
  if (dt >= 0.3) job.rate = ((job.doneBytes || 0) - erste.b) / dt;
}

/** Sekunden als Uhrzeit-Rest: 4:07, oder 1:04:07 wenn es laenger dauert. */
function dauerText(sekunden) {
  const s = Math.max(0, Math.round(sekunden));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** "12.3 MB/s · noch 0:42" - oder leer, wenn es nichts Ehrliches zu sagen gibt. */
function tempoText(job) {
  if (job.state !== 'running' || !job.rate || job.rate < 1) return '';
  let text = T('job.rate', bytes(job.rate));
  if (job.totalBytes) {
    const offen = Math.max(0, job.totalBytes - (job.doneBytes || 0));
    text += ` · ${T('job.timeLeft', dauerText(offen / job.rate))}`;
  }
  return text;
}

/* ------------------------------ Einstellungen ------------------------------ */

function renderSettingsForm() {
  const s = state.settings;

  $('#setName').value = s.name || '';
  $('#setOutDir').value = state.outDir || '';
  $('#setPort').value = s.port || 0;
  $('#setTrustNew').checked = Boolean(s.trustNew);
  $('#setDedup').checked = s.dedup !== false;
  $('#setMeetHost').value = s.meetHost || '';
  $('#setMeetPort').value = s.meetPort || 41997;
  $('#setMeetPass').value = s.meetPass || '';
  $('#setPortmap').checked = Boolean(s.portmap);
  $('#setTray').checked = s.tray !== false;
  $('#setNotify').checked = s.notify !== false;
  $('#setFinder').checked = state.finder.installed;
  // Ein Schalter ohne Wirkung ist schlimmer als gar keiner - auf einer
  // Plattform ohne Finder-Dienste bleibt er stumm, der Hinweistext
  // darunter erklaert warum (siehe renderSettingsNotes).
  $('#setFinder').disabled = !state.finder.supported;

  $('#recvOutDir').value = state.outDir || '';
  $('#recvTrustNew').checked = Boolean(s.trustNew);
  $('#recvConfirm').checked = s.confirmReceive !== false;

  $('#appVersion').textContent = T('set.version', state.version || '0.1.0');
  $('#keysNote').textContent = T('set.keysAt', state.keysDir || '~/.snapkey');
}

function renderSettingsNotes() {
  const meetEl = $('#meetNote');
  if (state.meetNote) {
    meetEl.textContent = state.meetNote.message || '';
    meetEl.dataset.tone = state.meetNote.state === 'fehler' ? 'bad' : (state.meetNote.state === 'angemeldet' ? 'good' : '');
  } else {
    meetEl.textContent = '';
    meetEl.removeAttribute('data-tone');
  }

  const pmEl = $('#portmapNote');
  const e = state.portmapNote;
  if (e && e.state === 'mapped') {
    pmEl.textContent = T('set.portmapMapped', `${e.external.host}:${e.external.port}`, e.method);
    pmEl.dataset.tone = 'good';
  } else if (e && e.state === 'lost') {
    pmEl.textContent = T('set.portmapLost');
    pmEl.dataset.tone = 'bad';
  } else if (e && e.state === 'none') {
    pmEl.textContent = T('set.portmapNone');
    pmEl.removeAttribute('data-tone');
  } else {
    pmEl.textContent = '';
    pmEl.removeAttribute('data-tone');
  }

  const finderEl = $('#finderNote');
  if (!state.finder.supported) {
    finderEl.textContent = T('set.finderUnsupported');
    finderEl.removeAttribute('data-tone');
  } else if (state.finder.installed) {
    finderEl.textContent = T('set.finderInstalled');
    finderEl.dataset.tone = 'good';
  } else {
    finderEl.textContent = T('set.finderNotInstalled');
    finderEl.removeAttribute('data-tone');
  }
}

async function setSetting(patch) {
  state.settings = await api.setSetting(patch);
  await refreshState();
  await refreshPeers();
  renderSettingsForm();
  renderSettingsNotes();
}

/**
 * Legt den Finder-Kurzbefehl an oder nimmt ihn weg - kein Eintrag in
 * settings.json wie bei den anderen Schaltern, sondern eine echte
 * Datei unter ~/Library/Services. Die Beschriftung geht in der gerade
 * eingestellten Sprache mit, damit der Menue-Eintrag im Finder dazu
 * passt (siehe set.finderLabel).
 */
async function onFinderToggle() {
  const an = $('#setFinder').checked;
  state.finder = an ? await api.finderInstall(T('set.finderLabel')) : await api.finderRemove();
  renderSettingsForm();
  renderSettingsNotes();
}

/* ------------------------------ Selbstupdate ------------------------------ */

// canReplace()/prepare() melden denselben kleinen Satz an Gruenden, warum
// es nicht ginge - hier auf je einen Satz abgebildet. Ein unbekannter
// Grund (z. B. ein Netzfehler) faellt auf die allgemeine Fehlermeldung
// samt der rohen Angabe zurueck, statt zu schweigen.
function updateReasonText(reason, message) {
  switch (reason) {
    case 'nicht-eingerichtet': return T('set.updateNotConfigured');
    case 'platform': return T('set.updateReasonPlatform');
    case 'dev': return T('set.updateReasonDev');
    case 'no-bundle':
    case 'read-only': return T('set.updateReasonBundle');
    case 'kein-anhang': return T('set.updateReasonNoAsset');
    case 'keine-veroeffentlichung': return T('set.updateReasonNoRelease');
    // Kann nur auftreten, wenn zwischen Nachsehen und Laden
    // veroeffentlicht wurde - dann ist "schon die neueste" die ehrliche
    // Auskunft und kein Fehler.
    case 'nicht-neuer': return T('set.updateNone');
    case 'version':
    case 'size': return T('set.updateReasonBad');
    default: return T('set.updateError', message || reason || '?');
  }
}

function renderUpdate() {
  const u = state.update;
  const checkBtn = $('#updateCheckBtn');
  const fetchBtn = $('#updateFetchBtn');
  const applyBtn = $('#updateApplyBtn');
  const meter = $('#updateMeter');
  const note = $('#updateNote');

  checkBtn.disabled = u.busy;
  fetchBtn.hidden = true;
  applyBtn.hidden = true;
  meter.hidden = true;
  note.removeAttribute('data-tone');

  // Waehrend fetch() laeuft, zaehlt nur der Fortschritt - alles andere
  // (vorheriges Ergebnis, alter Fehler) wartet, bis es durch ist.
  if (u.busy && u.phase) {
    meter.hidden = false;
    $('#updateMeterFill').style.width = `${u.pct}%`;
    note.textContent = u.phase === 'unpack' ? T('set.updateUnpacking') : T('set.updateDownloading', u.pct);
    return;
  }

  if (u.ready) {
    applyBtn.hidden = false;
    note.textContent = T('set.updateReady', (u.result && u.result.latest) || '');
    note.dataset.tone = 'good';
    return;
  }

  if (u.fail) {
    fetchBtn.hidden = false;
    note.textContent = updateReasonText(u.fail.reason, u.fail.message);
    note.dataset.tone = 'bad';
    return;
  }

  if (!u.result) {
    note.textContent = '';
    return;
  }

  if (!u.result.ok) {
    note.textContent = updateReasonText(u.result.reason, u.result.message);
    return;
  }

  if (!u.result.newer) {
    note.textContent = T('set.updateNone');
    return;
  }

  // Eine neuere Fassung ist da - laesst sie sich hier ueberhaupt
  // einspielen? Wenn nicht (kein Mac, aus dem Quelltext, Paket
  // schreibgeschuetzt), steht das dazu, statt den Laden-Knopf zu
  // zeigen und ihn dann scheitern zu lassen.
  if (u.can && !u.can.ok) {
    note.textContent = `${T('set.updateAvailable', u.result.latest)} ${updateReasonText(u.can.reason)}`;
    return;
  }

  fetchBtn.hidden = false;
  note.textContent = T('set.updateAvailable', u.result.latest);
  note.dataset.tone = 'good';
}

async function onUpdateCheck() {
  if (state.update.busy) return;
  state.update.busy = true;
  state.update.result = null;
  state.update.fail = null;
  state.update.ready = false;
  renderUpdate();

  state.update.result = await api.updateCheck();
  state.update.busy = false;
  renderUpdate();
}

async function onUpdateFetch() {
  if (state.update.busy) return;
  state.update.busy = true;
  state.update.phase = 'download';
  state.update.pct = 0;
  state.update.fail = null;
  renderUpdate();

  const res = await api.updateFetch();
  state.update.busy = false;
  state.update.phase = null;
  if (res.ok) state.update.ready = true;
  else state.update.fail = res;
  renderUpdate();
}

async function onUpdateApply() {
  $('#updateApplyBtn').disabled = true;
  const res = await api.updateApply();
  if (!res.ok) {
    // Bei Erfolg beendet sich die App gleich von selbst (siehe main.js)
    // - erst bei einem Fehlschlag lohnt sich noch ein neuer Render.
    state.update.ready = false;
    state.update.fail = res;
    $('#updateApplyBtn').disabled = false;
    renderUpdate();
  }
}

/**
 * Eine eingehende Uebertragung wartet auf Einwilligung.
 *
 * Die Frage wird zur Karte im Empfangen-Bereich - kein eigener Dialog,
 * der sich vor alles stellt: die Karte zeigt Absender, Dateien und
 * Groesse, und die beiden Knoepfe sind die Antwort. Der Sender wartet
 * derweil an der stehenden Verbindung; nach zwei Minuten ohne Antwort
 * lehnt der Hauptprozess von selbst ab (siehe main.js).
 */
function handleReceiveAsk(f) {
  const job = ensureJob(f.from, 'receive');
  job.state = 'asking';
  job.frage = f;
  job.totalBytes = f.bytes;
  if (f.name) job.title = f.name;
  else if (f.address) job.title = f.address;
  renderJobs();
  merkeEingang('receive');
}

function handleUpdateProgress(e) {
  state.update.phase = e.phase;
  state.update.pct = (e.phase === 'download' && e.total) ? Math.min(100, Math.round((e.done / e.total) * 100)) : state.update.pct;
  renderUpdate();
}

/**
 * Die stille Pruefung kurz nach dem Start hat etwas gefunden.
 *
 * Es wird nur die Karte gefuellt - kein Hinweis, kein Ton, nichts, was
 * sich in den Weg stellt. Wer gerade selbst nachsieht oder laedt, wird
 * dabei nicht unterbrochen: dann bleibt der Fund liegen, bis der
 * laufende Vorgang durch ist.
 */
function handleUpdateFound(res) {
  if (state.update.busy || state.update.ready) return;
  state.update.result = res;
  state.update.fail = null;
  renderUpdate();
}

/* --------------------------------- Verlauf -------------------------------- */

function historySummary(entry) {
  const teile = [];
  if (entry.files !== undefined && entry.bytes !== undefined) teile.push(T('send.summary', entry.files, bytes(entry.bytes)));
  else if (entry.bytes !== undefined) teile.push(bytes(entry.bytes));
  if (entry.route) teile.push(T(ROUTE_KEY[entry.route] || entry.route));
  teile.push(formatDateTime(entry.at));
  return teile.join(' · ');
}

function historyRowEl(entry) {
  const row = el('div', 'log__row');
  row.dataset.kind = entry.kind;

  row.append(el('span', 'log__arrow', entry.kind === 'send' ? '↑' : '↓'));

  const main = el('div', 'log__main');
  main.append(el('div', 'log__name', entry.name || entry.peer || T('hist.unknownPeer')));
  main.append(el('div', 'log__sub', historySummary(entry)));
  row.append(main);

  const zustand = el('span', 'log__state', entry.ok ? T('job.stateDone') : T('job.stateFailed'));
  zustand.dataset.tone = entry.ok ? 'ok' : 'bad';
  if (entry.error) zustand.title = entry.error;
  row.append(zustand);

  const acts = el('div', 'log__acts');

  if (entry.kind === 'receive' && entry.outDir) {
    const btn = el('button', 'btn btn--ghost btn--sm', T('hist.reveal'));
    btn.type = 'button';
    btn.addEventListener('click', () => api.reveal(entry.outDir));
    acts.append(btn);
  }

  if (entry.kind === 'send' && entry.paths && entry.paths.length) {
    const btn = el('button', 'btn btn--ghost btn--sm', T('hist.resend'));
    btn.type = 'button';
    btn.disabled = true;
    acts.append(btn);

    // Erst pruefen, ob die Pfade noch da sind - solange das laeuft,
    // bleibt der Knopf ausgegraut, nicht scheinbar bereit.
    api.statPaths(entry.paths).then((stats) => {
      const fehlt = stats.some((s) => s.missing);
      btn.disabled = fehlt;
      btn.title = fehlt ? T('hist.pathsGone') : '';
      if (!fehlt) btn.addEventListener('click', () => onResend(entry, stats));
    });
  }

  row.append(acts);
  return row;
}

function renderHistory() {
  const box = $('#histLog');
  box.textContent = '';
  $('#histEmpty').hidden = state.history.length > 0;
  state.history.forEach((entry) => box.append(historyRowEl(entry)));
}

async function refreshHistory() {
  state.history = await api.historyList();
  renderHistory();
}

/** Uebernimmt eine vergangene Sendung wieder in die Ansicht Senden - die Pfade wurden schon geprueft. */
async function onResend(entry, stats) {
  state.files = stats.filter((s) => !s.missing);
  renderFileList();

  $('#sendAddress').value = '';
  $('#sendDeviceSelect').value = '';
  const peer = entry.peer && state.peers.find((p) => p.address === entry.peer);
  if (peer) $('#sendDeviceSelect').value = peer.address;
  else if (entry.peer) $('#sendAddress').value = `snapkey:${entry.peer}`;

  activateView('send');
  toast(T('hist.resendReady'), 'good');
}

let histClearArmed = false;
let histClearTimer = null;

function disarmHistClear() {
  histClearArmed = false;
  clearTimeout(histClearTimer);
  const btn = $('#histClear');
  btn.classList.remove('btn--stop');
  btn.textContent = T('hist.clear');
}

function armHistClear() {
  histClearArmed = true;
  const btn = $('#histClear');
  btn.classList.add('btn--stop');
  btn.textContent = T('hist.clearConfirm');
  clearTimeout(histClearTimer);
  // Nicht ewig scharf stehen lassen - wer den zweiten Klick vergisst,
  // soll nicht Tage spaeter aus Versehen alles loeschen.
  histClearTimer = setTimeout(disarmHistClear, 4000);
}

async function onHistClear() {
  if (!histClearArmed) { armHistClear(); return; }
  disarmHistClear();
  state.history = await api.historyClear();
  renderHistory();
}

/* -------------------------------- Zustand -------------------------------- */

async function refreshState() {
  const s = await api.state();
  state.running = s.running;
  state.me = s.me;
  state.outDir = s.outDir || '';
  state.error = s.error;
  renderNodeStatus();
  renderMyAddress();
}

function renderAll() {
  renderNodeStatus();
  renderMyAddress();
  renderDevices();
  renderDeviceSelect();
  renderSettingsForm();
  renderSettingsNotes();
  renderUpdate();
  renderFileList();
  renderJobs();
  renderMessagesView();
  renderHistory();
  disarmHistClear();
}

/* --------------------------- Knotenereignisse --------------------------- */

function handleNodeEvent(e) {
  switch (e.type) {
    case 'peers':
      refreshPeers();
      break;

    case 'incoming':
      ensureJob(e.from, 'receive');
      renderJobs();
      break;

    case 'accepted': {
      const job = ensureJob(e.from, 'receive');
      job.peerAddress = e.address;
      const bekannt = state.peers.find((p) => p.address === e.address);
      job.title = (bekannt && bekannt.name) || e.address;
      renderJobs();
      // Angenommen heisst gekoppelt - auch fuer die Gespraechsliste.
      refreshGekoppelte();
      break;
    }

    case 'offered': {
      const job = ensureJob(e.from, 'receive');
      job.totalBytes = e.bytes;
      job.totalFiles = e.files;
      renderJobs();
      break;
    }

    case 'recovered': {
      const job = ensureJob(e.from, 'receive');
      job.recovered = e.count;
      renderJobs();
      break;
    }

    case 'plan': {
      if (e.need === undefined) break;   // gehoert zu einer ausgehenden Sendung, siehe handleSendProgress
      const job = ensureJob(e.from, 'receive');
      job.totalChunks = e.total;
      job.needChunks = e.need;
      renderJobs();
      break;
    }

    case 'taken': {
      const job = ensureJob(e.from, 'receive');
      job.doneBytes = (job.doneBytes || 0) + e.bytes;
      job.doneChunks = e.done;
      merkeTempo(job);
      renderJobs();
      break;
    }

    case 'received': {
      const job = ensureJob(e.from, 'receive');
      job.state = e.result.ok ? 'done' : 'failed';
      job.taken = e.result.taken;
      job.had = e.result.had;
      if (e.result.recovered) job.recovered = e.result.recovered;
      job.outDir = e.outDir;
      if (!e.result.ok && e.result.missing && e.result.missing.length) {
        job.error = T('job.missing', e.result.missing.join(', '));
      }
      renderJobs();
      refreshGekoppelte();
      merkeEingang('receive');
      break;
    }

    case 'message': {
      if (currentView() === 'messages' && state.chatSelected === e.address) {
        // Steht man genau bei diesem Gespraech, erzwingt das Loeschen
        // aus dem Zwischenspeicher, dass refreshChats() unten frisch holt.
        state.chatMessages.delete(e.address);
      } else {
        state.chatUnread.add(e.address);
        if (currentView() !== 'messages') merkeEingang('messages');
      }
      refreshChats();
      break;
    }

    case 'refused': {
      const bestehend = state.jobs.get(e.from);
      // 'asking' gehoert dazu: eine abgelehnte oder verfallene Frage
      // endet auch hier, und die Karte soll die Begruendung tragen.
      if (bestehend && bestehend.kind === 'receive' && (bestehend.state === 'running' || bestehend.state === 'asking')) {
        bestehend.kind = 'refused';
        bestehend.state = 'failed';
        bestehend.error = e.message;
        bestehend.title = bestehend.title === e.from ? e.from : bestehend.title;
      } else {
        const id = `refused-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        state.jobs.set(id, { id, kind: 'refused', state: 'failed', title: e.from, error: e.message, ts: Date.now() });
      }
      renderJobs();
      break;
    }

    case 'meet':
      state.meetNote = e;
      renderSettingsNotes();
      break;

    case 'portmap':
      state.portmapNote = e;
      renderSettingsNotes();
      break;

    default:
      break;
  }
}

function handleSendProgress(e) {
  // Die Kennung reist in jedem Ereignis mit - mehrere Sendungen laufen
  // nebeneinander, und jede Meldung muss zu ihrer Karte finden.
  const job = e.id && state.jobs.get(e.id);
  if (!job) return;
  switch (e.type) {
    case 'route': job.route = e.route; break;
    case 'offered': job.totalBytes = e.bytes; job.totalFiles = e.files; break;
    case 'plan': job.planTotal = e.total; job.planSend = e.send; break;
    case 'sent':
      job.doneBlocks = e.done;
      job.doneBytes = (job.doneBytes || 0) + e.bytes;
      merkeTempo(job);
      break;
    default: break;
  }
  renderJobs();
}

/* ---------------------------------- Senden --------------------------------- */

/**
 * Laesst eine Sendung laufen, bis sie fertig, gescheitert oder
 * angehalten ist. Auch die Fortsetzung einer Pause laeuft hier durch -
 * dieselbe Aufgabe, derselbe Ablauf, nur ein frischer Anlauf: die
 * Blockwiedererkennung der Gegenseite macht daraus von selbst "nur der
 * Rest".
 */
async function sendeLauf(job) {
  job.state = 'running';
  job.error = null;
  job.doneBytes = 0;
  job.tempoProben = [];
  job.rate = 0;
  renderJobs();

  try {
    const res = await api.send(job.ziel, job.paths, job.id);
    if (res.ok) {
      job.state = 'done';
      job.resultSent = res.sent;
      job.route = res.route || job.route;
    } else if (res.code === 'PAUSED') {
      // Kein Fehlschlag: die Karte bleibt stehen und bietet das
      // Fortsetzen an. Der Stand ist bei der Gegenseite gesichert.
      job.state = 'paused';
    } else {
      job.state = 'failed';
      job.error = res.message || (res.missing && T('job.missing', res.missing.join(', ')));
    }
  } catch (err) {
    job.state = 'failed';
    job.error = err.message;
  } finally {
    renderJobs();
    // Senden koppelt: an eine von Hand eingetippte Anschrift geschickt,
    // und die Gegenstelle steht danach in der Ablage. Ohne das hier
    // waere sie weder auf der Geraeteseite noch in den Nachrichten zu
    // sehen - bis zum naechsten Start.
    refreshGekoppelte();
  }
}

async function onSendStart() {
  if (!state.files.length) { toast(T('send.needFiles'), 'bad'); return; }

  const deviceAddress = $('#sendDeviceSelect').value;
  const manuell = $('#sendAddress').value.trim();

  let ziel;
  let title;
  if (deviceAddress) {
    const peer = state.peers.find((p) => p.address === deviceAddress);
    if (!peer || !peer.host) { toast(T('send.offline'), 'bad'); return; }
    ziel = { address: peer.address, host: peer.host, port: peer.port, name: peer.name };
    title = peer.name || peer.address;
  } else if (manuell) {
    ziel = manuell;
    title = manuell;
  } else {
    toast(T('send.needTarget'), 'bad');
    return;
  }

  // Ziel und Pfade wandern in die Aufgabe selbst: das Fortsetzen nach
  // einer Pause braucht beides noch, lange nachdem die Auswahl unten
  // laengst einer neuen Sendung gehoert.
  const id = `send-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id, kind: 'send', state: 'running', title, ts: Date.now(),
    doneBytes: 0, ziel, paths: state.files.map((f) => f.path)
  };
  state.jobs.set(id, job);

  // Die Auswahl ist verbraucht - wer parallel noch etwas schicken will,
  // stellt sie sich neu zusammen, waehrend diese Sendung laueft.
  state.files = [];
  renderFileList();

  sendeLauf(job);
}

/* --------------------------------- Verdrahtung -------------------------------- */

/** Welche Ansicht gerade vorne steht - ohne das "view-" davor. */
function currentView() {
  const v = $('.view.is-active');
  return v ? v.id.slice('view-'.length) : null;
}

/** Markiert eine Leistenkennung, wenn man gerade woanders steht - dieselbe Machart fuer Eingang wie Nachrichten. */
function merkeEingang(view = 'receive') {
  const knopf = $$('.rail__item').find((b) => b.dataset.view === view);
  if (knopf && !knopf.classList.contains('is-active')) knopf.classList.add('has-watch');
}

/** Wechselt die Ansicht - von der Leiste selbst, aber auch von aussen (Mitteilung, Menueleistensymbol). */
function activateView(view) {
  const knopf = $$('.rail__item').find((b) => b.dataset.view === view);
  if (!knopf) return;
  $$('.rail__item').forEach((b) => b.classList.toggle('is-active', b === knopf));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  // Wer hinsieht, hat es gesehen.
  knopf.classList.remove('has-watch');
}

function wireNav() {
  $$('.rail__item').forEach((btn) => {
    btn.addEventListener('click', () => activateView(btn.dataset.view));
  });
}

function wireSend() {
  const drop = $('#drop');

  $('#pickBtn').addEventListener('click', async () => {
    const paths = await api.pickFiles();
    if (paths.length) addPaths(paths);
  });

  drop.addEventListener('click', () => $('#pickBtn').click());
  drop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('#pickBtn').click(); }
  });
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('is-over');
    const paths = [...ev.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) addPaths(paths);
  });

  $('#sendStart').addEventListener('click', onSendStart);
  $('#sendClear').addEventListener('click', () => {
    state.files = [];
    $('#sendAddress').value = '';
    $('#sendDeviceSelect').value = '';
    renderFileList();
  });
}

function wireReceive() {
  $('#copyAddress').addEventListener('click', async () => {
    if (!state.me) return;
    await api.copy(state.me.uri);
    toast(T('toast.copied'), 'good');
  });
  $('#recvOutPick').addEventListener('click', async () => {
    const picked = await api.pickFolder(state.outDir);
    if (picked) await setSetting({ outDir: picked });
  });
  $('#recvTrustNew').addEventListener('change', () => setSetting({ trustNew: $('#recvTrustNew').checked }));
  $('#recvConfirm').addEventListener('change', () => setSetting({ confirmReceive: $('#recvConfirm').checked }));
}

function wireDevices() {
  // Einmal rufen. Die Antworten kommen nicht sofort - sie treffen in den
  // naechsten Sekunden ein und tragen sich ueber das peers-Ereignis
  // nach. Deshalb sagt der Hinweis "Antworten treffen ein", statt eine
  // fertige Liste zu versprechen.
  $('#devScan').addEventListener('click', async () => {
    const btn = $('#devScan');
    btn.disabled = true;
    try {
      state.peers = await api.scan();
      renderDevices();
      renderDeviceSelect();
      toast(T('dev.scanDone'), 'good');
    } finally {
      btn.disabled = false;
    }
  });

  $('#devAutoScan').addEventListener('change', () => {
    setSetting({ autoScan: $('#devAutoScan').checked });
  });

  $('#deviceList').addEventListener('click', async (ev) => {
    const pairBtn = ev.target.closest('[data-pair]');
    const forgetBtn = ev.target.closest('[data-forget]');
    const copyBtn = ev.target.closest('[data-copy]');

    if (pairBtn) {
      state.peers = await api.pair(pairBtn.dataset.pair);
      renderDevices();
      renderDeviceSelect();
      // Wer koppelt, will als Naechstes meist schreiben. Ohne das bliebe
      // die Gespraechsliste bis zum Neustart leer.
      refreshChats();
    } else if (forgetBtn) {
      state.peers = await api.forget(forgetBtn.dataset.forget);
      renderDevices();
      renderDeviceSelect();
      refreshChats();
    } else if (copyBtn) {
      await api.copy(copyBtn.dataset.copy);
      toast(T('toast.copied'), 'good');
    }
  });
}

function wireSettings() {
  $('#setName').addEventListener('change', () => setSetting({ name: $('#setName').value.trim() }));
  $('#setOutPick').addEventListener('click', async () => {
    const picked = await api.pickFolder(state.outDir);
    if (picked) await setSetting({ outDir: picked });
  });
  $('#setPort').addEventListener('change', () => setSetting({ port: Number($('#setPort').value) || 0 }));
  $('#setTrustNew').addEventListener('change', () => setSetting({ trustNew: $('#setTrustNew').checked }));
  $('#setDedup').addEventListener('change', () => setSetting({ dedup: $('#setDedup').checked }));
  $('#setMeetHost').addEventListener('change', () => setSetting({ meetHost: $('#setMeetHost').value.trim() }));
  $('#setMeetPort').addEventListener('change', () => setSetting({ meetPort: Number($('#setMeetPort').value) || 41997 }));
  $('#setMeetPass').addEventListener('change', () => setSetting({ meetPass: $('#setMeetPass').value }));
  $('#setPortmap').addEventListener('change', () => setSetting({ portmap: $('#setPortmap').checked }));
  $('#setTray').addEventListener('change', () => setSetting({ tray: $('#setTray').checked }));
  $('#setNotify').addEventListener('change', () => setSetting({ notify: $('#setNotify').checked }));
  $('#setFinder').addEventListener('change', onFinderToggle);

  $('#updateCheckBtn').addEventListener('click', onUpdateCheck);
  $('#updateFetchBtn').addEventListener('click', onUpdateFetch);
  $('#updateApplyBtn').addEventListener('click', onUpdateApply);
}

function wireMessages() {
  $('#chatSend').addEventListener('click', onChatSend);
  $('#chatInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    onChatSend();
  });
}

function wireHistory() {
  $('#histClear').addEventListener('click', onHistClear);
}

/* ---------------------------------- Start ---------------------------------- */

async function init() {
  buildLangPicker($('#langPick'));
  buildLangPicker($('#langPickSettings'));

  const info = await api.settings();
  state.settings = info.values;
  state.defaults = info.defaults;
  state.userData = info.userData;
  state.keysDir = info.keysDir || '';
  state.version = info.version || '';
  state.lang = state.settings.lang || DEFAULT_LANG;

  await refreshState();
  await refreshPeers();
  await refreshChats();
  await refreshHistory();
  state.finder = await api.finderStatus();

  wireNav();
  wireSend();
  wireReceive();
  wireDevices();
  wireSettings();
  wireMessages();
  wireHistory();

  api.onEvent(handleNodeEvent);
  api.onSendProgress(handleSendProgress);
  api.onHistoryChanged(refreshHistory);
  api.onUpdateProgress(handleUpdateProgress);
  api.onUpdateFound(handleUpdateFound);
  api.onReceiveAsk(handleReceiveAsk);
  api.onOpenView((view) => activateView(view));
  // Dieselbe Verarbeitung wie beim Ziehen und Ablegen (addPaths) - der
  // Hauptprozess hat die Ansicht schon auf "Senden" gestellt, bevor
  // dieses Ereignis kommt (siehe app/main.js, showWindow('send')).
  api.onFilesAdd((paths) => addPaths(paths));

  applyLang();

  // Ob sich die App ueberhaupt selbst ersetzen liesse (Mac, gepackt,
  // beschreibbar) steht schon vor dem ersten Klick auf "Laden" fest -
  // renderUpdate() zeigt den Grund gleich mit an, statt erst beim
  // Fehlschlag.
  state.update.can = await api.updateCan();
  renderUpdate();
}

init().catch((err) => {
  // Ohne Fenster keine Anzeige - immerhin in der Entwicklerkonsole sichtbar.
  console.error('SNAPKEY konnte nicht starten:', err);
});
