'use strict';

/* =================================================================
   Der Verlauf der Kurznachrichten - eine Datei je Geraet, neben
   identity.json und peers.json.

   Anders als die Dateiuebertragung braucht ein Chatverlauf ein
   Gedaechtnis: eine empfangene Nachricht ist kein Block, der sich aus
   der Platte nachrechnen liesse, sie ist der Inhalt selbst. Deshalb
   wird hier tatsaechlich mitgeschrieben, mit denselben Rechten wie der
   geheime Schluessel (0600) - der Verlauf verraet, mit wem man wann
   worueber geschrieben hat, das ist nicht weniger schuetzenswert.

   Je Gegenstelle wird nur eine begrenzte Menge behalten: aeltere
   Nachrichten fallen hinten heraus, nicht mittendrin - der Verlauf
   bleibt damit ein zusammenhaengendes Stueck, ohne Luecken mittendrin.
   ================================================================= */

const fs = require('fs');
const path = require('path');

const MAX_PER_PEER = 500;

function open(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'messages.json');

  // Unlesbare oder fehlende Datei: leer anfangen, nicht abstuerzen. Ein
  // Chatverlauf, der beim Start crasht, waere schlimmer als ein
  // verlorener Verlauf.
  let bySeit = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [address, liste] of Object.entries(raw)) {
        if (!Array.isArray(liste)) continue;
        const sauber = liste.filter((e) => (
          e && typeof e === 'object'
          && (e.dir === 'in' || e.dir === 'out')
          && typeof e.text === 'string'
          && typeof e.at === 'string'
        ));
        if (sauber.length) bySeit[address] = sauber.slice(-MAX_PER_PEER);
      }
    }
  } catch {
    bySeit = {};
  }

  function save() {
    fs.writeFileSync(file, JSON.stringify(bySeit, null, 2), { mode: 0o600 });
  }

  return {
    /** Legt eine Nachricht ab - eingegangen ('in') oder abgeschickt ('out'). */
    add(address, { dir, text, at }) {
      if (dir !== 'in' && dir !== 'out') throw new Error('dir muss "in" oder "out" sein');
      if (typeof text !== 'string') throw new Error('text muss eine Zeichenkette sein');

      const entry = { dir, text, at: at || new Date().toISOString() };
      const liste = bySeit[address] || (bySeit[address] = []);
      liste.push(entry);
      if (liste.length > MAX_PER_PEER) liste.splice(0, liste.length - MAX_PER_PEER);

      save();
      return entry;
    },

    /** Der ganze Verlauf mit einer Gegenstelle, aelteste zuerst. */
    forPeer(address) {
      return (bySeit[address] || []).slice();
    },

    /** Alle Gegenstellen, mit denen es einen Verlauf gibt. */
    peers() {
      return Object.entries(bySeit)
        .filter(([, liste]) => liste.length > 0)
        .map(([address, liste]) => ({
          address,
          letzte: liste[liste.length - 1].at,
          anzahl: liste.length
        }));
    },

    /** Loescht den Verlauf einer Gegenstelle, oder ganz ohne Anschrift: alles. */
    clear(address) {
      if (address) {
        const hatte = Boolean(bySeit[address]);
        delete bySeit[address];
        if (hatte) save();
        return hatte;
      }
      const hatte = Object.keys(bySeit).length > 0;
      bySeit = {};
      if (hatte) save();
      return hatte;
    }
  };
}

module.exports = { open };
