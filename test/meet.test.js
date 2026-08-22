'use strict';

/* =================================================================
   Der Treffpunkt, fuer sich.

   Erst das Protokoll: jede Nachricht formt und liest sich zurueck,
   und alles, was auf einer offenen Verbindung sonst noch auftauchen
   kann, ergibt null statt einer Ausnahme. Danach der Ernstfall: ein
   echter Server, eine echte Anmeldung, eine echte Vermittlung - und
   die Probe, dass die Stelle nach dem Zusammenschalten kein einziges
   Byte mehr deutet.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const identity = require('../src/core/identity');
const frame = require('../src/core/frame');
const protocol = require('../src/meet/protocol');
const meetServer = require('../src/meet/server');
const meet = require('../src/net/meet');

/* ----------------------------- Aufbau ----------------------------- */

async function warteAuf(bedingung, ms = 3000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (bedingung()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Bedingung ist nicht rechtzeitig eingetreten');
}

/* ---------------------------- Protokoll ---------------------------- */

test('jede Nachricht formt und liest sich zurueck', () => {
  const adresse = identity.create().address;

  const faelle = [
    protocol.hereMsg(adresse),
    protocol.hereMsg(adresse, 'geheim'),
    protocol.reachMsg(adresse),
    protocol.reachMsg(adresse, 'geheim'),
    protocol.okMsg(),
    protocol.joinedMsg(),
    protocol.nobodyMsg(),
    protocol.deniedMsg('falsches Passwort'),
    protocol.pingMsg(),
    protocol.pongMsg()
  ];

  for (const msg of faelle) {
    const bytes = Buffer.from(JSON.stringify(msg), 'utf8');
    assert.deepEqual(protocol.read(bytes), msg, `${msg.t} liest sich nicht zurueck`);
  }
});

test('Unfug auf dem Kanal ergibt null, keine Ausnahme', () => {
  const roh = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
  const echteAnschrift = identity.create().address;

  const faelle = [
    ['kein JSON', Buffer.from('das hier ist kein JSON', 'utf8')],
    ['leerer Puffer', Buffer.alloc(0)],
    ['null statt Objekt', roh(null)],
    ['ein Feld ohne Art', roh({})],
    ['unbekannte Art', roh({ t: 'was-auch-immer' })],
    ['here ohne Anschrift', roh({ t: 'here' })],
    ['here mit Anschrift als Zahl', roh({ t: 'here', address: 12345 })],
    ['here mit unbrauchbarer Anschrift', roh({ t: 'here', address: 'quatsch-keine-echte-anschrift' })],
    ['here mit Passwort als Zahl', roh({ t: 'here', address: echteAnschrift, pass: 5 })],
    ['reach ohne Anschrift', roh({ t: 'reach' })],
    ['denied ohne Grund', roh({ t: 'denied' })]
  ];

  for (const [name, bytes] of faelle) {
    assert.equal(protocol.read(bytes), null, `"${name}" haette null ergeben muessen`);
  }
});

/* ---------------------------- Vermittlung ---------------------------- */

test('register und reach finden sich, danach fliessen rohe Bytes unveraendert durch', async (t) => {
  const ereignisse = [];
  const server = await meetServer.start({ port: 0, onEvent: (e) => ereignisse.push(e) });
  t.after(() => server.close());

  const adresse = identity.create().address;

  const wartend = meet.register('127.0.0.1', server.port, { address: adresse });
  await warteAuf(() => server.registered === 1);

  const [empfaenger, sucher] = await Promise.all([
    wartend,
    meet.reach('127.0.0.1', server.port, { address: adresse })
  ]);
  t.after(() => { empfaenger.close(); sucher.close(); });

  assert.equal(server.registered, 0, 'die Anmeldung haette verbraucht sein muessen');
  assert.ok(ereignisse.some((e) => e.type === 'joined' && e.address === adresse));

  // Absichtlich etwas geschickt, das wie ein gueltiger Rahmen der
  // Vermittlung aussieht - mit einer Anschrift, die es gar nicht gibt.
  // Wuerde die Stelle noch deuten, wuerde sie daran die Verbindung
  // abbrechen (unbrauchbare Anschrift -> null -> destroy).
  const getarnt = frame.pack(frame.control({ t: 'here', address: 'nicht-wirklich-eine-anschrift' }));

  const beiEmpfaenger = [];
  empfaenger.onData((b) => beiEmpfaenger.push(b));

  const beiSucher = [];
  sucher.onData((b) => beiSucher.push(b));

  sucher.send(getarnt);
  await warteAuf(() => Buffer.concat(beiEmpfaenger).length >= getarnt.length);
  assert.ok(Buffer.concat(beiEmpfaenger).equals(getarnt), 'die Bytes kamen veraendert an');

  const zweiterGetarnt = frame.pack(frame.control({ t: 'reach', address: 'auch-keine-echte-anschrift' }));
  empfaenger.send(zweiterGetarnt);
  await warteAuf(() => Buffer.concat(beiSucher).length >= zweiterGetarnt.length);
  assert.ok(Buffer.concat(beiSucher).equals(zweiterGetarnt), 'die Bytes kamen in der Gegenrichtung veraendert an');
});

test('reach auf eine unbekannte Anschrift ergibt NOBODY', async (t) => {
  const server = await meetServer.start({ port: 0 });
  t.after(() => server.close());

  await assert.rejects(
    () => meet.reach('127.0.0.1', server.port, { address: identity.create().address }),
    (err) => {
      assert.equal(err.code, 'NOBODY');
      return true;
    }
  );
});

test('falsches Passwort ergibt DENIED, und die Anschrift bleibt unangemeldet', async (t) => {
  const server = await meetServer.start({ port: 0, pass: 'das-echte-wort' });
  t.after(() => server.close());

  const adresse = identity.create().address;

  await assert.rejects(
    () => meet.register('127.0.0.1', server.port, { address: adresse, pass: 'falsch' }),
    (err) => {
      assert.equal(err.code, 'DENIED');
      return true;
    }
  );

  assert.equal(server.registered, 0, 'trotz falschem Passwort wurde etwas angemeldet');
});

test('zweite Anmeldung auf dieselbe Anschrift verdraengt die erste', async (t) => {
  const ereignisse = [];
  const server = await meetServer.start({ port: 0, onEvent: (e) => ereignisse.push(e) });
  t.after(() => server.close());

  const adresse = identity.create().address;

  const erste = meet.register('127.0.0.1', server.port, { address: adresse });
  const ersteAbgelehnt = erste.catch((e) => e);
  await warteAuf(() => server.registered === 1);

  const zweite = meet.register('127.0.0.1', server.port, { address: adresse });
  await warteAuf(() => ereignisse.filter((e) => e.type === 'registered' && e.address === adresse).length === 2);

  const fehler = await ersteAbgelehnt;
  assert.ok(fehler instanceof Error, 'die erste Anmeldung haette scheitern muessen');
  assert.equal(server.registered, 1, 'es sollte nur noch eine Anmeldung geben');

  const [sucher, empfaenger] = await Promise.all([
    meet.reach('127.0.0.1', server.port, { address: adresse }),
    zweite
  ]);
  t.after(() => { sucher.close(); empfaenger.close(); });

  assert.ok(sucher && empfaenger, 'die Vermittlung haette mit der zweiten Anmeldung klappen muessen');
});

test('eine Verbindung, die nichts sagt, wird nach Ablauf der Frist geschlossen', async (t) => {
  // Die Frist ist fuer diese Pruefung klein gesetzt - `idleTimeout` bei
  // `meetServer.start` (Standard: 30000 ms, siehe src/meet/server.js).
  const server = await meetServer.start({ port: 0, idleTimeout: 150 });
  t.after(() => server.close());

  const socket = net.connect(server.port, '127.0.0.1');
  t.after(() => socket.destroy());

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  await new Promise((resolve) => socket.once('close', resolve));
  assert.ok(socket.destroyed);
});

/* ------------------------ Der zweistufige Weg ------------------------ */

test('found liefert das direct der Anmeldung durch', async (t) => {
  const server = await meetServer.start({ port: 0 });
  t.after(() => server.close());

  const adresse = identity.create().address;

  meet.register('127.0.0.1', server.port, { address: adresse, direct: '203.0.113.7:41999' }).catch(() => {});
  await warteAuf(() => server.registered === 1);

  const auskunft = await meet.lookup('127.0.0.1', server.port, { address: adresse });
  assert.equal(auskunft.direct, '203.0.113.7:41999');

  // Aufräumen: sagen, dass es der direkte Weg wird - hier nur zum Testabschluss.
  auskunft.cancel();
});

test('ohne direct liefert found null - kein erfundener Wert', async (t) => {
  const server = await meetServer.start({ port: 0 });
  t.after(() => server.close());

  const adresse = identity.create().address;

  meet.register('127.0.0.1', server.port, { address: adresse }).catch(() => {});
  await warteAuf(() => server.registered === 1);

  const auskunft = await meet.lookup('127.0.0.1', server.port, { address: adresse });
  assert.equal(auskunft.direct, null);
  auskunft.cancel();
});

test('nach cancel bleibt die Gegenstelle angemeldet - ein zweiter Anlauf findet sie, und join schaltet wie bisher durch', async (t) => {
  const server = await meetServer.start({ port: 0 });
  t.after(() => server.close());

  const adresse = identity.create().address;

  const registrierung = meet.register('127.0.0.1', server.port, { address: adresse });
  await warteAuf(() => server.registered === 1);

  const ersterAnlauf = await meet.lookup('127.0.0.1', server.port, { address: adresse });
  assert.equal(server.registered, 1, 'die Anmeldung sollte durch found noch nicht verbraucht sein');
  ersterAnlauf.cancel();

  // 'cancel' geht erst noch ueber die Leitung - kurz nachschauen, dass
  // die Anmeldung danach wirklich noch da ist.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.registered, 1, 'die Anmeldung war nach cancel weg');

  const zweiterAnlauf = await meet.lookup('127.0.0.1', server.port, { address: adresse });
  assert.equal(zweiterAnlauf.direct, null);

  const [sucher, empfaenger] = await Promise.all([zweiterAnlauf.join(), registrierung]);
  t.after(() => { sucher.close(); empfaenger.close(); });

  assert.equal(server.registered, 0, 'die Anmeldung haette jetzt verbraucht sein muessen');

  // Rohe Bytes in beide Richtungen - genau wie bei 'reach' bisher.
  const beiEmpfaenger = [];
  empfaenger.onData((b) => beiEmpfaenger.push(b));
  sucher.send(Buffer.from('hallo empfaenger'));
  await warteAuf(() => Buffer.concat(beiEmpfaenger).length >= 'hallo empfaenger'.length);
  assert.equal(Buffer.concat(beiEmpfaenger).toString('utf8'), 'hallo empfaenger');

  const beiSucher = [];
  sucher.onData((b) => beiSucher.push(b));
  empfaenger.send(Buffer.from('hallo sucher'));
  await warteAuf(() => Buffer.concat(beiSucher).length >= 'hallo sucher'.length);
  assert.equal(Buffer.concat(beiSucher).toString('utf8'), 'hallo sucher');
});

test('close() kehrt zurueck, auch wenn noch Verbindungen offen sind', async () => {
  const server = await meetServer.start({ port: 0 });
  const adresse = identity.create().address;

  meet.register('127.0.0.1', server.port, { address: adresse }).catch(() => {});
  await warteAuf(() => server.registered === 1);

  // Es geht nicht darum, WANN genau die Buchfuehrung nachzieht, sondern
  // darum, dass close() nicht auf eine Gegenstelle wartet, die nie
  // von selbst aufgelegt haette.
  const zeitueberschreitung = Symbol('zeitueberschreitung');
  const ergebnis = await Promise.race([
    server.close().then(() => 'fertig'),
    new Promise((resolve) => setTimeout(() => resolve(zeitueberschreitung), 2000))
  ]);

  assert.equal(ergebnis, 'fertig', 'close() ist trotz offener Verbindung nicht zurueckgekehrt');
});
