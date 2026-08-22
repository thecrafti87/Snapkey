'use strict';

/* =================================================================
   Kurznachrichten zwischen zwei echten Knoten - dieselbe Torkontrolle
   wie bei Dateien, dieselbe Weiche zwischen beidem, und eine Ablage,
   die einen Neustart uebersteht.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const nodeMod = require('../src/node/node');

/* ----------------------------- Aufbau ----------------------------- */

function tempdir(t, praefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kaiman-${praefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quelldatei(dir, name, text) {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, text);
  return abs;
}

/**
 * Wartet, bis `pruef()` zutrifft - hoechstens `timeoutMs`. Gebraucht,
 * weil say() nicht auf die Verarbeitung von "bye" bei der Gegenstelle
 * wartet (dieselbe Schlussnachricht-vorm-Auflegen-Regel wie bei
 * Dateien): das "talked"-Ereignis bei B kann also noch unterwegs sein,
 * wenn A.n.say() schon zurueckgekehrt ist.
 */
async function bisWahr(pruef, timeoutMs = 2000) {
  const ende = Date.now() + timeoutMs;
  while (!pruef() && Date.now() < ende) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return pruef();
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

test('eine Nachricht von A nach B kommt an und steht bei beiden in der Ablage', async (t) => {
  const A = await knoten(t, { trustNew: true });
  const B = await knoten(t, { trustNew: true });

  const res = await A.n.say({ host: '127.0.0.1', port: B.n.port }, ['hallo B, hier ist A']);
  assert.equal(res.delivered, 1);
  assert.equal(res.route, 'lan');

  const beiA = A.n.messages.forPeer(B.n.me.address);
  assert.equal(beiA.length, 1);
  assert.equal(beiA[0].dir, 'out');
  assert.equal(beiA[0].text, 'hallo B, hier ist A');

  const beiB = B.n.messages.forPeer(A.n.me.address);
  assert.equal(beiB.length, 1);
  assert.equal(beiB[0].dir, 'in');
  assert.equal(beiB[0].text, 'hallo B, hier ist A');
  assert.equal(beiB[0].at, beiA[0].at, 'beide Seiten sollten denselben Zeitstempel fuehren');

  await t.test('B meldet die eingegangene Nachricht und den Abschluss der Sitzung', async () => {
    const empfangen = B.ereignisse.find((e) => e.type === 'message');
    assert.ok(empfangen, 'kein "message"-Ereignis');
    assert.equal(empfangen.text, 'hallo B, hier ist A');
    assert.equal(empfangen.address, A.n.me.address);

    await bisWahr(() => B.ereignisse.some((e) => e.type === 'talked'));
    const abgeschlossen = B.ereignisse.find((e) => e.type === 'talked');
    assert.ok(abgeschlossen, 'kein "talked"-Ereignis');
    assert.equal(abgeschlossen.count, 1);
  });

  await t.test('kaiman.js liest denselben Verlauf ueber node.messages.peers()', () => {
    const peersBeiA = A.n.messages.peers();
    assert.equal(peersBeiA.length, 1);
    assert.equal(peersBeiA[0].address, B.n.me.address);
    assert.equal(peersBeiA[0].anzahl, 1);
  });
});

test('ein unbekannter Absender wird abgewiesen - in der Ablage des Empfaengers steht nichts', async (t) => {
  const empfaenger = await knoten(t, { trustNew: false });
  const sender = await knoten(t);

  await assert.rejects(
    () => sender.n.say({ host: '127.0.0.1', port: empfaenger.n.port }, ['sollte nie ankommen']),
    'say() haette an der Torkontrolle scheitern muessen'
  );

  assert.deepEqual(empfaenger.n.messages.peers(), [], 'in der Ablage des Empfaengers steht trotzdem etwas');

  const abgewiesen = empfaenger.ereignisse.find((e) => e.type === 'refused');
  assert.ok(abgewiesen, 'der Empfänger hat keine "refused"-Meldung gebracht');
  assert.equal(abgewiesen.code, 'UNKNOWN_PEER');
});

test('nach einer Nachricht funktioniert eine Dateiuebertragung zwischen denselben beiden weiterhin', async (t) => {
  const A = await knoten(t, { trustNew: true });
  const B = await knoten(t, { trustNew: true });

  const rSay = await A.n.say({ host: '127.0.0.1', port: B.n.port }, ['erst reden wir']);
  assert.equal(rSay.delivered, 1);

  const datei = quelldatei(tempdir(t, 'quelle'), 'nach-dem-reden.txt', 'und jetzt eine Datei, wie gehabt');
  const rSend = await A.n.sendTo({ host: '127.0.0.1', port: B.n.port }, [datei]);
  assert.equal(rSend.ok, true);
  assert.ok(
    fs.readFileSync(path.join(B.ziel, 'nach-dem-reden.txt')).equals(fs.readFileSync(datei)),
    'die Datei kam nach der Nachrichtensitzung nicht unverfaelscht an'
  );

  // Und umgekehrt: nach einer Datei geht auch wieder eine Nachricht.
  const rSay2 = await B.n.say({ host: '127.0.0.1', port: A.n.port }, ['danke fuer die Datei']);
  assert.equal(rSay2.delivered, 1);
  assert.equal(A.n.messages.forPeer(B.n.me.address).at(-1).text, 'danke fuer die Datei');
});

test('die Ablage der Nachrichten uebersteht einen Neustart des Knotens', async (t) => {
  const senderHeim = tempdir(t, 'sender-heim');
  const empfaenger = await knoten(t, { trustNew: true });

  let sender = await knoten(t, { trustNew: true, home: senderHeim });
  const res = await sender.n.say({ host: '127.0.0.1', port: empfaenger.n.port }, ['bleibt das erhalten?']);
  assert.equal(res.delivered, 1);
  await sender.n.close();

  // --- Neustart, derselbe Ablage ---
  sender = await knoten(t, { trustNew: true, home: senderHeim });

  const nachNeustart = sender.n.messages.forPeer(empfaenger.n.me.address);
  assert.equal(nachNeustart.length, 1);
  assert.equal(nachNeustart[0].text, 'bleibt das erhalten?');
  assert.equal(nachNeustart[0].dir, 'out');
});
