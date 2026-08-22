'use strict';

/* =================================================================
   Der eigentliche Nachweis: zwei Knoten, die sich nur ueber einen
   Treffpunkt erreichen.

   Kein direktes Kabel zwischen Sender und Empfaenger - beide reden nur
   mit dem Treffpunkt, der sie zusammenschaltet. Geprueft wird, was
   dabei zaehlt: die Datei kommt vollstaendig und unverfaelscht an, die
   Vermittlungsstelle bekommt vom Inhalt nichts zu sehen, der Empfaenger
   bleibt danach erreichbar, und die Torkontrolle gilt unveraendert.

   Zwei weitere Pruefungen unten zeigen den direkten Weg: meldet der
   Empfaenger ein `direct`, das wirklich zu ihm fuehrt, verbindet der
   Sender direkt und der Treffpunkt sieht nur noch die schmale
   Vermittlung, keine Nutzdaten (`route === 'direct'`). Zeigt `direct`
   ins Leere, faengt die Umleitung es auf (`route === 'relay'`).
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const nodeMod = require('../src/node/node');
const meetServer = require('../src/meet/server');
const meetClient = require('../src/net/meet');
const tcp = require('../src/net/tcp');
const session = require('../src/core/session');
const identity = require('../src/core/identity');

/* ----------------------------- Aufbau ----------------------------- */

