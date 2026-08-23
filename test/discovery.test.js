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

const dgram = require('dgram');

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

/* --------------------- Auf welchen Karten gerufen --------------------- */

/**
 * Warum das eine eigene Pruefung braucht, obwohl unten schon zwei echte
 * Rundrufe gegeneinander laufen:
 *
 * Die beiden dort sitzen auf DEMSELBEN Rechner, und
 * setMulticastLoopback(true) schleift jedes Paket hostintern zurueck -
 * ganz gleich, ueber welche Karte es hinausging. Die Pruefung unten
 * wird also auch dann gruen, wenn gar keine echte Karte benutzt wird.
 * Genau daran ist der Fehler lange vorbeigekommen: gerufen wurde auf
 * einer toten 169.254-Karte, die Pruefungen sagten trotzdem "passt",
 * und im echten Netz fand sich niemand.
 *
 * Hier wird deshalb nicht gehorcht, sondern nachgesehen, WO beigetreten
 * wurde - das laesst sich ohne Netz und ohne Wackeln festnageln.
 */
test('der Rundruf tritt auf jeder Karte bei, die eine Gruppe annimmt - nicht nur auf der, die das System waehlt', async (t) => {
  const alle = discovery.karten();
  if (!alle.length) {
    t.skip('dieser Rechner hat keine nicht-interne IPv4-Karte - dann greift der Notnagel, und das ist richtig so');
    return;
  }

  // Kontrollgruppe: auf einem eigenen Socket ausprobieren, welche Karten
  // eine Mitgliedschaft ueberhaupt annehmen. Nicht jede tut das -
  // abgeschaltete Adapter, virtuelle Bruecken ohne Multicast. Genau die
  // annehmenden, und keine andere, muss der Rundruf erwischt haben.
  const moeglich = await new Promise((resolve) => {
    const probe = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    probe.bind(0, () => {
      const geht = [];
      for (const adresse of alle) {
        try {
          probe.addMembership(discovery.GROUP, adresse);
          geht.push(adresse);
        } catch { /* diese Karte nimmt keine Gruppe an */ }
      }
      probe.close(() => resolve(geht));
    });
  });

  if (!moeglich.length) {
    t.skip('keine Karte dieses Rechners nimmt eine Multicast-Gruppe an');
    return;
  }

  const beacon = await discovery.start({ identity: identity.create(), port: 51003, name: 'Kartenprobe', onChange: () => {} });
  t.after(() => beacon.stop());

  assert.deepEqual(
    [...beacon.karten].sort(),
    [...moeglich].sort(),
    'der Rundruf hat nicht genau die Karten erwischt, die eine Gruppe annehmen'
  );
});

/* ------------------------ Der echte Rundruf ------------------------ */

