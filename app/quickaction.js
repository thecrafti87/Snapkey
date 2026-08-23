'use strict';

/* =================================================================
   Finder-Kurzbefehl.

   Baut unter ~/Library/Services ein Dienst-Buendel (.workflow), das
   der Finder im Rechtsklick-Menue anbietet. Kein Automator-Programm
   noetig, um es anzulegen: ein .workflow-Buendel ist nur ein Ordner
   mit zwei plist-Dateien, die sich genauso gut von Hand schreiben
   lassen wie mit dem Automator-Editor.

   Die Bruecke zu SNAPKEY ist ein einziger Shell-Aufruf:
     open -a "SNAPKEY" "$@"
   "$@" reicht ALLE markierten Pfade als ein Aufruf weiter, Dateien wie
   Ordner gleichermassen - das Dienst-Buendel meldet sich fuer den Typ
   "public.item", die gemeinsame UTI-Wurzel von beidem. macOS liefert
   sie dem Electron-Prozess trotzdem einzeln aus, als je ein eigenes
   open-file-Ereignis - das faengt app/main.js ab (dort gesammelt und
   gebuendelt an die Oberflaeche weitergereicht, siehe die Begruendung
   dort im Abschnitt "Dateien aus dem Finder").

   Nur macOS kennt diesen Mechanismus. Auf anderen Systemen melden die
   Funktionen hier nur, dass nichts geht, statt zu werfen - die
   Oberflaeche zeigt dann einen Hinweistext statt eines wirkenden
   Schalters (siehe renderer/app.js, renderSettingsNotes).
   ================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'SNAPKEY';

/** Nur macOS hat Finder-Dienste. */
function supported() {
  return process.platform === 'darwin';
}

/**
 * Zielordner fuer den Dienst. Ueber die Umgebungsvariable
 * SNAPKEY_TEST_SERVICES_DIR ueberschreibbar - ausschliesslich fuer
 * test/quickaction.test.js gedacht, damit die Pruefungen in einen
 * Wegwerf-Ordner schreiben statt ins echte ~/Library/Services.
 */
function servicesDir() {
  return process.env.SNAPKEY_TEST_SERVICES_DIR || path.join(os.homedir(), 'Library', 'Services');
}

function servicePath() {
  return path.join(servicesDir(), `${NAME}.workflow`);
}

/** Meldet den Dienst beim Finder-Menue an: eine Beschriftung, ein Typ ("alles"). */
function infoPlist(label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>${label}</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict>
        <key>NSApplicationIdentifier</key>
        <string>com.apple.finder</string>
      </dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>public.item</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

/**
 * Automator-Dokument mit genau einer Aktion: ein Shellskript, das die
 * vom Finder gereichten Pfade an SNAPKEY weiterreicht. Die Feldnamen
 * und Kennungen darin sind Automators eigenes Dateiformat, kein Text
 * von uns - nur ActionParameters/COMMAND_STRING traegt den Aufruf, den
 * dieses Buendel wirklich ausfuehrt.
 */
function documentPlist(appName) {
  const script = `open -a ${JSON.stringify(appName)} "$@"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>528</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><true/>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key><string>${script}</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>1</integer>
          <key>shell</key><string>/bin/zsh</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>7D4F9A20-0000-4000-A000-000000000101</string>
        <key>Keywords</key><array><string>Shell</string></array>
        <key>OutputUUID</key><string>7D4F9A20-0000-4000-A000-000000000102</string>
        <key>UUID</key><string>7D4F9A20-0000-4000-A000-000000000103</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
        <key>arguments</key>
        <dict>
          <key>0</key>
          <dict>
            <key>default value</key><integer>0</integer>
            <key>name</key><string>inputMethod</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>0</string>
          </dict>
          <key>1</key>
          <dict>
            <key>default value</key><false/>
            <key>name</key><string>CheckedForUserDefaultShell</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>1</string>
          </dict>
          <key>2</key>
          <dict>
            <key>default value</key><string></string>
            <key>name</key><string>source</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>2</string>
          </dict>
          <key>3</key>
          <dict>
            <key>default value</key><string></string>
            <key>name</key><string>COMMAND_STRING</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>3</string>
          </dict>
          <key>4</key>
          <dict>
            <key>default value</key><string>/bin/sh</string>
            <key>name</key><string>shell</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>4</string>
          </dict>
        </dict>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.000000:253.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`;
}

function isInstalled() {
  if (!supported()) return false;
  try {
    return fs.statSync(servicePath()).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Schreibt das Buendel und meldet es beim System an. Liefert den
 * angelegten Pfad zurueck - oder null auf einer Plattform ohne Finder-
 * Dienste, statt zu werfen: der Aufrufer (die Einstellungen) soll das
 * als "ging nicht" behandeln koennen, ohne selbst ein try/catch zu
 * brauchen.
 */
function install(label, appName = NAME) {
  if (!supported()) return null;
  const beschriftung = label || 'SNAPKEY senden';

  const root = servicePath();
  const contents = path.join(root, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist(beschriftung), 'utf8');
  fs.writeFileSync(path.join(contents, 'document.wflow'), documentPlist(appName), 'utf8');

  // Ohne diesen Anstoss taucht der Eintrag im Finder-Menue erst nach
  // einer Ab- und Anmeldung auf.
  execFile('/System/Library/CoreServices/pbs', ['-flush'], () => {});
  return root;
}

/**
 * Nimmt das Buendel wieder weg. Gibt false zurueck, wenn es das gar
 * nicht (mehr) gibt - der Schalter in den Einstellungen soll seinen
 * Zustand ehrlich aus dem Rueckgabewert ablesen koennen, nicht nur
 * daraus, dass kein Fehler geworfen wurde.
 */
function remove() {
  if (!supported()) return false;
  if (!isInstalled()) return false;
  try {
    fs.rmSync(servicePath(), { recursive: true, force: true });
    execFile('/System/Library/CoreServices/pbs', ['-flush'], () => {});
    return true;
  } catch {
    return false;
  }
}

module.exports = { supported, servicePath, isInstalled, install, remove };
