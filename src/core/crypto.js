'use strict';

/* =================================================================
   Die kryptografischen Bausteine, an einer Stelle.

   Alles hier kommt aus Nodes eingebauter Bibliothek - kein Fremdpaket,
   keine eigenen Primitiven. Die Auswahl ist danach getroffen, was
   spaeter auch im Browser zur Verfuegung steht:

     X25519       Schluesseleinigung   - WebCrypto, sonst @noble/curves
     HKDF-SHA256  Schluesselableitung  - WebCrypto
     AES-256-GCM  Verschluesselung     - WebCrypto, in Hardware beschleunigt
     SHA-256      Pruefsummen          - WebCrypto

   Bewusst AES-GCM statt ChaCha20: ChaCha kennt WebCrypto nicht, und ein
   Kern, der in beiden Welten laufen soll, darf sich nicht an etwas
   binden, das die eine Seite nicht hat.

   Diese Datei ist die einzige Stelle, die getauscht werden muss, wenn
   der Kern in den Browser zieht.
   ================================================================= */

const crypto = require('crypto');

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/* ------------------------- Schluesselpaare ------------------------- */

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(str, 'base64url');

/** Rohe 32 Bytes zu einem oeffentlichen Schluessel, den Node versteht. */
function importPublic(raw) {
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64(raw) },
    format: 'jwk'
  });
}

function importPrivate(rawPriv, rawPub) {
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: b64(rawPriv), x: b64(rawPub) },
    format: 'jwk'
  });
}

/** Ein frisches Schluesselpaar als rohe Bytes. */
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    pub: unb64(publicKey.export({ format: 'jwk' }).x),
    priv: unb64(privateKey.export({ format: 'jwk' }).d)
  };
}

/**
 * Der gemeinsame Wert aus eigenem geheimem und fremdem oeffentlichem
 * Schluessel. Beide Seiten rechnen dasselbe aus, ohne es zu senden.
 */
function dh(ownPriv, ownPub, peerPub) {
  return crypto.diffieHellman({
    privateKey: importPrivate(ownPriv, ownPub),
    publicKey: importPublic(peerPub)
  });
}

/* -------------------------- Ableitungen -------------------------- */

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Aus einem gemeinsamen Wert werden Schluessel fuer einzelne Zwecke.
 * `info` trennt sie voneinander: derselbe Ausgangswert, verschiedene
 * Verwendungen, und keiner laesst auf den anderen schliessen.
 */
function hkdf(ikm, salt, info, length = KEY_BYTES) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));
}

/* ------------------------ Verschluesselung ------------------------ */

/**
 * Der Zaehlwert, mit dem ein Paket verschluesselt wird.
 *
 * Er darf sich unter demselben Schluessel NIE wiederholen - bei GCM
 * bricht sonst nicht nur dieses eine Paket, sondern die Vertraulichkeit
 * beider. Deshalb ist er schlicht durchgezaehlt statt gewuerfelt, und
 * jede Richtung hat ihren eigenen Schluessel, damit sich die Zaehler
 * nicht ins Gehege kommen.
 */
function nonceFor(counter) {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('Zaehlwert ausserhalb des gueltigen Bereichs');
  }
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/** Verschluesselt und versiegelt. `aad` wird mitgeprueft, aber nicht verschluesselt. */
function seal(key, counter, plaintext, aad = Buffer.alloc(0)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFor(counter));
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/**
 * Oeffnet ein Paket. Gibt null zurueck, wenn das Siegel nicht passt -
 * also bei jeder Veraenderung, egal ob Uebertragungsfehler oder Absicht.
 * Kein Unterschied nach aussen: wer nicht den Schluessel hat, erfaehrt
 * auch nicht, wie knapp er daneben lag.
 */
function open(key, counter, box, aad = Buffer.alloc(0)) {
  if (box.length < TAG_BYTES) return null;
  const body = box.subarray(0, box.length - TAG_BYTES);
  const tag = box.subarray(box.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(counter));
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

/** Zeitkonstanter Vergleich - fuer alles, was ein Angreifer erraten koennte. */
function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const random = (n) => crypto.randomBytes(n);

module.exports = {
  KEY_BYTES, NONCE_BYTES, TAG_BYTES,
  keyPair, dh,
  sha256, hkdf,
  nonceFor, seal, open,
  equal, random
};
