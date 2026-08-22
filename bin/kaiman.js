#!/usr/bin/env node
'use strict';

/* =================================================================
   Die Kommandozeile fuer Kaiman.

   Sechs Befehle, jeder fuer sich klein: die eigene Anschrift zeigen,
   im Netz umschauen, auf Post warten, Post verschicken, den Treffpunkt
   selbst betreiben. Diese Datei kennt kein Fremdpaket - Argumente
   werden von Hand zerlegt, Zahlen von Hand formatiert.

   Fehler werden hier zu einem Satz, nicht zu einem Stapelabzug: wer
   das Werkzeug von der Kommandozeile benutzt, will wissen was los ist,
   nicht wo im Code es passiert ist.
   ================================================================= */

const path = require('path');
const os = require('os');

const identity = require('../src/core/identity');
const chunks = require('../src/core/chunks');
const store = require('../src/node/store');
const discovery = require('../src/net/discovery');
const nodeMod = require('../src/node/node');
const tcp = require('../src/net/tcp');
const meetServerMod = require('../src/meet/server');

const SUCH_ZEIT_MS = 6000;

/* ------------------------------ Kleinkram ------------------------------ */

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const warten = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "host" oder "host:port" - der Doppelpunkt trennt von hinten, wegen IPv6. */
function hostPort(text, standardPort) {
  const i = text.lastIndexOf(':');
  if (i === -1) return { host: text, port: standardPort };

  const host = text.slice(0, i);
  const port = Number(text.slice(i + 1));
  if (!host || Number.isNaN(port)) throw new Error(`"${text}" ist keine brauchbare Adresse (Host[:Port] erwartet)`);
  return { host, port };
}

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
const SCHALTER = new Set(['neue-annehmen', 'ohne-wiedererkennung', 'ohne-rundruf']);

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

  const treffpunkt = flags.treffpunkt ? hostPort(flags.treffpunkt, meetServerMod.DEFAULT_PORT) : null;
  const treffpunktPass = flags['treffpunkt-pass'] || '';

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

      case 'recovered':
        // Nur eine Meldung wert, wenn wirklich etwas dabei herauskam -
        // session.js loest dieses Ereignis ohnehin nur dann aus.
        if (e.count > 0) console.log(`  ${e.count} Block(e) lokal wiederhergestellt (ohne Übertragung)`);
        if (e.truncated) {
          console.error('  Hinweis: die Suche nach wiederverwendbaren Blöcken im Zielordner wurde '
            + 'abgebrochen (zu groß) - nicht der ganze Ordner wurde durchsucht.');
        }
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

      case 'meet':
        if (e.state === 'angemeldet') console.log(`Treffpunkt: ${e.message}`);
        else if (e.state === 'fehler') console.error(`Treffpunkt: ${e.message}`);
        break;

      default:
        break;
    }
  }

  const n = await nodeMod.open({
    outDir, trustNew, port, name: flags.name, onEvent: melden,
    // Ohne Rundruf ist der Knoten im eigenen Netz unsichtbar und nur
    // ueber den Treffpunkt zu erreichen - genau der Fall, den man
    // sonst nicht vorfuehren kann, solange beide Seiten im selben
    // Netz haengen.
    announce: !flags['ohne-rundruf'],
    dedup: !flags['ohne-wiedererkennung'],
    meet: treffpunkt ? { host: treffpunkt.host, port: treffpunkt.port, pass: treffpunktPass } : null
  });

  console.log(`Kaiman hört auf ${n.me.uri}`);
  console.log(`Ziel: ${n.outDir}`);
  console.log(trustNew
    ? 'Neue Gegenstellen werden angenommen.'
    : 'Nur bereits gekoppelte Gegenstellen kommen durch (--neue-annehmen fehlt).');
  console.log(treffpunkt
    ? `Melde mich zusätzlich am Treffpunkt ${treffpunkt.host}:${treffpunkt.port} an ...`
    : 'Ohne Treffpunkt - nur im eigenen Netz erreichbar (--treffpunkt fehlt).');
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

  const an = flags.an ? hostPort(flags.an, tcp.DEFAULT_PORT) : null;
  const treffpunkt = flags.treffpunkt ? hostPort(flags.treffpunkt, meetServerMod.DEFAULT_PORT) : null;
  const treffpunktPass = flags['treffpunkt-pass'] || '';

  const n = await nodeMod.open({ port: 0, announce: true, trustNew: false, name: flags.name, onEvent: () => {} });

  try {
    // "find" vergleicht die Anschrift buchstabengetreu - mit Vorsatz,
    // Grossschrift oder Leerzeichen abgetippt faende es nichts. Deshalb
    // hier erst durch parseAddress glaetten, wenn es wie eine Anschrift
    // aussieht; sieht es aus wie ein Name, bleibt er unangetastet.
    const alsAnschrift = identity.parseAddress(ziel);

    let gegenstelle;

    if (an) {
      // Der direkte Weg - keine Suche, kein Treffpunkt. Fuer
      // Gegenstellen, die ohnehin erreichbar sind (VPN, Portfreigabe).
      gegenstelle = { host: an.host, port: an.port, address: alsAnschrift || undefined };
      console.log(`Verbinde direkt zu ${an.host}:${an.port} ...`);
    } else {
      const suchbegriff = alsAnschrift || ziel;

      console.log(`Suche "${ziel}" im eigenen Netz (bis ${Math.round(SUCH_ZEIT_MS / 1000)} s) ...`);
      let gefunden = null;
      const ende = Date.now() + SUCH_ZEIT_MS;
      while (Date.now() < ende) {
        gefunden = n.find(suchbegriff);
        if (gefunden) break;
        await warten(150);
      }

      if (gefunden) {
        gegenstelle = gefunden;
        console.log(`Im eigenen Netz gefunden: ${gefunden.name || gefunden.address} (${gefunden.host}:${gefunden.port})`);
      } else if (treffpunkt) {
        if (!alsAnschrift) {
          throw new Error(
            `"${ziel}" wurde im eigenen Netz nicht gefunden - über den Treffpunkt wird eine `
            + 'Anschrift gebraucht, ein Gerätename reicht dafür nicht.'
          );
        }
        console.log(`Im eigenen Netz nicht gefunden - versuche es über den Treffpunkt ${treffpunkt.host}:${treffpunkt.port} ...`);
        gegenstelle = {
          address: alsAnschrift,
          meet: { host: treffpunkt.host, port: treffpunkt.port, pass: treffpunktPass }
        };
      } else {
        throw new Error(`"${ziel}" wurde im eigenen Netz nicht gefunden (--treffpunkt fehlt).`);
      }
    }

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
    const zusatz = wiederverwendet > 0 ? `, von der Gegenstelle wiederverwendet: ${wiederverwendet}` : '';
    console.log(`Geschickt: ${res.sent} Block(e)${zusatz}, ${res.ok ? 'vollständig' : 'unvollständig'}.`);
    if (!res.ok) console.log(`Fehlt noch: ${res.missing.join(', ')}`);
  } finally {
    await n.close();
  }
}

