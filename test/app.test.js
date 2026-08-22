'use strict';

/* =================================================================
   Die Oberflaeche haengt an Kennungen und an Uebersetzungsschluesseln.

   app.js greift ueber $('#etwas') in die Seite. Ein Tippfehler dort
   wirft keinen Fehler beim Laden - er faellt erst auf, wenn jemand den
   Knopf drueckt und nichts geschieht. Dasselbe gilt fuer data-i18n und
   T('...'): ein Schluessel ohne Eintrag bleibt einfach leer oder zeigt
   sich selbst an.

   Ohne Electron und ohne Browser geprueft, mit Mustern statt mit einem
   DOM - das reicht, um genau diese Fehler zu finden, und laeuft mit
   demselben "node --test" wie der Rest der Pruefungen.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'app', 'renderer');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

const { I18N, LANGS, DEFAULT_LANG, t } = require('../app/renderer/i18n');

/* Alle id="..." der Seite. */
const IDS = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('jede angesprochene Kennung gibt es auch in der Seite', () => {
  // $('#foo') und $('#foo', irgendwo)
  const gesucht = [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]);
  assert.ok(gesucht.length > 20, `nur ${gesucht.length} Kennungen gefunden - Muster kaputt?`);

  const fehlt = [...new Set(gesucht)].filter((id) => !IDS.has(id));
  assert.deepEqual(fehlt, [], `nicht in index.html: ${fehlt.join(', ')}`);
});

test('keine Kennung ist doppelt vergeben', () => {
  // Bei doppelten liefert $ die erste - und die andere Stelle bleibt tot.
  const alle = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const doppelt = alle.filter((id, i) => alle.indexOf(id) !== i);
  assert.deepEqual([...new Set(doppelt)], []);
});

test('jede Beschriftung in der Seite hat eine Uebersetzung', () => {
  const attrs = ['data-i18n', 'data-i18n-ph', 'data-i18n-title'];
  const fehlt = [];
  for (const attr of attrs) {
    for (const m of html.matchAll(new RegExp(`\\b${attr}="([^"]+)"`, 'g'))) {
      if (I18N.en[m[1]] === undefined) fehlt.push(`${attr}="${m[1]}"`);
    }
  }
  assert.deepEqual(fehlt, [], `ohne Text: ${fehlt.join(', ')}`);
});

