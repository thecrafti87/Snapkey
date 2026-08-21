#!/usr/bin/env node
'use strict';

/* =================================================================
   Die Kommandozeile fuer Kaiman.

   Fuenf Befehle, jeder fuer sich klein: die eigene Anschrift zeigen,
   im Netz umschauen, auf Post warten, Post verschicken. Diese Datei
   kennt kein Fremdpaket - Argumente werden von Hand zerlegt, Zahlen
   von Hand formatiert.

   Fehler werden hier zu einem Satz, nicht zu einem Stapelabzug: wer
   das Werkzeug von der Kommandozeile benutzt, will wissen was los ist,
   nicht wo im Code es passiert ist.
   ================================================================= */

const path = require('path');
const os = require('os');

const identity = require('../src/core/identity');
const store = require('../src/node/store');
const discovery = require('../src/net/discovery');
const nodeMod = require('../src/node/node');

const SUCH_ZEIT_MS = 6000;

/* ------------------------------ Kleinkram ------------------------------ */

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const warten = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spalte(text, breite) {
  text = String(text);
  return text + ' '.repeat(Math.max(0, breite - text.length));
}

/** Eine schlichte Tabelle - genug fuer eine Handvoll Geraete. */
function tabelle(zeilen, spalten) {
  const breiten = spalten.map(([schluessel, titel]) => (
    Math.max(titel.length, ...zeilen.map((z) => String(z[schluessel]).length))
  ));
  const zeileDrucken = (werte) => console.log(werte.map((w, i) => spalte(w, breiten[i])).join('   '));

  zeileDrucken(spalten.map(([, titel]) => titel));
  zeileDrucken(breiten.map((b) => '-'.repeat(b)));
  for (const z of zeilen) zeileDrucken(spalten.map(([schluessel]) => z[schluessel]));
}

/* ------------------------------ Argumente ------------------------------ */

// Flaggen ohne Wert dahinter - der Rest schluckt das naechste Wort.
const SCHALTER = new Set(['neue-annehmen']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const teil = argv[i];
    if (teil.startsWith('--')) {
      const key = teil.slice(2);
      if (SCHALTER.has(key)) { flags[key] = true; continue; }
      flags[key] = argv[++i];
    } else {
      positional.push(teil);
    }
  }
  return { positional, flags };
}

/* --------------------------------- id --------------------------------- */

function befehlId() {
  const box = store.open();
  console.log(`Anschrift:     ${box.me.uri}`);
  console.log(`Fingerabdruck: ${box.me.fingerprint}`);
  console.log(`Ablage:        ${box.dir}`);
}

/* ------------------------------- peers -------------------------------- */

async function befehlPeers() {
  const box = store.open();

  // Reines Zuhoeren, kein eigener Zuhoerer auf einem echten Port - der
  // Rundruf verlangt trotzdem eine Portzahl in der Ankuendigung. Sie
  // bleibt hier ungenutzt, es wird ja niemand angerufen.
  const beacon = await discovery.start({ identity: box.me, port: 1, name: os.hostname(), onChange: () => {} });

  console.log(`Suche im Netz (${Math.round(SUCH_ZEIT_MS / 1000)} s) ...`);
  await warten(SUCH_ZEIT_MS);
  const gefunden = beacon.peers;
  beacon.stop();

  if (!gefunden.length) {
    console.log('Kein Gerät im Netz gefunden.');
    return;
  }

  const zeilen = gefunden
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((p) => ({
      Name: p.name || '(ohne Namen)',
      Anschrift: p.address,
      'Adresse:Port': `${p.host}:${p.port}`,
      Gekoppelt: box.peers.get(p.address) ? 'ja' : 'nein'
    }));

  tabelle(zeilen, [
    ['Name', 'Name'], ['Anschrift', 'Anschrift'], ['Adresse:Port', 'Adresse:Port'], ['Gekoppelt', 'Gekoppelt']
  ]);
}

/* ------------------------------- listen -------------------------------- */

async function befehlListen(flags) {
  const outDir = flags.out ? path.resolve(flags.out) : process.cwd();
  const trustNew = Boolean(flags['neue-annehmen']);
  const port = flags.port !== undefined ? Number(flags.port) : 0;
  if (Number.isNaN(port)) throw new Error('--port erwartet eine Zahl');

  // Je Verbindung wird gemerkt, wie viel schon da ist - fuer die
  // Prozentanzeige, und damit nicht bei jedem einzelnen Block gedruckt
  // wird, sondern hoechstens einmal pro Sekunde.
  const laufend = new Map();

  function melden(e) {
    switch (e.type) {
      case 'accepted':
        laufend.set(e.from, { total: 0, empfangen: 0, letzterDruck: 0 });
        console.log(`${e.neu ? 'Neu gekoppelt' : 'Bekannte Gegenstelle'}: ${e.address} (${e.from})`);
        break;

      case 'offered':
        if (laufend.has(e.from)) laufend.get(e.from).total = e.bytes;
        break;

      case 'taken': {
        const stand = laufend.get(e.from);
        if (!stand) break;
        stand.empfangen += e.bytes;

        const jetzt = Date.now();
        const fertig = stand.total > 0 && stand.empfangen >= stand.total;
        if (fertig || jetzt - stand.letzterDruck >= 1000) {
          stand.letzterDruck = jetzt;
          const prozent = stand.total ? Math.min(100, Math.round((stand.empfangen / stand.total) * 100)) : 0;
          console.log(`  ${e.from}: ${prozent}% (${mb(stand.empfangen)} / ${mb(stand.total)} MB)`);
        }
        break;
      }

      case 'received': {
        laufend.delete(e.from);
        const r = e.result;
        console.log(`Empfangen von ${e.from}: ${r.ok ? 'vollständig' : 'unvollständig'} `
          + `(${r.taken} Block(e) neu, ${r.had} schon vorhanden)`);
        break;
      }

      case 'refused':
        laufend.delete(e.from);
        if (e.code === 'PEER_CHANGED') console.error(`ACHTUNG - abgewiesen (${e.from}): ${e.message}`);
        else console.error(`Abgewiesen (${e.from}): ${e.message}`);
        break;

      default:
        break;
    }
  }

  const n = await nodeMod.open({
    outDir, trustNew, port, name: flags.name, announce: true, onEvent: melden
  });

  console.log(`Kaiman hört auf ${n.me.uri}`);
  console.log(`Ziel: ${n.outDir}`);
  console.log(trustNew
    ? 'Neue Gegenstellen werden angenommen.'
    : 'Nur bereits gekoppelte Gegenstellen kommen durch (--neue-annehmen fehlt).');
  console.log('Bereit. Strg+C beendet.');

  await new Promise((resolve) => {
    process.once('SIGINT', async () => {
      console.log('\nBeende...');
      try { await n.close(); } catch { /* egal, es wird sowieso beendet */ }
      resolve();
    });
  });
  process.exit(0);
}

