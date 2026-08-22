'use strict';

/* =================================================================
   Kurznachrichten - ueber denselben Handschlag wie die Dateien.

   Nach dem Handschlag (session.connect) ist der Kanal gesichert und
   beglaubigt; was dann ueber ihn laeuft, ist reine Formsache:

     -> { t: 'say', text, at }     eine Nachricht (at = Zeitstempel des Senders)
     <- { t: 'got', at }           angekommen und abgelegt
     -> { t: 'bye' }               Ende

   Mehrere "say" hintereinander sind erlaubt, aber streng der Reihe
   nach: erst kommt die Bestaetigung der einen an, dann geht die
   naechste raus. Eine Nachricht gilt erst als zugestellt, wenn "got"
   da ist - nicht schon, wenn sie rausgeschickt wurde. Der Unterschied
   zaehlt bei einem Abriss mitten in der Sitzung: ohne "got" weiss der
   Sender, dass er es nicht sicher sagen kann.

   Wer beim Empfaenger Dateien und wer Nachrichten bringt, entscheidet
   keine eigene Vorwortnachricht, sondern schlicht, was als erstes nach
   dem Handschlag ankommt ('manifest' oder 'say') - die Weiche dafuer
   liegt in node.js, nicht hier.
   ================================================================= */

const frame = require('./frame');
const session = require('./session');

const MAX_TEXT_LENGTH = 8000;
const MAX_MESSAGES = 100;

function pruefeText(text) {
  if (typeof text !== 'string') {
    const err = new Error('Eine Nachricht muss Text sein');
    err.code = 'BAD_TEXT';
    throw err;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    const err = new Error(`Eine Nachricht darf höchstens ${MAX_TEXT_LENGTH} Zeichen haben`);
    err.code = 'TEXT_TOO_LONG';
    throw err;
  }
}

/**
 * Macht den Handschlag selbst (ueber session.connect), schickt die
 * Texte der Reihe nach, wartet je auf "got", schickt zuletzt "bye".
 *
 * `texts` wird komplett vor dem ersten Versand geprueft - eine zu lange
 * oder zu zahlreiche Liste wird abgelehnt, ohne dass vorher schon etwas
 * ueber die Leitung ging.
 */
function say(transport, { identity, expect = null, texts, onEvent = () => {} }) {
  if (!Array.isArray(texts)) throw new Error('texts muss eine Liste von Zeichenketten sein');
  if (texts.length > MAX_MESSAGES) {
    const err = new Error(`Höchstens ${MAX_MESSAGES} Nachrichten je Sitzung`);
    err.code = 'TOO_MANY_MESSAGES';
    throw err;
  }
  texts.forEach(pruefeText);

  return new Promise((resolve, reject) => {
    let settled = false;
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
    let delivered = 0;
    let waiting = null;   // { text, at } der Nachricht, deren Bestaetigung gerade aussteht

    function schickeNaechste() {
      if (waiting) return;

      if (delivered >= texts.length) {
        sendControl({ t: 'bye' });
        finish({ delivered, peer });
        return;
      }

      const text = texts[delivered];
      const at = new Date().toISOString();
      waiting = { text, at };
      sendControl({ t: 'say', text, at });
    }

    const handle = (msg) => {
      if (msg.t === 'got') {
        if (!waiting) return;   // unerwartet - wird ignoriert statt die Sitzung zu sprengen
        const { text, at } = waiting;
        waiting = null;
        delivered++;
        // text/at gehen mit, damit der Aufrufer genau das ablegen kann,
        // was tatsaechlich bestaetigt wurde - mit demselben Zeitstempel,
        // der auch bei der Gegenstelle steht.
        onEvent({ type: 'delivered', done: delivered, of: texts.length, text, at });
        schickeNaechste();
        return;
      }

      if (msg.t === 'error') {
        const err = new Error(msg.message || 'Die Gegenstelle hat abgebrochen');
        if (msg.code) err.code = msg.code;
        fail(err);
      }
    };

    function drain() {
      for (let packet = channel.next(); packet; packet = channel.next()) {
        if (packet.type !== frame.CONTROL) continue;
        const msg = frame.readControl(packet.body);
        if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
        handle(msg);
      }
    }

    session.connect(transport, { identity, expect, initiator: true, onEvent })
      .then((h) => {
        channel = h.channel;
        sendControl = h.sendControl;
        peer = h.peer;

        // Die Zustaendigkeit fuer neue Bytes geht ab hier auf uns ueber
        // (siehe Channel.setOwner) - der Transport selbst wird kein
        // zweites Mal angefasst (ein echter Socket haengt Zuhoerer nur
        // an, ersetzt sie nicht).
        channel.setOwner({
          onData: drain,
          onError: fail,
          onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
        });

        schickeNaechste();
        try { drain(); } catch (err) { fail(err); }
      })
      .catch(fail);
  });
}

