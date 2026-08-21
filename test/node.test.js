'use strict';

/* =================================================================
   Ein Knoten, ganz fuer sich - ohne Geraetesuche.

   Die Geraetesuche ist in discovery.test.js schon geprueft, deshalb
   laufen alle Knoten hier mit `announce: false` und werden direkt ueber
   `{ host, port }` verbunden. Es geht um die Torkontrolle: wer reinkommt,
   wer draussen bleibt, und was auf der Platte sicher liegt.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const identity = require('../src/core/identity');
const nodeMod = require('../src/node/node');
const store = require('../src/node/store');

/* ----------------------------- Aufbau ----------------------------- */

function tempdir(t, praefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kaiman-${praefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Legt eine Quelldatei mit etwas Inhalt an und gibt den Pfad zurueck. */
function quelldatei(dir, name, text) {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, text);
  return abs;
}

/**
 * Startet einen Knoten ohne Geraetesuche, mit eigenem Wegwerf-Ordner
 * fuer Schluessel und Ziel. `t.after` raeumt Knoten und Ordner auf.
 */
async function knoten(t, { trustNew = false, home = null } = {}) {
  const heim = home || tempdir(t, 'home');
  const ziel = tempdir(t, 'ziel');
  const ereignisse = [];

  const n = await nodeMod.open({
    home: heim,
    outDir: ziel,
    port: 0,
    trustNew,
    announce: false,
    onEvent: (e) => ereignisse.push(e)
  });

  t.after(() => n.close());
  return { n, heim, ziel, ereignisse };
}

/* ---------------------------- Pruefungen ---------------------------- */

test('eine unbekannte Gegenstelle wird abgewiesen', async (t) => {
  const empfaenger = await knoten(t, { trustNew: false });
  const sender = await knoten(t);

  const datei = quelldatei(tempdir(t, 'quelle'), 'brief.txt', 'ein Brief an jemand Unbekanntes');

  await assert.rejects(
    () => sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [datei]),
    'sendTo haette scheitern muessen'
  );

  assert.deepEqual(fs.readdirSync(empfaenger.ziel), [], 'im Zielordner liegt trotzdem etwas');

  const abgewiesen = empfaenger.ereignisse.find((e) => e.type === 'refused');
  assert.ok(abgewiesen, 'der Empfänger hat keine "refused"-Meldung gebracht');
  assert.equal(abgewiesen.code, 'UNKNOWN_PEER');
});

test('der Sender erfaehrt den echten Grund der Abweisung', async (t) => {
  // Der Empfaenger schickt seinen Abbruchgrund jetzt mit, bevor er
  // auflegt - der Sender soll mehr sehen als nur einen Verbindungsabriss.
  const empfaenger = await knoten(t, { trustNew: false });
  const sender = await knoten(t);

  const datei = quelldatei(tempdir(t, 'quelle'), 'brief.txt', 'noch ein Brief an jemand Unbekanntes');

  await assert.rejects(
    () => sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [datei]),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_PEER');
      assert.match(err.message, /--neue-annehmen/);
      return true;
    }
  );
});

test('der Sender merkt sich die Gegenstelle auch ohne Vorwissen', async (t) => {
  // Verbunden wird ueber ein blosses { host, port } - ohne vorher eine
  // Anschrift oder einen Schluessel der Gegenstelle zu kennen.
  const empfaenger = await knoten(t, { trustNew: true });
  const sender = await knoten(t);

  const datei = quelldatei(tempdir(t, 'quelle'), 'ohne-vorwissen.txt', 'erster Kontakt, nichts vorher bekannt');
  const res = await sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [datei]);
  assert.equal(res.ok, true);

  const bekannt = sender.n.store.peers.list();
  assert.equal(bekannt.length, 1, 'der Sender hat sich die Gegenstelle nicht gemerkt');
  assert.equal(bekannt[0].address, empfaenger.n.me.address);
  assert.ok(bekannt[0].pub.equals(empfaenger.n.me.pub));
});

test('eine irrefuehrende Geraeteschau fliegt auf', async (t) => {
  // Der Rundruf ist unbeglaubigt - wer host und port kennt, kann dazu
  // jede Anschrift behaupten. Der im Handschlag bewiesene Schluessel
  // muss zu der angesteuerten Anschrift passen, sonst wird abgebrochen.
  const empfaenger = await knoten(t, { trustNew: true });
  const sender = await knoten(t);
  const fremd = identity.create();

  const datei = quelldatei(tempdir(t, 'quelle'), 'irrefuehrung.txt', 'sollte nie ankommen');

  await assert.rejects(
    () => sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port, address: fremd.address }, [datei]),
    (err) => {
      assert.equal(err.code, 'PEER_CHANGED');
      return true;
    }
  );

  assert.equal(fs.existsSync(path.join(empfaenger.ziel, 'irrefuehrung.txt')), false,
    'es wurde trotzdem etwas geschrieben');
});