/* ----------------------------- treffpunkt -------------------------------- */

async function befehlTreffpunkt(flags) {
  const port = flags.port !== undefined ? Number(flags.port) : meetServerMod.DEFAULT_PORT;
  if (Number.isNaN(port)) throw new Error('--port erwartet eine Zahl');
  const pass = flags.pass || '';

  const server = await meetServerMod.start({
    port,
    pass,
    onEvent: (e) => {
      switch (e.type) {
        case 'registered': console.log(`Angemeldet: ${e.address}`); break;
        case 'joined': console.log(`Vermittelt: ${e.address}`); break;
        case 'nobody': console.log(`Gesucht, niemand da: ${e.address}`); break;
        case 'denied': console.error(`Passwort abgelehnt (${e.reason}): ${e.address}`); break;
        case 'gone': console.log(`Nicht mehr angemeldet: ${e.address}`); break;
        default: break;
      }
    }
  });

  console.log(`Treffpunkt hört auf Port ${server.port}${pass ? ' (mit Passwort)' : ' (offen, ohne Passwort)'}`);
  console.log('Bereit. Strg+C beendet.');

  await new Promise((resolve) => {
    process.once('SIGINT', async () => {
      console.log('\nBeende...');
      try { await server.close(); } catch { /* egal, es wird sowieso beendet */ }
      resolve();
    });
  });
  process.exit(0);
}

/* -------------------------------- help ---------------------------------- */

function befehlHelp() {
  console.log(`Kaiman - Dateien direkt von Gerät zu Gerät

  kaiman id                                       eigene Anschrift zeigen
  kaiman peers                                    Geräte im Netz suchen (${Math.round(SUCH_ZEIT_MS / 1000)} s)
  kaiman listen [--out ORDNER] [--neue-annehmen] [--port N] [--name NAME]
                [--ohne-wiedererkennung] [--ohne-rundruf]
                [--treffpunkt HOST[:PORT]] [--treffpunkt-pass WORT]
                                                   auf Übertragungen warten
  kaiman send <ziel> <pfad...>                    Dateien oder Ordner schicken
                [--treffpunkt HOST[:PORT]] [--treffpunkt-pass WORT]
                [--an HOST[:PORT]]
  kaiman treffpunkt [--port N] [--pass WORT]      die Vermittlungsstelle betreiben
  kaiman help                                     diese Übersicht

Beispiele:
  kaiman id
  kaiman listen --out ~/Empfangen --neue-annehmen
  kaiman listen --out ~/Empfangen --neue-annehmen --treffpunkt dxp8800plus-1
  kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub
  kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub --treffpunkt dxp8800plus-1
  kaiman send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub --an 100.x.y.z
  kaiman treffpunkt --port 41997 --pass geheimnis

<ziel> bei "send" ist entweder eine Anschrift oder der Name eines
Geräts, so wie er bei "kaiman peers" auftaucht. Über den Treffpunkt
geht es nur mit einer Anschrift, kein Gerätename - der Rundruf reicht
dort nicht hin.`);
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
    case 'treffpunkt': return befehlTreffpunkt(flags);
    case 'help':
    case undefined: return befehlHelp();
    default:
      throw new Error(`Unbekannter Befehl "${befehl}" - "kaiman help" zeigt, was geht.`);
  }
}

main().catch((err) => {
  if (err && err.code === 'PEER_CHANGED') {
    console.error(`ACHTUNG: ${err.message}`);
  } else if (err && err.code === 'NOBODY') {
    console.error(`${err.message} - die Gegenstelle muss dafür mit --treffpunkt laufen.`);
  } else {
    // 'UNKNOWN_PEER' traegt schon im Text den Hinweis auf
    // --neue-annehmen (siehe src/node/node.js) - hier reicht die
    // Meldung selbst.
    console.error(err && err.message ? err.message : String(err));
  }
  process.exitCode = 1;
});
