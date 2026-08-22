'use strict';

/* =================================================================
   Der Handschlag: aus zwei Schluesselpaaren wird ein Sitzungsschluessel.

   ACHTUNG - HIER STEHT EINE SELBSTGEBAUTE ZUSAMMENSETZUNG.

   Sie benutzt ausschliesslich Standardbausteine (X25519, HKDF, SHA-256)
   und folgt einem bekannten Muster: vier Diffie-Hellman-Rechnungen ueber
   fluechtige und dauerhafte Schluessel, gebunden an ein Protokoll der
   gesamten Begegnung. Dasselbe Muster steckt hinter Noise KK. Trotzdem
   ist "aus richtigen Teilen zusammengesetzt" nicht dasselbe wie
   "geprueft", und der Unterschied faellt im Betrieb nicht auf - es
   funktioniert ja.

   Deshalb: BEVOR hier echte Daten fremder Leute durchgehen, wird diese
   Datei gegen eine gepruefte Noise-Umsetzung getauscht. Die Schnittstelle
   ist genau dafuer schmal gehalten - Nachrichten rein, zwei Schluessel
   raus. Nichts anderes im Kern muss sich dafuer aendern.

   Was das Muster leistet:
     - Vertraulichkeit auch spaeter noch (die fluechtigen Schluessel
       werden weggeworfen; ein spaeter gestohlener Dauerschluessel
       oeffnet aufgezeichnete Sitzungen nicht)
     - beidseitige Echtheit (wer den Dauerschluessel nicht hat, kommt
       durch die Bestaetigung nicht durch)
     - Bindung an den Verlauf (nichts laesst sich unbemerkt austauschen)
   ================================================================= */

const { keyPair, dh, sha256, hkdf, equal } = require('./crypto');

const PROTO = Buffer.from('snapkey-handshake-v1-x25519-hkdf-sha256-aes256gcm', 'utf8');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(String(str), 'base64url');

/** Ein oeffentlicher Schluessel hat genau diese Laenge - alles andere fliegt raus. */
const validPub = (buf) => Buffer.isBuffer(buf) && buf.length === 32;

/**
 * Das Protokoll der Begegnung. Jeder Wert, der die Sitzung bestimmt,
 * geht hier ein - dadurch haengen die Schluessel an allem, was gesagt
 * wurde, und nichts davon laesst sich nachtraeglich umdeuten.
 */
function transcriptOf(initStatic, respStatic, initEph, respEph) {
  return sha256(PROTO, initStatic, respStatic, initEph, respEph);
}

function derive(self, peer, initiator, transcript) {
  // Vier Rechnungen: fluechtig-fluechtig, fluechtig-dauerhaft in beide
  // Richtungen, dauerhaft-dauerhaft. Die erste sorgt fuer spaetere
  // Vertraulichkeit, die anderen drei fuer Echtheit.
  const ee = dh(self.eph.priv, self.eph.pub, peer.eph);
  const es = initiator
    ? dh(self.eph.priv, self.eph.pub, peer.stat)
    : dh(self.stat.priv, self.stat.pub, peer.eph);
  const se = initiator
    ? dh(self.stat.priv, self.stat.pub, peer.eph)
    : dh(self.eph.priv, self.eph.pub, peer.stat);
  const ss = dh(self.stat.priv, self.stat.pub, peer.stat);

  const master = hkdf(Buffer.concat([ee, es, se, ss]), transcript, 'snapkey master');

  return {
    master,
    // Jede Richtung bekommt ihren eigenen Schluessel. Sonst muessten
    // sich beide Seiten ueber die Zaehlwerte einig sein, und ein
    // wiederholter Zaehler bricht bei GCM alles auf.
    i2r: hkdf(master, transcript, 'snapkey i2r'),
    r2i: hkdf(master, transcript, 'snapkey r2i'),
    confirmInit: hkdf(master, transcript, 'snapkey confirm initiator'),
    confirmResp: hkdf(master, transcript, 'snapkey confirm responder')
  };
}

