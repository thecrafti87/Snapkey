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
const { sha256 } = require('../src/core/crypto');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-chunks-'));
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

/* --------------------- Blockwiedererkennung: indexBlocks --------------------- */

test('indexBlocks findet Bloecke anhand ihrer Pruefsumme', async (t) => {
  const dir = tempdir(t);
  const root = path.join(dir, 'daten');
  const inhaltA = MUSTER(chunks.CHUNK_SIZE, 11);
  const inhaltB = MUSTER(chunks.CHUNK_SIZE, 22);
  schreibe(path.join(root, 'a.bin'), inhaltA);
  schreibe(path.join(root, 'b.bin'), inhaltB);
  const hexA = sha256(inhaltA).toString('hex');
  const hexB = sha256(inhaltB).toString('hex');

  await t.test('ein Block, der in einer anderen Datei liegt, wird gefunden', () => {
    const { found, truncated } = chunks.indexBlocks(root, new Set([hexA]));
    assert.equal(truncated, false);
    const treffer = found.get(hexA);
    assert.ok(treffer, 'der Block wurde nicht gefunden');
    assert.equal(treffer.abs, path.join(root, 'a.bin'));
    assert.equal(treffer.index, 0);
  });

  await t.test('die Suche hoert auf, sobald alles gefunden ist', () => {
    // "a.bin" kommt beim Scannen zuerst (alphabetisch) - ist der
    // gesuchte Block schon dort, wird "b.bin" gar nicht mehr angefasst.
    const { scanned } = chunks.indexBlocks(root, new Set([hexA]));
    const gesamt = chunks.scan([root]).reduce((n, f) => n + f.size, 0);
    assert.ok(scanned < gesamt, 'es wurde mehr gelesen, als noetig gewesen waere');
  });

  await t.test('truncated, wenn maxBytes zu klein gesetzt wird', () => {
    // Der gesuchte Block liegt in "b.bin" - "a.bin" muss dafuer schon
    // komplett gelesen werden, und danach ist maxBytes ausgeschoepft.
    const { truncated, found } = chunks.indexBlocks(root, new Set([hexB]), { maxBytes: chunks.CHUNK_SIZE / 2 });
    assert.equal(truncated, true);
    assert.equal(found.size, 0, 'trotz Abbruch faelschlich etwas gemeldet');
  });

  await t.test('ein Block, der nirgends passt, bleibt ungefunden', () => {
    const irgendwas = sha256(Buffer.from('kommt hier nicht vor')).toString('hex');
    const { found } = chunks.indexBlocks(root, new Set([irgendwas]));
    assert.equal(found.size, 0);
  });
});

/* ----------------------- Blockwiedererkennung: recover ----------------------- */

