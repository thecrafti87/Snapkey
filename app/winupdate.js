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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
 * Der Neustart danach wird SELBST besorgt, nicht dem Installer
 * ueberlassen. Beide eingebauten Wege wurden am installierten Paket
 * nachgemessen und starteten die App nicht wieder - weder still ("/S"
 * samt --force-run) noch sichtbar: 0.1.5 lag jedesmal auf der Platte
 * und in der Registrierung, es lief nur nichts mehr. Ein Knopf, der
 * "Neu starten und uebernehmen" heisst, darf das nicht.
 *
 * Deshalb dasselbe Muster wie im Mac-Weg (siehe install() in
 * selfupdate.js): ein abgekoppelter Helfer, der wartet, bis der
 * Installer durch ist, und dann startet. Er prueft vorher, ob nicht
 * doch schon jemand gestartet hat - liefe der eingebaute Weg auf einem
 * anderen Windows doch, gaebe es sonst zwei Fenster.
 *
 * Eingespielt wird sichtbar, nicht still: der Mensch hat den Knopf
 * gerade selbst gedrueckt und darf sehen, dass etwas geschieht. Weil
 * der Installer auf oneClick steht, ist es ein Fortschrittsbalken und
 * kein Dialog, der etwas fragt.
 */
function install() {
  const platz = canReplace();
  if (!platz.ok) return { ok: false, reason: platz.reason };

  neustartVormerken();

  setImmediate(() => {
    try {
      // Kein --force-run: den Neustart besorgt neustartVormerken().
      updater().quitAndInstall(false, false);
    } catch (err) {
      console.error('Einspielen misslungen:', err.message);
    }
  });
  return { ok: true };
}

/**
 * Meldet einen abgekoppelten Helfer an, der SNAPKEY nach dem Einspielen
 * wieder startet.
 *
 * Er wartet, bis kein Installer mehr laueft (der heisst
 * "SNAPKEY-<fassung>-x64", die App schlicht "SNAPKEY"), und startet
 * dann - aber nur, wenn nicht schon eine Instanz da ist. Damit ist er
 * gutmuetig: springt der eingebaute Weg auf einem anderen Windows doch
 * an, tut der Helfer nichts, statt ein zweites Fenster aufzumachen.
 *
 * Muss VOR quitAndInstall() gerufen werden - danach gibt es diesen
 * Prozess nicht mehr, der ihn anmelden koennte.
 */
function neustartVormerken() {
  // In einfachen Anfuehrungszeichen von PowerShell wird ' durch ''
  // geschuetzt - ein Benutzername mit Apostroph soll den Befehl nicht
  // auseinanderreissen.
  const hoch = (s) => s.replace(/'/g, "''");

  try {
    const werkstatt = fs.mkdtempSync(path.join(os.tmpdir(), 'snapkey-neustart-'));
    const skript = path.join(werkstatt, 'neustart.ps1');

    fs.writeFileSync(skript, [
      '$ende = (Get-Date).AddSeconds(180)',
      // ZUERST auf das Ende DIESES Prozesses warten - genau wie das
      // Tauschskript im Mac-Weg (while kill -0 "$PID"). Ohne diesen
      // Schritt sieht der Helfer die noch laufende alte App, haelt sich
      // fuer ueberfluessig und tut nichts. Nachgemessen: genau daran
      // scheiterte der erste Anlauf.
      `$alt = ${process.pid}`,
      'while ((Get-Date) -lt $ende -and (Get-Process -Id $alt -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }',
      // Dann auf den Installer warten (heisst "SNAPKEY-<fassung>-x64").
      "while ((Get-Date) -lt $ende -and (Get-Process -Name 'SNAPKEY-*' -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }",
      // Kurz nachfassen: zwischen dem Ende des Installers und der
      // fertigen Datei liegt noch ein Wimpernschlag.
      'Start-Sleep -Seconds 2',
      `if (-not (Get-Process -Name 'SNAPKEY' -ErrorAction SilentlyContinue)) { Start-Process -FilePath '${hoch(process.execPath)}' }`,
      // Hinter sich aufraeumen.
      `Remove-Item -LiteralPath '${hoch(werkstatt)}' -Recurse -Force -ErrorAction SilentlyContinue`
    ].join('\n'), 'utf8');

    // ueber "cmd /c start" statt direkt: Electron haengt seine
    // Kindprozesse an ein Job-Objekt, und beim Beenden der App stirbt
    // alles darin mit - detached allein genuegt auf Windows NICHT.
    // Nachgemessen an einem Mini-Programm: direkt gespawnt hinterliess
    // der Helfer keine Spur, ueber "start" lief er weiter. "start"
    // haengt den neuen Prozess an die Konsole statt an uns.
    const helfer = spawn(
      'cmd.exe',
      ['/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', skript],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    helfer.unref();
  } catch (err) {
    // Ohne Helfer wird trotzdem eingespielt - dann fehlt nur der
    // Neustart, und das ist kein Grund, das Update abzublasen.
    console.error('Neustart konnte nicht vorgemerkt werden:', err.message);
  }
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
