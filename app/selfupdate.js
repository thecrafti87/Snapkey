'use strict';

/* =================================================================
   Selbstaktualisierung ohne Apple-Developer-ID.

   Die Machart folgt einem erprobten Vorbild (CrocGUI, selfupdate.js):
   electron-updater scheidet aus, weil sein Weg ueber Squirrel eine
   Signatur verlangt und bei einer unsignierten App verweigert. Der
   Tausch von Hand geht trotzdem - und hat einen angenehmen
   Nebeneffekt: was die App selbst herunterlaedt, bekommt kein
   Quarantaene-Merkmal, die neue Fassung startet also ohne die
   Gatekeeper-Meldung.

   Warum ein abgekoppeltes Tauschskript statt sich selbst im laufenden
   Betrieb zu ueberschreiben: das eigene .app-Paket ist die Datei, aus
   der der eigene Prozess gerade laeuft. Es waehrenddessen zu ersetzen
   ist ein Wettlauf mit dem eigenen Beenden - siehe install() weiter
   unten. Ein Skript, das erst nach dem Ende des eigenen Prozesses
   antastet, was vorher noch offen war, hat dieses Problem nicht.

   Was hier NICHT passiert: eine kryptografische Pruefung der Herkunft.
   Ohne Signatur stuetzt sich das Vertrauen auf HTTPS und GitHub -
   dasselbe wie beim Herunterladen von Hand, nicht mehr und nicht
   weniger. Geprueft werden Groesse und Fassungsnummer im Paket, bevor
   irgendetwas Bestehendes angefasst wird.

   Aufgeteilt in reine Funktionen (Fassungsvergleich, Anhangswahl,
   Repo-Pruefung) und welche, die Electron, das Dateisystem oder das
   Netz brauchen - erstere lassen sich in test/selfupdate.test.js ohne
   beides pruefen (siehe module.exports am Dateiende).
   ================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawn } = require('child_process');
// Ausserhalb von Electron liefert das Paket "electron" nur den Pfad zur
// Programmdatei (eine Zeichenkette) - "app" wird dann einfach undefined,
// kein Absturz. Genau das nutzen canReplace() und die Pruefungen aus.
const { app } = require('electron');

/* ------------------------------ Reine Funktionen ------------------------------ */

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

// Nur echte Ziffern-Punkt-Fassungen zaehlen als gueltig - alles andere
// (leer, "Unfug", ein Vorabtag wie "1.2.0-beta") faellt sauber durch,
// statt aus einem NaN-Vergleich zufaellig "neuer" zu behaupten.
function istGueltigeFassung(v) {
  return /^v?\d+(\.\d+)*$/.test(String(v || '').trim());
}

function fassungsTeile(v) {
  return normalizeVersion(v).split('.').map((teil) => {
    const n = parseInt(teil, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Ziffernweiser Vergleich, nicht als Zeichenkette - sonst waere "1.9.0" > "1.10.0". */
function compareVersions(a, b) {
  const ta = fassungsTeile(a);
  const tb = fassungsTeile(b);
  const laenge = Math.max(ta.length, tb.length);
  for (let i = 0; i < laenge; i++) {
    const x = ta[i] || 0;
    const y = tb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Ist `latest` eine echte, neuere Fassung als `current`? */
function isNewer(latest, current) {
  if (!istGueltigeFassung(latest) || !istGueltigeFassung(current)) return false;
  return compareVersions(latest, current) > 0;
}

/** Das zur Architektur passende DMG aus einer Veroeffentlichung (GitHub-API-Form). */
function pickAsset(release, arch) {
  if (!release || !release.tag_name || !Array.isArray(release.assets)) return null;
  const suffix = arch === 'arm64' ? '-arm64.dmg' : '-x64.dmg';
  const asset = release.assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(suffix));
  if (!asset) return null;
  return {
    version: normalizeVersion(release.tag_name),
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size
  };
}

// Diese Zeichenketten sind erkennbar kein echtes Konto/Repo, sondern der
// Rest eines Musters - package.json traegt sie derzeit genau so ein.
const REPO_PLATZHALTER = new Set(['owner/repo', 'eigner/name', 'user/repo', 'dein-name/dein-repo']);

/** Ist `repo` ("eigner/name") eine echte Angabe, kein leerer oder Platzhalterwert? */
function isConfiguredRepo(repo) {
  if (typeof repo !== 'string') return false;
  const getrimmt = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(getrimmt)) return false;
  return !REPO_PLATZHALTER.has(getrimmt.toLowerCase());
}

/**
 * Liest "eigner/name" aus package.json (build.publish) - eine einzige
 * Quelle fuer electron-builder und das Selbstupdate, statt derselben
 * Angabe an zwei Stellen zu pflegen. Solange dort nichts eingetragen
 * ist, liefert das die leere Zeichenkette.
 */
function configuredRepo() {
  const pkg = require('../package.json');
  const publish = pkg.build && pkg.build.publish;
  const eintrag = Array.isArray(publish) ? publish[0] : publish;
  if (!eintrag || !eintrag.owner || !eintrag.repo) return '';
  return `${eintrag.owner}/${eintrag.repo}`;
}

/* ------------------------------ Netz ------------------------------ */

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'SNAPKEY', Accept: 'application/vnd.github+json' },
      timeout: 15000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Zeitueberschreitung')); });
  });
}

