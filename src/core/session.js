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

   Der Handschlag selbst steckt in connect(): jeder gesicherte Kanal
   beginnt dort, gleich ob am Ende Dateien folgen (send/receive) oder
   nur Nachrichten (siehe talk.js).
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
    this.owner = null;
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

  /**
   * Wer gerade fuer neu eintreffende Bytes zustaendig ist - wechselt im
   * Lauf einer Sitzung mehrfach (Handschlag -> Weiche -> Dateien oder
   * Nachrichten). `owner` bekommt drei Rueckrufe: onData() (neue Pakete
   * liegen bereit, koennen ueber next() geholt werden), onError(err)
   * und onClose().
   *
   * Der Transport selbst wird davon NICHT beruehrt - siehe
   * listenOnTransport().
   */
  setOwner(owner) {
    this.owner = owner;
  }

  /**
   * Haengt sich EIN EINZIGES Mal an den Transport - der einzige Ort im
   * ganzen Ablauf, der das tut.
   *
   * Ein echter Socket (net/tcp.js) haengt Zuhoerer nur AN, ersetzt sie
   * nicht - anders als der Speichertransport zum Pruefen, der die
   * Zustaendigkeit ueberschreibt. Ein zweites transport.onData() waere
   * also auf einer echten Leitung kein Ersatz, sondern ein zweiter
   * Zuhoerer, und jedes Byte wuerde doppelt verarbeitet. Deshalb wird
   * hier ein fuer alle Mal zugehoert, und alles Spaetere laeuft ueber
   * setOwner() um.
   */
  listenOnTransport() {
    this.transport.onData((bytes) => {
      try {
        this.push(bytes);
        if (this.owner) this.owner.onData();
      } catch (err) {
        if (this.owner) this.owner.onError(err);
      }
    });
    this.transport.onClose(() => {
      if (this.owner) this.owner.onClose();
    });
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
 * Handschlag
 * ------------------------------------------------------------------ */

/**
 * Handschlag ueber einem Transport. Gibt den gesicherten Kanal zurueck,
 * sobald beide Seiten sich ausgewiesen haben.
 *
 * DIE FALLE: zwischen der letzten Handschlagnachricht und den ersten
 * Nutzdaten liegt kein Luftholen - ein echter Transport buendelt, also
 * koennen beide im selben Paket ankommen. Deshalb wird hier, sobald der
 * Handschlag steht, sofort aufgehoert zu lesen: was sonst noch in
 * derselben Zustellung mitkam, liegt bereits (roh, noch nicht
 * entschluesselt) in der Warteschlange des Kanals - siehe
 * Channel.next() - und wartet dort auf den naechsten Besitzer. Nichts
 * geht verloren, nichts wird hier schon gedeutet.
 */
function connect(transport, { identity, expect = null, initiator, onEvent = () => {} }) {
  const ctx = base(transport, { identity, expect, initiator, onEvent });

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      // Ein Fehler kann auch NACH dem Handschlag entstehen, obwohl
      // dieser Aufruf hier noch laeuft - zum Beispiel, wenn die
      // Torkontrolle der Oberflaeche (onEvent('secure', ...)) eine
      // unbekannte oder geaenderte Gegenstelle abweist. Der Kanal
      // steht dann schon: ohne diese Nachricht saehe die Gegenstelle
      // nur einen Abriss und muesste raten, woran es lag.
      if (ctx.channel.keys) {
        try { ctx.sendControl({ t: 'error', message: err.message, code: err.code || null }); } catch { /* egal */ }
      }
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };

    ctx.channel.setOwner({
      onData: () => {
        // Solange der Handschlag laeuft, wird hier gelesen. Ist er
        // fertig, gehoert die Warteschlange - und alles, was noch im
        // selben Paket mitkam - dem naechsten Besitzer; diese Schleife
        // ruehrt dann nichts mehr an (state.phase ist nicht mehr
        // 'handshake').
        while (ctx.state.phase === 'handshake') {
          const packet = ctx.channel.next();
          if (!packet) return;
          if (packet.type !== frame.CONTROL) return fail(new Error('Unlesbare Steuernachricht'));

          const msg = frame.readControl(packet.body);
          if (!msg) return fail(new Error('Unlesbare Steuernachricht'));

          const antwort = ctx.shake.read(msg);
          if (antwort) ctx.sendControl(antwort);
          if (!ctx.shake.done) continue;

          ctx.finishHandshake();
          ctx.state.phase = 'connected';
          settled = true;

          // Bis der naechste Besitzer sich gleich danach ueber
          // channel.setOwner() meldet, wird nur noch stumm
          // weitergepuffert - nichts wird hier schon gedeutet.
          ctx.channel.setOwner({ onData: () => {}, onError: () => {}, onClose: () => {} });

          resolve({
            channel: ctx.channel,
            peer: ctx.state.peer,
            sendControl: ctx.sendControl,
            next: () => ctx.channel.next()
          });
          return;
        }
      },
      onError: fail,
      onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
    });

    ctx.channel.listenOnTransport();

    if (initiator) ctx.sendControl(ctx.shake.hello());
  });
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

    let channel = null;
    let sendControl = null;
    let peer = null;

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
          channel.send(frame.chunk(fileIndex, chunkIndex, data));
          sent++;
          onEvent({ type: 'sent', done: sent, of: want.length, bytes: data.length });

          if (transport.drain) await transport.drain();
          else if ((i & 15) === 15) await new Promise((r) => setImmediate(r));
        }
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }

      sendControl({ t: 'end' });
    }

    const handle = (msg) => {
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
        finish({ ok: Boolean(msg.ok), sent, peer, missing: msg.missing || [] });
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

    /** Alles verarbeiten, was gerade in der Warteschlange des Kanals liegt. */
    function drain() {
      for (let packet = channel.next(); packet; packet = channel.next()) {
        if (packet.type !== frame.CONTROL) continue;
        const msg = frame.readControl(packet.body);
        if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
        handle(msg);
      }
    }

    connect(transport, { identity, expect, initiator: true, onEvent })
      .then((h) => {
        channel = h.channel;
        sendControl = h.sendControl;
        peer = h.peer;

        if (!sheet) {
          onEvent({ type: 'hashing' });
          sheet = chunks.buildManifest(files, (n) => onEvent({ type: 'hashed', bytes: n }));
        }
        sendControl({ t: 'manifest', manifest: sheet });
        onEvent({ type: 'offered', files: sheet.files.length, bytes: chunks.totalBytes(sheet) });

        // Die Zustaendigkeit fuer neue Bytes geht ab hier auf uns ueber
        // (siehe Channel.setOwner) - der Transport selbst wird kein
        // zweites Mal angefasst.
        channel.setOwner({
          onData: drain,
          onError: fail,
          onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
        });

        // Was schon in der Warteschlange lag, bevor wir hier ankamen -
        // z.B. "want" gleich im selben Paket wie das letzte
        // Handschlagpaket -, wird jetzt nachgeholt.
        try { drain(); } catch (err) { fail(err); }
      })
      .catch(fail);
  });
}

