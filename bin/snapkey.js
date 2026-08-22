#!/usr/bin/env node
'use strict';

/* =================================================================
   Die Kommandozeile fuer SNAPKEY.

   Sieben Befehle, jeder fuer sich klein: die eigene Anschrift zeigen,
   im Netz umschauen, auf Post warten, Post verschicken, den Treffpunkt
   selbst betreiben, den eigenen Router abklopfen. Diese Datei kennt
   kein Fremdpaket - Argumente werden von Hand zerlegt, Zahlen von Hand
   formatiert.

   Fehler werden hier zu einem Satz, nicht zu einem Stapelabzug: wer
   das Werkzeug von der Kommandozeile benutzt, will wissen was los ist,
   nicht wo im Code es passiert ist.
   ================================================================= */

const path = require('path');
const os = require('os');

const identity = require('../src/core/identity');
const chunks = require('../src/core/chunks');
const store = require('../src/node/store');
const messagesMod = require('../src/node/messages');
const discovery = require('../src/net/discovery');
const nodeMod = require('../src/node/node');
const tcp = require('../src/net/tcp');
const meetServerMod = require('../src/meet/server');
const portmap = require('../src/net/portmap');

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

/** Ein ISO-Zeitstempel, lesbar fuer einen Menschen - faellt notfalls auf den Rohwert zurueck. */
function zeitAnzeige(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

const WEG_TEXT = { lan: 'im eigenen Netz', direct: 'direkt über den Treffpunkt vermittelt', relay: 'über die Umleitung' };

/**
 * Findet die Gegenstelle fuer "send" und "say" - dieselbe Wegewahl bei
 * beiden: erst --an (direkt, keine Suche), sonst das eigene Netz (bis
 * zu SUCH_ZEIT_MS), sonst der Treffpunkt, wenn einer angegeben ist.
 */
async function zielFinden(n, ziel, { an, treffpunkt, treffpunktPass }) {
  // "find" vergleicht die Anschrift buchstabengetreu - mit Vorsatz,
  // Grossschrift oder Leerzeichen abgetippt faende es nichts. Deshalb
  // hier erst durch parseAddress glaetten, wenn es wie eine Anschrift
  // aussieht; sieht es aus wie ein Name, bleibt er unangetastet.
  const alsAnschrift = identity.parseAddress(ziel);

  if (an) {
    // Der direkte Weg - keine Suche, kein Treffpunkt. Fuer
    // Gegenstellen, die ohnehin erreichbar sind (VPN, Portfreigabe).
    console.log(`Verbinde direkt zu ${an.host}:${an.port} ...`);
    return { host: an.host, port: an.port, address: alsAnschrift || undefined };
  }

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
    console.log(`Im eigenen Netz gefunden: ${gefunden.name || gefunden.address} (${gefunden.host}:${gefunden.port})`);
    return gefunden;
  }

  if (treffpunkt) {
    if (!alsAnschrift) {
      throw new Error(
        `"${ziel}" wurde im eigenen Netz nicht gefunden - über den Treffpunkt wird eine `
        + 'Anschrift gebraucht, ein Gerätename reicht dafür nicht.'
      );
    }
    console.log(`Im eigenen Netz nicht gefunden - versuche es über den Treffpunkt ${treffpunkt.host}:${treffpunkt.port} ...`);
    return { address: alsAnschrift, meet: { host: treffpunkt.host, port: treffpunkt.port, pass: treffpunktPass } };
  }

  throw new Error(`"${ziel}" wurde im eigenen Netz nicht gefunden (--treffpunkt fehlt).`);
}

/* ------------------------------ Argumente ------------------------------ */

// Flaggen ohne Wert dahinter - der Rest schluckt das naechste Wort.
const SCHALTER = new Set(['neue-annehmen', 'ohne-wiedererkennung', 'ohne-rundruf', 'portfreigabe']);

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