/** Laedt eine Datei und meldet dabei den Fortschritt. */
function download(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('zu viele Weiterleitungen'));
    https.get(url, { headers: { 'User-Agent': 'SNAPKEY' }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, target, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }

      const total = Number(res.headers['content-length'] || 0);
      let done = 0;
      let letzterStand = 0;
      const out = fs.createWriteStream(target);
      res.on('data', (chunk) => {
        done += chunk.length;
        if (done - letzterStand > 512 * 1024) { letzterStand = done; onProgress({ done, total }); }
      });
      res.pipe(out);
      out.on('finish', () => { onProgress({ done, total }); out.close(() => resolve({ bytes: done })); });
      out.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Zeitueberschreitung')); });
  });
}

/* ------------------------------ Programmpaket ------------------------------ */

/** Das eigene App-Paket: .../SNAPKEY.app */
function bundlePath() {
  // exe liegt in SNAPKEY.app/Contents/MacOS/SNAPKEY
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

function versionOfBundle(bundle) {
  try {
    return execFileSync('/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', path.join(bundle, 'Contents', 'Info.plist')],
      { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Kann die App sich selbst ersetzen, oder fehlen die Voraussetzungen? */
function canReplace() {
  // Der Tausch von Hand kennt nur den Aufbau eines .app-Pakets - auf
  // Windows und Linux bleibt nur der Download von Hand.
  if (process.platform !== 'darwin') return { ok: false, reason: 'platform' };
  // "app" fehlt schon dann, wenn dieser Code ausserhalb von Electron
  // laeuft (siehe der require oben) - und app.isPackaged ist false im
  // Entwicklungslauf per "npm run app". Beides bedeutet dasselbe: kein
  // fertiges Paket zum Ersetzen da.
  if (!app || !app.isPackaged) return { ok: false, reason: 'dev' };

  const bundle = bundlePath();
  if (!bundle.endsWith('.app')) return { ok: false, reason: 'no-bundle' };
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return { ok: true, bundle };
  } catch {
    return { ok: false, reason: 'read-only', bundle };
  }
}

/* ------------------------------ Ablauf ------------------------------ */

/** Fassungsvergleich gegen die neueste Veroeffentlichung - ohne etwas zu laden. */
async function check(repo) {
  if (!isConfiguredRepo(repo)) return { ok: false, reason: 'nicht-eingerichtet' };

  let release;
  try {
    release = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  } catch (err) {
    return { ok: false, reason: 'netz', message: err.message };
  }
  if (!release || !release.tag_name) return { ok: false, reason: 'keine-veroeffentlichung' };

  const latest = normalizeVersion(release.tag_name);
  const current = (app && typeof app.getVersion === 'function') ? app.getVersion() : require('../package.json').version;
  return { ok: true, current, latest, newer: isNewer(latest, current), url: release.html_url || '' };
}

/**
 * Laedt die neue Fassung, packt sie aus und prueft sie. Der Tausch
 * selbst passiert erst danach, in install() - siehe dort, warum.
 */
async function prepare(repo, onProgress) {
  if (!isConfiguredRepo(repo)) return { ok: false, reason: 'nicht-eingerichtet' };

  const platz = canReplace();
  if (!platz.ok) return { ok: false, reason: platz.reason };

  let release;
  try {
    release = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  } catch (err) {
    return { ok: false, reason: 'netz', message: err.message };
  }

  const asset = pickAsset(release, process.arch);
  if (!asset) return { ok: false, reason: 'kein-anhang', message: `Kein Paket fuer ${process.arch} in dieser Veroeffentlichung.` };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-update-'));
  const dmg = path.join(work, asset.name);

  onProgress({ phase: 'download', done: 0, total: asset.size });
  let bekommen;
  try {
    ({ bytes: bekommen } = await download(asset.url, dmg, (p) => onProgress({ phase: 'download', ...p })));
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: 'netz', message: err.message };
  }

  if (asset.size && bekommen !== asset.size) {
    fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: 'size', message: `erwartet ${asset.size} Byte, bekommen ${bekommen}` };
  }

  onProgress({ phase: 'unpack' });
  const mount = path.join(work, 'mnt');
  fs.mkdirSync(mount);
  try {
    execFileSync('/usr/bin/hdiutil',
      ['attach', dmg, '-nobrowse', '-quiet', '-readonly', '-mountpoint', mount], { timeout: 60000 });
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: 'einhaengen', message: err.message };
  }

  let staged = null;
  try {
    const drin = fs.readdirSync(mount).find((n) => n.endsWith('.app'));
    if (!drin) throw new Error('kein Programm im Abbild');
    staged = path.join(work, drin);
    execFileSync('/usr/bin/ditto', [path.join(mount, drin), staged], { timeout: 120000 });
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: 'auspacken', message: err.message };
  } finally {
    // Aushaengen muss auch nach einem Fehlschlag beim Auspacken
    // passieren - sonst bleibt ein Abbild eingehaengt liegen.
    try { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { timeout: 30000 }); } catch { /* egal */ }
  }

  // Erst hier, nach dem Auspacken, wird die Fassung im echten Bundle
  // gelesen und bestaetigt - nicht die Angabe aus der Veroeffentlichung
  // selbst uebernommen. Ein falsch benanntes DMG faellt so auf, bevor
  // irgendetwas Bestehendes angefasst wird.
  const bekommeneFassung = versionOfBundle(staged);
  if (bekommeneFassung !== asset.version) {
    fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: 'version', message: `erwartet ${asset.version}, bekommen ${bekommeneFassung}` };
  }

  return { ok: true, version: asset.version, staged, work, bundle: platz.bundle };
}

