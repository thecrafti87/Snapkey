'use strict';

/* =================================================================
   Was ein Geraet ueber sich und andere behaelt - und nicht verliert.

   Zwei Dinge stehen hier auf dem Spiel, und beide wiegen schwer:

   Die eigene Kennung ist alles, worauf sich Kopplungen stuetzen. Eine
   neue macht jede bestehende wertlos, und die Gegenstellen sehen ein
   fremdes Geraet. Sie darf deshalb nie stillschweigend wechseln.

   Und die Liste der Gegenstellen darf nicht verschwinden, nur weil
   SNAPKEY zweimal laeuft - zwei Fenster, oder das Fenster und die
   Kommandozeile. Genau das ist passiert: wer als Zweiter koppelte,
   schrieb seine veraltete Liste ueber die des Ersten.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/node/store');
const identity = require('../src/core/identity');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const namen = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'peers.json'), 'utf8')).map((p) => p.name);

/* ---------------------------- Die Kennung ---------------------------- */

test('dieselbe Kennung ueberlebt jedes erneute Oeffnen', (t) => {
  const dir = tempdir(t);

  const erst = store.open(dir).me.address;
  assert.equal(store.open(dir).me.address, erst);
  assert.equal(store.open(dir).me.address, erst, 'die Anschrift wechselt beim Oeffnen');
});

test('beim ersten Start wird eine Kennung angelegt - ohne Aufhebens', (t) => {
  const dir = tempdir(t);

  const gemeldet = [];
  const box = store.open(dir, { onEvent: (e) => gemeldet.push(e) });

  assert.ok(box.me.address, 'keine Kennung angelegt');
  assert.deepEqual(gemeldet, [], 'der erste Start ist kein Vorfall und soll nichts melden');
});

test('eine unlesbare Kennung wird gemeldet und beiseitegelegt, nicht ueberschrieben', (t) => {
  const dir = tempdir(t);
  const datei = path.join(dir, 'identity.json');

  const vorher = store.open(dir).me.address;
  const echterInhalt = fs.readFileSync(datei, 'utf8');

  // So sieht es aus, wenn beim Schreiben etwas dazwischenkam.
  fs.writeFileSync(datei, '{ das ist kein JSON');

  const gemeldet = [];
  const box = store.open(dir, { onEvent: (e) => gemeldet.push(e) });

  assert.notEqual(box.me.address, vorher, 'aus Unlesbarem laesst sich keine Kennung machen');

  const meldung = gemeldet.find((e) => e.type === 'identity');
  assert.ok(meldung, 'der Verlust der Kennung wurde verschwiegen');
  assert.equal(meldung.state, 'verloren');

  // Das Entscheidende: das Kaputte ist noch da. Waere es ueberschrieben
  // worden, waere der alte Schluessel endgueltig weg - und mit ihm jede
  // Aussicht, ihn von Hand zu retten.
  const beiseite = fs.readdirSync(dir).filter((n) => n.startsWith('identity-unlesbar-'));
  assert.equal(beiseite.length, 1, 'die unlesbare Datei wurde nicht beiseitegelegt');

  assert.ok(fs.existsSync(datei), 'es wurde keine neue Kennung geschrieben');
  assert.notEqual(fs.readFileSync(datei, 'utf8'), echterInhalt);
});

/* -------------------------- Die Gegenstellen -------------------------- */

test('zwei Zugriffe auf denselben Ordner loeschen einander die Kopplungen nicht', (t) => {
  const dir = tempdir(t);

  // Zwei Fenster, oder das Fenster und die Kommandozeile: jedes kennt
  // beim Start nur den Stand von diesem Augenblick.
  const eins = store.open(dir);
  const zwei = store.open(dir);

  const x = identity.create();
  const y = identity.create();

  eins.peers.remember(x.address, x.pub, 'Gerät X');
  zwei.peers.remember(y.address, y.pub, 'Gerät Y');

  assert.deepEqual(namen(dir).sort(), ['Gerät X', 'Gerät Y'],
    'der Zweite hat die Kopplung des Ersten ueberschrieben');
});

test('Vergessen holt die Kopplungen der anderen nicht zurueck', (t) => {
  const dir = tempdir(t);
  const eins = store.open(dir);
  const zwei = store.open(dir);

  const x = identity.create();
  const y = identity.create();
  eins.peers.remember(x.address, x.pub, 'Gerät X');
  zwei.peers.remember(y.address, y.pub, 'Gerät Y');

  zwei.peers.forget(y.address);

  // Nur Y ist weg. X bleibt - und kommt nicht als Nebenwirkung des
  // Zusammenfuehrens wieder hoch.
  assert.deepEqual(namen(dir), ['Gerät X']);
});

test('das "seit"-Datum bleibt stehen, auch wenn ein anderer daneben schreibt', (t) => {
  const dir = tempdir(t);
  const eins = store.open(dir);
  const zwei = store.open(dir);

  const x = identity.create();
  eins.peers.remember(x.address, x.pub, 'Gerät X');
  const seit = JSON.parse(fs.readFileSync(path.join(dir, 'peers.json'), 'utf8'))[0].since;

  const y = identity.create();
  zwei.peers.remember(y.address, y.pub, 'Gerät Y');

  const jetzt = JSON.parse(fs.readFileSync(path.join(dir, 'peers.json'), 'utf8'));
  assert.equal(jetzt.find((p) => p.address === x.address).since, seit,
    'das Datum von X wurde beim Zusammenfuehren neu gesetzt');
});

test('ein anderer Schluessel unter bekannter Anschrift wird gemeldet, nicht uebernommen', (t) => {
  const dir = tempdir(t);
  const box = store.open(dir);

  const echt = identity.create();
  box.peers.remember(echt.address, echt.pub, 'Gerät X');

  // Dieselbe Anschrift behauptet, anderer Schluessel: das ist der
  // Verdachtsfall, ueber den ein Mensch entscheidet.
  const fremd = identity.create();
  const res = box.peers.remember(echt.address, fremd.pub, 'Gerät X');

  assert.equal(res.status, 'changed');
  assert.ok(Buffer.from(box.peers.get(echt.address).pub).equals(echt.pub),
    'der fremde Schluessel wurde einfach uebernommen');

  // Und der Ausweg, wenn dort wirklich neu installiert wurde.
  box.peers.replace(echt.address, fremd.pub, 'Gerät X');
  assert.ok(Buffer.from(box.peers.get(echt.address).pub).equals(fremd.pub));
});