test('recover holt vorhandene Bloecke, statt sie erneut anzufordern', async (t) => {
  await t.test('eine umbenannte Datei wird zurueckgeholt, ohne dass ein Byte fehlt', () => {
    const dir = tempdir(t);
    const root = path.join(dir, 'daten');
    const inhalt = MUSTER(2.5 * chunks.CHUNK_SIZE, 5);
    schreibe(path.join(root, 'original.bin'), inhalt);
    const manifest = chunks.buildManifest(chunks.scan([root]));

    const ziel = path.join(dir, 'ziel');
    // Beim Empfaenger liegt genau dieser Inhalt schon - nur unter
    // einem anderen Namen, so wie nach einem Umbenennen oder Verschieben.
    schreibe(path.join(ziel, 'daten', 'umbenannt.bin'), inhalt);

    const { want: fehlend } = chunks.missing(manifest, ziel);
    assert.equal(fehlend.length, 3, 'die Datei unter dem erwarteten Namen fehlt komplett');

    const ergebnis = chunks.recover(manifest, ziel, fehlend);
    assert.equal(ergebnis.want.length, 0, 'es sollte nichts mehr fehlen');
    assert.equal(ergebnis.recovered, 3);
    assert.ok(fs.readFileSync(path.join(ziel, 'daten', 'original.bin')).equals(inhalt));
  });

  await t.test('Selbstbezug: zwei gleiche Bloecke kommen aus derselben verschobenen Quelle', () => {
    const dir = tempdir(t);
    const root = path.join(dir, 'daten');
    const stueck = MUSTER(chunks.CHUNK_SIZE, 42);
    const mitte = MUSTER(chunks.CHUNK_SIZE, 9);
    // Block 0 und Block 2 sind absichtlich gleich.
    const inhalt = Buffer.concat([stueck, mitte, stueck]);
    schreibe(path.join(root, 'original.bin'), inhalt);
    const manifest = chunks.buildManifest(chunks.scan([root]));
    assert.equal(manifest.files[0].chunks[0], manifest.files[0].chunks[2], 'Testaufbau: Bloecke muessten gleich sein');

    const ziel = path.join(dir, 'ziel');
    schreibe(path.join(ziel, 'daten', 'verschoben.bin'), inhalt);

    const { want: fehlend } = chunks.missing(manifest, ziel);
    assert.equal(fehlend.length, 3);

    const ergebnis = chunks.recover(manifest, ziel, fehlend);
    assert.equal(ergebnis.want.length, 0);
    assert.equal(ergebnis.recovered, 3);
    assert.ok(fs.readFileSync(path.join(ziel, 'daten', 'original.bin')).equals(inhalt),
      'nach dem Wiederherstellen muss der Inhalt vollstaendig und korrekt sein');
  });

  await t.test('veralteter Index: ein Block wird uebersprungen statt falsch kopiert', () => {
    const dir = tempdir(t);
    const CS = chunks.CHUNK_SIZE;
    const c0 = MUSTER(CS, 10);
    const c1 = MUSTER(CS, 20);
    const c2 = MUSTER(CS, 30);
    const w0 = MUSTER(CS, 40); // an Position 0 im Zielordner: falsch
    const w2 = MUSTER(CS, 50); // an Position 2 im Zielordner: falsch

    const root = path.join(dir, 'daten');
    schreibe(path.join(root, 'gross.bin'), Buffer.concat([c0, c1, c2]));
    const manifest = chunks.buildManifest(chunks.scan([root]));

    const ziel = path.join(dir, 'ziel');
    const zielGross = path.join(ziel, ...manifest.files[0].name.split('/'));
    // Position 1 haelt im Zielordner zufaellig schon den Inhalt von
    // Block 2 - das ist der Zeitpunkt, den indexBlocks sieht.
    schreibe(zielGross, Buffer.concat([w0, c2, w2]));
    // Block 1 selbst liegt unversehrt an ganz anderer Stelle.
    schreibe(path.join(ziel, 'anderswo', 'ersatz.bin'), c1);

    const { want: fehlend } = chunks.missing(manifest, ziel);
    assert.equal(fehlend.length, 3, 'keine der drei Positionen stimmt bisher');

    const ergebnis = chunks.recover(manifest, ziel, fehlend);

    // Block 1 wird aus "ersatz.bin" geholt - dabei wird Position 1 in
    // "gross.bin" ueberschrieben. Der Index fuer Block 2 zeigte aber
    // genau auf diese Position: die erneute Pruefsumme dort passt jetzt
    // nicht mehr, also bleibt Block 2 in der Wunschliste statt falsch
    // aus der (nun veraenderten) Stelle kopiert zu werden.
    assert.equal(ergebnis.recovered, 1, 'nur Block 1 liess sich wirklich wiederherstellen');
    assert.deepEqual(ergebnis.want.map((w) => w.chunkIndex).sort(), [0, 2]);

    const nachher = fs.readFileSync(zielGross);
    assert.ok(nachher.subarray(CS, 2 * CS).equals(c1), 'Block 1 wurde korrekt nachgetragen');
    assert.ok(nachher.subarray(2 * CS).equals(w2), 'Block 2 wurde nicht faelschlich ueberschrieben');
  });

  await t.test('ein Block, dessen Pruefsumme nirgends passt, bleibt in der Wunschliste', () => {
    const dir = tempdir(t);
    const root = path.join(dir, 'daten');
    schreibe(path.join(root, 'x.bin'), MUSTER(chunks.CHUNK_SIZE, 77));
    const manifest = chunks.buildManifest(chunks.scan([root]));

    const ziel = path.join(dir, 'ziel');
    fs.mkdirSync(ziel, { recursive: true }); // leer - da ist nichts zu finden

    const fehlend = [{ fileIndex: 0, chunkIndex: 0 }];
    const ergebnis = chunks.recover(manifest, ziel, fehlend);
    assert.deepEqual(ergebnis.want, fehlend);
    assert.equal(ergebnis.recovered, 0);
  });
});