/* -------------------------------- send ---------------------------------- */

async function befehlSend(positional, flags) {
  const [ziel, ...pfade] = positional;
  if (!ziel || !pfade.length) throw new Error('Aufruf: kaiman send <ziel> <pfad...>');

  const n = await nodeMod.open({ port: 0, announce: true, trustNew: false, name: flags.name, onEvent: () => {} });

  try {
    console.log(`Suche "${ziel}" (bis ${Math.round(SUCH_ZEIT_MS / 1000)} s) ...`);

    // "find" vergleicht die Anschrift buchstabengetreu - mit Vorsatz,
    // Grossschrift oder Leerzeichen abgetippt faende es nichts. Deshalb
    // hier erst durch parseAddress glaetten, wenn es wie eine Anschrift
    // aussieht; sieht es aus wie ein Name, bleibt er unangetastet.
    const alsAnschrift = identity.parseAddress(ziel);
    const suchbegriff = alsAnschrift || ziel;

    let gegenstelle = null;
    const ende = Date.now() + SUCH_ZEIT_MS;
    while (Date.now() < ende) {
      gegenstelle = n.find(suchbegriff);
      if (gegenstelle) break;
      await warten(150);
    }

    if (!gegenstelle) throw new Error(`"${ziel}" wurde im Netz nicht gefunden.`);
    console.log(`Gefunden: ${gegenstelle.name || gegenstelle.address} (${gegenstelle.host}:${gegenstelle.port})`);

    let plan = null;
    let uebertragen = 0;
    let letzterDruck = 0;

    const res = await n.sendTo(gegenstelle, pfade, {
      onProgress: (e) => {
        if (e.type === 'plan') plan = e;

        if (e.type === 'sent') {
          uebertragen += e.bytes;
          const jetzt = Date.now();
          if (jetzt - letzterDruck >= 1000 || e.done === e.of) {
            letzterDruck = jetzt;
            const prozent = e.of ? Math.round((e.done / e.of) * 100) : 100;
            console.log(`  ${prozent}% - ${mb(uebertragen)} MB (Block ${e.done}/${e.of})`);
          }
        }
      }
    });

    const wiederverwendet = plan ? plan.total - plan.send : 0;
    console.log(`Geschickt: ${res.sent} Block(e), von der Gegenstelle wiederverwendet: ${wiederverwendet}, `
      + `${res.ok ? 'vollständig' : 'unvollständig'}.`);
    if (!res.ok) console.log(`Fehlt noch: ${res.missing.join(', ')}`);
  } finally {
    await n.close();
  }
}

/* -------------------------------- help ---------------------------------- */

function befehlHelp() {
  console.log(`Kaiman - eigener Nahweg fuer Dateien, ohne Vermittlung

  kaiman id                                       eigene Anschrift zeigen
  kaiman peers                                    Geräte im Netz suchen (${Math.round(SUCH_ZEIT_MS / 1000)} s)
  kaiman listen [--out ORDNER] [--neue-annehmen] [--port N] [--name NAME]
                                                   auf Übertragungen warten
  kaiman send <ziel> <pfad...>                    Dateien oder Ordner schicken
  kaiman help                                     diese Übersicht

Beispiele:
  kaiman id
  kaiman listen --out ~/Empfangen --neue-annehmen
  kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub

<ziel> bei "send" ist entweder eine Anschrift oder der Name eines
Geräts, so wie er bei "kaiman peers" auftaucht.`);
}

/* --------------------------------- Start --------------------------------- */

async function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (befehl) {
    case 'id': return befehlId();
    case 'peers': return befehlPeers();
    case 'listen': return befehlListen(flags);
    case 'send': return befehlSend(positional, flags);
    case 'help':
    case undefined: return befehlHelp();
    default:
      throw new Error(`Unbekannter Befehl "${befehl}" - "kaiman help" zeigt, was geht.`);
  }
}

main().catch((err) => {
  if (err && err.code === 'PEER_CHANGED') {
    console.error(`ACHTUNG: ${err.message}`);
  } else {
    // 'UNKNOWN_PEER' traegt schon im Text den Hinweis auf
    // --neue-annehmen (siehe src/node/node.js) - hier reicht die
    // Meldung selbst.
    console.error(err && err.message ? err.message : String(err));
  }
  process.exitCode = 1;
});
