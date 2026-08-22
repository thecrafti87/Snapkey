#!/usr/bin/env node
'use strict';

/* =================================================================
   Sagt, ob dieser Rechner SNAPKEY signieren und beglaubigen kann.

   Signieren und Beglaubigen sind zwei verschiedene Dinge, und beide
   muessen sitzen, damit macOS beim Empfaenger nichts meldet:

     Signieren    braucht ein "Developer ID Application"-Zertifikat im
                  Schluesselbund. Es sagt, WER das Programm gebaut hat.
     Beglaubigen  schickt das fertige Paket zu Apple, die es kurz
                  pruefen und einen Vermerk zurueckgeben. Das sagt, dass
                  NICHTS BEKANNT SCHAEDLICHES drin ist.

   Ohne das Zweite meldet macOS trotz gueltiger Signatur weiterhin
   Bedenken - deshalb pruefen wir beides und nicht nur eines.
   ================================================================= */

const { execFileSync } = require('child_process');

const PROFIL = process.env.SNAPKEY_NOTARY_PROFIL || 'SNAPKEY_NOTARY';

function ruhig(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Welche Developer-ID-Zertifikate liegen im Schluesselbund? */
function zertifikate() {
  const aus = ruhig('security', ['find-identity', '-v', '-p', 'codesigning']) || '';
  return aus
    .split('\n')
    .filter((z) => z.includes('Developer ID Application'))
    .map((z) => (z.match(/"([^"]+)"/) || [])[1])
    .filter(Boolean);
}

/** Ist ein Apple-Zugang fuer die Beglaubigung hinterlegt? */
function beglaubigungBereit() {
  const aus = ruhig('xcrun', ['notarytool', 'history', '--keychain-profile', PROFIL]);
  return aus !== null;
}

const zert = zertifikate();
const beglaubigt = beglaubigungBereit();

console.log('SNAPKEY — kann dieser Rechner signieren?\n');

if (zert.length) {
  console.log('  Zertifikat    ✓ ' + zert[0]);
} else {
  console.log('  Zertifikat    ✗ keines gefunden');
}
console.log(beglaubigt
  ? `  Beglaubigung  ✓ Zugang "${PROFIL}" ist hinterlegt`
  : `  Beglaubigung  ✗ kein Zugang unter "${PROFIL}"`);

console.log('');

if (zert.length && beglaubigt) {
  console.log('Alles da. `npm run dist:signiert` baut, signiert und beglaubigt.');
  process.exit(0);
}

console.log('Was noch zu tun ist — das kann dir niemand abnehmen, es verlangt');
console.log('deine Apple-Anmeldung und deine Zahlungsdaten:\n');

if (!zert.length) {
  console.log('  1. Apple Developer Program, 99 € im Jahr');
  console.log('     https://developer.apple.com/programs/');
  console.log('');
  console.log('  2. Zertifikat "Developer ID Application" anlegen und laden');
  console.log('     https://developer.apple.com/account/resources/certificates');
  console.log('     Danach doppelklicken, damit es im Schlüsselbund landet.');
  console.log('');
}

if (!beglaubigt) {
  console.log('  3. Ein app-spezifisches Passwort erzeugen');
  console.log('     https://appleid.apple.com → Anmelden und Sicherheit');
  console.log('');
  console.log('  4. Diesen Zugang einmalig hinterlegen:');
  console.log('');
  console.log(`     xcrun notarytool store-credentials "${PROFIL}" \\`);
  console.log('       --apple-id DEINE@APPLE-ID.DE \\');
  console.log('       --team-id DEINE-TEAM-ID \\');
  console.log('       --password DAS-APP-SPEZIFISCHE-PASSWORT');
  console.log('');
  console.log('     Die Team-ID steht oben rechts im Developer-Konto.');
  console.log('');
}

console.log('Danach nochmal `npm run signatur` — und wenn beide Haken stehen,');
console.log('baut `npm run dist:signiert` ein Paket, das ohne Warnung startet.');
process.exit(1);
