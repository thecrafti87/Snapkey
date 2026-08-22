#!/usr/bin/env node
'use strict';

/* =================================================================
   Schickt die fertigen Pakete zu Apple und heftet den Vermerk an.

   Warum das ein eigener Schritt ist und nicht electron-builders
   eingebaute Beglaubigung: die verlangt das app-spezifische Passwort
   in einer Umgebungsvariablen. Von dort landet es in der Prozessliste,
   in Protokollen und in der Verlaufsdatei der Kommandozeile. Apples
   notarytool kann es stattdessen aus dem Schluesselbund holen - das
   Passwort verlaesst ihn nie.

   Signiert wird uebrigens nicht hier, sondern von electron-builder
   beim Bauen; das passiert von selbst, sobald ein passendes Zertifikat
   im Schluesselbund liegt. Dieser Schritt kommt danach.
   ================================================================= */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROFIL = process.env.SNAPKEY_NOTARY_PROFIL || 'SNAPKEY_NOTARY';
const AUSGABE = path.join(__dirname, '..', 'build');

function lauf(cmd, args, { still = false } = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: still ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']
  });
}

const pakete = fs.existsSync(AUSGABE)
  ? fs.readdirSync(AUSGABE).filter((n) => n.endsWith('.dmg')).map((n) => path.join(AUSGABE, n))
  : [];

if (!pakete.length) {
  console.error('Keine Pakete unter build/ gefunden - erst bauen, dann beglaubigen.');
  process.exit(1);
}

for (const paket of pakete) {
  const name = path.basename(paket);
  console.log(`\n— ${name}`);

  // Ist ueberhaupt eine Signatur drin? Ohne die lehnt Apple sofort ab,
  // und die Fehlermeldung von drueben ist dann wenig hilfreich.
  try {
    lauf('codesign', ['--verify', '--deep', '--strict', paket], { still: true });
    console.log('  Signatur     ✓');
  } catch {
    console.error('  Signatur     ✗ nicht signiert - beim Bauen fehlte das Zertifikat.');
    console.error('               `npm run signatur` sagt, was fehlt.');
    process.exit(1);
  }

  console.log('  Beglaubigen  … das dauert meist ein bis fuenf Minuten');
  try {
    lauf('xcrun', ['notarytool', 'submit', paket, '--keychain-profile', PROFIL, '--wait']);
  } catch {
    console.error('  Beglaubigen  ✗ Apple hat abgelehnt oder der Zugang stimmt nicht.');
    console.error(`               Naeheres: xcrun notarytool history --keychain-profile ${PROFIL}`);
    process.exit(1);
  }

  // Den Vermerk ans Paket heften, damit auch ein Rechner ohne Netz ihn
  // sieht. Ohne diesen Schritt fragt macOS beim ersten Start bei Apple
  // nach - und meldet Bedenken, wenn gerade keine Verbindung besteht.
  try {
    lauf('xcrun', ['stapler', 'staple', paket], { still: true });
    console.log('  Vermerk      ✓ angeheftet');
  } catch {
    console.error('  Vermerk      ✗ liess sich nicht anheften.');
    process.exit(1);
  }
}

console.log('\nFertig. Diese Pakete starten auf einem fremden Mac ohne Warnung.');
