'use strict';

/* =================================================================
   Das Rahmenformat.

   Ein Datenstrom kennt keine Grenzen - was als ein Paket losgeschickt
   wurde, kommt womoeglich in drei Stuecken an, oder drei Pakete kommen
   in einem. Deshalb bekommt jedes Paket seine Laenge vorangestellt, und
   der Leser sammelt so lange, bis eines vollstaendig ist.

     [4 Byte Laenge][Inhalt]

   Was im Inhalt steht, entscheidet die Schicht darueber: waehrend des
   Handschlags Klartext, danach ein versiegeltes Paket. Die Laenge liegt
   bewusst aussen und unverschluesselt - man muss wissen, wie viel zu
   lesen ist, bevor man etwas entschluesseln kann.

   Der Inhalt selbst ist immer [1 Byte Art][Rumpf]. Zwei Arten, aus
   einem Grund: Steuerung faehrt als JSON, weil sie selten und klein ist
   und sich leicht erweitern laesst. Nutzdaten fahren roh, weil JSON sie
   um ein Drittel aufblaehen wuerde.
   ================================================================= */

const CONTROL = 1;
const CHUNK = 2;

const HEADER = 4;

// Ein Paket, das groesser ist, kann keines von uns sein. Ohne diese
// Grenze wuerde eine verstuemmelte Laengenangabe die Gegenstelle dazu
// bringen, Gigabyte an Speicher anzufordern - ein Absturz, den ein
// Fremder von aussen ausloesen koennte.
const MAX_FRAME = 8 * 1024 * 1024;

/** Legt die Laenge davor - das Einzige, was immer im Klartext steht. */
function pack(payload) {
  const out = Buffer.allocUnsafe(HEADER + payload.length);
  out.writeUInt32BE(payload.length, 0);
  Buffer.from(payload).copy(out, HEADER);
  return out;
}

/** Art und Rumpf zu einem Inhalt zusammen. */
function inner(type, body) {
  const out = Buffer.allocUnsafe(1 + body.length);
  out.writeUInt8(type, 0);
  Buffer.from(body).copy(out, 1);
  return out;
}

function split(payload) {
  if (!payload || payload.length < 1) return null;
  return { type: payload.readUInt8(0), body: Buffer.from(payload.subarray(1)) };
}

const control = (obj) => inner(CONTROL, Buffer.from(JSON.stringify(obj), 'utf8'));

/**
 * Ein Datenblock. Datei- und Blocknummer stehen vorn, damit der
 * Empfaenger weiss, wohin er gehoert, ohne den Inhalt zu deuten.
 */
function chunk(fileIndex, chunkIndex, data) {
  const head = Buffer.allocUnsafe(6);
  head.writeUInt16BE(fileIndex, 0);
  head.writeUInt32BE(chunkIndex, 2);
  return inner(CHUNK, Buffer.concat([head, data]));
}

function readControl(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function readChunk(body) {
  if (body.length < 6) return null;
  return {
    fileIndex: body.readUInt16BE(0),
    chunkIndex: body.readUInt32BE(2),
    data: Buffer.from(body.subarray(6))
  };
}

/**
 * Sammelt Bytes, bis ganze Pakete daraus werden.
 *
 * `push` gibt zurueck, was vollstaendig geworden ist - moeglicherweise
 * nichts, moeglicherweise mehrere auf einmal.
 */
class Decoder {
  constructor() {
    // Angesammelt wird als Liste, nicht als ein wachsender Puffer.
    // Ein Buffer.concat je Zustellung sieht harmlos aus und ist es
    // nicht: bei einem Megabyte-Paket in Kilobyte-Stuecken werden
    // hunderte Male hunderte Kilobyte umkopiert. Gemessen hat das einen
    // Testlauf von Sekunden auf sechs Minuten gebracht.
    this.parts = [];
    this.length = 0;
  }

  /** Die ersten `n` Bytes ansehen, ohne sie zu verbrauchen. */
  peek(n) {
    if (this.length < n) return null;
    if (this.parts[0].length >= n) return this.parts[0].subarray(0, n);

    const out = Buffer.allocUnsafe(n);
    let at = 0;
    for (const part of this.parts) {
      const take = Math.min(part.length, n - at);
      part.copy(out, at, 0, take);
      at += take;
      if (at === n) break;
    }
    return out;
  }

  /** Die ersten `n` Bytes herausnehmen. */
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const part = this.parts[0];
      const take = Math.min(part.length, n - at);
      part.copy(out, at, 0, take);
      at += take;
      if (take === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(take);
    }
    this.length -= n;
    return out;
  }

  push(bytes) {
    if (bytes.length) {
      this.parts.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      this.length += bytes.length;
    }

    const out = [];
    for (;;) {
      const header = this.peek(HEADER);
      if (!header) break;

      const length = header.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME) {
        throw new RangeError(`Unmögliche Paketlänge: ${length}`);
      }
      if (this.length < HEADER + length) break;

      this.take(HEADER);
      out.push(this.take(length));
    }
    return out;
  }

  /** Liegt noch ein angefangenes Paket herum? */
  get pending() {
    return this.length;
  }
}

module.exports = {
  CONTROL, CHUNK, MAX_FRAME, HEADER,
  pack, inner, split, control, chunk, readControl, readChunk, Decoder
};
