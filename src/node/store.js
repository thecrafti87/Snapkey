'use strict';

/* =================================================================
   Was ein Geraet ueber sich und andere behaelt.

   Zwei Dateien in einem Ordner: der eigene Schluessel und die Liste der
   Gegenstellen, denen man schon einmal begegnet ist.

   Der geheime Schluessel wird mit 0600 geschrieben und der Ordner mit
   0700 angelegt. Das ist keine Zierde: auf einem Rechner mit mehreren
   Benutzern waere er sonst fuer alle lesbar, und wer ihn hat, ist man.
   ================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const identity = require('../core/identity');

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (str) => Buffer.from(String(str), 'base64url');

const homeDir = () => process.env.KAIMAN_HOME || path.join(os.homedir(), '.kaiman');

function open(dir = homeDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const keyFile = path.join(dir, 'identity.json');
  const peerFile = path.join(dir, 'peers.json');

  /* --------------------------- Ich --------------------------- */

  let me;
  try {
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const pub = unb64(raw.pub);
    const priv = unb64(raw.priv);
    if (pub.length !== 32 || priv.length !== 32) throw new Error('Schlüssel unbrauchbar');
    me = {
      pub, priv,
      address: identity.addressOf(pub),
      uri: identity.uriOf(pub),
      fingerprint: identity.fingerprintOf(pub)
    };
  } catch {
    // Beim ersten Start - oder wenn die Datei nicht mehr zu gebrauchen
    // ist. Eine neue Kennung ist besser als ein Programm, das nicht
    // startet; die Gegenstellen melden dann "Schluessel geaendert", und
    // genau dafuer ist diese Meldung da.
    me = identity.create();
    fs.writeFileSync(keyFile, JSON.stringify({ pub: b64(me.pub), priv: b64(me.priv) }, null, 2), { mode: 0o600 });
  }

  /* ----------------------- Die anderen ----------------------- */

  let liste = [];
  try {
    const raw = JSON.parse(fs.readFileSync(peerFile, 'utf8'));
    if (Array.isArray(raw)) {
      liste = raw
        .map((p) => ({ ...p, pub: unb64(p.pub) }))
        .filter((p) => p.pub.length === 32 && typeof p.address === 'string');
    }
  } catch {
    liste = [];
  }

  const peers = identity.makeStore(liste);

  function save() {
    const raus = peers.list().map((p) => ({ ...p, pub: b64(p.pub) }));
    fs.writeFileSync(peerFile, JSON.stringify(raus, null, 2), { mode: 0o600 });
  }

  return {
    dir,
    me,

    peers: {
      list: () => peers.list(),
      get: (address) => peers.get(address),

      /** Merkt sich eine Gegenstelle und sichert die Liste sofort. */
      remember(address, pub, name) {
        const res = peers.remember(address, pub, name);
        if (res.status !== 'changed') save();
        return res;
      },

      /**
       * Uebernimmt einen geaenderten Schluessel - nur auf
       * ausdrueckliche Ansage eines Menschen. Ohne diesen Weg gaebe es
       * keinen Ausweg, wenn jemand wirklich neu installiert hat.
       */
      replace(address, pub, name) {
        peers.forget(address);
        const res = peers.remember(address, pub, name);
        save();
        return res;
      },

      forget(address) {
        const weg = peers.forget(address);
        if (weg) save();
        return weg;
      }
    }
  };
}

module.exports = { open, homeDir };