/**
 * Nimmt Nachrichten ueber einen bereits gesicherten Kanal entgegen -
 * der Aufrufer hat den Handschlag (session.connect) schon hinter sich
 * und weiss aus der ersten Nachricht, dass es hier um Text geht.
 *
 * `ersteNachricht` ist genau diese schon gelesene erste Nachricht
 * (dasselbe Muster wie bei session.receiveOn) - ohne sie ginge sie
 * verloren, denn das Lesen selbst hat sie schon aus der Warteschlange
 * des Kanals entfernt.
 *
 * `onMessage({ text, at })` wird VOR dem "got" gerufen: erst ablegen,
 * dann bestaetigen. Wirft der Rueckruf, geht kein "got" raus - die
 * Gegenstelle sieht dann keine Bestaetigung und weiss, dass es nicht
 * sicher angekommen ist.
 */
function listen(channel, peer, { onMessage = () => {}, onEvent = () => {} } = {}, ersteNachricht = null) {
  const transport = channel.transport;
  const sendControl = (obj) => channel.send(frame.control(obj));

  let received = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (channel.keys) {
        try { sendControl({ t: 'error', message: err.message, code: err.code || null }); } catch { /* egal */ }
      }
      try { transport.close(); } catch { /* egal */ }
      reject(err);
    };
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const handle = (msg) => {
      if (msg.t === 'say') {
        if (received >= MAX_MESSAGES) {
          return fail(Object.assign(
            new Error(`Höchstens ${MAX_MESSAGES} Nachrichten je Sitzung`), { code: 'TOO_MANY_MESSAGES' }
          ));
        }
        try {
          pruefeText(msg.text);
        } catch (err) {
          return fail(err);
        }

        try {
          onMessage({ text: msg.text, at: msg.at });
        } catch (err) {
          // Kein "got" - die Gegenstelle merkt am Ausbleiben der
          // Bestaetigung, dass es nicht sicher abgelegt wurde.
          return fail(err);
        }
        received++;
        sendControl({ t: 'got', at: msg.at });
        // Nicht 'received' getauft: dieser Ereignisname ist schon fuer
        // den Abschluss einer Dateiuebertragung vergeben (session.js /
        // node.js) und liefe durch dieselbe onEvent-Leitung - eine
        // Namensgleichheit haette dort ein falsch geformtes Ereignis
        // ausgeloest.
        onEvent({ type: 'got', done: received });
        return;
      }

      if (msg.t === 'bye') {
        finish({ received, peer });
        return;
      }

      if (msg.t === 'error') {
        const err = new Error(msg.message || 'Die Gegenstelle hat abgebrochen');
        if (msg.code) err.code = msg.code;
        fail(err);
      }
    };

    const processPacket = (packet) => {
      if (packet.type !== frame.CONTROL) return fail(new Error('Unlesbare Steuernachricht'));
      const msg = frame.readControl(packet.body);
      if (!msg) return fail(new Error('Unlesbare Steuernachricht'));
      handle(msg);
    };

    function drain() {
      for (let packet = channel.next(); packet; packet = channel.next()) processPacket(packet);
    }

    // Die Zustaendigkeit fuer neue Bytes geht ab hier auf uns ueber
    // (siehe Channel.setOwner) - der Transport selbst wird kein
    // zweites Mal angefasst.
    channel.setOwner({
      onData: drain,
      onError: fail,
      onClose: () => fail(new Error('Die Verbindung wurde getrennt'))
    });

    try {
      if (ersteNachricht) processPacket(ersteNachricht);
      if (!settled) drain();
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { say, listen, MAX_TEXT_LENGTH, MAX_MESSAGES };