/* ------------------------------------------------------------------ *
 * Empfangen
 * ------------------------------------------------------------------ */

/**
 * Die Fortsetzung von receive() ab dem Punkt, an dem der Handschlag
 * steht und die erste Nachricht schon gelesen ist. `handshake` ist das
 * Ergebnis von connect(); `ersteNachricht` ist das schon entnommene
 * erste Paket ({type, body}).
 *
 * Eigens herausgezogen, weil der Aufrufer aus genau dieser ersten
 * Nachricht entscheiden muss, wie es weitergeht, bevor die Uebertragung
 * beginnt - bei Dateien ist es ein 'manifest', bei einer Nachrichten-
 * sitzung (talk.js) ein 'say' (siehe node.js, die Weiche liegt dort).
 */
function receiveOn(handshake, { dir, dedup = true, onEvent = () => {}, approve = null }, ersteNachricht) {
  const { channel, peer } = handshake;
  const sendControl = handshake.sendControl;
  const transport = channel.transport;

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
      // Der Kanal steht laengst (der Handschlag ist ja schon durch) -
      // die Pruefung bleibt trotzdem stehen, aus demselben Grund wie
      // vorher: ohne Schluessel gibt es niemanden, dem man etwas
      // verschluesselt sagen koennte.
      if (channel.keys) {
        try { sendControl({ t: 'error', message: err.message, code: err.code || null }); } catch { /* egal */ }
      }
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    /**
     * Der Ablauf ab dem Punkt, an dem das Angebot angenommen ist -
     * herausgezogen, weil zwischen Angebot und diesem Punkt jetzt eine
     * Einwilligung liegen kann (siehe unten im 'manifest'-Zweig).
     */
    const angenommen = () => {
      if (settled) return;

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
      sendControl({ t: 'want', want });
      if (!want.length) {
        // Nichts zu holen - trotzdem sauber abschliessen, damit die
        // Dateien auf die richtige Laenge kommen.
        sink.close();
        sink = null;
        sendControl({ t: 'done', ok: true, missing: [] });
        finish({ ok: true, taken: 0, had, recovered, peer, missing: [] });
      }
    };

    const handleControl = (msg) => {
      if (msg.t === 'manifest') {
        sheet = msg.manifest;
        if (!sheet || !Array.isArray(sheet.files)) return fail(new Error('Unbrauchbare Dateiliste'));

        onEvent({ type: 'offered', files: sheet.files.length, bytes: chunks.totalBytes(sheet) });

        // Ohne Einwilligungs-Haken laeuft alles wie bisher: sofort
        // weiter. Mit ihm wird erst gefragt - der Sender wartet in
        // dieser Zeit einfach auf die want-Nachricht, die Verbindung
        // traegt das (kein Timeout auf einer stehenden Verbindung,
        // siehe tcp.js). Bis zur Antwort ist noch kein Byte Nutzlast
        // geflossen und nichts auf die Platte geschrieben - genau
        // deshalb sitzt die Frage HIER und nicht spaeter.
        if (!approve) return angenommen();

        Promise.resolve()
          .then(() => approve({
            files: sheet.files.length,
            bytes: chunks.totalBytes(sheet),
            // Die ersten Namen reichen, um zu wissen, worum es geht -
            // die ganze Liste kann bei einem Ordner riesig sein.
            names: sheet.files.slice(0, 8).map((f) => f.name)
          }))
          .then((ja) => {
            if (settled) return;
            if (ja) return angenommen();
            const err = new Error('Die Gegenstelle hat die Übertragung nicht angenommen');
            err.code = 'DECLINED';
            fail(err);
          })
          .catch(fail);
        return;
      }

      if (msg.t === 'end') {
        if (sink) { sink.close(); sink = null; }

        // Das letzte Wort hat die Platte, nicht die Buchfuehrung: noch
        // einmal nachrechnen statt mitzuzaehlen.
        const rest = chunks.missing(sheet, dir).want;
        const names = [...new Set(rest.map((r) => sheet.files[r.fileIndex].name))];

        sendControl({ t: 'done', ok: rest.length === 0, missing: names });
        finish({ ok: rest.length === 0, taken, had, recovered, peer, missing: names });
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

    const processPacket = (packet) => {
      if (packet.type === frame.CHUNK) {
        const part = frame.readChunk(packet.body);
        if (!part || !sink) return fail(new Error('Ein Block kam zur falschen Zeit'));
        if (!sink.write(part.fileIndex, part.chunkIndex, part.data)) {
          // Nicht abbrechen: der Block wird beim Nachrechnen ohnehin
          // als fehlend gemeldet und kann nachgeliefert werden. Ein
          // einzelner kaputter Block soll nicht eine Uebertragung von
          // Stunden wegwerfen.
          onEvent({ type: 'rejected', fileIndex: part.fileIndex, chunkIndex: part.chunkIndex });
          return;
        }
        taken++;
        onEvent({ type: 'taken', done: taken, bytes: part.data.length });
        return;
      }

      const msg = frame.readControl(packet.body);
      if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
      handleControl(msg);
    };

    channel.setOwner({
      onData: () => {
        for (let packet = channel.next(); packet; packet = channel.next()) processPacket(packet);
      },
      onError: fail,
      onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
    });

    try {
      processPacket(ersteNachricht);
    } catch (err) {
      fail(err);
    }
  });
}

function receive(transport, { identity, expect = null, dir, onEvent = () => {}, dedup = true, approve = null }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };

    connect(transport, { identity, expect, initiator: false, onEvent })
      .then((h) => {
        const weiter = (ersteNachricht) => {
          if (settled) return;
          settled = true;
          receiveOn(h, { dir, dedup, onEvent, approve }, ersteNachricht).then(resolve, reject);
        };

        // Vielleicht liegt die erste Nachricht schon in der
        // Warteschlange - im selben Paket wie das letzte
        // Handschlagpaket. Sonst wird auf sie gewartet.
        const schonDa = h.next();
        if (schonDa) { weiter(schonDa); return; }

        h.channel.setOwner({
          onData: () => {
            const packet = h.next();
            if (packet) weiter(packet);
          },
          onError: fail,
          onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
        });
      })
      .catch(fail);
  });
}

module.exports = { send, receive, connect, receiveOn, Channel };