test('mit trustNew erlaubt, klappt die Kopplung', async (t) => {
  const A = await knoten(t, { trustNew: true });
  const B = await knoten(t, { trustNew: true });

  const quelleA = quelldatei(tempdir(t, 'quelle-a'), 'von-a.txt', 'Gruesse von A, mehrfach wiederholt. '.repeat(200));
  const quelleB = quelldatei(tempdir(t, 'quelle-b'), 'von-b.txt', 'Antwort von B, auch mehrfach. '.repeat(200));

  // Beide Richtungen: erst lernt B den Schluessel von A kennen, dann
  // A den von B - genau so entsteht beidseitiges Vertrauen.
  const r1 = await A.n.sendTo({ host: '127.0.0.1', port: B.n.port }, [quelleA]);
  assert.equal(r1.ok, true);
  assert.ok(fs.readFileSync(path.join(B.ziel, 'von-a.txt')).equals(fs.readFileSync(quelleA)),
    'der Inhalt kam nicht unverfaelscht bei B an');

  const r2 = await B.n.sendTo({ host: '127.0.0.1', port: A.n.port }, [quelleB]);
  assert.equal(r2.ok, true);
  assert.ok(fs.readFileSync(path.join(A.ziel, 'von-b.txt')).equals(fs.readFileSync(quelleB)),
    'der Inhalt kam nicht unverfaelscht bei A an');

  await t.test('beide Seiten haben die Gegenstelle jetzt gemerkt', () => {
    const beiA = A.n.store.peers.list();
    const beiB = B.n.store.peers.list();

    assert.equal(beiA.length, 1);
    assert.equal(beiB.length, 1);

    assert.equal(beiA[0].address, B.n.me.address);
    assert.ok(identity.addressMatches(beiA[0].address, beiA[0].pub));
    assert.ok(beiA[0].pub.equals(B.n.me.pub));

    assert.equal(beiB[0].address, A.n.me.address);
    assert.ok(identity.addressMatches(beiB[0].address, beiB[0].pub));
    assert.ok(beiB[0].pub.equals(A.n.me.pub));
  });
});

test('nach der Kopplung geht es auch ohne trustNew', async (t) => {
  const sender = await knoten(t);
  const empfaengerHeim = tempdir(t, 'home-empfaenger');

  // --- Erster Anlauf: koppeln ---
  let empfaenger = await knoten(t, { trustNew: true, home: empfaengerHeim });
  const quelle1 = quelldatei(tempdir(t, 'quelle-1'), 'erster.txt', 'der erste Versuch');
  const r1 = await sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [quelle1]);
  assert.equal(r1.ok, true);
  await empfaenger.n.close();

  // --- Zweiter Anlauf: derselbe Ordner, diesmal ohne trustNew ---
  empfaenger = await knoten(t, { trustNew: false, home: empfaengerHeim });
  const quelle2 = quelldatei(tempdir(t, 'quelle-2'), 'zweiter.txt', 'der zweite Versuch, schon gekoppelt');
  const r2 = await sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [quelle2]);

  assert.equal(r2.ok, true, 'die zweite Uebertragung an eine bereits bekannte Gegenstelle scheiterte');
  assert.ok(fs.readFileSync(path.join(empfaenger.ziel, 'zweiter.txt')).equals(Buffer.from('der zweite Versuch, schon gekoppelt')));
});

test('ein Fremder mit derselben Anschrift kommt nicht durch', async (t) => {
  const sender = await knoten(t, { trustNew: true });
  const empfaenger = await knoten(t, { trustNew: true });

  // --- Erst koppeln ---
  const quelle1 = quelldatei(tempdir(t, 'quelle-1'), 'echt.txt', 'die echte Gegenstelle');
  const gekoppelt = await sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [quelle1]);
  assert.equal(gekoppelt.ok, true);

  const bekannt = empfaenger.n.store.peers.list();
  assert.equal(bekannt.length, 1);
  const anschrift = bekannt[0].address;
  assert.equal(anschrift, sender.n.me.address);

  // --- Dem Empfaenger heimlich einen anderen Schluessel unterschieben ---
  const fremderSchluessel = identity.create().pub;
  empfaenger.n.store.peers.replace(anschrift, fremderSchluessel, null);

  // --- Der echte Sender meldet sich - passt nicht mehr zum gemerkten Schluessel ---
  const quelle2 = quelldatei(tempdir(t, 'quelle-2'), 'zweiter-versuch.txt', 'sollte nie ankommen');
  await assert.rejects(
    () => sender.n.sendTo({ host: '127.0.0.1', port: empfaenger.n.port }, [quelle2]),
    'sendTo haette an dem geaenderten Schluessel scheitern muessen'
  );

  assert.equal(fs.existsSync(path.join(empfaenger.ziel, 'zweiter-versuch.txt')), false,
    'es wurde trotzdem etwas geschrieben');

  const letzte = empfaenger.ereignisse.filter((e) => e.type === 'refused').pop();
  assert.ok(letzte, 'der Empfänger hat keine "refused"-Meldung gebracht');
  assert.equal(letzte.code, 'PEER_CHANGED');
});

/* ---------------------------- Die Ablage ---------------------------- */

test('der Schluessel liegt sicher auf der Platte', (t) => {
  const heim = tempdir(t, 'schluessel');
  store.open(heim);

  const rechte = fs.statSync(path.join(heim, 'identity.json')).mode & 0o777;
  assert.equal(rechte, 0o600, `identity.json hat die Rechte ${rechte.toString(8)}`);
});

test('ein Neustart behaelt die Kennung', (t) => {
  const heim = tempdir(t, 'neustart');
  const erst = store.open(heim);
  const wieder = store.open(heim);

  assert.equal(wieder.me.address, erst.me.address);
  assert.ok(wieder.me.pub.equals(erst.me.pub));
});
