'use strict';

/* =================================================================
   Dateien in Bloecke, und die Frage: was fehlt noch?

   Der wichtigste Entwurfsentscheid steckt in `missing`: der
   Fortsetzungsstand wird NICHT nebenher mitgeschrieben, sondern aus dem
   gelesen, was tatsaechlich auf der Platte liegt. Jeder Block wird
   nachgerechnet und mit der Liste verglichen.

   Das ist langsamer als eine mitgefuehrte Merkdatei - und ueberlebt
   dafuer alles: Absturz, Stromausfall, halb geschriebene Bloecke, eine
   Datei, die jemand zwischendurch angefasst hat. Eine Merkdatei
   behauptet, was da sein sollte. Die Platte weiss, was da ist.

   Genau daran ist croc gescheitert: eine abgebrochene Uebertragung
   hinterlaesst eine Datei in exakt richtiger Groesse voller Nullen.
   Groesse und Zeitstempel halten sie fuer heil - nur Nachrechnen findet
   das, und ein Nullblock stimmt mit keiner Pruefsumme ueberein.
   ================================================================= */

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./crypto');

// Ein Mebibyte. Kleiner hiesse feineres Fortsetzen, aber mehr
// Pruefsummen: 28 GB waeren bei 1 MiB rund 28000 Bloecke und knapp ein
// Megabyte Liste. Feiner lohnt sich erst, wenn Abbrueche die Regel sind.
const CHUNK_SIZE = 1024 * 1024;

const chunkCount = (size) => (size === 0 ? 1 : Math.ceil(size / CHUNK_SIZE));

/** Wo im Datenstrom ein Block liegt und wie lang er ist. */
function span(size, index) {
  const start = index * CHUNK_SIZE;
  return { start, length: Math.max(0, Math.min(CHUNK_SIZE, size - start)) };
}

/* --------------------------- Einsammeln --------------------------- */

/**
 * Alle Dateien unter den gewaehlten Pfaden, mit den Namen, unter denen
 * sie beim Empfaenger liegen werden. Der Name ist immer mit
 * Schraegstrich getrennt - auch unter Windows, wo `path.join` den
 * umgekehrten liefert; sonst passt die Liste nicht zwischen zwei
 * Systemen zusammen.
 */
function scan(roots, excludes = []) {
  const drop = excludes.map((e) => String(e).trim()).filter(Boolean);
  const out = [];

  const walk = (abs, rel) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs).sort()) {
        walk(path.join(abs, entry), `${rel}/${entry}`);
      }
    } else if (st.isFile() && !drop.some((d) => rel.includes(d))) {
      out.push({ abs, name: rel, size: st.size });
    }
  };

  for (const root of roots) walk(root, path.basename(root));
  return out;
}

/* ------------------------------ Liste ------------------------------ */

function readChunk(fd, size, index) {
  const { start, length } = span(size, index);
  const buf = Buffer.allocUnsafe(length);
  if (length === 0) return buf;
  const read = fs.readSync(fd, buf, 0, length, start);
  return read === length ? buf : buf.subarray(0, read);
}

/**
 * Die Blockpruefsummen einer Datei. `onProgress` bekommt gelesene Bytes
 * gemeldet, damit eine Oberflaeche etwas anzeigen kann.
 */
function hashChunks(abs, size, onProgress = () => {}) {
  const fd = fs.openSync(abs, 'r');
  try {
    const hashes = [];
    for (let i = 0; i < chunkCount(size); i++) {
      const data = readChunk(fd, size, i);
      hashes.push(sha256(data).toString('hex'));
      onProgress(data.length);
    }
    return hashes;
  } finally {
    fs.closeSync(fd);
  }
}

/** Die vollstaendige Liste dessen, was uebertragen werden soll. */
function buildManifest(files, onProgress = () => {}) {
  return {
    version: 1,
    chunkSize: CHUNK_SIZE,
    files: files.map((f) => ({
      name: f.name,
      size: f.size,
      chunks: hashChunks(f.abs, f.size, onProgress)
    }))
  };
}

