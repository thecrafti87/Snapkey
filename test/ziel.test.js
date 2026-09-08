'use strict';

/* =================================================================
   Eine Gegenstelle von Hand angeben.

   Der Parser entscheidet hier ueber mehr als Bequemlichkeit: die
   laengere Form nennt die Anschrift mit, und nur dann steht im Voraus
   fest, wer am anderen Ende erwartet wird. Faellt sie stillschweigend
   auf den blossen Ort zurueck, waere die Pruefung weg, ohne dass es
   jemandem auffaellt. Genau das wird hier festgenagelt.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDirekt, direktText } = require('../app/ziel');
const identity = require('../src/core/identity');

/* --------------------------- Der blosse Ort --------------------------- */

test('Adresse und Port werden gelesen', () => {
  assert.deepEqual(parseDirekt('192.168.178.54:51877'), { host: '192.168.178.54', port: 51877 });
  assert.deepEqual(parseDirekt('  192.168.178.54:51877  '), { host: '192.168.178.54', port: 51877 });
  assert.deepEqual(parseDirekt('mein-rechner:41998'), { host: 'mein-rechner', port: 41998 });
});

test('IPv6 gehoert in Klammern - sonst waere der Port nicht zu erkennen', () => {
  assert.deepEqual(parseDirekt('[fe80::1]:51877'), { host: 'fe80::1', port: 51877 });
  // Ohne Klammern ist nicht entscheidbar, was Adresse und was Port ist.
  assert.equal(parseDirekt('fe80::1:51877'), null);
});

test('was keine unmittelbare Adresse ist, ergibt null statt einer Vermutung', (t) => {
  const me = identity.create();
  const faelle = [
    ['leer', ''],
    ['nur Leerzeichen', '   '],
    ['eine blosse Anschrift', me.address],
    ['eine Anschrift mit Schema', me.uri],
    ['ein Geraetename', 'MacBook von Benni'],
    ['Adresse ohne Port', '192.168.178.54'],
    ['Port ist Text', '192.168.178.54:abc'],
    ['Port null', '192.168.178.54:0'],
    ['Port zu gross', '192.168.178.54:70000'],
    ['nur ein Port', ':51877'],
    ['Leerzeichen mittendrin', '192.168.178.54 :51877']
  ];
  for (const [was, eingabe] of faelle) {
    assert.equal(parseDirekt(eingabe), null, was);
  }
});

/* ------------------- Ort MIT Anschrift: die geprüfte Form ------------------- */

test('mit vorangestellter Anschrift kommt sie mit heraus', () => {
  const me = identity.create();

  const mitSchema = parseDirekt(`${me.uri}@192.168.178.54:51877`);
  assert.deepEqual(mitSchema, { host: '192.168.178.54', port: 51877, address: me.address });

  // Auch ohne "snapkey:" davor - abgetippt wird selten vollstaendig.
  const ohneSchema = parseDirekt(`${me.address}@192.168.178.54:51877`);
  assert.deepEqual(ohneSchema, { host: '192.168.178.54', port: 51877, address: me.address });
});

test('ein "@" mit unbrauchbarer Anschrift faellt NICHT still auf den blossen Ort zurueck', () => {
  // Das ist der Kern: wer eine Anschrift mitschickt, verlangt damit die
  // Pruefung. Sie wegen eines Tippfehlers wortlos fallen zu lassen,
  // waere ein Sicherheitsverlust, den niemand bemerkt - lieber gar
  // nichts verstehen und den Menschen fragen lassen.
  assert.equal(parseDirekt('nicht-mal-eine-anschrift@192.168.178.54:51877'), null);
  assert.equal(parseDirekt('@192.168.178.54:51877'), null);

  const me = identity.create();
  const verdreht = me.address.split('-').slice(0, 5).join('-');   // ein Wort zu wenig
  assert.equal(parseDirekt(`${verdreht}@192.168.178.54:51877`), null);
});

/* ---------------------------- Die Gegenprobe ---------------------------- */

test('was direktText baut, liest parseDirekt wieder ein', () => {
  const me = identity.create();
  const zeile = direktText(me.address, '192.168.178.23', 51877);

  assert.match(zeile, /^snapkey:/);
  assert.deepEqual(parseDirekt(zeile), {
    host: '192.168.178.23',
    port: 51877,
    address: me.address
  });
});

test('die gebaute Zeile traegt die Anschrift - ohne sie waere sie die halbe Miete', () => {
  const me = identity.create();
  const zeile = direktText(me.address, '10.0.0.7', 41998);
  assert.ok(zeile.includes(me.address), 'die Anschrift fehlt in der Zeile');
  assert.ok(zeile.includes('10.0.0.7:41998'), 'der Ort fehlt in der Zeile');
});
