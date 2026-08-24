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

const homeDir = () => process.env.SNAPKEY_HOME || path.join(os.homedir(), '.snapkey');

function open(dir = homeDir(), { onEvent = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const keyFile = path.join(dir, 'identity.json');
  const peerFile = path.join(dir, 'peers.json');

  /* --------------------------- Ich --------------------------- */

  let me = null;
  let gabEsSchon = false;
  let grund = null;

  try {
    const text = fs.readFileSync(keyFile, 'utf8');
    gabEsSchon = true;

    const raw = JSON.parse(text);
    const pub = unb64(raw.pub);
    const priv = unb64(raw.priv);
    if (pub.length !== 32 || priv.length !== 32) throw new Error('Schlüssel unbrauchbar');
    me = {
      pub, priv,
      address: identity.addressOf(pub),
      uri: identity.uriOf(pub),
      fingerprint: identity.fingerprintOf(pub)
    };
  } catch (err) {
    // ENOENT beim ersten Start ist der Normalfall und kein Vorfall.
    // Alles andere heisst: es GAB eine Kennung, und sie ist jetzt nicht
    // zu gebrauchen.
    grund = err.code === 'ENOENT' ? null : (err.message || String(err));
    if (err.code === 'ENOENT') gabEsSchon = false;
  }

  if (!me) {
    // Die eigene Kennung ist alles, worauf sich Kopplungen stuetzen: eine
    // neue macht jede bestehende wertlos, und die Gegenstellen sehen ein
    // fremdes Geraet. Frueher geschah das STILL - hier stand ein catch,
    // das jeden Fehler schluckte und wortlos eine neue Kennung anlegte.
    // Wer dann jeden Start eine andere Anschrift hatte, konnte nirgends
    // ablesen, warum.
    //
    // Deshalb jetzt: die unlesbare Datei wird nicht ueberschrieben,
    // sondern beiseitegelegt - vielleicht laesst sich der Schluessel
    // daraus noch retten, und ueberschrieben waere er endgueltig weg.
    // Und es wird gemeldet, statt es geschehen zu lassen.
    if (gabEsSchon) {
      const beiseite = path.join(dir, `identity-unlesbar-${Date.now()}.json`);
      try {
        fs.renameSync(keyFile, beiseite);
      } catch { /* dann eben nicht - die neue Kennung ist trotzdem noetig */ }
      onEvent({ type: 'identity', state: 'verloren', message: grund, beiseite });
    }

    me = identity.create();
    fs.writeFileSync(keyFile, JSON.stringify({ pub: b64(me.pub), priv: b64(me.priv) }, null, 2), { mode: 0o600 });

    // Nachfassen: geschrieben ist nicht gelesen. Kann die Datei nicht
    // zurueckgelesen werden, bekaeme dieses Geraet bei JEDEM Start eine
    // neue Anschrift - genau das Bild, das den Fehler ueberhaupt
    // sichtbar gemacht hat. Lieber einmal laut sagen als es jedes Mal
    // stillschweigend zu wiederholen.
    try {
      const nachher = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (unb64(nachher.pub).length !== 32) throw new Error('zurueckgelesen unbrauchbar');
    } catch (err) {
      onEvent({
        type: 'identity',
        state: 'fluechtig',
        message: `Die Kennung liess sich nicht dauerhaft sichern (${err.message}) - dieses Gerät bekommt bei jedem Start eine neue Anschrift.`,
        file: keyFile
      });
    }
  }

  /* ----------------------- Die anderen ----------------------- */

  /** Liest die Gegenstellen frisch von der Platte. Unlesbares gilt als leer. */
  function vonPlatte() {
    try {
      const raw = JSON.parse(fs.readFileSync(peerFile, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw
        .map((p) => ({ ...p, pub: unb64(p.pub) }))
        .filter((p) => p.pub.length === 32 && typeof p.address === 'string');
    } catch {
      return [];
    }
  }

  // Kein const: nach jeder Aenderung tritt der frische Stand an seine
  // Stelle (siehe aendern()).
  let peers = identity.makeStore(vonPlatte());

  /**
   * Aendert die Liste auf dem FRISCHEN Stand der Platte, nicht auf dem
   * eigenen Gedaechtnis.
   *
   * Frueher schrieb save() schlicht die Liste im Speicher. Laufen zwei
   * SNAPKEY nebeneinander - zwei Fenster, oder das Fenster und die
   * Kommandozeile -, dann kennt jedes nur den Stand von seinem eigenen
   * Start. Wer als Zweiter koppelt, schreibt seine veraltete Liste
   * darueber, und die Kopplung des Ersten ist weg. Nachgemessen: zwei
   * Zugriffe auf denselben Ordner, jeder koppelt ein Geraet - danach
   * stand nur noch das zweite in der Datei.
   *
   * Deshalb: lesen, aendern, schreiben. Was ein anderer inzwischen
   * eingetragen hat, bleibt dabei stehen; nur die eigene Aenderung
   * kommt hinzu oder faellt weg.
   */
  function aendern(wandeln) {
    const frisch = identity.makeStore(vonPlatte());
    const ergebnis = wandeln(frisch);

    fs.writeFileSync(
      peerFile,
      JSON.stringify(frisch.list().map((p) => ({ ...p, pub: b64(p.pub) })), null, 2),
      { mode: 0o600 }
    );

    // Das eigene Gedaechtnis IST ab jetzt der frische Stand - nicht
    // nachgebaut, sondern uebernommen: ein Nachbau ueber remember()
    // wuerde jedem Eintrag ein neues "seit"-Datum verpassen.
    peers = frisch;

    return ergebnis;
  }

  return {
    dir,
    me,

    peers: {
      list: () => peers.list(),
      get: (address) => peers.get(address),

      /** Merkt sich eine Gegenstelle und sichert die Liste sofort. */
      remember(address, pub, name) {
        // Ein geaenderter Schluessel wird NICHT geschrieben - das ist der
        // Verdachtsfall, ueber den ein Mensch entscheidet (siehe
        // replace()). Deshalb erst fragen, dann gegebenenfalls aendern.
        if (peers.get(address) && peers.remember(address, pub, name).status === 'changed') {
          return { status: 'changed', peer: peers.get(address) };
        }
        return aendern((frisch) => frisch.remember(address, pub, name));
      },

      /**
       * Uebernimmt einen geaenderten Schluessel - nur auf
       * ausdrueckliche Ansage eines Menschen. Ohne diesen Weg gaebe es
       * keinen Ausweg, wenn jemand wirklich neu installiert hat.
       */
      replace(address, pub, name) {
        return aendern((frisch) => {
          frisch.forget(address);
          return frisch.remember(address, pub, name);
        });
      },

      forget(address) {
        return aendern((frisch) => frisch.forget(address));
      }
    }
  };
}

module.exports = { open, homeDir };