const totalBytes = (manifest) => manifest.files.reduce((n, f) => n + f.size, 0);
const totalChunks = (manifest) => manifest.files.reduce((n, f) => n + f.chunks.length, 0);

/* ---------------------------- Was fehlt ---------------------------- */

/**
 * Vergleicht die Liste mit dem, was im Zielordner liegt.
 *
 * Gibt die Bloecke zurueck, die noch gebraucht werden - beim ersten
 * Anlauf alle, nach einem Abbruch nur den Rest. Loecher in einer Datei
 * lesen sich als Nullen und stimmen mit keiner Pruefsumme ueberein,
 * fallen also von selbst auf.
 */
function missing(manifest, dir, onProgress = () => {}) {
  const want = [];
  let have = 0;

  manifest.files.forEach((file, fileIndex) => {
    const target = path.join(dir, ...file.name.split('/'));

    let fd = null;
    let onDisk = -1;
    try {
      onDisk = fs.statSync(target).size;
      fd = fs.openSync(target, 'r');
    } catch {
      // Gibt es nicht - dann fehlt alles daran.
      file.chunks.forEach((_, chunkIndex) => want.push({ fileIndex, chunkIndex }));
      onProgress(0);
      return;
    }

    try {
      file.chunks.forEach((expected, chunkIndex) => {
        const { start, length } = span(file.size, chunkIndex);
        if (onDisk < start + length) {
          want.push({ fileIndex, chunkIndex });
          return;
        }
        const data = readChunk(fd, file.size, chunkIndex);
        onProgress(data.length);
        if (sha256(data).toString('hex') === expected) have++;
        else want.push({ fileIndex, chunkIndex });
      });
    } finally {
      fs.closeSync(fd);
    }
  });

  return { want, have, total: totalChunks(manifest) };
}

/* --------------------------- Hineinlegen --------------------------- */

/**
 * Nimmt Bloecke entgegen und legt sie an ihren Platz.
 *
 * Geschrieben wird an die richtige Stelle in der Datei, egal in welcher
 * Reihenfolge die Bloecke kommen. Ein Block, dessen Pruefsumme nicht
 * stimmt, wird abgelehnt statt geschrieben - falsche Daten sollen gar
 * nicht erst auf der Platte landen.
 */
class Sink {
  constructor(manifest, dir) {
    this.manifest = manifest;
    this.dir = dir;
    this.open = new Map();
  }

  fdFor(fileIndex) {
    if (this.open.has(fileIndex)) return this.open.get(fileIndex);

    const file = this.manifest.files[fileIndex];
    const target = path.join(this.dir, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // "r+" wuerde eine fehlende Datei ablehnen, "w" eine vorhandene
    // leeren - und damit genau das wegwerfen, was schon angekommen war.
    const fd = fs.openSync(target, fs.existsSync(target) ? 'r+' : 'w+');
    this.open.set(fileIndex, fd);
    return fd;
  }

  /** Legt einen Block ab. Gibt false zurueck, wenn er nicht passt. */
  write(fileIndex, chunkIndex, data) {
    const file = this.manifest.files[fileIndex];
    if (!file) return false;

    const expected = file.chunks[chunkIndex];
    if (!expected) return false;

    const { start, length } = span(file.size, chunkIndex);
    if (data.length !== length) return false;
    if (sha256(data).toString('hex') !== expected) return false;

    if (length > 0) fs.writeSync(this.fdFor(fileIndex), data, 0, length, start);
    else this.fdFor(fileIndex);
    return true;
  }

  /**
   * Schliesst alles ab und schneidet auf die richtige Laenge zurueck -
   * eine Datei, die vorher groesser war, behielte sonst ihren Rest.
   */
  close() {
    for (const [fileIndex, fd] of this.open) {
      try {
        fs.ftruncateSync(fd, this.manifest.files[fileIndex].size);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.open.clear();
  }
}

module.exports = {
  CHUNK_SIZE, chunkCount, span,
  scan, hashChunks, buildManifest, totalBytes, totalChunks,
  missing, readChunk, Sink
};