function tempdir(t, praefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snapkey-meet-${praefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function warteAuf(bedingung, ms = 4000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Bedingung ist nicht rechtzeitig eingetreten');
}

/** Ein Ordner mit Unterordner, dazu ein Stueck Klartext, das sich im Mitschnitt wiederfinden liesse. */
function quelle(dir, marke) {
  const root = path.join(dir, 'quelle', 'ordner');
  fs.mkdirSync(path.join(root, 'unter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'oben.txt'), `KLARTEXT-OBEN-${marke}-` + 'x'.repeat(60000));
  fs.writeFileSync(path.join(root, 'unter', 'tief.txt'), `KLARTEXT-TIEF-${marke}-` + 'y'.repeat(60000));
  return root;
}

/**
 * Ein durchgeschalteter Zapfhahn vor dem echten Treffpunkt: alles, was
 * in beide Richtungen durchlaeuft, landet zusaetzlich im Mitschnitt -
 * genau das, was die Vermittlungsstelle selbst zu sehen bekommt.
 *
 * Wie in tcp.js: ueber die offenen Verbindungen wird selbst Buch
 * gefuehrt, und beide Beine einer Leitung werden zusammen geschlossen -
 * sonst haengt eine Seite verwaist weiter, wenn die andere (etwa durch
 * server.close() auf der Gegenseite) unvermittelt abreisst, und close()
 * hier wartet dann ewig auf eine Verbindung, die nie von selbst endet.
 */
function tapProxy(zielPort) {
  const mitschnitt = [];
  const offen = new Set();

  const server = net.createServer((client) => {
    const upstream = net.connect(zielPort, '127.0.0.1');
    offen.add(client);
    offen.add(upstream);

    client.on('data', (b) => mitschnitt.push(Buffer.from(b)));
    upstream.on('data', (b) => mitschnitt.push(Buffer.from(b)));
    client.pipe(upstream);
    upstream.pipe(client);

    const schliessen = () => { client.destroy(); upstream.destroy(); };
    client.once('close', () => { offen.delete(client); offen.delete(upstream); schliessen(); });
    upstream.once('close', () => { offen.delete(client); offen.delete(upstream); schliessen(); });
    client.on('error', () => {});
    upstream.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      mitschnitt,
      close: () => new Promise((done) => {
        server.close(done);
        for (const socket of offen) socket.destroy();
        offen.clear();
      })
    }));
  });
}

/** Ein Knoten ohne Geraetesuche, mit eigenem Wegwerf-Heimatordner. */
async function knoten(t, praefix, opts = {}) {
  const heim = tempdir(t, `${praefix}-home`);
  const ziel = tempdir(t, `${praefix}-ziel`);
  const ereignisse = [];

  const n = await nodeMod.open({
    home: heim, outDir: ziel, port: 0, announce: false,
    onEvent: (e) => ereignisse.push(e),
    ...opts
  });

  t.after(() => n.close());
  return { n, heim, ziel, ereignisse };
}

/* ---------------------------- Pruefungen ---------------------------- */

test('zwei Knoten finden sich nur ueber den Treffpunkt - vollstaendig, byteweise identisch, unbeobachtet', async (t) => {
  const meetSrv = await meetServer.start({ port: 0 });
  t.after(() => meetSrv.close());

  const proxy = await tapProxy(meetSrv.port);
  t.after(() => proxy.close());

  const treffpunkt = { host: '127.0.0.1', port: proxy.port };

  const empfaenger = await knoten(t, 'empf', { trustNew: true, meet: treffpunkt });
  await warteAuf(() => meetSrv.registered === 1);

  const sender = await knoten(t, 'send');

  const dir1 = tempdir(t, 'quelle-1');
  const root1 = quelle(dir1, 'eins');

  const res1 = await sender.n.sendTo({ address: empfaenger.n.me.address, meet: treffpunkt }, [root1]);
  assert.equal(res1.ok, true, 'die erste Uebertragung wurde nicht vollstaendig');

  assert.ok(fs.readFileSync(path.join(empfaenger.ziel, 'ordner', 'oben.txt'))
    .equals(fs.readFileSync(path.join(root1, 'oben.txt'))), 'oben.txt kam nicht unverfaelscht an');
  assert.ok(fs.readFileSync(path.join(empfaenger.ziel, 'ordner', 'unter', 'tief.txt'))
    .equals(fs.readFileSync(path.join(root1, 'unter', 'tief.txt'))), 'tief.txt kam nicht unverfaelscht an');

  // Nach einer Uebertragung ist der Empfaenger wieder erreichbar - eine
  // zweite Uebertragung ueber denselben Treffpunkt muss durchgehen.
  await warteAuf(() => meetSrv.registered === 1);

  const dir2 = tempdir(t, 'quelle-2');
  const root2 = quelle(dir2, 'zwei');

  const res2 = await sender.n.sendTo({ address: empfaenger.n.me.address, meet: treffpunkt }, [root2]);
  assert.equal(res2.ok, true, 'die zweite Uebertragung ueber denselben Treffpunkt scheiterte');
  assert.ok(res2.sent > 0, 'die zweite Uebertragung haette echten Inhalt schicken muessen');

  assert.ok(fs.readFileSync(path.join(empfaenger.ziel, 'ordner', 'oben.txt'))
    .equals(fs.readFileSync(path.join(root2, 'oben.txt'))), 'die zweite Fassung kam nicht unverfaelscht an');

  // Der Treffpunkt sieht nichts: keines der beiden bekannten
  // Klartextstuecke darf im Mitschnitt auftauchen.
  const alles = Buffer.concat(proxy.mitschnitt);
  assert.equal(alles.indexOf('KLARTEXT-OBEN-eins'), -1, 'der Treffpunkt konnte den ersten Dateiinhalt lesen');
  assert.equal(alles.indexOf('KLARTEXT-TIEF-eins'), -1, 'der Treffpunkt konnte den ersten Dateiinhalt lesen');
  assert.equal(alles.indexOf('KLARTEXT-OBEN-zwei'), -1, 'der Treffpunkt konnte den zweiten Dateiinhalt lesen');
  assert.equal(alles.indexOf('KLARTEXT-TIEF-zwei'), -1, 'der Treffpunkt konnte den zweiten Dateiinhalt lesen');
  assert.ok(alles.length > 0, 'der Mitschnitt ist leer - die Pruefung haette gar nichts gesehen');
});

test('die Torkontrolle gilt auch ueber den Treffpunkt: ein unbekannter Sender wird abgewiesen', async (t) => {
  const meetSrv = await meetServer.start({ port: 0 });
  t.after(() => meetSrv.close());
  const treffpunkt = { host: '127.0.0.1', port: meetSrv.port };

  const empfaenger = await knoten(t, 'gate-empf', { trustNew: false, meet: treffpunkt });
  await warteAuf(() => meetSrv.registered === 1);

  const sender = await knoten(t, 'gate-send');

  const dir = tempdir(t, 'gate-quelle');
  const datei = path.join(dir, 'brief.txt');
  fs.writeFileSync(datei, 'sollte nie ankommen');

  await assert.rejects(
    () => sender.n.sendTo({ address: empfaenger.n.me.address, meet: treffpunkt }, [datei]),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_PEER');
      return true;
    }
  );

  assert.deepEqual(fs.readdirSync(empfaenger.ziel), [], 'im Zielordner liegt trotzdem etwas');
});

/* ------------------------- Der direkte Weg ------------------------- */

