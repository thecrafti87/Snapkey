'use strict';

/* =================================================================
   Der Verlauf abgeschlossener Uebertragungen (app/history.js).

   Anders als der Rest der Pruefungen hier: kein Kern-Modul, sondern
   die Huelle - trotzdem mit demselben Anspruch wie src/node/messages.js,
   dem es nachempfunden ist. Besonders wichtig: es darf nie mehr in der
   Datei landen, als ausdruecklich erlaubt ist - kein Schluessel, kein
   Nachrichtentext.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const historyMod = require('../app/history');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ---------------------------------------------------------------- */

test('ein Eintrag bekommt id und Zeitstempel, und liegt danach in list()', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);

  const nachAdd = h.add({ kind: 'send', peer: 'wal-tanne', ok: true, files: 2, bytes: 1234 });
  assert.equal(nachAdd.length, 1);
  assert.equal(typeof nachAdd[0].id, 'string');
  assert.ok(nachAdd[0].id.length > 0);
  assert.equal(typeof nachAdd[0].at, 'string');
  assert.ok(!Number.isNaN(Date.parse(nachAdd[0].at)), 'at ist kein lesbarer Zeitstempel');

  const liste = h.list();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].kind, 'send');
  assert.equal(liste[0].peer, 'wal-tanne');
  assert.equal(liste[0].files, 2);
  assert.equal(liste[0].bytes, 1234);
});

test('list() liefert neueste zuerst', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);

  h.add({ kind: 'send', peer: 'erste' });
  h.add({ kind: 'send', peer: 'zweite' });
  h.add({ kind: 'receive', peer: 'dritte' });

  const liste = h.list();
  assert.deepEqual(liste.map((e) => e.peer), ['dritte', 'zweite', 'erste']);
});

test('hoechstens 200 Eintraege - die aeltesten fallen heraus', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);

  assert.equal(historyMod.MAX_ENTRIES, 200);

  for (let i = 0; i < 205; i++) h.add({ kind: 'send', peer: `nr-${i}` });

  const liste = h.list();
  assert.equal(liste.length, 200);
  // Neueste zuerst: der letzte hinzugefuegte (nr-204) steht vorn, die
  // ersten fuenf (nr-0 .. nr-4) sind rausgefallen.
  assert.equal(liste[0].peer, 'nr-204');
  assert.equal(liste[liste.length - 1].peer, 'nr-5');
  assert.ok(!liste.some((e) => e.peer === 'nr-4'), 'nr-4 haette schon herausfallen muessen');
});

test('clear() leert den Verlauf, list() bleibt danach leer', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);

  h.add({ kind: 'send', peer: 'a' });
  h.add({ kind: 'receive', peer: 'b' });
  assert.equal(h.list().length, 2);

  const nachClear = h.clear();
  assert.deepEqual(nachClear, []);
  assert.deepEqual(h.list(), []);

  // Auch nach einem Neuoeffnen bleibt es leer - clear() hat wirklich
  // gesichert, nicht nur den Speicher geleert.
  const h2 = historyMod.open(dir);
  assert.deepEqual(h2.list(), []);
});

test('history.json bekommt die Rechte 0600', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);
  h.add({ kind: 'send', peer: 'irgendwer' });

  const datei = path.join(dir, 'history.json');
  assert.ok(fs.existsSync(datei), 'history.json wurde nicht angelegt');

  const modus = fs.statSync(datei).mode & 0o777;
  assert.equal(modus, 0o600, `Rechte sind ${modus.toString(8)}, erwartet 600`);
});

test('kaputter Inhalt (kein JSON) fuehrt nicht zum Absturz - open() faengt ihn ab', (t) => {
  const dir = tempdir(t);
  const datei = path.join(dir, 'history.json');
  fs.writeFileSync(datei, 'kein JSON, nur Muell{{{', { mode: 0o600 });

  assert.doesNotThrow(() => {
    const h = historyMod.open(dir);
    assert.deepEqual(h.list(), []);
  });
});

