'use strict';

/* =================================================================
   Die Client-Seite des Treffpunkts.

   Nach aussen dasselbe Bild wie tcp.js: `register`/`reach` liefern
   einen Transport, der sich exakt so verhaelt wie der aus einer
   direkten Verbindung. Was dazwischen passiert - eine Anschrift
   melden oder suchen, auf die Antwort warten -, ist von aussen nicht
   zu sehen.

   Eine Falle dabei: waehrend wir selbst auf 'joined' warten, hoeren
   WIR dem Socket zu (nicht der Kern) und deuten die Bytes als
   Steuernachrichten. Kommen im selben Netzwerkpaket wie 'joined'
   schon die ersten Bytes der eigentlichen Sitzung mit - was passiert,
   sobald die Vermittlungsstelle beide Seiten zusammenschaltet und die
   Gegenseite sofort lossendet -, hat unser Decoder sie unter Umstaenden
   schon als vollstaendige Rahmen herausgeloest, bevor der Kern ueberhaupt
   `onData` gesetzt hat. Verloren gehen sie trotzdem nicht: was uebrig
   bleibt, wird vor den ersten echten Socket-Ereignissen an `onData`
   nachgereicht, sobald es gesetzt wird.
   ================================================================= */

const tcp = require('./tcp');
const frame = require('../core/frame');
const protocol = require('../meet/protocol');

const DEFAULT_PORT = 41997;

// Wie oft `register` ein Lebenszeichen gibt, solange noch niemand da
// ist - ein Portscanner oder ein totes NAT-Mapping soll nicht dafuer
// sorgen, dass die Anmeldung unbemerkt verwaist.
const PING_INTERVAL_MS = 20000;

function fehlerMit(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Huellt einen fertig verbundenen Transport so ein, dass gepufferte
 * Sitzungsbytes vor den ersten Socket-Ereignissen an `onData`
 * nachgereicht werden. Rein synchron - zwischen den beiden Zeilen in
 * `onData` kann kein neues Socket-Ereignis dazwischenkommen, also
 * bleibt die Reihenfolge gewahrt.
 */
function mitRest(transport, rest) {
  if (!rest || !rest.length) return transport;
  let uebrig = rest;

  return {
    socket: transport.socket,
    send: (bytes) => transport.send(bytes),
    drain: () => transport.drain(),
    onClose: (cb) => transport.onClose(cb),
    close: () => transport.close(),
    get remote() { return transport.remote; },

    onData(cb) {
      if (uebrig) {
        const puffer = uebrig;
        uebrig = null;
        cb(puffer);
      }
      transport.onData(cb);
    }
  };
}

/**
 * Baut die Verbindung zum Treffpunkt auf, schickt `hello`, und reicht
 * jede gelesene Steuernachricht an `handle(msg, ctx)` weiter.
 * `ctx.done()` schliesst die Vermittlung erfolgreich ab und loest mit
 * dem fertigen Transport auf, `ctx.fail(err)` bricht ab.
 *
 * `signal` (ein normales AbortSignal, optional) bricht sowohl das
 * Verbinden als auch ein laufendes Warten auf `joined` ab - wichtig
 * fuer `register`, das sonst beliebig lange auf niemanden warten
 * wuerde und sich beim Beenden des Knotens nicht mehr einholen liesse.
 */
function handshake(host, port, hello, { timeout, ping, handle, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let transport = null;
    let pingTimer = null;
    let dataHandler = null;
    let fertig = false;

    const decoder = new frame.Decoder();
    const restFrames = [];

    const aufraeumen = () => {
      clearInterval(pingTimer);
      if (transport && dataHandler) transport.socket.off('data', dataHandler);
      if (signal) signal.removeEventListener('abort', abbrechen);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      aufraeumen();
      if (transport) transport.close();
      reject(err);
    };

    const abbrechen = () => fail(fehlerMit('Abgebrochen', 'ABORTED'));
    if (signal) {
      if (signal.aborted) { abbrechen(); return; }
      signal.addEventListener('abort', abbrechen, { once: true });
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      aufraeumen();

      // Was der Decoder ab hier schon vollstaendig herausgeloest hatte,
      // gehoert der Sitzung, nicht mehr der Vermittlung - genauso ein
      // angefangenes, noch unvollstaendiges Paket.
      const rest = Buffer.concat([
        ...restFrames.map((p) => frame.pack(p)),
        decoder.pending ? decoder.take(decoder.pending) : Buffer.alloc(0)
      ]);
      resolve(mitRest(transport, rest));
    };

    tcp.connect(host, port, { timeout })
      .then((t) => {
        if (settled) { t.close(); return; }
        transport = t;

        dataHandler = (bytes) => {
          let out;
          try {
            out = decoder.push(bytes);
          } catch (err) {
            fail(err);
            return;
          }

          for (const payload of out) {
            if (fertig) { restFrames.push(payload); continue; }

            const split = frame.split(payload);
            const msg = split && split.type === frame.CONTROL ? protocol.read(split.body) : null;
            if (!msg) { fail(new Error('Unlesbare Antwort vom Treffpunkt')); return; }

            let scheitern = null;
            handle(msg, {
              done: () => { fertig = true; },
              fail: (err) => { scheitern = err; },
              // Fuer 'reach': auf 'found' hin gleich 'join' zurueckschicken,
              // ohne die Verbindung neu aufzubauen.
              reply: (m) => transport.send(frame.pack(frame.control(m)))
            });
            if (scheitern) { fail(scheitern); return; }
          }

          if (fertig) finish();
        };

        transport.socket.on('data', dataHandler);
        transport.onClose(() => fail(new Error('Die Verbindung zum Treffpunkt wurde getrennt')));
        transport.send(frame.pack(frame.control(hello)));

        if (ping) {
          pingTimer = setInterval(() => {
            if (!settled) transport.send(frame.pack(frame.control(protocol.pingMsg())));
          }, PING_INTERVAL_MS);
          if (pingTimer.unref) pingTimer.unref();
        }
      })
      .catch(fail);
  });
}

