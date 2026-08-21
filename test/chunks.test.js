'use strict';

/* =================================================================
   Bloecke und die Frage, was noch fehlt.

   Der Kern dieser Datei ist die Pruefung mit den Nullen: eine
   abgebrochene Uebertragung hinterlaesst eine Datei in exakt richtiger
   Groesse, gefuellt mit Nullen. Groesse und Zeitstempel halten sie fuer
   heil. Genau daran ist croc gescheitert, und genau das darf hier nicht
   passieren.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const chunks = require('../src/core/chunks');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiman-chunks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function schreibe(file, inhalt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, inhalt);
  return file;
}

const MUSTER = (n, b = 7) => Buffer.alloc(n, b);

test('Blockgrenzen', () => {
  assert.equal(chunks.chunkCount(0), 1, 'auch eine leere Datei hat einen Block');
  assert.equal(chunks.chunkCount(1), 1);
  assert.equal(chunks.chunkCount(chunks.CHUNK_SIZE), 1);
  assert.equal(chunks.chunkCount(chunks.CHUNK_SIZE + 1), 2);

  // Der letzte Block ist so lang wie der Rest, nicht voll.
  assert.deepEqual(chunks.span(chunks.CHUNK_SIZE + 100, 1), { start: chunks.CHUNK_SIZE, length: 100 });
});

test('einsammeln', async (t) => {
  const dir = tempdir(t);
  schreibe(path.join(dir, 'daten', 'a.txt'), 'a');
  schreibe(path.join(dir, 'daten', 'unter', 'b.txt'), 'b');
  schreibe(path.join(dir, 'daten', '.DS_Store'), 'x');

  await t.test('Namen mit Schraegstrich, auch unter Windows', () => {
    const namen = chunks.scan([path.join(dir, 'daten')]).map((f) => f.name);
    assert.deepEqual(namen, ['daten/.DS_Store', 'daten/a.txt', 'daten/unter/b.txt']);
    assert.ok(namen.every((n) => !n.includes('\\')));
  });

  await t.test('Ausschluesse greifen als Teilzeichenkette', () => {
    const namen = chunks.scan([path.join(dir, 'daten')], ['.DS_Store']).map((f) => f.name);
    assert.deepEqual(namen, ['daten/a.txt', 'daten/unter/b.txt']);
  });

  await t.test('leere Ausschluesse werfen nicht alles weg', () => {
    // Eine leere Zeichenkette steckt in jedem Pfad.
    assert.equal(chunks.scan([path.join(dir, 'daten')], ['', '  ']).length, 3);
  });
});

test('die Liste deckt jede Datei ab', async (t) => {
  const dir = tempdir(t);
  const root = path.join(dir, 'daten');
  schreibe(path.join(root, 'gross.bin'), MUSTER(2.5 * chunks.CHUNK_SIZE));
  schreibe(path.join(root, 'leer.txt'), '');

  const manifest = chunks.buildManifest(chunks.scan([root]));

  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].chunks.length, 3, 'zweieinhalb Blöcke sind drei');
  assert.equal(manifest.files[1].chunks.length, 1, 'auch die leere Datei hat einen');
  assert.equal(chunks.totalChunks(manifest), 4);
  assert.equal(chunks.totalBytes(manifest), 2.5 * chunks.CHUNK_SIZE);
});

test('was fehlt', async (t) => {
  const dir = tempdir(t);
  const root = path.join(dir, 'daten');
  const inhalt = MUSTER(2.5 * chunks.CHUNK_SIZE);
  schreibe(path.join(root, 'gross.bin'), inhalt);
  const manifest = chunks.buildManifest(chunks.scan([root]));

  await t.test('ein leerer Zielordner braucht alles', () => {
    const ziel = path.join(dir, 'leer');
    fs.mkdirSync(ziel, { recursive: true });
    const { want, have } = chunks.missing(manifest, ziel);
    assert.equal(want.length, 3);
    assert.equal(have, 0);
  });

  await t.test('ein vollstaendiger Zielordner braucht nichts', () => {
    const ziel = path.join(dir, 'voll');
    schreibe(path.join(ziel, 'daten', 'gross.bin'), inhalt);
    const { want, have } = chunks.missing(manifest, ziel);
    assert.deepEqual(want, []);
    assert.equal(have, 3);
  });

  await t.test('eine halb angekommene Datei braucht nur den Rest', () => {
    const ziel = path.join(dir, 'halb');
    schreibe(path.join(ziel, 'daten', 'gross.bin'), inhalt.subarray(0, chunks.CHUNK_SIZE));
    const { want, have } = chunks.missing(manifest, ziel);
    assert.equal(have, 1, 'der fertige Block wurde nicht wiedererkannt');
    assert.deepEqual(want.map((w) => w.chunkIndex), [1, 2]);
  });

  await t.test('richtige Groesse, Nullen darin: kaputt, nicht heil', () => {
    // Der Fall, der die ganze Einrichtung ausgeloest hat.
    const ziel = path.join(dir, 'nullen');
    schreibe(path.join(ziel, 'daten', 'gross.bin'), Buffer.alloc(inhalt.length, 0));
    const { want, have } = chunks.missing(manifest, ziel);
    assert.equal(have, 0);
    assert.equal(want.length, 3);
  });

  await t.test('ein einzelner verdorbener Block wird einzeln nachgefordert', () => {
    const ziel = path.join(dir, 'einer');
    const kaputt = Buffer.from(inhalt);
    kaputt[chunks.CHUNK_SIZE + 5] ^= 0xff;
    schreibe(path.join(ziel, 'daten', 'gross.bin'), kaputt);

    const { want, have } = chunks.missing(manifest, ziel);
    assert.equal(have, 2);
    assert.deepEqual(want.map((w) => w.chunkIndex), [1]);
  });
});

test('hineinlegen', async (t) => {
  const dir = tempdir(t);
  const root = path.join(dir, 'daten');
  const inhalt = MUSTER(2.5 * chunks.CHUNK_SIZE, 3);
  schreibe(path.join(root, 'unter', 'gross.bin'), inhalt);

  const files = chunks.scan([root]);
  const manifest = chunks.buildManifest(files);
  const ziel = path.join(dir, 'ziel');
  fs.mkdirSync(ziel, { recursive: true });

  const fd = fs.openSync(files[0].abs, 'r');
  const block = (i) => chunks.readChunk(fd, files[0].size, i);

  await t.test('Bloecke in beliebiger Reihenfolge', () => {
    const sink = new chunks.Sink(manifest, ziel);
    for (const i of [2, 0, 1]) assert.equal(sink.write(0, i, block(i)), true);
    sink.close();
    assert.ok(fs.readFileSync(path.join(ziel, 'daten', 'unter', 'gross.bin')).equals(inhalt));
  });

  await t.test('Unterordner werden angelegt', () => {
    assert.ok(fs.existsSync(path.join(ziel, 'daten', 'unter')));
  });

  await t.test('ein falscher Block wird abgelehnt, nicht geschrieben', () => {
    const ziel2 = path.join(dir, 'ziel2');
    fs.mkdirSync(ziel2, { recursive: true });
    const sink = new chunks.Sink(manifest, ziel2);

    assert.equal(sink.write(0, 0, MUSTER(chunks.CHUNK_SIZE, 99)), false, 'falscher Inhalt durchgelassen');
    assert.equal(sink.write(0, 0, block(0).subarray(0, 100)), false, 'falsche Länge durchgelassen');
    assert.equal(sink.write(0, 99, block(0)), false, 'unbekannter Block durchgelassen');
    assert.equal(sink.write(9, 0, block(0)), false, 'unbekannte Datei durchgelassen');
    sink.close();
  });

  fs.closeSync(fd);
});

test('eine zu lange Datei wird zurechtgeschnitten', async (t) => {
  // Lag dort vorher etwas Groesseres, bliebe sonst ein Rest stehen.
  const dir = tempdir(t);
  const root = path.join(dir, 'daten');
  schreibe(path.join(root, 'kurz.txt'), 'kurz');
  const files = chunks.scan([root]);
  const manifest = chunks.buildManifest(files);

  const ziel = path.join(dir, 'ziel');
  schreibe(path.join(ziel, 'daten', 'kurz.txt'), 'viel viel laenger als kurz');

  const sink = new chunks.Sink(manifest, ziel);
  assert.equal(sink.write(0, 0, Buffer.from('kurz')), true);
  sink.close();

  assert.equal(fs.readFileSync(path.join(ziel, 'daten', 'kurz.txt'), 'utf8'), 'kurz');
});
