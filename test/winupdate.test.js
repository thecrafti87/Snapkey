'use strict';

/* =================================================================
   Pruefungen fuer app/winupdate.js - ohne Netz und ohne Electron.

   Wie bei selfupdate.test.js nur die Teile, die sich hier festnageln
   lassen: die Adressbildung, die Absagegruende, und - das ist der
   eigentliche Punkt dieser Datei - dass beide Wege zum Selbstupdate
   DENSELBEN Vertrag erfuellen. main.js waehlt zwischen ihnen aus und
   die Oberflaeche kennt nur eine Form; driften die beiden auseinander,
   faellt es sonst erst im gebauten Paket auf, und dort am spaetesten
   von allen Stellen.

   Das eigentliche Laden und Einspielen braucht ein echtes Paket und
   ein echtes Release - das ist Sache eines Baus, nicht dieser Datei.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const winupdate = require('../app/winupdate');
const selfupdate = require('../app/selfupdate');

/** Taeuscht fuer eine Pruefung eine andere Plattform vor, macht es danach rueckgaengig. */
function alsPlattform(t, platform) {
  const echte = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: echte, configurable: true }));
}

/* ------------------------------ Der Vertrag ------------------------------ */

test('beide Wege zum Selbstupdate bieten dieselben Griffe an', () => {
  for (const name of ['canReplace', 'check', 'prepare', 'install']) {
    assert.equal(typeof selfupdate[name], 'function', `selfupdate.${name} fehlt`);
    assert.equal(typeof winupdate[name], 'function', `winupdate.${name} fehlt`);
  }
});

test('beide melden dieselben Absagegruende in derselben Form', async (t) => {
  // Nicht eingerichtet: derselbe Grund, gleich auf welchem Weg.
  for (const [name, weg] of [['selfupdate', selfupdate], ['winupdate', winupdate]]) {
    const res = await weg.check('owner/repo');
    assert.equal(res.ok, false, `${name}: ein Platzhalter-Repo darf nicht als eingerichtet gelten`);
    assert.equal(res.reason, 'nicht-eingerichtet', `${name}: falscher Grund`);
  }

  await t.test('und beide antworten auf ein leeres Repo genauso', async () => {
    assert.equal((await selfupdate.check('')).reason, 'nicht-eingerichtet');
    assert.equal((await winupdate.check('')).reason, 'nicht-eingerichtet');
  });
});

/* ------------------------------ Die Plattform ------------------------------ */

test('auf Mac und Linux sagt der Windows-Weg klar, dass er hier nichts zu suchen hat', async (t) => {
  for (const system of ['darwin', 'linux']) {
    await t.test(system, async (sub) => {
      alsPlattform(sub, system);
      assert.deepEqual(winupdate.canReplace(), { ok: false, reason: 'platform' });

      // Und check() faellt darauf zurueck, statt ins Netz zu greifen.
      const res = await winupdate.check('thecrafti87/Snapkey');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'platform');
    });
  }
});

test('auf Windows aus dem Quelltext heraus gibt es nichts zu tauschen', (t) => {
  alsPlattform(t, 'win32');

  // Ausserhalb von Electron ist "app" undefined - dasselbe Ergebnis wie
  // beim Lauf per "npm run app", wo app.isPackaged false ist. Beides
  // heisst: kein fertiges Paket, also auch keine app-update.yml.
  assert.deepEqual(winupdate.canReplace(), { ok: false, reason: 'dev' });
});

test('der Mac-Weg beansprucht Windows nicht fuer sich', (t) => {
  alsPlattform(t, 'win32');
  assert.equal(selfupdate.canReplace().reason, 'platform');
});

/* ------------------------------ Die Adresse ------------------------------ */

test('die Adresse zur Veroeffentlichung traegt das v vor der Fassung', () => {
  assert.equal(
    winupdate.releaseUrl('thecrafti87/Snapkey', '0.1.4'),
    'https://github.com/thecrafti87/Snapkey/releases/tag/v0.1.4'
  );
});

/* ------------------------------ Der Neustart ------------------------------ */

/**
 * Warum der Neustart nicht dem Installer ueberlassen wird:
 *
 * NSIS bietet dafuer "--force-run" an, und electron-updater reicht es
 * durch. Am installierten Paket nachgemessen hat es nicht getragen -
 * weder still ("/S") noch sichtbar: die neue Fassung lag jedesmal auf
 * der Platte und in der Registrierung, es lief nur nichts mehr.
 *
 * Der eigene Helfer wiederum darf NICHT direkt gespawnt werden: Electron
 * haengt seine Kindprozesse an ein Job-Objekt, und beim Beenden der App
 * stirbt alles darin mit. An einem Mini-Programm nachgemessen -
 * powershell direkt gespawnt (detached, unref) hinterliess keine Spur,
 * ueber "cmd /c start" lief derselbe Helfer weiter.
 *
 * Beides sind Erfahrungen, die man am Quelltext nicht sieht. Diese
 * Pruefung haelt sie fest, damit sie nicht beim naechsten Aufraeumen
 * "vereinfacht" werden.
 */
test('der Neustart nach dem Einspielen wird selbst besorgt, und zwar abgekoppelt', () => {
  const quelle = fs.readFileSync(path.join(__dirname, '..', 'app', 'winupdate.js'), 'utf8');

  assert.match(quelle, /quitAndInstall\(false,\s*false\)/,
    'quitAndInstall soll weder still einspielen noch --force-run verlangen');

  assert.match(quelle, /spawn\(\s*'cmd\.exe'/,
    'der Helfer muss ueber "cmd /c start" laufen - direkt gespawnt stirbt er mit der App');

  assert.match(quelle, /process\.pid/,
    'der Helfer muss auf das Ende DIESES Prozesses warten, sonst haelt er sich fuer ueberfluessig');
});
