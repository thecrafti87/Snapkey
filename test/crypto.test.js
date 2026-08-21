'use strict';

/* =================================================================
   Die Bausteine.

   Geprueft wird nicht, ob AES rechnen kann - das tut Node. Geprueft
   wird, ob ich sie richtig zusammengesteckt habe: dass ein veraendertes
   Paket auffliegt, dass Zaehlwerte sich nicht wiederholen, dass zwei
   Richtungen verschiedene Schluessel bekommen.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../src/core/crypto');

test('zwei Seiten kommen auf denselben Wert', () => {
  const a = c.keyPair();
  const b = c.keyPair();
  assert.ok(c.dh(a.priv, a.pub, b.pub).equals(c.dh(b.priv, b.pub, a.pub)));
});

test('jedes Schluesselpaar ist ein anderes', () => {
  const paare = new Set(Array.from({ length: 30 }, () => c.keyPair().pub.toString('hex')));
  assert.equal(paare.size, 30);
});

test('versiegeln und oeffnen', async (t) => {
  const key = c.random(32);
  const klartext = Buffer.from('die Wortgruppe ist der Schlüssel', 'utf8');

  await t.test('was versiegelt wurde, laesst sich oeffnen', () => {
    assert.ok(c.open(key, 7, c.seal(key, 7, klartext)).equals(klartext));
  });

  await t.test('ein veraendertes Paket faellt auf', () => {
    const box = c.seal(key, 0, klartext);
    box[3] ^= 1;
    assert.equal(c.open(key, 0, box), null);
  });

  await t.test('ein abgeschnittenes Paket faellt auf', () => {
    const box = c.seal(key, 0, klartext);
    assert.equal(c.open(key, 0, box.subarray(0, box.length - 1)), null);
  });

  await t.test('mit dem falschen Zaehlwert geht nichts auf', () => {
    // So faellt auch auf, wenn jemand Pakete umsortiert oder wiederholt.
    assert.equal(c.open(key, 1, c.seal(key, 0, klartext)), null);
  });

  await t.test('mit dem falschen Schluessel geht nichts auf', () => {
    assert.equal(c.open(c.random(32), 0, c.seal(key, 0, klartext)), null);
  });

  await t.test('Beiwerk wird mitgeprueft, aber nicht verschluesselt', () => {
    const aad = Buffer.from('daten/gross.bin');
    const box = c.seal(key, 0, klartext, aad);
    assert.ok(c.open(key, 0, box, aad).equals(klartext));
    assert.equal(c.open(key, 0, box, Buffer.from('daten/andere.bin')), null);
  });
});

test('Zaehlwerte wiederholen sich nicht', () => {
  // Bei GCM bricht ein wiederholter Zaehlwert unter demselben Schluessel
  // nicht nur ein Paket, sondern die Vertraulichkeit beider.
  const gesehen = new Set();
  for (const n of [0, 1, 2, 255, 256, 65535, 1e6, Number.MAX_SAFE_INTEGER]) {
    const nonce = c.nonceFor(n).toString('hex');
    assert.equal(gesehen.has(nonce), false, `Zählwert ${n} doppelt`);
    gesehen.add(nonce);
    assert.equal(c.nonceFor(n).length, c.NONCE_BYTES);
  }
});

test('unmoegliche Zaehlwerte werden abgewiesen', () => {
  for (const schlecht of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => c.nonceFor(schlecht), RangeError, `${schlecht} durchgelassen`);
  }
});

test('abgeleitete Schluessel unterscheiden sich nach Verwendung', () => {
  const gemeinsam = c.random(32);
  const salz = c.random(32);
  const hin = c.hkdf(gemeinsam, salz, 'kaiman i2r');
  const her = c.hkdf(gemeinsam, salz, 'kaiman r2i');

  assert.equal(hin.length, 32);
  assert.ok(!hin.equals(her), 'beide Richtungen bekamen denselben Schlüssel');
  // Gleiche Zutaten, gleiches Ergebnis - sonst kaeme keine Gegenstelle mit.
  assert.ok(c.hkdf(gemeinsam, salz, 'kaiman i2r').equals(hin));
});

test('der Vergleich verraet nichts ueber die Zeit', () => {
  const a = Buffer.from('gleich');
  assert.equal(c.equal(a, Buffer.from('gleich')), true);
  assert.equal(c.equal(a, Buffer.from('anders')), false);
  assert.equal(c.equal(a, Buffer.from('kurz')), false);
  assert.equal(c.equal(a, null), false);
});
