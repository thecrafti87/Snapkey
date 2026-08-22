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
  sendRunning: false,
  currentSendJob: null
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

function renderDevices() {
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

function jobEl(job) {
  const card = el('div', 'job');
  card.dataset.state = job.state;
  card.dataset.kind = job.kind === 'refused' ? 'receive' : job.kind;

  const top = el('div', 'job__top');
  top.append(el('span', 'job__name', job.title || job.id));
  const stateKey = job.state === 'running' ? 'job.stateRunning' : (job.state === 'done' ? 'job.stateDone' : 'job.stateFailed');
  top.append(el('span', 'job__state', T(stateKey)));
  card.append(top);

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
      read.append(el('span', null, `${bytes(gezeigt)} / ${bytes(job.totalBytes)}`));
    }
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

function renderJobs() {
  const alle = [...state.jobs.values()].sort((a, b) => b.ts - a.ts);

  const sendBox = $('#sendJobs');
  sendBox.textContent = '';
  alle.filter((j) => j.kind === 'send').forEach((j) => sendBox.append(jobEl(j)));

  const recvBox = $('#recvJobs');
  recvBox.textContent = '';
  const recvJobs = alle.filter((j) => j.kind === 'receive' || j.kind === 'refused');
  recvJobs.forEach((j) => recvBox.append(jobEl(j)));
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

  $('#recvOutDir').value = state.outDir || '';
  $('#recvTrustNew').checked = Boolean(s.trustNew);

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
}

async function setSetting(patch) {
  state.settings = await api.setSetting(patch);
  await refreshState();
  await refreshPeers();
  renderSettingsForm();
  renderSettingsNotes();
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
  renderFileList();
  renderJobs();
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
      refreshPeers();
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
      refreshPeers();
      merkeEingang();
      break;
    }

    case 'refused': {
      const bestehend = state.jobs.get(e.from);
      if (bestehend && bestehend.kind === 'receive' && bestehend.state === 'running') {
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
  const job = state.currentSendJob;
  if (!job) return;
  switch (e.type) {
    case 'route': job.route = e.route; break;
    case 'offered': job.totalBytes = e.bytes; job.totalFiles = e.files; break;
    case 'plan': job.planTotal = e.total; job.planSend = e.send; break;
    case 'sent':
      job.doneBlocks = e.done;
      job.doneBytes = (job.doneBytes || 0) + e.bytes;
      break;
    default: break;
  }
  renderJobs();
}

/* ---------------------------------- Senden --------------------------------- */

async function onSendStart() {
  if (state.sendRunning) return;
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

  state.sendRunning = true;
  $('#sendStart').disabled = true;

  const id = `send-${Date.now()}`;
  const job = { id, kind: 'send', state: 'running', title, ts: Date.now(), doneBytes: 0 };
  state.jobs.set(id, job);
  state.currentSendJob = job;
  renderJobs();

  const paths = state.files.map((f) => f.path);

  try {
    const res = await api.send(ziel, paths);
    job.state = res.ok ? 'done' : 'failed';
    job.resultSent = res.sent;
    job.route = res.route || job.route;
    if (!res.ok) job.error = res.message || (res.missing && T('job.missing', res.missing.join(', ')));
  } catch (err) {
    job.state = 'failed';
    job.error = err.message;
  } finally {
    state.currentSendJob = null;
    state.sendRunning = false;
    $('#sendStart').disabled = false;
    renderJobs();
  }
}

/* --------------------------------- Verdrahtung -------------------------------- */

/** Markiert die Leiste, wenn man beim Eingang gerade woanders steht. */
function merkeEingang() {
  const knopf = $$('.rail__item').find((b) => b.dataset.view === 'receive');
  if (knopf && !knopf.classList.contains('is-active')) knopf.classList.add('has-watch');
}

function wireNav() {
  $$('.rail__item').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.rail__item').forEach((b) => b.classList.toggle('is-active', b === btn));
      $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${btn.dataset.view}`));
      // Wer hinsieht, hat es gesehen.
      btn.classList.remove('has-watch');
    });
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
}

function wireDevices() {
  $('#deviceList').addEventListener('click', async (ev) => {
    const pairBtn = ev.target.closest('[data-pair]');
    const forgetBtn = ev.target.closest('[data-forget]');
    const copyBtn = ev.target.closest('[data-copy]');

    if (pairBtn) {
      state.peers = await api.pair(pairBtn.dataset.pair);
      renderDevices();
      renderDeviceSelect();
    } else if (forgetBtn) {
      state.peers = await api.forget(forgetBtn.dataset.forget);
      renderDevices();
      renderDeviceSelect();
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

  wireNav();
  wireSend();
  wireReceive();
  wireDevices();
  wireSettings();

  api.onEvent(handleNodeEvent);
  api.onSendProgress(handleSendProgress);

  applyLang();
}

init().catch((err) => {
  // Ohne Fenster keine Anzeige - immerhin in der Entwicklerkonsole sichtbar.
  console.error('SNAPKEY konnte nicht starten:', err);
});
