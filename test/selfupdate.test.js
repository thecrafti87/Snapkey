'use strict';

/* =================================================================
   Pruefungen fuer app/selfupdate.js - ohne Netz und ohne Electron.

   Nur die reinen Teile werden hier angefasst (siehe module.exports in
   selfupdate.js): Fassungsvergleich, Anhangswahl, Repo-Pruefung und
   canReplace() im Entwicklungslauf. check()/prepare()/install() mit
   echtem Netz und echtem Bundle sind hier bewusst nicht dabei - das
   ist Sache eines echten Baus (siehe Abnahme im Auftrag).
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  isNewer,
  pickAsset,
  isConfiguredRepo,
  configuredRepo,
  canReplace,
  check
} = require('../app/selfupdate');

/* ------------------------------ Fassungsvergleich ------------------------------ */

test('compareVersions vergleicht ziffernweise, nicht als Zeichenkette', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.1.9', '1.2.0'), -1);
  // "1.10.0" > "1.9.0" numerisch, obwohl "1.10.0" < "1.9.0" als Text waere.
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.9.0'), 0);
});

test('isNewer: 1.2.0 ist neuer als 1.1.9', () => {
  assert.equal(isNewer('1.2.0', '1.1.9'), true);
});

test('isNewer: 1.10.0 ist neuer als 1.9.0', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

test('isNewer: gleiche Fassung ist nicht neuer', () => {
  assert.equal(isNewer('1.4.2', '1.4.2'), false);
  assert.equal(isNewer('1.4.0', '1.4'), false); // fehlende Stellen zaehlen als 0
});

test('isNewer: ein v-Vorsatz stoert nicht', () => {
  assert.equal(isNewer('v1.2.0', '1.1.9'), true);
  assert.equal(isNewer('1.2.0', 'v1.1.9'), true);
  assert.equal(isNewer('v2.0.0', 'v1.9.9'), true);
});

test('isNewer: Unfug fuehrt nie zu einer falschen "ja, neuer"-Antwort', () => {
  assert.equal(isNewer('banane', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', 'banane'), false);
  assert.equal(isNewer('', '1.0.0'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
  assert.equal(isNewer('1.2.0-beta', '1.1.0'), false);
  assert.equal(isNewer(undefined, undefined), false);
});

/* ------------------------------ Anhangswahl ------------------------------ */

function nachgemachteVeroeffentlichung(namen) {
  return {
    tag_name: 'v2.4.0',
    html_url: 'https://example.invalid/releases/v2.4.0',
    assets: namen.map((name) => ({
      name,
      browser_download_url: `https://example.invalid/dl/${name}`,
      size: 1234
    }))
  };
}

test('pickAsset waehlt das arm64-DMG bei arm64', () => {
  const release = nachgemachteVeroeffentlichung(['SNAPKEY-2.4.0-x64.dmg', 'SNAPKEY-2.4.0-arm64.dmg']);
  const asset = pickAsset(release, 'arm64');
  assert.equal(asset.name, 'SNAPKEY-2.4.0-arm64.dmg');
  assert.equal(asset.version, '2.4.0');
  assert.equal(asset.url, 'https://example.invalid/dl/SNAPKEY-2.4.0-arm64.dmg');
});

test('pickAsset waehlt das x64-DMG bei jeder anderen Architektur', () => {
  const release = nachgemachteVeroeffentlichung(['SNAPKEY-2.4.0-x64.dmg', 'SNAPKEY-2.4.0-arm64.dmg']);
  const asset = pickAsset(release, 'x64');
  assert.equal(asset.name, 'SNAPKEY-2.4.0-x64.dmg');
});

test('pickAsset scheitert sauber, wenn der passende Anhang fehlt', () => {
  const release = nachgemachteVeroeffentlichung(['SNAPKEY-2.4.0-x64.dmg']);
  assert.equal(pickAsset(release, 'arm64'), null);
});

test('pickAsset scheitert sauber ohne tag_name oder ohne Anhaenge', () => {
  assert.equal(pickAsset({ assets: [] }, 'x64'), null);
  assert.equal(pickAsset({ tag_name: 'v1.0.0' }, 'x64'), null);
  assert.equal(pickAsset(null, 'x64'), null);
});

/* ------------------------------ Repo-Pruefung ------------------------------ */

test('isConfiguredRepo erkennt eine echte "eigner/name"-Angabe', () => {
  assert.equal(isConfiguredRepo('bezi-film/snapkey'), true);
});

test('isConfiguredRepo lehnt leer, Unfug und bekannte Platzhalter ab', () => {
  assert.equal(isConfiguredRepo(''), false);
  assert.equal(isConfiguredRepo('   '), false);
  assert.equal(isConfiguredRepo(undefined), false);
  assert.equal(isConfiguredRepo(null), false);
  assert.equal(isConfiguredRepo('keine-schraegstriche'), false);
  assert.equal(isConfiguredRepo('owner/repo'), false);
  assert.equal(isConfiguredRepo('OWNER/REPO'), false);
  assert.equal(isConfiguredRepo('eigner/name'), false);
});

test('configuredRepo liest den Ort aus package.json', () => {
  // Frueher stand hier, das Feld sei leer - und die Pruefung fiel um, als
  // der Ort eingetragen wurde. Sie haengt jetzt an der Form, nicht am
  // Inhalt: entweder es steht nichts da, oder etwas Brauchbares.
  const ort = configuredRepo();
  if (ort === '') return;
  assert.match(ort, /^[\w.-]+\/[\w.-]+$/, `unbrauchbarer Eintrag: ${ort}`);
  assert.equal(isConfiguredRepo(ort), true, 'der eingetragene Ort gilt als Platzhalter');
});

test('check() mit leerem Repo scheitert sofort, ohne Netzanfrage', async () => {
  const res = await check('');
  assert.deepEqual(res, { ok: false, reason: 'nicht-eingerichtet' });
});

test('check() mit einem Platzhalter-Repo scheitert sofort, ohne Netzanfrage', async () => {
  const res = await check('owner/repo');
  assert.deepEqual(res, { ok: false, reason: 'nicht-eingerichtet' });
});

/* ------------------------------ canReplace() ------------------------------ */

test('canReplace behauptet im Entwicklungslauf nie, es ginge', () => {
  const res = canReplace();
  assert.equal(res.ok, false);
  // Dieser Lauf hier ist weder gepackt noch ueberhaupt Electron - je
  // nach Plattform ist der genannte Grund 'dev' (macOS) oder 'platform'
  // (ueberall sonst), niemals ok:true.
  assert.ok(['dev', 'platform'].includes(res.reason), `unerwarteter Grund: ${res.reason}`);
  if (process.platform === 'darwin') assert.equal(res.reason, 'dev');
  else assert.equal(res.reason, 'platform');
});

/* --------------------- Die Quelle im gebauten Paket --------------------- */

// electron-builder streift beim Packen das build-Feld aus der
// package.json - build.publish existiert im installierten Paket also
// NICHT. Aufgefallen erst am installierten Paket: das Selbstupdate
// meldete "kein Veroeffentlichungsort", obwohl im Quelltext einer
// stand, und zwar auf jedem System. Der Rueckfallweg liest deshalb das
// Standardfeld repository, das das Packen uebersteht.

const { repoAusFeld } = require('../app/selfupdate');

test('repoAusFeld liest jede uebliche Schreibweise des repository-Feldes', () => {
  assert.equal(repoAusFeld('github:thecrafti87/Snapkey'), 'thecrafti87/Snapkey');
  assert.equal(repoAusFeld('https://github.com/thecrafti87/Snapkey.git'), 'thecrafti87/Snapkey');
  assert.equal(repoAusFeld('git+https://github.com/thecrafti87/Snapkey.git'), 'thecrafti87/Snapkey');
  assert.equal(repoAusFeld({ type: 'git', url: 'https://github.com/thecrafti87/Snapkey.git' }), 'thecrafti87/Snapkey');
});

test('was kein GitHub-Verweis ist, ergibt leer statt Unsinn', () => {
  assert.equal(repoAusFeld(undefined), '');
  assert.equal(repoAusFeld(''), '');
  assert.equal(repoAusFeld('https://gitlab.com/wer/auch-immer'), '');
  assert.equal(repoAusFeld({ url: null }), '');
});

test('package.json traegt das repository-Feld - ohne das ist das Selbstupdate im Paket blind', () => {
  // build.publish gibt es nur im Quelltext; im gebauten Paket bleibt
  // allein dieses Feld uebrig. Fehlt es, faellt der Fehler erst am
  // installierten Programm auf - deshalb wird es hier festgenagelt.
  const pkg = require('../package.json');
  assert.equal(repoAusFeld(pkg.repository), 'thecrafti87/Snapkey');
});