/**
 * Meldet sich unter `address` erreichbar und wartet, bis jemand kommt.
 * `direct` (optional, "host:port") wird an den Treffpunkt mitgegeben -
 * wer nach `address` sucht, bekommt sie zuerst genannt und kann es
 * direkt probieren, bevor er die Umleitung nimmt.
 * `signal` (optional) bricht das Warten ab - siehe `handshake`.
 */
function register(host, port, { address, pass, direct, timeout = 8000, signal } = {}) {
  return handshake(host, port, protocol.hereMsg(address, pass, direct), {
    timeout,
    ping: true,
    signal,
    handle(msg, ctx) {
      if (msg.t === 'ok' || msg.t === 'pong') return;
      if (msg.t === 'joined') return ctx.done();
      if (msg.t === 'denied') return ctx.fail(fehlerMit(msg.reason || 'Anmeldung abgelehnt', 'DENIED'));
      ctx.fail(new Error(`Unerwartete Antwort des Treffpunkts: ${msg.t}`));
    }
  });
}

/**
 * Sucht `address` am Treffpunkt und bekommt die Leitung zu ihr - das
 * volle Programm in einem Rutsch: auf 'found' folgt sofort 'join', die
 * Umleitung wird also in jedem Fall genommen. Wer stattdessen zuerst
 * selbst einen direkten Weg probieren will, braucht `lookup` statt
 * dessen.
 */
function reach(host, port, { address, pass, timeout = 8000, signal } = {}) {
  return handshake(host, port, protocol.reachMsg(address, pass), {
    timeout,
    ping: false,
    signal,
    handle(msg, ctx) {
      if (msg.t === 'found') return ctx.reply(protocol.joinMsg());
      if (msg.t === 'joined') return ctx.done();
      if (msg.t === 'nobody') return ctx.fail(fehlerMit(`${address} ist gerade nicht am Treffpunkt angemeldet`, 'NOBODY'));
      if (msg.t === 'denied') return ctx.fail(fehlerMit(msg.reason || 'Anmeldung abgelehnt', 'DENIED'));
      ctx.fail(new Error(`Unerwartete Antwort des Treffpunkts: ${msg.t}`));
    }
  });
}

