'use strict';

/* =================================================================
   Was die Oberflaeche sich merkt.

   Bewusst getrennt von ~/.snapkey: dort liegen Schluessel und
   Gegenstellen, das gehoert dem Kern (siehe src/node/store.js). Hier
   liegt nur, was die Oberflaeche braucht, um beim naechsten Start
   denselben Knoten wieder zu oeffnen - im userData-Ordner von
   Electron, wie es sich fuer eine Anwendungseinstellung gehoert.
   ================================================================= */

const fs = require('fs');
const path = require('path');

// Leere Zeichenketten bedeuten "der Kern soll seinen eigenen Standard
// nehmen" (siehe buildNodeOptions in main.js) - nicht "nichts".
const DEFAULTS = {
  name: '',
  outDir: '',
  port: 0,
  trustNew: false,
  dedup: true,
  meetHost: '',
  meetPort: 41997,
  meetPass: '',
  portmap: false,
  lang: 'en',
  // Ruft der Knoten von selbst in den Raum? Steht bewusst NICHT in
  // NODE_FELDER: das laesst sich am laufenden Knoten umlegen (siehe
  // node:setSetting in main.js), ein Neustart waere hier unnoetig
  // grob - er risse jede laufende Uebertragung mit ab.
  autoScan: true,
  // Vor dem Empfang fragen. Steht wie autoScan NICHT in NODE_FELDER:
  // der Einwilligungs-Haken in main.js sieht bei jeder Frage selbst
  // nach, ein Neustart des Knotens waere fuer diesen Schalter unnoetig.
  confirmReceive: true,
  // Beide betreffen nur die Huelle (Menueleistensymbol, Mitteilungen),
  // nicht den Knoten - deshalb auch nicht in NODE_FELDER unten.
  tray: true,
  notify: true
};

// Diese Felder aendern, was der Knoten beim Oeffnen bekommt - eine
// Aenderung daran macht einen laufenden Knoten unehrlich, deshalb
// fuehrt main.js bei jedem von ihnen einen Neustart aus.
const NODE_FELDER = ['name', 'outDir', 'port', 'trustNew', 'dedup', 'meetHost', 'meetPort', 'meetPass', 'portmap'];

let cache = null;
let datei = null;

function init(userDataDir) {
  datei = path.join(userDataDir, 'settings.json');
  cache = null;
  return datei;
}

function load() {
  if (cache) return cache;
  let gespeichert = {};
  try {
    gespeichert = JSON.parse(fs.readFileSync(datei, 'utf8'));
  } catch {
    gespeichert = {};
  }
  cache = { ...DEFAULTS, ...gespeichert };
  return cache;
}

/** Speichert einen Teil der Einstellungen und gibt zurueck, ob ein Knotenfeld dabei war. */
function save(patch) {
  const vorher = load();
  cache = { ...vorher, ...patch };
  try {
    fs.mkdirSync(path.dirname(datei), { recursive: true });
    fs.writeFileSync(datei, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Einstellungen konnten nicht gespeichert werden:', err.message);
  }
  const betrifftKnoten = Object.keys(patch).some((k) => NODE_FELDER.includes(k));
  return { values: cache, betrifftKnoten };
}

module.exports = { DEFAULTS, NODE_FELDER, init, load, save, file: () => datei };