test('zwei Geraete im Netz finden sich ueber den echten Rundruf', async (t) => {
  const A = identity.create();
  const B = identity.create();

  const beaconA = await discovery.start({ identity: A, port: 51001, name: 'Alpha', onChange: () => {} });
  const beaconB = await discovery.start({ identity: B, port: 51002, name: 'Beta', onChange: () => {} });
  t.after(() => { beaconA.stop(); beaconB.stop(); });

  // Im Abstand von 100 ms gezielt nach der Gegenstelle Ausschau halten
  // (nicht nach "irgendjemand ist da") - oder nach 8 Sekunden mit einem
  // klaren Fehlschlag aufgeben. Sonst faellt der Test um, sobald sonst
  // noch ein SNAPKEY-Knoten im selben Netz mitlaeuft, obwohl Alpha und
  // Beta sich sehr wohl gefunden haben. Kein stillschweigendes
  // Uebergehen bleibt trotzdem: findet A den B (oder umgekehrt) nicht,
  // soll der Test das weiterhin scharf melden.
  const deadline = Date.now() + 8000;
  let gesehenVonA = null;
  let gesehenVonB = null;
  while (Date.now() < deadline) {
    gesehenVonA = beaconA.peers.find((p) => p.address === B.address) || null;
    gesehenVonB = beaconB.peers.find((p) => p.address === A.address) || null;
    if (gesehenVonA && gesehenVonB) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Auf den macOS-Laeufern der CI ist Multicast gesperrt - dort kann sich
  // nichts finden, egal wie richtig der Code ist. Das zu uebergehen waere
  // falsch, also wird es benannt und uebersprungen, statt einen
  // Fehlschlag vorzutaeuschen oder zu verschweigen. Auf einem echten
  // Rechner - dort, wo es zaehlt - bleibt die Pruefung scharf.
  if (!gesehenVonA && !gesehenVonB && process.env.CI) {
    t.skip('Multicast ist auf diesem Laeufer gesperrt - hier nicht pruefbar');
    return;
  }

  assert.ok(gesehenVonA, 'Alpha hat Beta nicht gefunden - Multicast geht in dieser Umgebung nicht');
  assert.ok(gesehenVonB, 'Beta hat Alpha nicht gefunden - Multicast geht in dieser Umgebung nicht');

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

/* --------------------- Rufen: von selbst oder auf Knopf --------------------- */

/** Wartet, bis `pruefen()` wahr wird - oder gibt nach `ms` auf. */
async function warteBis(pruefen, ms = 6000) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (pruefen()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pruefen();
}

test('ein stiller Rundruf hoert zu, ohne sich zu zeigen - bis man ihn einmal rufen laesst', async (t) => {
  const A = identity.create();
  const B = identity.create();

  const stiller = await discovery.start({ identity: A, port: 51011, name: 'Stiller', auto: false, onChange: () => {} });
  const rufer = await discovery.start({ identity: B, port: 51012, name: 'Rufer', onChange: () => {} });
  t.after(() => { stiller.stop(); rufer.stop(); });

  assert.equal(stiller.auto, false);
  assert.equal(rufer.auto, true);

  // Zuhoeren kostet kein Rufen: der Stille sieht den anderen sehr wohl.
  const gehoert = await warteBis(() => stiller.peers.some((p) => p.address === B.address));

  // Auf den macOS-Laeufern der CI ist Multicast gesperrt - dort kann sich
  // nichts finden, egal wie richtig der Code ist. Benannt und
  // uebersprungen, nicht stillschweigend uebergangen.
  if (!gehoert && process.env.CI) {
    t.skip('Multicast ist auf diesem Laeufer gesperrt - hier nicht pruefbar');
    return;
  }
  assert.ok(gehoert, 'der Stille hat den Rufer nicht gehoert, obwohl Zuhoeren kein Rufen voraussetzt');

  // Umgekehrt nicht: wer nicht ruft, steht bei niemandem in der Liste.
  assert.equal(
    rufer.peers.some((p) => p.address === A.address),
    false,
    'der Stille war zu sehen, obwohl er nie gerufen hat'
  );

  // Ein einziger Ruf genuegt, um sichtbar zu werden - das ist der Knopf.
  stiller.jetztRufen();
  assert.ok(
    await warteBis(() => rufer.peers.some((p) => p.address === A.address)),
    'nach jetztRufen() war der Stille immer noch nicht zu sehen'
  );
});

test('wer den Ruf abschaltet, verschwindet sofort bei den anderen - nicht erst nach dem Verfall', async (t) => {
  const A = identity.create();
  const B = identity.create();

  const einer = await discovery.start({ identity: A, port: 51013, name: 'Einer', onChange: () => {} });
  const andrer = await discovery.start({ identity: B, port: 51014, name: 'Andrer', onChange: () => {} });
  t.after(() => { einer.stop(); andrer.stop(); });

  const gesehen = await warteBis(() => andrer.peers.some((p) => p.address === A.address));
  if (!gesehen && process.env.CI) {
    t.skip('Multicast ist auf diesem Laeufer gesperrt - hier nicht pruefbar');
    return;
  }
  assert.ok(gesehen, 'die beiden haben sich gar nicht erst gefunden');

  assert.equal(einer.setAuto(false), false);
  assert.equal(einer.auto, false);

  // Die Frist ist knapp gewaehlt: STALE_MS betraegt zehn Sekunden. Wer
  // hier innerhalb von drei verschwindet, ist abgemeldet worden und
  // nicht bloss verfallen - genau das soll geprueft sein.
  assert.ok(
    await warteBis(() => !andrer.peers.some((p) => p.address === A.address), 3000),
    'der Abgeschaltete stand immer noch in der Liste - der Abschied ging nicht raus'
  );

  // Und zurueck: Anschalten ruft sofort, statt bis zum naechsten Takt zu warten.
  assert.equal(einer.setAuto(true), true);
  assert.ok(
    await warteBis(() => andrer.peers.some((p) => p.address === A.address)),
    'nach dem Anschalten kam der Ruf nicht wieder'
  );
});