/**
 * Liest Steuernachrichten von einer schon verbundenen Leitung, bis
 * `handle` per `ctx.done()`/`ctx.fail()` sagt, dass dieser Abschnitt
 * des Gespraechs fertig ist. Anders als `handshake` baut das keine
 * eigene Verbindung auf und ist mehrfach hintereinander auf derselben
 * Leitung aufrufbar - `lookup` nutzt das: erst auf 'found' warten, dann
 * (nur wenn `join()` faellt) getrennt auf 'joined'.
 *
 * Was vom vorigen Abschnitt schon als vollstaendiger Rahmen dalag
 * (`restFrames`), wird zuerst abgearbeitet, bevor ueberhaupt auf neue
 * Socket-Ereignisse gewartet wird - siehe die Warnung oben im Datei-Kopf.
 */
function leseAbschnitt(transport, decoder, restFrames, handle) {
  return new Promise((resolve, reject) => {
    let fertig = false;
    let settled = false;
    let handler = null;

    const cleanup = () => { if (handler) transport.socket.off('data', handler); };
    const beenden = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    transport.onClose(() => beenden(reject, new Error('Die Verbindung zum Treffpunkt wurde getrennt')));

    const verarbeiten = (frames) => {
      for (const payload of frames) {
        if (fertig) { restFrames.push(payload); continue; }

        const split = frame.split(payload);
        const msg = split && split.type === frame.CONTROL ? protocol.read(split.body) : null;
        if (!msg) { beenden(reject, new Error('Unlesbare Antwort vom Treffpunkt')); return; }

        let scheitern = null;
        handle(msg, { done: () => { fertig = true; }, fail: (err) => { scheitern = err; } });
        if (scheitern) { beenden(reject, scheitern); return; }
      }
      if (fertig) beenden(resolve);
    };

    if (restFrames.length) {
      verarbeiten(restFrames.splice(0));
      if (settled) return;
    }

    handler = (bytes) => {
      let frames;
      try {
        frames = decoder.push(bytes);
      } catch (err) { beenden(reject, err); return; }
      verarbeiten(frames);
    };
    transport.socket.on('data', handler);
  });
}

/**
 * Fragt am Treffpunkt nach `address`, OHNE gleich durchzuschalten. Die
 * Verbindung bleibt offen - der Aufrufer entscheidet danach per
 * `join()` (doch die Umleitung nehmen) oder `cancel()` (der direkte
 * Weg - `direct`, falls vorhanden - hat geklappt, der Treffpunkt wird
 * nicht mehr gebraucht).
 *
 * Bei 'nobody' schlaegt das Versprechen fehl, code NOBODY - wie bei
 * `reach`.
 */
async function lookup(host, port, { address, pass, timeout = 8000 } = {}) {
  const transport = await tcp.connect(host, port, { timeout });
  const decoder = new frame.Decoder();
  const restFrames = [];
  let direct = null;

  try {
    transport.send(frame.pack(frame.control(protocol.reachMsg(address, pass))));

    await leseAbschnitt(transport, decoder, restFrames, (msg, ctx) => {
      if (msg.t === 'found') { direct = msg.direct || null; return ctx.done(); }
      if (msg.t === 'nobody') return ctx.fail(fehlerMit(`${address} ist gerade nicht am Treffpunkt angemeldet`, 'NOBODY'));
      if (msg.t === 'denied') return ctx.fail(fehlerMit(msg.reason || 'Anmeldung abgelehnt', 'DENIED'));
      ctx.fail(new Error(`Unerwartete Antwort des Treffpunkts: ${msg.t}`));
    });
  } catch (err) {
    transport.close();
    throw err;
  }

  let entschieden = false;

  return {
    direct,

    async join() {
      if (entschieden) throw new Error('join()/cancel() wurde fuer diese Anfrage schon aufgerufen');
      entschieden = true;

      try {
        transport.send(frame.pack(frame.control(protocol.joinMsg())));

        await leseAbschnitt(transport, decoder, restFrames, (msg, ctx) => {
          if (msg.t === 'joined') return ctx.done();
          ctx.fail(new Error(`Unerwartete Antwort des Treffpunkts: ${msg.t}`));
        });
      } catch (err) {
        transport.close();
        throw err;
      }

      const rest = Buffer.concat([
        ...restFrames.map((p) => frame.pack(p)),
        decoder.pending ? decoder.take(decoder.pending) : Buffer.alloc(0)
      ]);
      return mitRest(transport, rest);
    },

    cancel() {
      if (entschieden) return;
      entschieden = true;
      transport.send(frame.pack(frame.control(protocol.cancelMsg())));
      transport.close();
    }
  };
}

module.exports = { DEFAULT_PORT, register, reach, lookup };
