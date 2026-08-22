'use strict';

/* =================================================================
   Plattformfallen - was sich ohne ein echtes Windows oder Linux
   pruefen laesst.

   Kein Baurechner hier kann die Pakete fuer Windows oder Linux
   herstellen oder ausfuehren (siehe Auftrag) - das muss die CI
   uebernehmen. Was sich aber JETZT schon sichern laesst: die reinen
   Umwandlungsregeln, die zwischen den Systemen greifen muessen.

   Deshalb wird hier bewusst NICHT auf `require('path')` (das native,
   laufende System) gebaut, sondern ausdruecklich auf `path.win32` und
   `path.posix` - so laesst sich das Verhalten unter Windows auch von
   einem Mac aus nachrechnen.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const chunks = require('../src/core/chunks');
const portmap = require('../src/net/portmap');
const discovery = require('../src/net/discovery');
const nodeMod = require('../src/node/node');

function tempdir(t, praefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snapkey-plattform-${praefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ============================================================
   a) Listenname <-> Pfad - auf jedem System derselbe Name
   ============================================================ */

test('ein Listenname (immer mit /) ergibt unter win32 einen Backslash-Pfad und unter posix einen Schraegstrich-Pfad', () => {
  // Genau der Ausdruck aus chunks.js (missing() und Sink.fdFor()):
  // path.join(dir, ...name.split('/')).
  const name = 'ordner/unterordner/datei.txt';
  const teile = name.split('/');

  const win = path.win32.join('C:\\Nutzer\\ziel', ...teile);
  assert.equal(win, 'C:\\Nutzer\\ziel\\ordner\\unterordner\\datei.txt');
  assert.ok(!win.includes('/'), 'im Windows-Pfad ist ein Schraegstrich uebrig geblieben');

  const posix = path.posix.join('/heim/ziel', ...teile);
  assert.equal(posix, '/heim/ziel/ordner/unterordner/datei.txt');
});

test('ein einzelner Dateiname (keine Unterordner) landet auf beiden Systemen richtig', () => {
  const name = 'einzeln.txt';
  const teile = name.split('/');

  assert.equal(path.win32.join('C:\\ziel', ...teile), 'C:\\ziel\\einzeln.txt');
  assert.equal(path.posix.join('/ziel', ...teile), '/ziel/einzeln.txt');
});

test('path.basename liefert unter win32 einen sauberen Namen ohne Backslash - auch fuer einen Windows-Wurzelpfad', () => {
  // scan() in chunks.js baut den ersten Namensteil mit path.basename(root).
  // Kommt "root" aus einem Electron-Dialog unter Windows, sieht er aus wie
  // "C:\\Nutzer\\wer\\Ordner" - und genau das darf keinen Backslash in
  // die Namensliste einschleusen.
  assert.equal(path.win32.basename('C:\\Nutzer\\wer\\Ordner'), 'Ordner');
  assert.equal(path.win32.basename('C:\\Nutzer\\wer\\Ordner\\'), 'Ordner');
  assert.equal(path.win32.basename('Ordner'), 'Ordner');
  assert.ok(!path.win32.basename('C:\\Nutzer\\wer\\Ordner').includes('\\'));
});

test('chunks.scan() baut Namen ausschliesslich mit / zusammen - nie mit dem plattformeigenen Trenner', (t) => {
  const wurzel = tempdir(t, 'quelle');
  fs.mkdirSync(path.join(wurzel, 'unter'), { recursive: true });
  fs.writeFileSync(path.join(wurzel, 'oben.txt'), 'x');
  fs.writeFileSync(path.join(wurzel, 'unter', 'tief.txt'), 'y');

  const basisname = path.basename(wurzel);
  const gefunden = chunks.scan([wurzel]).map((f) => f.name).sort();

  assert.deepEqual(gefunden, [
    `${basisname}/oben.txt`,
    `${basisname}/unter/tief.txt`
  ].sort());

  // Egal welches System das hier ausfuehrt: ein Name aus scan() muss sich
  // anschliessend unter win32 UND unter posix wieder zu einem gueltigen
  // Pfad zusammensetzen lassen, ohne dass ein Rest-Trenner uebrig bleibt.
  for (const name of gefunden) {
    const teile = name.split('/');
    assert.ok(teile.every((teil) => !teil.includes('\\') && !teil.includes('/')),
      `ein Namensteil von "${name}" enthaelt noch einen Trenner`);
    assert.doesNotThrow(() => path.win32.join('C:\\ziel', ...teile));
    assert.doesNotThrow(() => path.posix.join('/ziel', ...teile));
  }
});