async function befehlId(flags) {
  const box = store.open();
  console.log(`Anschrift:     ${box.me.uri}`);
  console.log(`Fingerabdruck: ${box.me.fingerprint}`);
  console.log(`Ablage:        ${box.dir}`);

  if (flags.portfreigabe) {
    console.log('');
    console.log('Versuche eine Portfreigabe beim Router (bis zu einige Sekunden) ...');
    const ergebnis = await portmap.open({ port: tcp.DEFAULT_PORT });
    if (ergebnis) {
      console.log(`Öffentlich erreichbar (${ergebnis.method}) unter: ${ergebnis.external.host}:${ergebnis.external.port}`);
      // Nur zum Zeigen angefordert - "snapkey id" haelt keinen
      // Zuhoerer offen, also wird die Freigabe gleich zurueckgegeben.
      await ergebnis.release();
    } else {
      console.log('Keines der drei Verfahren (NAT-PMP, PCP, UPnP) hat geklappt - normal in '
        + 'vielen Netzen, kein Fehler. "snapkey router" zeigt mehr dazu.');
    }
  }
}

/* ------------------------------- peers -------------------------------- */

async function befehlPeers() {
  const box = store.open();

  // Reines Zuhoeren, kein eigener Zuhoerer auf einem echten Port - der
  // Rundruf verlangt trotzdem eine Portzahl in der Ankuendigung. Sie
  // bleibt hier ungenutzt, es wird ja niemand angerufen.
  // Scheitert das Binden - Port belegt, Multicast im Netz verboten -,
  // ist das ein Satz wert und kein Stapelabzug.
  let beacon;
  try {
    beacon = await discovery.start({ identity: box.me, port: 1, name: os.hostname(), onChange: () => {} });
  } catch (err) {
    throw new Error(`Die Geräteschau liess sich nicht starten: ${err.message}`);
  }

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

      case 'message':
        // Deutlich abgesetzt von den Uebertragungsmeldungen - eine
        // Leerzeile davor und danach, statt sich in "taken"/"offered"
        // zu verlieren.
        console.log(`\nNachricht von ${e.address} (${e.from}):\n  ${e.text}\n`);
        break;

      case 'talked':
        console.log(`Nachrichtensitzung mit ${e.address} (${e.from}) beendet: ${e.count} Nachricht(en).\n`);
        break;

      case 'refused':
        laufend.delete(e.from);
        if (e.code === 'PEER_CHANGED') console.error(`ACHTUNG - abgewiesen (${e.from}): ${e.message}`);
        else console.error(`Abgewiesen (${e.from}): ${e.message}`);
        break;

      case 'meet':
        if (e.state === 'angemeldet') console.log(`Treffpunkt: ${e.message}`);
        else if (e.state === 'fehler') console.error(`Treffpunkt: ${e.message}`);
        break;

      case 'portmap':
        if (e.state === 'mapped') {
          console.log(`Portfreigabe (${e.method}): öffentlich erreichbar unter ${e.external.host}:${e.external.port}`);
        } else if (e.state === 'none') {
          console.log('Portfreigabe: keines der drei Verfahren hat geklappt - normal in vielen '
            + 'Netzen, kein Fehler ("snapkey router" zeigt mehr dazu).');
        } else if (e.state === 'lost') {
          console.log('Portfreigabe: die Freigabe ist abgelaufen und liess sich nicht erneuern.');
        }
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
    portmap: Boolean(flags.portfreigabe),
    meet: treffpunkt ? { host: treffpunkt.host, port: treffpunkt.port, pass: treffpunktPass } : null
  });

  console.log(`SNAPKEY hört auf ${n.me.uri}`);
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
  if (!ziel || !pfade.length) throw new Error('Aufruf: snapkey send <ziel> <pfad...>');

  const an = flags.an ? hostPort(flags.an, tcp.DEFAULT_PORT) : null;
  const treffpunkt = flags.treffpunkt ? hostPort(flags.treffpunkt, meetServerMod.DEFAULT_PORT) : null;
  const treffpunktPass = flags['treffpunkt-pass'] || '';

  const n = await nodeMod.open({ port: 0, announce: true, trustNew: false, name: flags.name, onEvent: () => {} });

  try {
    const gegenstelle = await zielFinden(n, ziel, { an, treffpunkt, treffpunktPass });

    let plan = null;
    let uebertragen = 0;
    let letzterDruck = 0;

    const res = await n.sendTo(gegenstelle, pfade, {
      onProgress: (e) => {
        if (e.type === 'route') console.log(`Weg: ${WEG_TEXT[e.route] || e.route}`);

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

/* --------------------------------- say ----------------------------------- */

async function befehlSay(positional, flags) {
  const [ziel, ...worte] = positional;
  if (!ziel || !worte.length) throw new Error('Aufruf: snapkey say <ziel> <text...>');
  const text = worte.join(' ');

  const an = flags.an ? hostPort(flags.an, tcp.DEFAULT_PORT) : null;
  const treffpunkt = flags.treffpunkt ? hostPort(flags.treffpunkt, meetServerMod.DEFAULT_PORT) : null;
  const treffpunktPass = flags['treffpunkt-pass'] || '';

  const n = await nodeMod.open({ port: 0, announce: true, trustNew: false, name: flags.name, onEvent: () => {} });

  try {
    const gegenstelle = await zielFinden(n, ziel, { an, treffpunkt, treffpunktPass });

    const res = await n.say(gegenstelle, [text], {
      onProgress: (e) => {
        if (e.type === 'route') console.log(`Weg: ${WEG_TEXT[e.route] || e.route}`);
      }
    });

    console.log(res.delivered === 1
      ? `Angekommen (${WEG_TEXT[res.route] || res.route}).`
      : `Nicht angekommen (${WEG_TEXT[res.route] || res.route}).`);
  } finally {
    await n.close();
  }
}

/* -------------------------------- chat ----------------------------------- */

/**
 * Ohne Ziel: die Gegenstellen, mit denen es einen Verlauf gibt, mit
 * Anzahl und Zeitpunkt der letzten Nachricht. Mit Ziel: der Verlauf
 * selbst, aelteste Nachricht oben.
 */
async function befehlChat(positional) {
  const [ziel] = positional;
  const box = store.open();
  const inbox = messagesMod.open(box.dir);

  if (!ziel) {
    const gegenstellen = inbox.peers();
    if (!gegenstellen.length) {
      console.log('Noch keine Nachrichten. "snapkey say <ziel> <text...>" schickt die erste.');
      return;
    }

    const zeilen = gegenstellen
      .slice()
      .sort((a, b) => new Date(b.letzte) - new Date(a.letzte))
      .map((p) => {
        const bekannt = box.peers.get(p.address);
        return {
          Anschrift: p.address,
          Name: (bekannt && bekannt.name) || '(unbekannt)',
          Nachrichten: p.anzahl,
          Zuletzt: zeitAnzeige(p.letzte)
        };
      });

    tabelle(zeilen, [
      ['Anschrift', 'Anschrift'], ['Name', 'Name'], ['Nachrichten', 'Nachrichten'], ['Zuletzt', 'Zuletzt']
    ]);
    return;
  }

  const alsAnschrift = identity.parseAddress(ziel);
  if (!alsAnschrift) throw new Error(`"${ziel}" ist keine brauchbare Anschrift.`);

  const verlauf = inbox.forPeer(alsAnschrift);
  if (!verlauf.length) {
    console.log(`Noch kein Verlauf mit ${alsAnschrift}.`);
    return;
  }

  for (const eintrag of verlauf) {
    const richtung = eintrag.dir === 'out' ? '->' : '<-';
    console.log(`${zeitAnzeige(eintrag.at)}  ${richtung}  ${eintrag.text}`);
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

/* ------------------------------- router --------------------------------- */

async function befehlRouter() {
  const gw = portmap.gateway();
  if (!gw) {
    console.log('Kein Standardrouter gefunden - Portfreigabe ist damit nicht möglich. '
      + 'Das kommt vor (kein Fehler) und lässt sich von hier aus nicht reparieren.');
    return;
  }
  console.log(`Standardrouter: ${gw}`);
  console.log('Probiere NAT-PMP, PCP und UPnP (je bis zu einige Sekunden) ...');

  const ergebnis = await portmap.open({ port: tcp.DEFAULT_PORT });
  if (!ergebnis) {
    console.log('Keines der drei Verfahren hat geantwortet - normal in vielen Netzen '
      + '(abgeschaltet, oder ein Anschluss mit geteilter Adresse ohne eigenen Port). Kein Fehler.');
    return;
  }

  console.log(`Verfahren, das geklappt hat: ${ergebnis.method}`);
  console.log(`Öffentlich erreichbar unter: ${ergebnis.external.host}:${ergebnis.external.port}`);
  await ergebnis.release();
  console.log('Freigabe wieder zurückgegeben.');
}

/* -------------------------------- help ---------------------------------- */

function befehlHelp() {
  console.log(`SNAPKEY - Snap. Send. Done.
Dateien und Nachrichten direkt von Gerät zu Gerät

  snapkey id [--portfreigabe]                      eigene Anschrift zeigen
  snapkey peers                                    Geräte im Netz suchen (${Math.round(SUCH_ZEIT_MS / 1000)} s)
  snapkey listen [--out ORDNER] [--neue-annehmen] [--port N] [--name NAME]
                [--ohne-wiedererkennung] [--ohne-rundruf] [--portfreigabe]
                [--treffpunkt HOST[:PORT]] [--treffpunkt-pass WORT]
                                                   auf Übertragungen und Nachrichten warten
  snapkey send <ziel> <pfad...>                    Dateien oder Ordner schicken
                [--treffpunkt HOST[:PORT]] [--treffpunkt-pass WORT]
                [--an HOST[:PORT]]
  snapkey say <ziel> <text...>                     eine Nachricht schicken
                [--treffpunkt HOST[:PORT]] [--treffpunkt-pass WORT]
                [--an HOST[:PORT]]
  snapkey chat [<ziel>]                            Gegenstellen mit Verlauf, oder der Verlauf selbst
  snapkey treffpunkt [--port N] [--pass WORT]      die Vermittlungsstelle betreiben
  snapkey router                                   eigenen Router abklopfen (NAT-PMP/PCP/UPnP)
  snapkey help                                     diese Übersicht

Beispiele:
  snapkey id
  snapkey router
  snapkey listen --out ~/Empfangen --neue-annehmen
  snapkey listen --out ~/Empfangen --neue-annehmen --treffpunkt dxp8800plus-1
  snapkey listen --out ~/Empfangen --neue-annehmen --treffpunkt dxp8800plus-1 --portfreigabe
  snapkey send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub
  snapkey send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub --treffpunkt dxp8800plus-1
  snapkey send wal-tanne-nordwind-flotte-kiel-schilf ~/Bilder/urlaub --an 100.x.y.z
  snapkey say wal-tanne-nordwind-flotte-kiel-schilf Bin gleich da
  snapkey say wal-tanne-nordwind-flotte-kiel-schilf Bin gleich da --treffpunkt dxp8800plus-1
  snapkey chat
  snapkey chat wal-tanne-nordwind-flotte-kiel-schilf
  snapkey treffpunkt --port 41997 --pass geheimnis

<ziel> bei "send" und "say" ist entweder eine Anschrift oder der Name
eines Geräts, so wie er bei "snapkey peers" auftaucht. Über den
Treffpunkt geht es nur mit einer Anschrift, kein Gerätename - der
Rundruf reicht dort nicht hin.

"say" und "chat" nutzen denselben Weg und denselben Handschlag wie
"send" - nur dass keine Dateien fliessen, sondern Text. Wer bei
"listen" hereinkommt, wird genauso geprüft (--neue-annehmen), gleich
ob er Dateien bringt oder nur redet; die erste Nachricht nach dem
Handschlag entscheidet, was von beidem es ist. "chat" liest nur die
eigene Ablage - dafür muss kein Knoten laufen.

Mit --portfreigabe versucht "listen" (und auf Wunsch "id"), den Router
um eine Portfreigabe zu bitten - klappt das, wird der Treffpunkt für
diese Übertragungen nur noch zur Vermittlung gebraucht, nicht mehr zur
Umleitung. Das gelingt oft nicht (abgeschaltet, oder ein Anschluss mit
geteilter Adresse) - "snapkey router" zeigt, was bei einem selbst geht.`);
}

/* --------------------------------- Start --------------------------------- */

async function main() {
  const [befehl, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (befehl) {
    case 'id': return befehlId(flags);
    case 'peers': return befehlPeers();
    case 'listen': return befehlListen(flags);
    case 'send': return befehlSend(positional, flags);
    case 'say': return befehlSay(positional, flags);
    case 'chat': return befehlChat(positional);
    case 'treffpunkt': return befehlTreffpunkt(flags);
    case 'router': return befehlRouter();
    case 'help':
    case undefined: return befehlHelp();
    default:
      throw new Error(`Unbekannter Befehl "${befehl}" - "snapkey help" zeigt, was geht.`);
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
