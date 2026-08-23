'use strict';

/* =================================================================
   Selbstaktualisierung auf Windows.

   Zwei Wege, ein Vertrag. Auf dem Mac tauscht app/selfupdate.js das
   .app-Paket von Hand - electron-updater scheidet DORT aus, weil sein
   Weg ueber Squirrel.Mac eine Signatur verlangt und bei einer
   unsignierten App verweigert.

   Auf Windows gilt dieser Einwand nicht. Der NSIS-Weg von
   electron-updater kommt ohne Signatur aus, taeuscht keine
   Vertrauenswuerdigkeit vor und erspart uns den Handbetrieb samt
   Tauschskript. Also hier electron-updater, dort weiter von Hand - und
   beide liefern dieselben Felder zurueck. main.js waehlt nur aus, die
   Oberflaeche kennt nur eine Form (siehe renderUpdate in
   renderer/app.js).

   Der Fassungsvergleich kommt bewusst aus selfupdate.js statt hier noch
   einmal geschrieben zu werden: zwei Meinungen darueber, was "neuer"
   heisst, waeren eine zu viel.

   VORAUSSETZUNG: latest.yml muss am Release haengen. electron-builder
   legt die Datei neben den Installer, und der Bauablauf haengt sie mit
   an (siehe .github/workflows/build.yml). Fehlt sie, findet der Updater
   nichts - deshalb meldet check() dann "keine-veroeffentlichung" und
   nicht einen rohen Fehlertext.

   Was hier NICHT passiert: eine Pruefung der Herkunft. Ohne Signatur
   stuetzt sich das Vertrauen auf HTTPS und GitHub - dasselbe wie beim
   Herunterladen von Hand, nicht mehr und nicht weniger. Die Pruefsumme
   aus latest.yml prueft electron-updater; die schuetzt vor einem halb
   geladenen Paket, nicht vor einer falschen Quelle.
   ================================================================= */

const { app } = require('electron');

const { isNewer, isConfiguredRepo } = require('./selfupdate');

/**
 * electron-updater erst holen, wenn es gebraucht wird.
 *
 * Das Paket zieht beim Laden Electron nach. Ausserhalb von Electron -
 * also in den Pruefungen - wuerde ein require ganz oben die ganze Datei
 * unpruefbar machen. So bleiben die Teile ohne Netz und ohne Electron
 * pruefbar, genau wie bei selfupdate.js.
 */
let geholt = null;
function updater() {
  if (!geholt) {
    const { autoUpdater } = require('electron-updater');

    // Nichts geschieht hinter dem Ruecken: geladen wird erst auf Klick.
    autoUpdater.autoDownload = false;

    // Wer geladen hat und das Fenster schliesst, statt "Einspielen" zu
    // druecken, findet die neue Fassung beim naechsten Start vor -
    // statt beim naechsten Mal wieder von vorn zu laden.
    autoUpdater.autoInstallOnAppQuit = true;

    geholt = autoUpdater;
  }
  return geholt;
}

/* ------------------------------ Ablauf ------------------------------ */

/**
 * Kann auf diesem System ueberhaupt getauscht werden? Dieselben Gruende
 * wie in selfupdate.canReplace(), damit die Oberflaeche sie mit
 * denselben Texten erklaeren kann.
 */
function canReplace() {
  if (process.platform !== 'win32') return { ok: false, reason: 'platform' };
  // Fehlt "app", laeuft der Code ausserhalb von Electron; isPackaged ist
  // false im Entwicklungslauf per "npm run app". Beides heisst: kein
  // fertiges Paket da, und ohne Paket auch keine app-update.yml, aus der
  // electron-updater seine Quelle liest.
  if (!app || !app.isPackaged) return { ok: false, reason: 'dev' };
  return { ok: true };
}

/** Wo die Fassung im Netz nachzusehen ist - electron-updater liefert keine Adresse mit. */
function releaseUrl(repo, version) {
  return `https://github.com/${repo}/releases/tag/v${version}`;
}

/** Fassungsvergleich gegen die neueste Veroeffentlichung - ohne etwas zu laden. */
async function check(repo) {
  if (!isConfiguredRepo(repo)) return { ok: false, reason: 'nicht-eingerichtet' };

  const platz = canReplace();
  if (!platz.ok) return { ok: false, reason: platz.reason };

  // Bewusst aus package.json und nicht ueber app.getVersion() - dieselbe
  // Begruendung wie in selfupdate.check(): aus dem Quelltext heraus
  // meldete Electron sonst SEINE Fassung.
  const current = require('../package.json').version;

  let ergebnis;
  try {
    ergebnis = await updater().checkForUpdates();
  } catch (err) {
    // Fehlt latest.yml am Release, kommt hier ein 404 heraus. Das ist
    // kein Netzfehler, sondern eine unvollstaendige Veroeffentlichung -
    // und der Unterschied hilft beim Suchen.
    const text = String(err && err.message || err);
    if (/404|latest\.yml|Cannot find/i.test(text)) return { ok: false, reason: 'keine-veroeffentlichung' };
    return { ok: false, reason: 'netz', message: text };
  }

  const info = ergebnis && ergebnis.updateInfo;
  if (!info || !info.version) return { ok: false, reason: 'keine-veroeffentlichung' };

  const latest = String(info.version);
  return {
    ok: true,
    current,
    latest,
    newer: isNewer(latest, current),
    url: releaseUrl(repo, latest)
  };
}

/**
 * Laedt die neue Fassung herunter. Eingespielt wird erst in install() -
 * so wie auf dem Mac, damit der Knopf "Einspielen" auch dort etwas
 * bedeutet und nicht schon alles passiert ist.
 */
async function prepare(repo, onProgress = () => {}) {
  const vorher = await check(repo);
  if (!vorher.ok) return { ok: false, reason: vorher.reason, message: vorher.message };
  if (!vorher.newer) return { ok: false, reason: 'nicht-neuer' };

  const au = updater();
  const melden = (p) => onProgress({ phase: 'download', done: p.transferred, total: p.total });

  au.on('download-progress', melden);
  try {
    onProgress({ phase: 'download', done: 0, total: 0 });
    await au.downloadUpdate();
    return { ok: true, version: vorher.latest };
  } catch (err) {
    return { ok: false, reason: 'netz', message: String(err && err.message || err) };
  } finally {
    au.off('download-progress', melden);
  }
}

/**
 * Beendet SNAPKEY und spielt das Geladene ein.
 *
 * Nicht sofort, sondern im naechsten Durchlauf: der Aufrufer ist ein
 * IPC-Griff, dessen Antwort noch beim Fenster ankommen soll, bevor das
 * Programm sich beendet. Sonst sieht der Renderer nie, dass es geklappt
 * hat - genauso geloest wie im Mac-Weg.
 *
 * quitAndInstall(true, true): still einspielen und danach wieder
 * starten. "Still" geht nur, weil der Installer auf oneClick steht -
 * sonst stuende der Benutzer vor einem Installationsdialog, den er nie
 * angefordert hat.
 */
function install() {
  const platz = canReplace();
  if (!platz.ok) return { ok: false, reason: platz.reason };

  setImmediate(() => {
    try {
      updater().quitAndInstall(true, true);
    } catch (err) {
      console.error('Einspielen misslungen:', err.message);
    }
  });
  return { ok: true };
}

module.exports = {
  // Ohne Netz und ohne Electron pruefbar.
  releaseUrl,
  // Brauchen Electron oder das Netz.
  canReplace,
  check,
  prepare,
  install
};