test('meldet der Empfaenger ein direct, das wirklich zu ihm fuehrt, verbindet der Sender direkt - '
  + 'der Treffpunkt sieht die Nutzdaten nicht', async (t) => {
  const meetSrv = await meetServer.start({ port: 0 });
  t.after(() => meetSrv.close());

  // Derselbe Zapfhahn wie oben: was tatsaechlich durch den Treffpunkt
  // liefe, wuerde hier auftauchen. Bei einer echten Direktverbindung
  // laeuft dort NICHTS durch, ausser der schmalen Vermittlung selbst.
  const proxy = await tapProxy(meetSrv.port);
  t.after(() => proxy.close());
  const treffpunkt = { host: '127.0.0.1', port: proxy.port };

  const sender = await knoten(t, 'direkt-send');

  // Der Empfaenger hier ist absichtlich KEIN nodeMod.open() mit `meet` -
  // sonst koennte sein eigener Anmelde-Kreislauf (der ohne Portfreigabe
  // kein `direct` kennt) die von Hand gesetzte Anmeldung unten jederzeit
  // verdraengen. Ein blosser TCP-Zuhoerer reicht: `sendTo` kuemmert sich
  // nicht darum, wie die Gegenstelle organisiert ist.
  const empfId = identity.create();
  const zielOrdner = tempdir(t, 'direkt-ziel');
  const empfListener = await tcp.listen(0, (transport) => {
    session.receive(transport, { identity: empfId, expect: sender.n.me.pub, dir: zielOrdner })
      .catch(() => {})
      .finally(() => transport.close());
  });
  t.after(() => empfListener.close());

  const abbruch = new AbortController();
  t.after(() => abbruch.abort());
  meetClient.register(treffpunkt.host, treffpunkt.port, {
    address: empfId.address,
    direct: `127.0.0.1:${empfListener.port}`,
    signal: abbruch.signal
  }).catch(() => {});
  await warteAuf(() => meetSrv.registered === 1);

  const dir1 = tempdir(t, 'direkt-quelle');
  const root1 = quelle(dir1, 'direkt');

  const res = await sender.n.sendTo({ address: empfId.address, meet: treffpunkt }, [root1]);
  assert.equal(res.ok, true, 'die Uebertragung wurde nicht vollstaendig');
  assert.equal(res.route, 'direct', 'haette den direkten Weg nehmen muessen');

  assert.ok(fs.readFileSync(path.join(zielOrdner, 'ordner', 'oben.txt'))
    .equals(fs.readFileSync(path.join(root1, 'oben.txt'))), 'der Inhalt kam nicht unverfaelscht an');

  const alles = Buffer.concat(proxy.mitschnitt);
  assert.equal(alles.indexOf('KLARTEXT-OBEN-direkt'), -1, 'der Treffpunkt konnte den Dateiinhalt lesen');
  // Nur die schmale Vermittlung ('reach'/'found'/'cancel') laeuft durch
  // den Treffpunkt - keine 60 KB Nutzdaten. Grosszuegig bemessen, es
  // geht nicht um einen genauen Wert.
  assert.ok(alles.length < 2000, `der Mitschnitt ist zu gross fuer reine Steuerdaten: ${alles.length} Bytes`);
});

test('zeigt direct ins Leere, gelingt die Uebertragung trotzdem - ueber die Umleitung', async (t) => {
  const meetSrv = await meetServer.start({ port: 0 });
  t.after(() => meetSrv.close());
  const treffpunkt = { host: '127.0.0.1', port: meetSrv.port };

  const sender = await knoten(t, 'toterdirekt-send');

  const empfId = identity.create();
  const zielOrdner = tempdir(t, 'toterdirekt-ziel');
  const empfListener = await tcp.listen(0, (transport) => {
    session.receive(transport, { identity: empfId, expect: sender.n.me.pub, dir: zielOrdner })
      .catch(() => {})
      .finally(() => transport.close());
  });
  t.after(() => empfListener.close());

  const abbruch = new AbortController();
  t.after(() => abbruch.abort());

  // Ein direct, unter dem niemand lauscht - Port 1 ist privilegiert und
  // auf einem gewoehnlichen Entwicklungsrechner nicht belegt, ein
  // Verbindungsversuch dorthin scheitert schnell (siehe tcp.test.js).
  const registrierung = meetClient.register(treffpunkt.host, treffpunkt.port, {
    address: empfId.address,
    direct: '127.0.0.1:1',
    signal: abbruch.signal
  });
  registrierung.then((transport) => {
    // Klappt trotz des toten `direct` die Umleitung, landet die
    // Sitzung hier - genau wie bei einem gewoehnlichen `reach`.
    session.receive(transport, { identity: empfId, expect: sender.n.me.pub, dir: zielOrdner })
      .catch(() => {})
      .finally(() => transport.close());
  }).catch(() => {});
  await warteAuf(() => meetSrv.registered === 1);

  const dir1 = tempdir(t, 'toterdirekt-quelle');
  const root1 = quelle(dir1, 'toterdirekt');

  const res = await sender.n.sendTo({ address: empfId.address, meet: treffpunkt }, [root1]);
  assert.equal(res.ok, true, 'die Uebertragung wurde nicht vollstaendig');
  assert.equal(res.route, 'relay', 'haette ueber die Umleitung laufen muessen');

  assert.ok(fs.readFileSync(path.join(zielOrdner, 'ordner', 'oben.txt'))
    .equals(fs.readFileSync(path.join(root1, 'oben.txt'))), 'der Inhalt kam nicht unverfaelscht an');
});
