'use strict';

/* =================================================================
   Die Sprache zwischen einem Geraet und dem Treffpunkt.

   Zehn Nachrichten, nichts weiter - formen und lesen, sonst nichts.
   Diese Datei weiss nichts von Sockeln oder Zustand; das gehoert
   server.js und net/meet.js. Genau deshalb laesst sie sich fuer sich
   pruefen.

   Die Vermittlung ist zweistufig: 'reach' bekommt zuerst nur die
   Auskunft ('found', mit der optionalen `direct`-Adresse der
   Gegenstelle, oder 'nobody'), und erst ein ausdrueckliches 'join'
   schaltet wirklich durch. So kann der Sucher zuerst selbst probieren,
   direkt zu verbinden, und nur bei Fehlschlag die Umleitung nehmen -
   klappt der direkte Weg, sagt 'cancel' der Stelle Bescheid.

   `direct` wird unveraendert durchgereicht - die Stelle prueft es nicht
   und glaubt ihm nichts. Die Angabe stammt von der Gegenstelle, und ob
   dort wirklich die richtige sitzt, klaert erst der Handschlag der
   Sitzung selbst (handshake.js), nicht der Treffpunkt.

   `read` ist die Stelle, die Unfug abweist. Auf einer offenen
   Verbindung landet zwangslaeufig auch Unsinn - ein Portscanner, ein
   falsch verbundener Klient, ein absichtlicher Angriffsversuch -, und
   jede dieser Nachrichten muss sich mit `null` begnuegen statt mit
   einer Ausnahme, die die Verbindung unkontrolliert umwirft.
   ================================================================= */

const frame = require('../core/frame');
const identity = require('../core/identity');

/* ------------------------------ Bauer ------------------------------ */

function hereMsg(address, pass, direct) {
  const msg = { t: 'here', address };
  if (pass) msg.pass = pass;
  if (direct) msg.direct = direct;
  return msg;
}

function reachMsg(address, pass) {
  const msg = { t: 'reach', address };
  if (pass) msg.pass = pass;
  return msg;
}

function foundMsg(direct) {
  const msg = { t: 'found' };
  if (direct) msg.direct = direct;
  return msg;
}

const okMsg = () => ({ t: 'ok' });
const joinedMsg = () => ({ t: 'joined' });
const nobodyMsg = () => ({ t: 'nobody' });
const deniedMsg = (reason) => ({ t: 'denied', reason: String(reason || '') });
const pingMsg = () => ({ t: 'ping' });
const pongMsg = () => ({ t: 'pong' });
const joinMsg = () => ({ t: 'join' });
const cancelMsg = () => ({ t: 'cancel' });

/* ------------------------------ Leser ------------------------------ */

/**
 * Prueft die Form einer schon geparsten Nachricht. Getrennt von `read`,
 * damit beide Seiten - die, die rohe Bytes hat, und die, die schon ein
 * Objekt hat - dieselbe Pruefung durchlaufen.
 */
function check(msg) {
  if (!msg || typeof msg !== 'object') return null;

  switch (msg.t) {
    case 'here':
    case 'reach': {
      if (typeof msg.address !== 'string') return null;
      const address = identity.parseAddress(msg.address);
      if (!address) return null;

      const out = { t: msg.t, address };
      if (msg.pass !== undefined) {
        if (typeof msg.pass !== 'string') return null;
        out.pass = msg.pass;
      }
      // `direct` ergibt bei 'here' Sinn (der Empfaenger meldet, wo er
      // sonst noch erreichbar ist) - bei 'reach' waere es sinnlos, wird
      // aber aus Kulanz einfach ignoriert statt die Nachricht zu verwerfen.
      if (msg.t === 'here' && msg.direct !== undefined) {
        if (typeof msg.direct !== 'string') return null;
        out.direct = msg.direct;
      }
      return out;
    }

    case 'found': {
      const out = { t: 'found' };
      if (msg.direct !== undefined) {
        if (typeof msg.direct !== 'string') return null;
        out.direct = msg.direct;
      }
      return out;
    }

    case 'ok':
    case 'joined':
    case 'nobody':
    case 'ping':
    case 'pong':
    case 'join':
    case 'cancel':
      return { t: msg.t };

    case 'denied':
      if (typeof msg.reason !== 'string') return null;
      return { t: 'denied', reason: msg.reason };

    default:
      return null;
  }
}

/**
 * Liest den Rumpf eines Steuerpakets (das, was `frame.split` als
 * `body` einer CONTROL-Nachricht liefert) zu einer geprueften
 * Vermittlungsnachricht - oder `null`, wenn daraus keine wird.
 */
function read(payload) {
  return check(frame.readControl(payload));
}

module.exports = {
  hereMsg, reachMsg, foundMsg, okMsg, joinedMsg, nobodyMsg, deniedMsg, pingMsg, pongMsg, joinMsg, cancelMsg,
  check, read
};