/* ============================================================
   b) Router-Adresse unter Windows: reine Textverarbeitung
   ============================================================ */

test('portmap: die Windows-Routentabelle (route print -4 / netstat -rn) wird richtig gelesen', () => {
  // Nachgebaute Ausgabe von "route print -4" unter Windows: andere
  // Spaltenordnung als bei BSD-netstat, kein Wort "default" am Zeilenanfang.
  const ausgabe = [
    '===========================================================================',
    'Interface List',
    ' 12...00 15 5d 01 ab 02 ......Intel(R) Ethernet Connection',
    '===========================================================================',
    '',
    'IPv4 Route Table',
    '===========================================================================',
    'Active Routes:',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.100     25',
    '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331',
    '      192.168.1.0    255.255.255.0         On-link     192.168.1.100    281',
    '==========================================================================='
  ].join('\r\n');

  assert.equal(portmap.windows.parseRouteOutput(ausgabe), '192.168.1.1');
});

test('portmap: eine Routentabelle ohne Standardroute (nur On-link) ergibt null, nie einen Wurf', () => {
  const ausgabe = [
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331',
    '      192.168.1.0    255.255.255.0         On-link     192.168.1.100    281'
  ].join('\r\n');

  assert.equal(portmap.windows.parseRouteOutput(ausgabe), null);
});

test('portmap: eine IPv6-Standardroute (::/0) wird nicht mit der IPv4-Route verwechselt', () => {
  const ausgabe = [
    'IPv6 Route Table',
    '===========================================================================',
    'Active Routes:',
    'If Metric Network Destination      Gateway',
    ' 12    25 ::/0                     fe80::1',
    '===========================================================================',
    '',
    'IPv4 Route Table',
    '===========================================================================',
    'Network Destination        Netmask          Gateway       Interface  Metric',
    '          0.0.0.0          0.0.0.0        10.0.0.1        10.0.0.42     25'
  ].join('\r\n');

  assert.equal(portmap.windows.parseRouteOutput(ausgabe), '10.0.0.1');
});

test('portmap: leere, kaputte oder gar keine Ausgabe ergibt null, nie einen Wurf', () => {
  assert.equal(portmap.windows.parseRouteOutput(''), null);
  assert.equal(portmap.windows.parseRouteOutput('vollkommener Unfug ohne Tabelle'), null);
  assert.equal(portmap.windows.parseRouteOutput(null), null);
  assert.equal(portmap.windows.parseRouteOutput(undefined), null);
});

/* ============================================================
   c) Ein gescheiterter Rundruf darf den Knoten nicht mitreissen
   ============================================================ */

test('scheitert die Geraetesuche beim Binden, laeuft der Knoten trotzdem an - ohne Rundruf, nicht ohne alles', async (t) => {
  const original = discovery.start;
  // Steht fuer das, was ein Windows- oder Linux-System liefern koennte,
  // dessen reuseAddr-Bindung an Port 41998 anders ausgeht als erwartet -
  // ohne dafuer ein echtes zweites System zu brauchen.
  discovery.start = () => Promise.reject(new Error('nachgestellter Bindungsfehler'));
  t.after(() => { discovery.start = original; });

  const heim = tempdir(t, 'heim');
  const ziel = tempdir(t, 'ziel');
  const ereignisse = [];

  const n = await nodeMod.open({
    home: heim,
    outDir: ziel,
    port: 0,
    announce: true,
    onEvent: (e) => ereignisse.push(e)
  });
  t.after(() => n.close());

  // Der Knoten selbst steht - Zuhoeren und Senden brauchen keine
  // Geraetesuche, nur die Suche nach Gegenstellen im eigenen Netz faellt aus.
  assert.ok(n.port > 0, 'der Knoten haette trotzdem einen TCP-Zuhoerer bekommen muessen');
  assert.deepEqual(n.peers, [], 'ohne Rundruf gibt es keine gefundenen Gegenstellen');
  assert.equal(n.find('irgendwer'), null);

  const meldung = ereignisse.find((e) => e.type === 'discovery');
  assert.ok(meldung, 'der Fehlschlag der Geraetesuche haette gemeldet werden sollen');
  assert.equal(meldung.state, 'none');
});