test('eine wirklich unlesbare Datei (Rechte 000) fuehrt ebenfalls nicht zum Absturz', (t) => {
  // Als root wuerden Dateirechte beim Lesen ignoriert - dann liesse
  // sich dieser Fall hier gar nicht herstellen, und die Pruefung waere
  // ein Blindgaenger statt einer echten Aussage.
  if (process.getuid && process.getuid() === 0) {
    t.skip('laeuft als root - Dateirechte greifen dort nicht');
    return;
  }

  const dir = tempdir(t);
  const datei = path.join(dir, 'history.json');
  fs.writeFileSync(datei, JSON.stringify([{ id: 'x', at: new Date().toISOString(), kind: 'send', peer: 'a' }]));
  fs.chmodSync(datei, 0o000);
  t.after(() => { try { fs.chmodSync(datei, 0o600); } catch { /* schon aufgeraeumt */ } });

  assert.doesNotThrow(() => {
    const h = historyMod.open(dir);
    assert.deepEqual(h.list(), []);
  });
});

test('eine Datei mit fremdartigem Inhalt (kein Array) wird verworfen, nicht interpretiert', (t) => {
  const dir = tempdir(t);
  const datei = path.join(dir, 'history.json');
  fs.writeFileSync(datei, JSON.stringify({ nicht: 'ein array' }), { mode: 0o600 });

  const h = historyMod.open(dir);
  assert.deepEqual(h.list(), []);
});

test('nur die erlaubten Felder landen in der Datei - kein Schluessel, kein Nachrichtentext', (t) => {
  const dir = tempdir(t);
  const h = historyMod.open(dir);

  h.add({
    kind: 'send',
    peer: 'wal-tanne-nordwind',
    name: 'Arbeitszimmer',
    files: 3,
    bytes: 9000,
    ok: true,
    route: 'lan',
    sent: 3,
    outDir: '/tmp/irgendwo',
    paths: ['/tmp/a.txt'],
    // Das hier darf NIE in der Datei landen - weder Schluessel noch
    // Nachrichtentext gehoeren in den Verlauf.
    text: 'geheime Nachricht, die keinen Uebertragungs-Verlauf betrifft',
    priv: 'ANGEBLICH-EIN-GEHEIMER-SCHLUESSEL',
    pub: 'ANGEBLICH-EIN-OEFFENTLICHER-SCHLUESSEL',
    token: 'irgendwas-vertrauliches'
  });

  const datei = path.join(dir, 'history.json');
  const roh = fs.readFileSync(datei, 'utf8');

  assert.ok(!roh.includes('geheime Nachricht'), 'ein Nachrichtentext ist in der Datei gelandet');
  assert.ok(!roh.includes('ANGEBLICH-EIN-GEHEIMER-SCHLUESSEL'), 'ein Schluessel ist in der Datei gelandet');
  assert.ok(!roh.includes('ANGEBLICH-EIN-OEFFENTLICHER-SCHLUESSEL'), 'ein Schluessel ist in der Datei gelandet');
  assert.ok(!roh.includes('irgendwas-vertrauliches'), 'ein Token ist in der Datei gelandet');

  const eintrag = JSON.parse(roh)[0];
  const erlaubteZusatzfelder = [
    'id', 'at', 'kind', 'peer', 'name', 'files', 'bytes', 'ok', 'route',
    'sent', 'had', 'recovered', 'outDir', 'paths', 'error'
  ];
  for (const feld of Object.keys(eintrag)) {
    assert.ok(erlaubteZusatzfelder.includes(feld), `unerwartetes Feld im Verlauf: ${feld}`);
  }
  assert.equal(eintrag.text, undefined);
  assert.equal(eintrag.priv, undefined);
  assert.equal(eintrag.pub, undefined);
  assert.equal(eintrag.token, undefined);
});

test('dasselbe gilt beim erneuten Einlesen einer von Hand veraenderten Datei', (t) => {
  const dir = tempdir(t);
  const datei = path.join(dir, 'history.json');
  fs.writeFileSync(datei, JSON.stringify([
    { id: 'x1', at: new Date().toISOString(), kind: 'send', peer: 'a', priv: 'sollte-verschwinden' }
  ]), { mode: 0o600 });

  const h = historyMod.open(dir);
  const liste = h.list();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].priv, undefined);
  assert.equal(liste[0].peer, 'a');
});
