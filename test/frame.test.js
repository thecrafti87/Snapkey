'use strict';

/* =================================================================
   Das Rahmenformat.

   Fast alles hier prueft denselben Gedanken aus verschiedenen
   Richtungen: ein Datenstrom haelt sich nicht an Paketgrenzen. Was in
   einem Stueck losgeschickt wurde, kommt in dreien an - oder drei
   Pakete kommen in einem. Wer das nicht aushaelt, funktioniert im Test
   und faellt draussen um.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const f = require('../src/core/frame');

const einlesen = (decoder, bytes) => decoder.push(bytes).map((p) => f.split(p));

test('Steuernachrichten fahren als JSON', () => {
  const d = new f.Decoder();
  const [paket] = einlesen(d, f.pack(f.control({ t: 'want', want: [1, 2, 3] })));
  assert.equal(paket.type, f.CONTROL);
  assert.deepEqual(f.readControl(paket.body), { t: 'want', want: [1, 2, 3] });
});

test('Bloecke fahren roh', () => {
  const daten = Buffer.from([1, 2, 3, 4, 5]);
  const d = new f.Decoder();
  const [paket] = einlesen(d, f.pack(f.chunk(7, 42, daten)));

  assert.equal(paket.type, f.CHUNK);
  const teil = f.readChunk(paket.body);
  assert.equal(teil.fileIndex, 7);
  assert.equal(teil.chunkIndex, 42);
  assert.ok(teil.data.equals(daten));
});

test('ein Paket in Stuecken', async (t) => {
  await t.test('Byte fuer Byte zugestellt', () => {
    const ganz = f.pack(f.control({ t: 'hallo' }));
    const d = new f.Decoder();

    for (let i = 0; i < ganz.length - 1; i++) {
      assert.deepEqual(d.push(ganz.subarray(i, i + 1)), [], `bei Byte ${i} kam zu früh etwas`);
    }
    const fertig = d.push(ganz.subarray(ganz.length - 1));
    assert.equal(fertig.length, 1);
    assert.equal(d.pending, 0);
  });

  await t.test('die Laengenangabe selbst gestueckelt', () => {
    // Die vier Bytes vorn koennen auch mitten durchgeschnitten ankommen.
    const ganz = f.pack(f.control({ t: 'x' }));
    const d = new f.Decoder();
    assert.deepEqual(d.push(ganz.subarray(0, 2)), []);
    assert.equal(d.push(ganz.subarray(2)).length, 1);
  });
});

test('mehrere Pakete in einem Stueck', () => {
  const strom = Buffer.concat([
    f.pack(f.control({ n: 1 })),
    f.pack(f.control({ n: 2 })),
    f.pack(f.chunk(0, 0, Buffer.from('abc')))
  ]);
  const d = new f.Decoder();
  const pakete = einlesen(d, strom);

  assert.equal(pakete.length, 3);
  assert.deepEqual(f.readControl(pakete[0].body), { n: 1 });
  assert.deepEqual(f.readControl(pakete[1].body), { n: 2 });
  assert.equal(pakete[2].type, f.CHUNK);
  assert.equal(d.pending, 0);
});

test('ein angefangenes Paket bleibt liegen, bis es voll ist', () => {
  const zwei = Buffer.concat([f.pack(f.control({ n: 1 })), f.pack(f.control({ n: 2 }))]);
  const d = new f.Decoder();
  const erste = d.push(zwei.subarray(0, zwei.length - 3));
  assert.equal(erste.length, 1);
  assert.ok(d.pending > 0);
  assert.equal(d.push(zwei.subarray(zwei.length - 3)).length, 1);
});

test('eine unmoegliche Laengenangabe wird abgewiesen', () => {
  // Ohne diese Grenze koennte ein Fremder mit vier Bytes eine
  // Speicheranforderung ueber Gigabyte ausloesen.
  const boese = Buffer.alloc(8);
  boese.writeUInt32BE(0xfffffff0, 0);
  assert.throws(() => new f.Decoder().push(boese), RangeError);

  const null_ = Buffer.alloc(8);
  null_.writeUInt32BE(0, 0);
  assert.throws(() => new f.Decoder().push(null_), RangeError);
});

test('unlesbare Steuernachrichten ergeben null, keinen Absturz', () => {
  assert.equal(f.readControl(Buffer.from('kein json')), null);
  assert.equal(f.readControl(Buffer.from('"nur ein text"')), null);
  assert.equal(f.readChunk(Buffer.from([1, 2])), null);
});

test('ein leerer Block ist ein gueltiger Block', () => {
  // Leere Dateien gibt es, und sie haben genau einen Block der Laenge 0.
  const d = new f.Decoder();
  const [paket] = einlesen(d, f.pack(f.chunk(0, 0, Buffer.alloc(0))));
  assert.equal(f.readChunk(paket.body).data.length, 0);
});

test('ein grosser Block ueberlebt kleine Stuecke', () => {
  const daten = Buffer.alloc(700 * 1024, 9);
  const ganz = f.pack(f.chunk(1, 2, daten));
  const d = new f.Decoder();

  let fertig = [];
  for (let at = 0; at < ganz.length; at += 4096) {
    fertig = fertig.concat(d.push(ganz.subarray(at, at + 4096)));
  }
  assert.equal(fertig.length, 1);
  assert.ok(f.readChunk(f.split(fertig[0]).body).data.equals(daten));
});
