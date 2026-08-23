'use strict';

/* =================================================================
   Pruefungen fuer app/quickaction.js - der Finder-Kurzbefehl.

   Schreibt NIE ins echte ~/Library/Services: SNAPKEY_TEST_SERVICES_DIR
   biegt das Ziel auf einen Wegwerf-Ordner um (siehe servicesDir() in
   quickaction.js). Jede Pruefung, die etwas anlegt, setzt die
   Variable selbst per tempdir() und raeumt im t.after() wieder auf -
   derselbe Zeitpunkt raeumt auch den Ordner selbst weg.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const quickaction = require('../app/quickaction');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-quickaction-'));
  const vorher = process.env.SNAPKEY_TEST_SERVICES_DIR;
  process.env.SNAPKEY_TEST_SERVICES_DIR = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (vorher === undefined) delete process.env.SNAPKEY_TEST_SERVICES_DIR;
    else process.env.SNAPKEY_TEST_SERVICES_DIR = vorher;
  });
  return dir;
}

/** Taeuscht fuer eine Pruefung eine andere Plattform vor, macht es danach rueckgaengig. */
function alsPlattform(t, platform) {
  const echte = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: echte, configurable: true }));
}

/* ---------------------------------------------------------------- */

test('supported() ist nur unter macOS wahr', (t) => {
  alsPlattform(t, 'darwin');
  assert.equal(quickaction.supported(), true);
});

test('auf einer anderen Plattform ist supported() falsch, und install() scheitert sauber statt zu werfen', (t) => {
  alsPlattform(t, 'linux');
  assert.equal(quickaction.supported(), false);
  assert.doesNotThrow(() => {
    assert.equal(quickaction.install('Mit SNAPKEY senden'), null);
  });
  assert.equal(quickaction.isInstalled(), false);
  assert.equal(quickaction.remove(), false);
});

test('install() legt das Buendel an, isInstalled() erkennt es, remove() nimmt es wieder weg', (t) => {
  const dir = tempdir(t);
  assert.equal(quickaction.isInstalled(), false, 'vor dem Anlegen darf noch nichts da sein');

  const zielpfad = quickaction.install('Mit SNAPKEY senden', 'SNAPKEY');
  assert.equal(zielpfad, path.join(dir, 'SNAPKEY.workflow'));
  assert.equal(quickaction.servicePath(), zielpfad);
  assert.equal(quickaction.isInstalled(), true);

  assert.equal(quickaction.remove(), true);
  assert.equal(quickaction.isInstalled(), false);
  assert.equal(fs.existsSync(zielpfad), false);
});

test('das erzeugte Buendel enthaelt die erwarteten Dateien und die uebergebene Beschriftung', (t) => {
  tempdir(t);
  const root = quickaction.install('Mit SNAPKEY senden', 'SNAPKEY');

  const contents = path.join(root, 'Contents');
  assert.ok(fs.statSync(contents).isDirectory());

  const dateien = fs.readdirSync(contents).sort();
  assert.deepEqual(dateien, ['Info.plist', 'document.wflow']);

  const info = fs.readFileSync(path.join(contents, 'Info.plist'), 'utf8');
  assert.match(info, /<string>Mit SNAPKEY senden<\/string>/);
  assert.match(info, /NSSendFileTypes/);
  assert.match(info, /public\.item/);

  const doc = fs.readFileSync(path.join(contents, 'document.wflow'), 'utf8');
  assert.match(doc, /open -a "SNAPKEY" "\$@"/);
});

test('zweimal anlegen ueberschreibt, statt zu scheitern', (t) => {
  tempdir(t);
  quickaction.install('Erste Beschriftung', 'SNAPKEY');
  const root = quickaction.install('Zweite Beschriftung', 'SNAPKEY');

  const info = fs.readFileSync(path.join(root, 'Contents', 'Info.plist'), 'utf8');
  assert.match(info, /Zweite Beschriftung/);
  assert.doesNotMatch(info, /Erste Beschriftung/);
  assert.equal(quickaction.isInstalled(), true);
});

test('remove() auf etwas, das nicht da ist, gibt false statt zu werfen', (t) => {
  tempdir(t);
  assert.equal(quickaction.isInstalled(), false);
  assert.doesNotThrow(() => {
    assert.equal(quickaction.remove(), false);
  });
});

test('nach dem Lauf steht im echten ~/Library/Services nichts Neues von SNAPKEY', () => {
  const echterOrt = path.join(os.homedir(), 'Library', 'Services', 'SNAPKEY.workflow');
  assert.equal(fs.existsSync(echterOrt), false);
});
