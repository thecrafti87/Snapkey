'use strict';

/* =================================================================
   Die Nagelprobe fuer Stufe 0.

   Ein Ordner wandert von A nach B, ein Abbruch mittendrin wird
   ueberlebt, und der zweite Anlauf holt nur den Rest. Alles ohne Netz -
   zwei Endpunkte im Speicher, kein Port, keine Wartezeit.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/core/session');
const chunks = require('../src/core/chunks');
const identity = require('../src/core/identity');
const memory = require('../src/transport/memory');

/* ----------------------------- Aufbau ----------------------------- */

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiman-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Ein Ordner mit Inhalt, der ueber mehrere Bloecke geht. Die Daten sind
 * gewuerfelt, damit ein zufaellig richtiger Block ausgeschlossen ist -
 * und aus festem Samen, damit ein Fehlschlag wiederholbar bleibt.
 */
function quelle(dir) {
  const root = path.join(dir, 'quelle', 'daten');
  fs.mkdirSync(path.join(root, 'unter'), { recursive: true });

  const wuerfel = (n, samen) => {
    const out = Buffer.allocUnsafe(n);
    let h = crypto.createHash('sha256').update(samen).digest();
    for (let at = 0; at < n; at += 32) {
      h = crypto.createHash('sha256').update(h).digest();
      h.copy(out, at, 0, Math.min(32, n - at));
    }
    return out;
  };

  fs.writeFileSync(path.join(root, 'a-gross.bin'), wuerfel(2.5 * 1024 * 1024, 'a'));
  fs.writeFileSync(path.join(root, 'b-mittel.bin'), wuerfel(1.2 * 1024 * 1024, 'b'));
  fs.writeFileSync(path.join(root, 'c-klein.txt'), 'oben, klein, ein einziger Block');
  fs.writeFileSync(path.join(root, 'unter', 'd-tief.bin'), wuerfel(700 * 1024, 'd'));
  fs.writeFileSync(path.join(root, 'unter', 'e-leer.txt'), '');
  return root;
}

const ERWARTET = [
  'daten/a-gross.bin', 'daten/b-mittel.bin', 'daten/c-klein.txt',
  'daten/unter/d-tief.bin', 'daten/unter/e-leer.txt'
];

/** Ein Durchlauf. Gibt zurueck, was beide Seiten am Ende sagen. */
async function lauf(root, ziel, {
  sender, empfaenger, gekoppelt = true, cutAfter = Infinity, sliceSize = 0, dedup = true
} = {}) {
  const leitung = memory.pair({ cutAfter, sliceSize });
  const files = chunks.scan([root]);

  const senden = session.send(leitung.a, {
    identity: sender,
    expect: gekoppelt ? empfaenger.pub : null,
    files
  });
  const empfangen = session.receive(leitung.b, {
    identity: empfaenger,
    expect: gekoppelt ? sender.pub : null,
    dir: ziel,
    dedup
  });

  const [s, e] = await Promise.allSettled([senden, empfangen]);
  return { s, e, leitung };
}

const heil = (ziel, root) => ERWARTET.every((rel) => {
  const hier = path.join(ziel, ...rel.split('/'));
  const dort = path.join(path.dirname(root), ...rel.split('/'));
  try {
    return fs.readFileSync(hier).equals(fs.readFileSync(dort));
  } catch {
    return false;
  }
});

/* ---------------------------- Pruefungen ---------------------------- */

test('ein Ordner wandert von A nach B', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();

  const { s, e } = await lauf(root, ziel, { sender, empfaenger });

  assert.equal(s.status, 'fulfilled', s.reason && s.reason.message);
  assert.equal(e.status, 'fulfilled', e.reason && e.reason.message);
  assert.equal(e.value.ok, true);
  assert.deepEqual(e.value.missing, []);
  assert.ok(heil(ziel, root), 'Inhalte stimmen nicht überein');

  await t.test('auch die leere Datei ist da', () => {
    assert.equal(fs.statSync(path.join(ziel, 'daten', 'unter', 'e-leer.txt')).size, 0);
  });

  await t.test('die Unterordner bleiben erhalten', () => {
    // Genau das, woran croc scheitert: dort kaeme "d-tief.bin" flach an.
    assert.ok(fs.existsSync(path.join(ziel, 'daten', 'unter', 'd-tief.bin')));
  });
});

test('in Stuecken zugestellt kommt dasselbe an', async (t) => {
  // Draussen kommt ein Paket in drei Teilen an oder drei in einem.
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const { s, e } = await lauf(root, ziel, {
    sender: identity.create(), empfaenger: identity.create(), sliceSize: 1337
  });

  assert.equal(s.status, 'fulfilled', s.reason && s.reason.message);
  assert.equal(e.value.ok, true);
  assert.ok(heil(ziel, root));
});

