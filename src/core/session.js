'use strict';

/* =================================================================
   Eine Uebertragung, von Anfang bis Ende.

   Der Ablauf ist knapp gehalten, weil jeder zusaetzliche Zustand eine
   zusaetzliche Stelle ist, an der ein Abbruch etwas Halbes hinterlaesst:

     Handschlag  -->  Liste  -->  Bedarf  -->  Bloecke  -->  fertig

   Der Empfaenger sagt, was er braucht. Das klingt umstaendlich - der
   Sender weiss doch, was er hat - ist aber der Grund, warum Fortsetzen
   ohne Zutun funktioniert: nach einem Abbruch faellt der Bedarf beim
   zweiten Anlauf einfach kleiner aus. Es gibt keinen "Wiederaufnahme"-
   Fall im Code, es ist derselbe Weg.

   Diese Datei kennt keine Steckdose. Was die Bytes traegt - ein Kabel,
   ein Datenkanal im Browser, zwei Puffer im Speicher - steht woanders.
   ================================================================= */

const frame = require('./frame');
const chunks = require('./chunks');
const handshake = require('./handshake');
const { seal, open } = require('./crypto');

/**
 * Der verschluesselte Kanal ueber einem beliebigen Transport.
 *
 * Vor dem Handschlag laeuft alles im Klartext - es gibt ja noch keinen
 * Schluessel. Danach wird jedes Paket versiegelt, mit einem Zaehler, der
 * sich unter demselben Schluessel nie wiederholt.
 */
class Channel {
  constructor(transport) {
    this.transport = transport;
    this.decoder = new frame.Decoder();
    this.queue = [];
    this.keys = null;
    this.sendCounter = 0;
    this.recvCounter = 0;
  }

  secure(sendKey, recvKey) {
    this.keys = { sendKey, recvKey };
  }

  send(payload) {
    const body = this.keys ? seal(this.keys.sendKey, this.sendCounter++, payload) : payload;
    this.transport.send(frame.pack(body));
  }

  /** Nimmt Bytes entgegen und legt fertige Pakete bereit. */
  push(bytes) {
    for (const payload of this.decoder.push(bytes)) this.queue.push(payload);
  }

  /**
   * Holt das naechste Paket - und entschluesselt es ERST JETZT.
   *
   * Das ist kein Schoenheitsfehler, sondern der Kern: waehrend des
   * Handschlags laeuft der Kanal im Klartext, danach versiegelt. Kommen
   * die letzte Handschlagnachricht und das erste versiegelte Paket
   * gemeinsam an - was jeder echte Transport tut, weil er buendelt -,
   * dann wuerde ein Leser, der beide auf einmal auswertet, das zweite
   * noch im Klartextzustand deuten. Es ergaebe Unsinn, und die Sitzung
   * bliebe stumm stehen.
   */
  next() {
    if (!this.queue.length) return null;
    const payload = this.queue.shift();

    if (!this.keys) return frame.split(payload);

    const plain = open(this.keys.recvKey, this.recvCounter++, payload);
    if (!plain) {
      const err = new Error('Ein Paket ließ sich nicht öffnen - der Kanal ist gestört');
      err.code = 'BAD_SEAL';
      throw err;
    }
    return frame.split(plain);
  }
}

/* ------------------------------------------------------------------ *
 * Gemeinsamer Unterbau
 * ------------------------------------------------------------------ */

function base(transport, { identity, expect, initiator, onEvent = () => {} }) {
  const channel = new Channel(transport);
  const shake = handshake.create({ identity, initiator, expect });

  const state = { phase: 'handshake', peer: null };

  const sendControl = (obj) => channel.send(frame.control(obj));

  function finishHandshake() {
    const res = shake.result();
    channel.secure(res.sendKey, res.recvKey);
    state.peer = { pub: res.peerStatic, firstContact: res.firstContact };
    onEvent({ type: 'secure', peer: state.peer });
    return res;
  }

  return { channel, shake, state, sendControl, finishHandshake, onEvent };
}

/* ------------------------------------------------------------------ *
 * Senden
 * ------------------------------------------------------------------ */

/**
 * `files` sind die eingesammelten Dateien aus chunks.scan.
 * Die Liste kann fertig uebergeben werden - beim zweiten Anlauf muss
 * nicht noch einmal alles durchgerechnet werden.
 */
