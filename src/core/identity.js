'use strict';

/* =================================================================
   Wer man ist, und wie man das sagt.

   Beim ersten Start entsteht ein Schluesselpaar. Der geheime Teil
   verlaesst das Geraet nie. Der oeffentliche Teil ist die Kennung -
   nur in einer Form, die man vorlesen kann:

     kaiman:uhr-kaese-feder-rock-zucker-eimer

   Sechs Woerter aus der Liste, abgeleitet aus dem oeffentlichen
   Schluessel. Die Kennung ist eine ANSCHRIFT, kein Geheimnis: sie sagt,
   wen man sucht, nicht dass man es sein darf. Wer sich als jemand
   ausgeben will, braucht dessen geheimen Schluessel, und den hat er
   nicht.

   Beim ersten Kontakt merkt sich die App den vollen Schluessel der
   Gegenstelle. Ab da ist jede weitere Verbindung daran gebunden. Das
   ist dasselbe Modell, mit dem SSH seit dreissig Jahren arbeitet: beim
   ersten Mal vertraut man, danach faellt jede Abweichung auf.
   ================================================================= */

const { WORDS } = require('./words');
const { keyPair, sha256, equal } = require('./crypto');

const SCHEME = 'kaiman';
const ADDRESS_WORDS = 6;

// Wie viele Bits sich mit sechs Woertern darstellen lassen. Der Wert
// wird nicht geraten, sondern aus der Liste gerechnet - waechst sie,
// waechst er mit.
const SPACE = BigInt(WORDS.length) ** BigInt(ADDRESS_WORDS);
const ADDRESS_BITS = Math.floor(Math.log2(Number(SPACE)));

/**
 * Aus dem oeffentlichen Schluessel wird die Anschrift.
 *
 * Genommen werden die obersten Bits seiner Pruefsumme, nicht der
 * Schluessel selbst - aus der Anschrift laesst sich also nicht auf den
 * Schluessel zurueckrechnen, und sie bleibt kurz genug zum Vorlesen.
 */
function addressOf(pub) {
  const digest = sha256(pub);

  // Die ersten acht Bytes als Zahl, dann auf den Wertebereich der
  // sechs Woerter zusammenfalten.
  let value = digest.readBigUInt64BE(0) % SPACE;

  const words = [];
  const base = BigInt(WORDS.length);
  for (let i = 0; i < ADDRESS_WORDS; i++) {
    words.push(WORDS[Number(value % base)]);
    value /= base;
  }
  return words.join('-');
}

/** Die Anschrift mit Vorsatz, so wie sie weitergegeben wird. */
const uriOf = (pub) => `${SCHEME}:${addressOf(pub)}`;

/**
 * Liest eine Anschrift aus dem, was jemand einfuegt - mit oder ohne
 * Vorsatz, mit Leerzeichen statt Bindestrichen, in Grossbuchstaben.
 * Gibt null zurueck, wenn daraus keine wird.
 */
function parseAddress(input) {
  const text = String(input || '').trim().toLowerCase();
  const body = text.startsWith(`${SCHEME}:`) ? text.slice(SCHEME.length + 1) : text;

  const words = body.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length !== ADDRESS_WORDS) return null;
  if (!words.every((w) => WORDS.includes(w))) return null;

  return words.join('-');
}

/** Gehoert diese Anschrift zu diesem Schluessel? */
function addressMatches(address, pub) {
  const clean = parseAddress(address);
  return clean !== null && clean === addressOf(pub);
}

/**
 * Der Fingerabdruck - die Kurzform zum Vergleichen ueber einen anderen
 * Kanal ("lies mir mal deine vier Gruppen vor"). Anders als die
 * Anschrift deckt er den ganzen Schluessel ab.
 */
function fingerprintOf(pub) {
  return sha256(pub).subarray(0, 8).toString('hex')
    .replace(/(.{4})/g, '$1 ').trim();
}

/** Ein frisches Geraet: Schluesselpaar plus die Namen dazu. */
function create() {
  const { pub, priv } = keyPair();
  return { pub, priv, address: addressOf(pub), uri: uriOf(pub), fingerprint: fingerprintOf(pub) };
}

/* --------------------- Gemerkte Gegenstellen --------------------- */

/**
 * Vertrauen beim ersten Kontakt.
 *
 * `remember` gibt zurueck, was passiert ist - und der Fall, auf den es
 * ankommt, ist `changed`: die Anschrift ist dieselbe, der Schluessel
 * aber nicht. Das ist entweder eine Neuinstallation der Gegenstelle
 * oder jemand, der sich dazwischensetzt. Diesen Unterschied kann das
 * Programm nicht entscheiden, also entscheidet es ihn auch nicht - es
 * meldet ihn und haelt an.
 */
function makeStore(initial = []) {
  const peers = new Map(initial.map((p) => [p.address, { ...p, pub: Buffer.from(p.pub) }]));

  return {
    get: (address) => peers.get(address) || null,

    list: () => [...peers.values()],

    remember(address, pub, name = null) {
      const known = peers.get(address);
      if (!known) {
        peers.set(address, { address, pub: Buffer.from(pub), name, since: new Date().toISOString() });
        return { status: 'new' };
      }
      if (equal(known.pub, pub)) {
        if (name && !known.name) known.name = name;
        return { status: 'known', peer: known };
      }
      return { status: 'changed', peer: known };
    },

    forget: (address) => peers.delete(address)
  };
}

module.exports = {
  SCHEME, ADDRESS_WORDS, ADDRESS_BITS,
  create, addressOf, uriOf, parseAddress, addressMatches, fingerprintOf,
  makeStore
};