test('abgebrochen und fortgesetzt: der zweite Anlauf holt nur den Rest', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();

  // --- Erster Anlauf, mittendrin gekappt ---
  const erst = await lauf(root, ziel, { sender, empfaenger, cutAfter: 1_500_000 });
  assert.equal(erst.s.status, 'rejected', 'der Abbruch blieb unbemerkt');
  assert.equal(erst.e.status, 'rejected');
  assert.ok(erst.leitung.broken);

  const angefangen = chunks.scan([ziel]).reduce((n, f) => n + f.size, 0);
  assert.ok(angefangen > 0, 'es kam gar nichts an - der Schnitt lag zu früh');
  assert.ok(!heil(ziel, root), 'es kam schon alles an - der Schnitt lag zu spät');

  // --- Zweiter Anlauf, frische Leitung, derselbe Zielordner ---
  const zweit = await lauf(root, ziel, { sender, empfaenger });

  assert.equal(zweit.s.status, 'fulfilled', zweit.s.reason && zweit.s.reason.message);
  assert.equal(zweit.e.value.ok, true);
  assert.ok(heil(ziel, root), 'nach dem zweiten Anlauf stimmt der Inhalt nicht');

  await t.test('es wurde weniger geschickt als beim ersten Mal', () => {
    const alle = chunks.totalChunks(chunks.buildManifest(chunks.scan([root])));
    assert.ok(zweit.s.value.sent < alle,
      `es wurden wieder alle ${alle} Blöcke geschickt - nichts fortgesetzt`);
    assert.ok(zweit.e.value.had > 0, 'der Empfänger hat nichts wiederverwendet');
  });
});

test('was schon vollstaendig daliegt, wird nicht noch einmal geschickt', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();

  await lauf(root, ziel, { sender, empfaenger });
  const nochmal = await lauf(root, ziel, { sender, empfaenger });

  assert.equal(nochmal.s.value.sent, 0, 'es wurde erneut etwas übertragen');
  assert.equal(nochmal.e.value.ok, true);
});

test('eine kaputte Datei im Zielordner wird ersetzt, nicht uebersehen', async (t) => {
  // Der Fall, an dem croc gescheitert ist: richtige Groesse, Nullen
  // darin. Groesse und Zeitstempel halten das fuer heil.
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();
  await lauf(root, ziel, { sender, empfaenger });

  const opfer = path.join(ziel, 'daten', 'b-mittel.bin');
  const groesse = fs.statSync(opfer).size;
  fs.writeFileSync(opfer, Buffer.alloc(groesse, 0));

  const reparatur = await lauf(root, ziel, { sender, empfaenger });
  assert.ok(reparatur.s.value.sent > 0, 'die Nullen wurden für heil gehalten');
  assert.equal(reparatur.e.value.ok, true);
  assert.ok(heil(ziel, root));
});

test('eine umbenannte Datei beim Empfaenger muss nicht erneut geschickt werden', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();

  await lauf(root, ziel, { sender, empfaenger });
  assert.ok(heil(ziel, root), 'der erste Durchlauf muss schon vollstaendig sein');

  // Der Inhalt bleibt exakt derselbe - nur der Name aendert sich.
  fs.renameSync(path.join(ziel, 'daten', 'a-gross.bin'), path.join(ziel, 'daten', 'a-umbenannt.bin'));

  const zweiter = await lauf(root, ziel, { sender, empfaenger });

  assert.equal(zweiter.s.status, 'fulfilled', zweiter.s.reason && zweiter.s.reason.message);
  assert.equal(zweiter.e.status, 'fulfilled', zweiter.e.reason && zweiter.e.reason.message);
  assert.equal(zweiter.s.value.sent, 0, 'trotz Umbenennen wurde wieder etwas über die Leitung geschickt');
  assert.ok(zweiter.e.value.recovered > 0, 'der Empfänger hat nichts lokal wiederhergestellt');
  assert.equal(zweiter.e.value.ok, true);
  assert.ok(heil(ziel, root), 'nach dem Wiederherstellen stimmt der Inhalt nicht mehr');

  await t.test('mit dedup: false bleibt es beim alten Verhalten - es wird uebertragen', async () => {
    const ziel2 = path.join(dir, 'ziel2');
    await lauf(root, ziel2, { sender, empfaenger });
    fs.renameSync(path.join(ziel2, 'daten', 'a-gross.bin'), path.join(ziel2, 'daten', 'a-umbenannt.bin'));

    const ohne = await lauf(root, ziel2, { sender, empfaenger, dedup: false });

    assert.equal(ohne.e.value.recovered, 0, 'ohne dedup haette nichts wiederhergestellt werden duerfen');
    assert.ok(ohne.s.value.sent > 0, 'ohne dedup haette wieder uebertragen werden muessen');
    assert.equal(ohne.e.value.ok, true);
    assert.ok(heil(ziel2, root));
  });
});

test('wer den falschen Schluessel hat, kommt nicht durch', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();
  const fremder = identity.create();

  // Der Empfaenger erwartet den Sender - es meldet sich ein anderer.
  const leitung = memory.pair();
  const files = chunks.scan([root]);

  const senden = session.send(leitung.a, { identity: fremder, expect: empfaenger.pub, files });
  const empfangen = session.receive(leitung.b, { identity: empfaenger, expect: sender.pub, dir: ziel });

  const [, e] = await Promise.allSettled([senden, empfangen]);
  assert.equal(e.status, 'rejected');
  assert.match(e.reason.message, /anderen Schlüssel/);
  assert.equal(fs.existsSync(path.join(ziel, 'daten')), false, 'es wurde trotzdem geschrieben');
});

test('beim ersten Kontakt wird der Schluessel gelernt und gemeldet', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const sender = identity.create();
  const empfaenger = identity.create();

  const { s, e } = await lauf(root, ziel, { sender, empfaenger, gekoppelt: false });

  assert.equal(s.value.peer.firstContact, true);
  assert.equal(e.value.peer.firstContact, true);
  // Beide haben genau den Schluessel der Gegenseite vor sich.
  assert.ok(Buffer.from(s.value.peer.pub).equals(empfaenger.pub));
  assert.ok(Buffer.from(e.value.peer.pub).equals(sender.pub));
});