function send(transport, { identity, expect = null, files, manifest = null, onEvent = () => {} }) {
  const ctx = base(transport, { identity, expect, initiator: true, onEvent });
  let sheet = manifest;
  let sent = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    // Auflegen gehoert dazu: sonst wartet die Gegenseite auf eine
    // Nachricht, die nie kommt, und ihr Versprechen loest sich nie auf.
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    /**
     * Die Bloecke rausgeben, ohne dabei den Speicher vollzulaufen.
     *
     * Alles auf einmal in den Transport zu schieben waere bei 28 GB ein
     * sicherer Absturz. Deshalb wird zwischendurch abgegeben - und wenn
     * der Transport sagen kann, wann er wieder aufnahmefaehig ist,
     * richten wir uns danach.
     */
    async function pump(want) {
      const fs = require('fs');
      let openFile = -1;
      let fd = null;

      try {
        for (let i = 0; i < want.length; i++) {
          const { fileIndex, chunkIndex } = want[i];
          const file = sheet.files[fileIndex];
          const source = files[fileIndex];
          if (!file || !source) throw new Error('Die Gegenstelle fragt nach etwas, das es nicht gibt');

          // Dateien bleiben offen, solange Bloecke daraus drankommen -
          // die Liste ist nach Datei sortiert, das spart das staendige
          // Auf und Zu.
          if (fileIndex !== openFile) {
            if (fd !== null) fs.closeSync(fd);
            fd = fs.openSync(source.abs, 'r');
            openFile = fileIndex;
          }

          const data = chunks.readChunk(fd, file.size, chunkIndex);
          ctx.channel.send(frame.chunk(fileIndex, chunkIndex, data));
          sent++;
          onEvent({ type: 'sent', done: sent, of: want.length, bytes: data.length });

          if (transport.drain) await transport.drain();
          else if ((i & 15) === 15) await new Promise((r) => setImmediate(r));
        }
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }

      ctx.sendControl({ t: 'end' });
    }

    const handle = (msg) => {
      if (ctx.state.phase === 'handshake') {
        const next = ctx.shake.read(msg);
        if (next) ctx.sendControl(next);
        if (!ctx.shake.done) return;

        ctx.finishHandshake();
        ctx.state.phase = 'manifest';

        if (!sheet) {
          onEvent({ type: 'hashing' });
          sheet = chunks.buildManifest(files, (n) => onEvent({ type: 'hashed', bytes: n }));
        }
        ctx.sendControl({ t: 'manifest', manifest: sheet });
        onEvent({ type: 'offered', files: sheet.files.length, bytes: chunks.totalBytes(sheet) });
        return;
      }

      if (msg.t === 'want') {
        // Was die Gegenstelle schon hat, wird nicht noch einmal
        // geschickt - das ist das Fortsetzen, und es steht hier in
        // genau einer Zeile.
        const want = msg.want || [];
        onEvent({ type: 'plan', total: chunks.totalChunks(sheet), send: want.length });
        pump(want).catch(fail);
        return;
      }

      if (msg.t === 'done') {
        finish({ ok: Boolean(msg.ok), sent, peer: ctx.state.peer, missing: msg.missing || [] });
        return;
      }

      if (msg.t === 'error') {
        // Die Kennung mitnehmen: die Oberflaeche kann daraus einen
        // brauchbaren Rat machen statt "irgendetwas ging schief".
        const err = new Error(msg.message || 'Die Gegenstelle hat abgebrochen');
        if (msg.code) err.code = msg.code;
        fail(err);
      }
    };

    transport.onData((bytes) => {
      try {
        ctx.channel.push(bytes);
        for (let packet = ctx.channel.next(); packet; packet = ctx.channel.next()) {
          if (packet.type !== frame.CONTROL) continue;
          const msg = frame.readControl(packet.body);
          if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
          handle(msg);
        }
      } catch (err) {
        fail(err);
      }
    });

    transport.onClose(() => fail(new Error('Die Verbindung wurde getrennt')));

    ctx.sendControl(ctx.shake.hello());
  });
}

/* ------------------------------------------------------------------ *
 * Empfangen
 * ------------------------------------------------------------------ */

