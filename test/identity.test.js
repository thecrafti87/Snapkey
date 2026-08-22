'use strict';

/* =================================================================
   Kennung und Vertrauen.

   Die Anschrift wird vorgelesen, abgetippt, durch Chatfenster
   geschoben und in Grossbuchstaben zurueckgeschickt. Sie muss das
   aushalten. Und der Fall, auf den es wirklich ankommt, steht ganz
   unten: gleiche Anschrift, anderer Schluessel.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const id = require('../src/core/identity');
const { WORDS } = require('../src/core/words');

test('eine frische Kennung ist vollstaendig', () => {
  const me = id.create();
  assert.equal(me.pub.length, 32);
  assert.equal(me.priv.length, 32);
  assert.equal(me.address.split('-').length, id.ADDRESS_WORDS);
  assert.equal(me.uri, `snapkey:${me.address}`);
  assert.ok(me.fingerprint.length > 0);
});

test('die Anschrift haengt am Schluessel', async (t) => {
  const me = id.create();

  await t.test('derselbe Schluessel, dieselbe Anschrift', () => {
    assert.equal(id.addressOf(me.pub), me.address);
  });

  await t.test('ein anderer Schluessel, eine andere Anschrift', () => {
    const andere = new Set(Array.from({ length: 50 }, () => id.create().address));
    assert.equal(andere.size, 50);
  });

  await t.test('nur Woerter aus der Liste', () => {
    for (const wort of me.address.split('-')) assert.ok(WORDS.includes(wort), wort);
  });

  await t.test('genug Adressraum, um sich nicht ins Gehege zu kommen', () => {
    assert.ok(id.ADDRESS_BITS >= 48, `nur ${id.ADDRESS_BITS} Bit`);
  });
});

test('die Anschrift ueberlebt den Weg durch ein Chatfenster', async (t) => {
  const me = id.create();

  await t.test('mit und ohne Vorsatz', () => {
    assert.equal(id.parseAddress(me.uri), me.address);
    assert.equal(id.parseAddress(me.address), me.address);
  });

  await t.test('Grossbuchstaben, Leerzeichen, Rand', () => {
    const zerzaust = `  ${me.uri.toUpperCase().replace(/-/g, ' ')}  `;
    assert.equal(id.parseAddress(zerzaust), me.address);
  });

  await t.test('was keine Anschrift ist, wird auch nicht dafuer gehalten', () => {
    for (const mist of ['', 'hallo', 'a-b-c', `${me.address}-extra`, 'gibt-es-nicht-so-ein-wort', null]) {
      assert.equal(id.parseAddress(mist), null, JSON.stringify(mist));
    }
  });

  await t.test('ein vertipptes Wort faellt auf', () => {
    const teile = me.address.split('-');
    teile[2] = teile[2] === 'anker' ? 'apfel' : 'anker';
    const vertippt = teile.join('-');
    // Es ist eine gueltige Form, aber nicht mehr dieselbe Anschrift.
    assert.notEqual(id.parseAddress(vertippt), me.address);
    assert.equal(id.addressMatches(vertippt, me.pub), false);
  });
});

test('Anschrift und Schluessel lassen sich gegeneinander pruefen', () => {
  const me = id.create();
  const fremd = id.create();
  assert.equal(id.addressMatches(me.uri, me.pub), true);
  assert.equal(id.addressMatches(me.uri, fremd.pub), false);
  assert.equal(id.addressMatches('unfug', me.pub), false);
});

test('die Anschrift verraet den Schluessel nicht', () => {
  // Sie ist die Kurzform einer Pruefsumme, nicht der Schluessel selbst.
  const me = id.create();
  const roh = me.pub.toString('hex');
  for (const wort of me.address.split('-')) {
    assert.ok(!roh.includes(Buffer.from(wort).toString('hex')));
  }
});

test('Vertrauen beim ersten Kontakt', async (t) => {
  const me = id.create();
  const store = id.makeStore();

  await t.test('der erste Kontakt wird gelernt', () => {
    assert.deepEqual(store.remember(me.address, me.pub, 'Sebastian'), { status: 'new' });
    assert.ok(store.get(me.address).pub.equals(me.pub));
  });

  await t.test('beim zweiten Mal ist es derselbe', () => {
    assert.equal(store.remember(me.address, me.pub).status, 'known');
  });

  await t.test('gleiche Anschrift, anderer Schluessel: anhalten', () => {
    // Entweder hat die Gegenstelle neu installiert, oder jemand setzt
    // sich dazwischen. Das kann das Programm nicht entscheiden - also
    // entscheidet es nicht, sondern meldet.
    const angreifer = id.create();
    const res = store.remember(me.address, angreifer.pub);
    assert.equal(res.status, 'changed');
    // Der gemerkte Schluessel bleibt der alte, bis ein Mensch zustimmt.
    assert.ok(store.get(me.address).pub.equals(me.pub));
  });

  await t.test('vergessen geht auch', () => {
    assert.equal(store.forget(me.address), true);
    assert.equal(store.get(me.address), null);
  });
});

test('gemerkte Gegenstellen ueberleben einen Neustart', () => {
  const me = id.create();
  const erst = id.makeStore();
  erst.remember(me.address, me.pub, 'Anna');

  // So, wie es aus einer Datei zurueckkaeme.
  const wieder = id.makeStore(JSON.parse(JSON.stringify(erst.list())).map((p) => ({
    ...p, pub: Buffer.from(p.pub.data || p.pub)
  })));
  assert.equal(wieder.remember(me.address, me.pub).status, 'known');
  assert.equal(wieder.get(me.address).name, 'Anna');
});