/**
 * Eine Seite des Handschlags.
 *
 * `identity`  eigenes dauerhaftes Schluesselpaar { pub, priv }
 * `expect`    der erwartete oeffentliche Schluessel der Gegenstelle,
 *             falls sie schon bekannt ist. Fehlt er, ist es ein erster
 *             Kontakt: dann wird der Schluessel gelernt und gemeldet,
 *             damit die Ebene darueber ueber Vertrauen entscheidet -
 *             nicht diese hier.
 */
function create({ identity, initiator, expect = null }) {
  const eph = keyPair();
  const self = { stat: identity, eph };

  let peer = null;
  let keys = null;
  let done = false;
  let firstContact = false;

  function ingestHello(msg) {
    const stat = unb64(msg.s);
    const ephPub = unb64(msg.e);
    if (!validPub(stat) || !validPub(ephPub)) throw new Error('Ungültiger Schlüssel im Handschlag');

    if (expect && !equal(expect, stat)) {
      const err = new Error('Die Gegenstelle meldet sich mit einem anderen Schlüssel als erwartet');
      err.code = 'PEER_CHANGED';
      throw err;
    }
    if (!expect) firstContact = true;

    peer = { stat, eph: ephPub };

    const transcript = initiator
      ? transcriptOf(self.stat.pub, peer.stat, self.eph.pub, peer.eph)
      : transcriptOf(peer.stat, self.stat.pub, peer.eph, self.eph.pub);

    keys = derive(self, peer, initiator, transcript);
  }

  return {
    /** Die erste Nachricht - nur der Anrufer schickt sie. */
    hello() {
      return { t: 'hello', s: b64(identity.pub), e: b64(eph.pub) };
    },

    /**
     * Nimmt eine Nachricht der Gegenstelle entgegen. Gibt zurueck, was
     * als naechstes zu senden ist, oder null.
     */
    read(msg) {
      if (done) throw new Error('Der Handschlag ist bereits abgeschlossen');
      if (!msg || typeof msg !== 'object') throw new Error('Leere Nachricht im Handschlag');

      if (!initiator && msg.t === 'hello') {
        ingestHello(msg);
        // Der Antwortende weist sich sofort mit aus - der Anrufer soll
        // nicht erst Daten schicken und danach erfahren, mit wem.
        return { t: 'hello', s: b64(identity.pub), e: b64(eph.pub), c: b64(keys.confirmResp) };
      }

      if (initiator && msg.t === 'hello') {
        ingestHello(msg);
        if (!equal(unb64(msg.c || ''), keys.confirmResp)) {
          const err = new Error('Die Gegenstelle konnte sich nicht ausweisen');
          err.code = 'BAD_CONFIRM';
          throw err;
        }
        done = true;
        return { t: 'confirm', c: b64(keys.confirmInit) };
      }

      if (!initiator && msg.t === 'confirm') {
        if (!keys) throw new Error('Bestätigung vor der Vorstellung');
        if (!equal(unb64(msg.c || ''), keys.confirmInit)) {
          const err = new Error('Die Gegenstelle konnte sich nicht ausweisen');
          err.code = 'BAD_CONFIRM';
          throw err;
        }
        done = true;
        return null;
      }

      throw new Error(`Unerwartete Nachricht im Handschlag: ${msg.t}`);
    },

    get done() { return done; },

    /** Die Schluessel, sobald der Handschlag durch ist. */
    result() {
      if (!done) throw new Error('Der Handschlag ist noch nicht abgeschlossen');
      return {
        peerStatic: peer.stat,
        firstContact,
        // Senden mit dem Schluessel der eigenen Richtung, lesen mit dem
        // der anderen.
        sendKey: initiator ? keys.i2r : keys.r2i,
        recvKey: initiator ? keys.r2i : keys.i2r
      };
    }
  };
}

module.exports = { create, PROTO };