function receive(transport, { identity, expect = null, dir, onEvent = () => {}, dedup = true }) {
  const ctx = base(transport, { identity, expect, initiator: false, onEvent });
  let sink = null;
  let sheet = null;
  let taken = 0;
  let had = 0;      // was beim Nachsehen schon heil dalag
  let recovered = 0;  // was aus dem Zielordner selbst wiederhergestellt wurde

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Erst sichern, was schon dalag - der naechste Anlauf baut darauf
      // auf -, dann Bescheid geben, dann auflegen.
      if (sink) { try { sink.close(); } catch { /* egal */ } }
      // Ohne diese Nachricht sieht die Gegenstelle nur einen Abriss und
      // raet, woran es lag. Sie geht erst raus, wenn der Kanal steht -
      // vorher gibt es niemanden, dem man etwas sagen koennte, und
      // Unverschluesseltes wuerde nur verraten, wer hier wartet.
      if (ctx.channel.keys) {
        try { ctx.sendControl({ t: 'error', message: err.message, code: err.code || null }); } catch { /* egal */ }
      }
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const handleControl = (msg) => {
      if (ctx.state.phase === 'handshake') {
        const next = ctx.shake.read(msg);
        if (next) ctx.sendControl(next);
        if (ctx.shake.done) {
          ctx.finishHandshake();
          ctx.state.phase = 'manifest';
        }
        return;
      }

      if (msg.t === 'manifest') {
        sheet = msg.manifest;
        if (!sheet || !Array.isArray(sheet.files)) return fail(new Error('Unbrauchbare Dateiliste'));

        onEvent({ type: 'offered', files: sheet.files.length, bytes: chunks.totalBytes(sheet) });

        // Hier entsteht das Fortsetzen: nachsehen, was schon daliegt.
        onEvent({ type: 'checking' });
        let { want, have, total } = chunks.missing(sheet, dir, (n) => onEvent({ type: 'checked', bytes: n }));
        had = have;

        // Bevor die Wunschliste rausgeht: der Inhalt liegt vielleicht
        // schon woanders im Zielordner - umbenannt, verschoben, oder
        // als zweite Fassung eines Ordners mit wenig Aenderung. Das
        // muss dann nicht mehr ueber die Leitung.
        if (dedup && want.length) {
          const geholt = chunks.recover(sheet, dir, want);
          recovered = geholt.recovered;
          want = geholt.want;
          if (recovered > 0 || geholt.truncated) {
            onEvent({ type: 'recovered', count: recovered, scanned: geholt.scanned, truncated: geholt.truncated });
          }
        }

        onEvent({ type: 'plan', total, have, need: want.length });

        sink = new chunks.Sink(sheet, dir);
        ctx.sendControl({ t: 'want', want });
        if (!want.length) {
          // Nichts zu holen - trotzdem sauber abschliessen, damit die
          // Dateien auf die richtige Laenge kommen.
          sink.close();
          sink = null;
          ctx.sendControl({ t: 'done', ok: true, missing: [] });
          finish({ ok: true, taken: 0, had, recovered, peer: ctx.state.peer, missing: [] });
        }
        return;
      }

      if (msg.t === 'end') {
        if (sink) { sink.close(); sink = null; }

        // Das letzte Wort hat die Platte, nicht die Buchfuehrung: noch
        // einmal nachrechnen statt mitzuzaehlen.
        const rest = chunks.missing(sheet, dir).want;
        const names = [...new Set(rest.map((r) => sheet.files[r.fileIndex].name))];

        ctx.sendControl({ t: 'done', ok: rest.length === 0, missing: names });
        finish({ ok: rest.length === 0, taken, had, recovered, peer: ctx.state.peer, missing: names });
        return;
      }

      if (msg.t === 'error') {
        // Die Kennung mitnehmen: die Oberflaeche kann daraus einen
        // brauchbaren Rat machen statt "irgendetwas ging schief".
        const err = new Error(msg.message || 'Die Gegenstelle hat abgebrochen');
        if (msg.code) err.code = msg.code;
        fail(err);
      }
    };

    transport.onData((bytes) => {
      try {
        ctx.channel.push(bytes);
        for (let packet = ctx.channel.next(); packet; packet = ctx.channel.next()) {
          if (packet.type === frame.CHUNK) {
            const part = frame.readChunk(packet.body);
            if (!part || !sink) return fail(new Error('Ein Block kam zur falschen Zeit'));
            if (!sink.write(part.fileIndex, part.chunkIndex, part.data)) {
              // Nicht abbrechen: der Block wird beim Nachrechnen
              // ohnehin als fehlend gemeldet und kann nachgeliefert
              // werden. Ein einzelner kaputter Block soll nicht eine
              // Uebertragung von Stunden wegwerfen.
              onEvent({ type: 'rejected', fileIndex: part.fileIndex, chunkIndex: part.chunkIndex });
              continue;
            }
            taken++;
            onEvent({ type: 'taken', done: taken, bytes: part.data.length });
            continue;
          }

          const msg = frame.readControl(packet.body);
          if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
          handleControl(msg);
        }
      } catch (err) {
        fail(err);
      }
    });

    transport.onClose(() => fail(new Error('Die Verbindung wurde getrennt')));
  });
}

module.exports = { send, receive, Channel };
