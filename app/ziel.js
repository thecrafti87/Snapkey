'use strict';

/* =================================================================
   Eine Gegenstelle von Hand angeben.

   Normalerweise findet die Geraeteschau die Gegenstelle: man waehlt sie
   aus einer Liste, und Adresse und Port kommen von dort. Es gibt aber
   Netze, in denen der Rundruf nur in eine Richtung durchkommt -
   nachgemessen an einem Router, der Multicast von WLAN-Geraeten nicht
   ins Kabelnetz weiterreicht: das WLAN-Geraet sah das Kabel-Geraet,
   umgekehrt nie. Unicast lief dabei einwandfrei (Ping in 1 ms).

   Dann muss man die Gegenstelle benennen koennen, ohne sie zu finden.
   Die Kommandozeile kann das laengst (--an host:port); hier ist
   dieselbe Moeglichkeit fuer das Fenster.

   ZWEI FORMEN, und der Unterschied ist keiner der Bequemlichkeit:

     192.168.178.54:51877
       Der blosse Ort. Es wird verbunden, aber vorher steht nicht fest,
       WER dort antwortet - dieselbe Lage wie bei --an. Die Gegenstelle
       ihrerseits prueft weiterhin, wer anklopft.

     snapkey:wort-wort-...@192.168.178.54:51877
       Ort UND Anschrift. Jetzt ist im Voraus gesagt, wer dort erwartet
       wird, und der Handschlag weist jeden ab, der einen anderen
       Schluessel beweist. Das ist die Form, die die Empfangen-Seite zum
       Kopieren anbietet - deshalb ist sie der Normalfall und die
       nackte Adresse die Ausnahme.
   ================================================================= */

const identity = require('../src/core/identity');

/**
 * Liest eine von Hand eingegebene Gegenstelle.
 *
 * Gibt `{host, port}` zurueck, bei der laengeren Form zusaetzlich
 * `address`. Null heisst: das ist keine unmittelbare Adresse - dann ist
 * es eine Anschrift oder ein Geraetename, und darum kuemmert sich der
 * Aufrufer (siehe findZiel in main.js).
 */
function parseDirekt(eingabe) {
  const text = String(eingabe || '').trim();
  if (!text) return null;

  // Von hinten trennen: eine Anschrift enthaelt kein @, ein Host auch
  // nicht - aber sicher ist sicher, falls doch je eins auftaucht.
  const at = text.lastIndexOf('@');
  const anschriftTeil = at === -1 ? null : text.slice(0, at);
  const ortTeil = at === -1 ? text : text.slice(at + 1);

  // IPv6 gehoert in Klammern, sonst waeren seine eigenen Doppelpunkte
  // nicht vom Port zu unterscheiden.
  const m = /^\[([^\]\s]+)\]:(\d{1,5})$/.exec(ortTeil) || /^([^\s:@[\]]+):(\d{1,5})$/.exec(ortTeil);
  if (!m) return null;

  const host = m[1];
  const port = Number(m[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const ziel = { host, port };

  if (anschriftTeil !== null) {
    // Ein "@" ist eine Zusage: davor steht eine Anschrift. Steht dort
    // Unbrauchbares, wird NICHT stillschweigend auf den blossen Ort
    // zurueckgefallen - das waere ein Wegfall der Pruefung, den niemand
    // bemerkt hat.
    const address = identity.parseAddress(anschriftTeil);
    if (!address) return null;
    ziel.address = address;
  }

  return ziel;
}

/**
 * Die Zeile, die man der Gegenstelle gibt, damit sie einen ohne
 * Geraeteschau erreicht. Ohne Anschrift waere sie die halbe Miete -
 * deshalb steht sie immer mit drin.
 */
function direktText(address, host, port) {
  return `${identity.SCHEME}:${address}@${host}:${port}`;
}

module.exports = { parseDirekt, direktText };
