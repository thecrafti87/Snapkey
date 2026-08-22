'use strict';

/* =================================================================
   Von Kaiman zu SNAPKEY - kein Rest.

   Zwei Seiten einer Verbindung muessen exakt dieselben Protokoll-
   konstanten lesen, sonst passen die Schluessel nicht mehr zusammen.
   Diese Pruefung haelt fest, dass die Umbenennung vollstaendig war:
   ueberall "snapkey", nirgends mehr "kaiman".
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../src/core/identity');
const handshake = require('../src/core/handshake');
const discovery = require('../src/net/discovery');

test('die Protokollkonstanten heissen snapkey, nirgends mehr kaiman', () => {
  assert.equal(identity.SCHEME, 'snapkey');
  assert.doesNotMatch(identity.SCHEME, /kaiman/i);

  assert.ok(handshake.PROTO.toString('utf8').startsWith('snapkey-'));
  assert.doesNotMatch(handshake.PROTO.toString('utf8'), /kaiman/i);

  const me = identity.create();
  const ankuendigung = discovery.announcement({ address: me.address, pub: me.pub, port: 4321 });
  const gelesen = discovery.parse(ankuendigung);
  assert.ok(gelesen, 'die eigene Ankuendigung liess sich nicht lesen');
  assert.doesNotMatch(ankuendigung.toString('utf8'), /kaiman/i);
  assert.match(ankuendigung.toString('utf8'), /snapkey-hello-v1/);
});

test('eine erzeugte Anschrift beginnt mit snapkey: und wird wieder angenommen', () => {
  const me = identity.create();
  assert.ok(me.uri.startsWith('snapkey:'));
  assert.equal(identity.parseAddress(me.uri), me.address);
});
