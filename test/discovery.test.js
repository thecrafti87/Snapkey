'use strict';

/* =================================================================
   Wer ist sonst noch da - diesmal wirklich gefragt.

   Erst die reinen Funktionen: eine Ankuendigung geht rein, dieselben
   Werte kommen raus, und alles, was auf dem Rundruf sonst noch
   auftauchen kann, wirft nicht, sondern liefert null. Danach der
   Ernstfall: zwei echte Rundrufe im echten Netz, die sich finden.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../src/core/identity');
const discovery = require('../src/net/discovery');

/* ---------------------- Ankuendigung und Lesen ---------------------- */

test('eine Ankuendigung liest sich zu denselben Werten zurueck', () => {
  const me = identity.create();
  const buf = discovery.announcement({ address: me.address, pub: me.pub, port: 4321, name: 'Werkstatt' });
  const msg = discovery.parse(buf);

  assert.ok(msg, 'die eigene Ankuendigung liess sich nicht lesen');
  assert.equal(msg.address, me.address);
  assert.ok(Buffer.from(msg.pub).equals(me.pub));
  assert.equal(msg.port, 4321);
  assert.equal(msg.name, 'Werkstatt');
  assert.equal(msg.bye, false);
});

test('ein fehlender Name kommt als null zurueck, nicht als leerer Text', () => {
  const me = identity.create();
  const buf = discovery.announcement({ address: me.address, pub: me.pub, port: 4321 });
  const msg = discovery.parse(buf);
  assert.equal(msg.name, null);
});

test('ein Abschieds-Rundruf ist beim Lesen als solcher erkennbar', () => {
  const me = identity.create();
  const buf = discovery.announcement({ address: me.address, pub: me.pub, port: 4321, name: 'Werkstatt', bye: true });
  const msg = discovery.parse(buf);
  assert.equal(msg.bye, true);
});

test('auf dem Rundruf landet auch Fremdes - das wird zu null, nicht zum Wurf', async (t) => {
  const me = identity.create();
  const gueltig = () => JSON.parse(discovery.announcement({ address: me.address, pub: me.pub, port: 4321 }).toString('utf8'));

  const faelle = [
    ['kein JSON', () => Buffer.from('das hier ist kein JSON', 'utf8')],
    ['leerer Puffer', () => Buffer.alloc(0)],
    ['fremde Kennung', () => Buffer.from(JSON.stringify({ ...gueltig(), k: 'irgendwas-anderes' }), 'utf8')],
    ['Kennung fehlt ganz', () => {
      const roh = gueltig();
      delete roh.k;
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Anschrift fehlt', () => {
      const roh = gueltig();
      delete roh.a;
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Schluessel fehlt', () => {
      const roh = gueltig();
      delete roh.p;
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Schluessel zu kurz', () => {
      const roh = gueltig();
      roh.p = Buffer.alloc(16).toString('base64url');
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Schluessel zu lang', () => {
      const roh = gueltig();
      roh.p = Buffer.alloc(48).toString('base64url');
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Port null', () => {
      const roh = gueltig();
      roh.t = 0;
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Port ausserhalb des Bereichs', () => {
      const roh = gueltig();
      roh.t = 70000;
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['Port ist Text', () => {
      const roh = gueltig();
      roh.t = 'abc';
      return Buffer.from(JSON.stringify(roh), 'utf8');
    }],
    ['ganz und gar kein Objekt', () => Buffer.from(JSON.stringify([1, 2, 3]), 'utf8')],
    ['leeres Objekt', () => Buffer.from('{}', 'utf8')]
  ];

  for (const [bezeichnung, machen] of faelle) {
    await t.test(bezeichnung, () => {
      assert.doesNotThrow(() => discovery.parse(machen()), bezeichnung);
      assert.equal(discovery.parse(machen()), null, bezeichnung);
    });
  }
});

/* ------------------------ Der echte Rundruf ------------------------ */

test('zwei Geraete im Netz finden sich ueber den echten Rundruf', async (t) => {
  const A = identity.create();
  const B = identity.create();

  const beaconA = await discovery.start({ identity: A, port: 51001, name: 'Alpha', onChange: () => {} });
  const beaconB = await discovery.start({ identity: B, port: 51002, name: 'Beta', onChange: () => {} });
  t.after(() => { beaconA.stop(); beaconB.stop(); });

  // Im Abstand von 100 ms nachsehen, bis beide sich gefunden haben -
  // oder nach 8 Sekunden mit einem klaren Fehlschlag aufgeben. Kein
  // stillschweigendes Uebergehen: geht der Rundruf hier nicht, soll
  // der Test das melden, nicht so tun, als waere nichts gewesen.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (beaconA.peers.length && beaconB.peers.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(beaconA.peers.length, 1, 'Alpha hat Beta nicht gefunden - Multicast geht in dieser Umgebung nicht');
  assert.equal(beaconB.peers.length, 1, 'Beta hat Alpha nicht gefunden - Multicast geht in dieser Umgebung nicht');

  const gesehenVonA = beaconA.peers[0];
  const gesehenVonB = beaconB.peers[0];

  assert.equal(gesehenVonA.address, B.address);
  assert.equal(gesehenVonB.address, A.address);

  assert.ok(identity.addressMatches(gesehenVonA.address, gesehenVonA.pub), 'Anschrift und Schluessel passen bei Beta nicht zusammen');
  assert.ok(identity.addressMatches(gesehenVonB.address, gesehenVonB.pub), 'Anschrift und Schluessel passen bei Alpha nicht zusammen');

  // Der Rundruf geht ueber eine echte Netzschnittstelle raus, nicht
  // ueber die Rueckschleife - welche Adresse das genau ist, haengt vom
  // Rechner ab. Gesetzt und eine Zeichenkette muss sie trotzdem sein.
  assert.equal(typeof gesehenVonA.host, 'string');
  assert.ok(gesehenVonA.host.length > 0);
  assert.equal(gesehenVonA.port, 51002);
  assert.equal(typeof gesehenVonB.host, 'string');
  assert.ok(gesehenVonB.host.length > 0);
  assert.equal(gesehenVonB.port, 51001);

  await t.test('sich selbst sieht niemand als Gegenstelle', () => {
    assert.equal(beaconA.peers.some((p) => p.address === A.address), false);
    assert.equal(beaconB.peers.some((p) => p.address === B.address), false);
  });

  await t.test('find sucht ueber Anschrift und Name', () => {
    assert.equal(beaconA.find(B.address).address, B.address);
    assert.equal(beaconA.find('beta').address, B.address);
    assert.equal(beaconA.find('nicht-vorhanden'), null);
  });
});