/**
 * Ersetzt das Paket und startet neu. Das alte wird erst beiseite
 * geschoben und nur bei Erfolg geloescht - schlaegt das Kopieren fehl,
 * kommt es zurueck, statt dass gar keine App mehr dasteht.
 *
 * Warum ein abgekoppeltes Skript und nicht der eigene Prozess: die
 * Datei, aus der dieser Code gerade laeuft, liegt selbst im Bundle,
 * das gleich ersetzt wird. Das eigene Beenden und das Ersetzen
 * gleichzeitig zu versuchen ist ein Wettlauf - das Skript wartet
 * stattdessen ab, bis der PID wirklich weg ist (siehe die kill-0-
 * Schleife), bevor es antastet, was eben noch offen war.
 */
function install(prepared) {
  if (!prepared || !prepared.staged || !prepared.bundle || !prepared.work) {
    return { ok: false, message: 'Nichts zum Installieren vorbereitet.' };
  }

  const { staged, work, bundle } = prepared;
  const script = path.join(work, 'tausch.sh');
  const backup = `${bundle}.alt`;

  try {
    fs.writeFileSync(script, `#!/bin/sh
PID=${process.pid}
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
sleep 0.5
rm -rf ${JSON.stringify(backup)}
mv ${JSON.stringify(bundle)} ${JSON.stringify(backup)} || exit 1
if /usr/bin/ditto ${JSON.stringify(staged)} ${JSON.stringify(bundle)}; then
  rm -rf ${JSON.stringify(backup)}
else
  rm -rf ${JSON.stringify(bundle)}
  mv ${JSON.stringify(backup)} ${JSON.stringify(bundle)}
fi
/usr/bin/open ${JSON.stringify(bundle)}
rm -rf ${JSON.stringify(work)}
`, { mode: 0o755 });

    spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    return { ok: false, message: err.message };
  }

  setTimeout(() => { if (app && typeof app.quit === 'function') app.quit(); }, 300);
  return { ok: true };
}

module.exports = {
  // Reine Funktionen - ohne Netz und ohne Electron pruefbar.
  compareVersions,
  isNewer,
  pickAsset,
  isConfiguredRepo,
  configuredRepo,
  // Brauchen Electron, das Dateisystem oder das Netz.
  canReplace,
  check,
  prepare,
  install,
  bundlePath
};
