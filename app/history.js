'use strict';

/* =================================================================
   Der Verlauf abgeschlossener Uebertragungen - anders als die
   Kurznachrichten (src/node/messages.js) gehoert das nicht zum Kern:
   der Kern selbst fuehrt kein Gedaechtnis darueber, was schon
   uebertragen wurde, das ist reine Sache der Oberflaeche.

   Deshalb liegt history.json auch nicht unter ~/.snapkey, sondern im
   userData-Ordner von Electron, neben settings.json. Rechte 0600, wie
   beim Rest, was etwas ueber die eigenen Gegenstellen verraet.

   Absichtlich schmal gehalten, was hineindarf: kein Schluessel, kein
   Nachrichtentext - nur, was fuer eine Zeile im Verlauf noetig ist.
   Ein Aufrufer, der aus Versehen zu viel mitgibt, bekommt trotzdem nur
   die erlaubten Felder gespeichert.
   ================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 200;

// "nur, was du wirklich weisst" - alles andere wird beim Ablegen
// stillschweigend abgeschnitten, nicht erst beim Lesen bemaengelt.
const ERLAUBTE_FELDER = [
  'kind', 'peer', 'name', 'files', 'bytes', 'ok', 'route',
  'sent', 'had', 'recovered', 'outDir', 'paths', 'error'
];

function saeubern(entry) {
  const raus = {};
  for (const feld of ERLAUBTE_FELDER) {
    if (entry && entry[feld] !== undefined) raus[feld] = entry[feld];
  }
  return raus;
}

function open(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'history.json');

  // Unlesbare oder fehlende Datei: leer anfangen, nicht abstuerzen -
  // derselbe Griff wie bei src/node/messages.js. Ein Verlauf, der beim
  // Start crasht, waere schlimmer als ein verlorener Verlauf.
  let liste = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) {
      liste = raw
        .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string')
        .map((e) => ({ id: e.id, at: e.at, ...saeubern(e) }))
        .slice(-MAX_ENTRIES);
    }
  } catch {
    liste = [];
  }

  function save() {
    fs.writeFileSync(file, JSON.stringify(liste, null, 2), { mode: 0o600 });
  }

  function list() {
    return liste.slice().reverse();
  }

  return {
    /** Legt einen Eintrag ab - id und Zeitstempel entstehen hier, hoechstens 200 werden behalten. */
    add(entry) {
      const voll = { id: crypto.randomUUID(), at: new Date().toISOString(), ...saeubern(entry) };
      liste.push(voll);
      if (liste.length > MAX_ENTRIES) liste.splice(0, liste.length - MAX_ENTRIES);
      save();
      return list();
    },

    /** Der ganze Verlauf, neueste zuerst. */
    list,

    /** Loescht den ganzen Verlauf. */
    clear() {
      liste = [];
      save();
      return [];
    }
  };
}

module.exports = { open, MAX_ENTRIES };