test('jeder Schluessel, den app.js ueber T(...) benutzt, ist eingetragen', () => {
  // T('foo.bar') greift auf die Tabelle zu; fehlt der Schluessel, steht
  // er dem Benutzer roh auf dem Bildschirm.
  const keys = [...js.matchAll(/\bT\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 30, `nur ${keys.length} Schluessel gefunden - Muster kaputt?`);

  const fehlt = [...new Set(keys)].filter((k) => I18N.en[k] === undefined);
  assert.deepEqual(fehlt, [], `nicht in i18n.js: ${fehlt.join(', ')}`);
});

test('die Seite laedt alle Skripte, die sie braucht', () => {
  for (const datei of ['i18n.js', 'app.js']) {
    assert.ok(html.includes(`src="${datei}"`), `${datei} wird nicht geladen`);
    assert.ok(fs.existsSync(path.join(dir, datei)), `${datei} fehlt auf der Platte`);
  }
});

test('die uebernommene Formsprache liegt da', () => {
  assert.ok(fs.existsSync(path.join(dir, 'styles.css')), 'styles.css fehlt');
  const fonts = ['archivo-latin.woff2', 'archivo-latin-ext.woff2', 'martianmono-latin.woff2', 'martianmono-latin-ext.woff2'];
  for (const f of fonts) {
    assert.ok(fs.existsSync(path.join(dir, 'fonts', f)), `Schriftdatei fehlt: ${f}`);
  }

  const assets = path.join(__dirname, '..', 'app', 'assets');
  assert.ok(fs.existsSync(path.join(assets, 'icon.png')), 'icon.png fehlt');
  assert.ok(fs.existsSync(path.join(assets, 'crocTemplate.png')), 'crocTemplate.png fehlt');
});

/* --------------------------- Sprachtabellen --------------------------- */

const SPRACHEN = LANGS.map((l) => l.code);
const platzhalter = (text) => [...String(text).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

test('Englisch ist die Vorgabe und ausreichend gefuellt', () => {
  assert.equal(DEFAULT_LANG, 'en');
  assert.ok(Object.keys(I18N.en).length > 60);
});

test('jede angebotene Sprache hat auch eine Tabelle', () => {
  for (const code of SPRACHEN) assert.ok(I18N[code], `keine Tabelle fuer ${code}`);
  assert.deepEqual(Object.keys(I18N).sort(), [...SPRACHEN].sort());
});

test('keine Sprache hat Luecken', () => {
  const erwartet = Object.keys(I18N.en);
  for (const code of SPRACHEN) {
    const fehlt = erwartet.filter((k) => I18N[code][k] === undefined);
    assert.deepEqual(fehlt, [], `${code} fehlt: ${fehlt.slice(0, 10).join(', ')}`);
  }
});

test('keine Sprache hat Ueberzaehliges', () => {
  // Ein Schluessel, den nur eine Sprache kennt, ist meist ein Tippfehler
  // oder ein Rest, den beim Umbenennen niemand mitgenommen hat.
  for (const code of SPRACHEN) {
    const zuviel = Object.keys(I18N[code]).filter((k) => I18N.en[k] === undefined);
    assert.deepEqual(zuviel, [], `${code} kennt zusaetzlich: ${zuviel.slice(0, 10).join(', ')}`);
  }
});

test('Platzhalter bleiben ueber alle Sprachen hinweg erhalten', () => {
  for (const key of Object.keys(I18N.en)) {
    const soll = platzhalter(I18N.en[key]);
    for (const code of SPRACHEN) {
      assert.equal(platzhalter(I18N[code][key]), soll, `${code}.${key}`);
    }
  }
});

test('keine leeren Texte', () => {
  for (const code of SPRACHEN) {
    for (const [key, wert] of Object.entries(I18N[code])) {
      assert.ok(String(wert).trim().length > 0, `${code}.${key} ist leer`);
    }
  }
});

test('Deutsch benutzt echte Umlaute, keine Umschreibung', () => {
  const text = Object.values(I18N.de).join(' ');
  assert.ok(/[äöüßÄÖÜ]/.test(text), 'kein einziger Umlaut im deutschen Text');
});

test('t() liefert Text, nicht den nackten Schluessel', async (sub) => {
  const key = Object.keys(I18N.en)[0];

  await sub.test('in jeder Sprache', () => {
    for (const code of SPRACHEN) assert.equal(t(code, key), I18N[code][key]);
  });

  await sub.test('unbekannte Sprache faellt aufs Englische zurueck', () => {
    assert.equal(t('kl', key), I18N.en[key]);
  });

  await sub.test('unbekannter Schluessel gibt sich selbst zurueck', () => {
    assert.equal(t('de', 'gibt.es.nicht'), 'gibt.es.nicht');
  });

  await sub.test('Werte werden eingesetzt', () => {
    const mit = Object.keys(I18N.en).find((k) => /\{0\}/.test(I18N.en[k]));
    assert.ok(mit, 'kein Text mit Platzhalter gefunden');
    assert.ok(!t('en', mit, 'XYZ').includes('{0}'));
    assert.ok(t('en', mit, 'XYZ').includes('XYZ'));
  });
});

/* ------------------------------- main.js ------------------------------- */

test('main.js spricht genau die vereinbarten IPC-Kanaele an', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const erwartet = [
    'node:state', 'node:peers', 'node:settings', 'node:setSetting',
    'node:send', 'node:pair', 'node:forget',
    'dialog:pickFiles', 'dialog:pickFolder', 'fs:stat', 'clipboard:write', 'shell:reveal'
  ];
  for (const kanal of erwartet) {
    assert.ok(main.includes(`'${kanal}'`), `Kanal fehlt in main.js: ${kanal}`);
  }
});

test('preload.js baut keine Bruecke zu Node - nur zu ipcRenderer', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
  assert.ok(preload.includes('contextBridge.exposeInMainWorld'));
  assert.ok(!/require\('fs'\)|require\("fs"\)/.test(preload), 'preload.js sollte kein fs direkt anfassen');
});
