'use strict';

/* =================================================================
   Der Handschlag.

   Wichtig ist hier weniger, dass er im guten Fall funktioniert - das
   sieht man ohnehin sofort -, sondern dass er in den schlechten Faellen
   ANHAELT: falscher Schluessel, gefaelschte Bestaetigung, Nachrichten
   in falscher Reihenfolge.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const handshake = require('../src/core/handshake');
const identity = require('../src/core/identity');

/** Laesst beide Seiten miteinander reden, bis sie fertig sind. */
function durchlauf(a, b) {
  let von = a;
  let zu = b;
  let msg = a.hello();

  for (let runde = 0; runde < 6; runde++) {
    const antwort = zu.read(msg);
    if (!antwort) break;
    [von, zu] = [zu, von];
    msg = antwort;
    if (von.done && zu.done) break;
  }
  return { a, b };
}

const paar = (expectA, expectB) => {
  const A = identity.create();
  const B = identity.create();
  return {
    A,
    B,
    anrufer: handshake.create({ identity: A, initiator: true, expect: expectB === undefined ? B.pub : expectB }),
    antwort: handshake.create({ identity: B, initiator: false, expect: expectA === undefined ? A.pub : expectA })
  };
};

test('beide Seiten kommen auf dieselben Schluessel', () => {
  const { anrufer, antwort } = paar();
  durchlauf(anrufer, antwort);

  assert.equal(anrufer.done, true);
  assert.equal(antwort.done, true);

  const x = anrufer.result();
  const y = antwort.result();
  // Was der eine zum Senden nimmt, nimmt der andere zum Lesen.
  assert.ok(x.sendKey.equals(y.recvKey));
  assert.ok(x.recvKey.equals(y.sendKey));
});

test('die Richtungen haben verschiedene Schluessel', () => {
  // Sonst muessten sich beide ueber die Zaehlwerte einig sein, und ein
  // wiederholter Zaehler bricht bei GCM alles auf.
  const { anrufer } = paar();
  const { antwort } = { antwort: null };
  const p = paar();
  durchlauf(p.anrufer, p.antwort);
  const x = p.anrufer.result();
  assert.ok(!x.sendKey.equals(x.recvKey));
  assert.ok(anrufer !== antwort);
});

test('jede Begegnung bekommt eigene Schluessel', () => {
  // Dieselben Dauerschluessel, andere Sitzung - die fluechtigen
  // Schluessel sorgen dafuer, dass ein spaeter gestohlener
  // Dauerschluessel aufgezeichnete Sitzungen nicht oeffnet.
  const A = identity.create();
  const B = identity.create();

  const einmal = () => {
    const a = handshake.create({ identity: A, initiator: true, expect: B.pub });
    const b = handshake.create({ identity: B, initiator: false, expect: A.pub });
    durchlauf(a, b);
    return a.result().sendKey.toString('hex');
  };
  assert.notEqual(einmal(), einmal());
});

test('jede Seite weiss hinterher, mit wem sie gesprochen hat', () => {
  const p = paar();
  durchlauf(p.anrufer, p.antwort);
  assert.ok(p.anrufer.result().peerStatic.equals(p.B.pub));
  assert.ok(p.antwort.result().peerStatic.equals(p.A.pub));
});

test('ein anderer Schluessel als erwartet haelt an', () => {
  const A = identity.create();
  const B = identity.create();
  const fremd = identity.create();

  // Der Anrufer erwartet B - es antwortet ein Fremder.
  const a = handshake.create({ identity: A, initiator: true, expect: B.pub });
  const b = handshake.create({ identity: fremd, initiator: false, expect: A.pub });

  const antwort = b.read(a.hello());
  assert.throws(() => a.read(antwort), (err) => err.code === 'PEER_CHANGED');
});

test('eine gefaelschte Bestaetigung haelt an', () => {
  const A = identity.create();
  const B = identity.create();
  const a = handshake.create({ identity: A, initiator: true, expect: B.pub });
  const b = handshake.create({ identity: B, initiator: false, expect: A.pub });

  const antwort = b.read(a.hello());
  antwort.c = Buffer.alloc(32, 9).toString('base64url');

  assert.throws(() => a.read(antwort), (err) => err.code === 'BAD_CONFIRM');
});

test('beim ersten Kontakt wird gelernt und gemeldet', () => {
  const A = identity.create();
  const B = identity.create();
  const a = handshake.create({ identity: A, initiator: true, expect: null });
  const b = handshake.create({ identity: B, initiator: false, expect: null });

  durchlauf(a, b);
  assert.equal(a.result().firstContact, true);
  assert.equal(b.result().firstContact, true);
  assert.ok(a.result().peerStatic.equals(B.pub));
});

test('Unfug wird abgewiesen, nicht verarbeitet', async (t) => {
  const A = identity.create();

  await t.test('leere Nachricht', () => {
    const a = handshake.create({ identity: A, initiator: false });
    assert.throws(() => a.read(null));
    assert.throws(() => a.read({}));
  });

  await t.test('ein Schluessel falscher Laenge', () => {
    const a = handshake.create({ identity: A, initiator: false });
    assert.throws(() => a.read({ t: 'hello', s: 'AAAA', e: 'AAAA' }), /Ungültiger Schlüssel/);
  });

  await t.test('Bestaetigung vor der Vorstellung', () => {
    const a = handshake.create({ identity: A, initiator: false });
    assert.throws(() => a.read({ t: 'confirm', c: 'AAAA' }));
  });

  await t.test('nach dem Abschluss nimmt niemand mehr etwas an', () => {
    const p = paar();
    durchlauf(p.anrufer, p.antwort);
    assert.throws(() => p.anrufer.read({ t: 'hello' }), /bereits abgeschlossen/);
  });
});

test('vor dem Abschluss gibt es keine Schluessel', () => {
  const A = identity.create();
  const a = handshake.create({ identity: A, initiator: true });
  assert.throws(() => a.result(), /noch nicht abgeschlossen/);
});
