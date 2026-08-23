'use strict';

/* =================================================================
   Wer ist sonst noch da?

   Im eigenen Netz braucht es keine Vermittlung: man ruft in den Raum
   und hoert, wer antwortet. Technisch ein Rundruf an eine
   Multicast-Gruppe, alle paar Sekunden wiederholt.

   BEWUSST NICHT mDNS/Bonjour. Das waere die Norm und wuerde auch von
   fremden Programmen gesehen - kostet aber die vollstaendige Umsetzung
   des DNS-Drahtformats, mehrere hundert Zeilen fuer einen Nutzen, den
   hier niemand braucht: gesucht werden nur die eigenen Gegenstellen.
   Der Tausch auf echtes mDNS betraefe spaeter nur diese Datei.

   Die Ankuendigung enthaelt den oeffentlichen Schluessel. Das ist
   Absicht - so kann die Gegenseite sofort pruefen, ob Anschrift und
   Schluessel zusammenpassen, ohne dass jemand etwas abtippt. Wer im
   selben Netz sitzt, sieht damit, welche Geraete es gibt; das ist bei
   jeder Geraetesuche so und der Preis dafuer, dass sie funktioniert.
   ================================================================= */

const dgram = require('dgram');
const os = require('os');

// Nicht `identity` genannt: `start()` hat einen Parameter dieses
// Namens, der das Modul sonst verdeckt.
const identityMod = require('../core/identity');

// Eine Adresse aus dem Bereich fuer eigene Zwecke - nicht die von
// mDNS, damit sich beide nicht ins Gehege kommen.
const GROUP = '239.255.41.99';
const PORT = 41998;

const HELLO_MS = 3000;   // wie oft angekuendigt wird
const STALE_MS = 10000;  // ab wann jemand als weg gilt

const KIND = 'snapkey-hello-v1';

/* ---------------------- Nachrichten formen ---------------------- */

function announcement({ address, pub, port, name, bye = false }) {
  return Buffer.from(JSON.stringify({
    k: KIND,
    a: address,
    p: Buffer.from(pub).toString('base64url'),
    t: port,
    n: name || null,
    bye: bye || undefined
  }), 'utf8');
}

/**
 * Liest eine Ankuendigung. Gibt null zurueck bei allem, was keine ist -
 * auf einer Multicast-Gruppe landet auch Fremdes, und ein Rundruf ist
 * genau der Ort, an dem man mit Unfug rechnen muss.
 */
function parse(buf) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!msg || msg.k !== KIND) return null;
  if (typeof msg.a !== 'string' || typeof msg.p !== 'string') return null;

  const pub = Buffer.from(msg.p, 'base64url');
  if (pub.length !== 32) return null;

  const port = Number(msg.t);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    address: msg.a,
    pub,
    port,
    name: typeof msg.n === 'string' ? msg.n : null,
    bye: msg.bye === true
  };
}

/* --------------------------- Die Karten --------------------------- */

/**
 * Alle brauchbaren IPv4-Karten dieses Rechners.
 *
 * Gibt man dem Betriebssystem keine Karte vor, waehlt es selbst - unter
 * Windows nach der kleinsten Metrik der Route 224.0.0.0/4. Auf einem
 * Rechner mit VPN, WSL oder Hyper-V ist das regelmaessig NICHT das echte
 * Netz, sondern eine tote 169.254-Karte: der Rundruf ginge ins Leere,
 * und gelauscht wuerde auf derselben toten Karte. Nachgemessen auf einem
 * Windows-Rechner mit zehn Karten - gewonnen hat eine abgezogene
 * Ethernet-Buchse mit Metrik 5, waehrend das echte LAN bei 25 stand.
 *
 * Auf einem Mac mit einer aktiven Karte faellt das nie auf. Deshalb wird
 * hier nichts der Wahl des Systems ueberlassen: es wird auf jeder Karte
 * beigetreten und auf jeder Karte gerufen.
 *
 * 169.254 bleibt ausdruecklich drin. Zwei Rechner an einem Kabel ohne
 * DHCP haben genau solche Adressen - und das ist der Fall, fuer den es
 * SNAPKEY gibt.
 */
function karten() {
  const raus = [];
  for (const adressen of Object.values(os.networkInterfaces())) {
    for (const a of adressen || []) {
      // Node meldet die Familie je nach Fassung als Text oder als Zahl.
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      raus.push(a.address);
    }
  }
  return raus;
}

/* --------------------------- Der Rundruf --------------------------- */

/**
 * Kuendigt sich an und sammelt, wer sonst noch ruft.
 *
 * `onChange(peers)` wird gerufen, sobald jemand dazukommt oder
 * verschwindet - nicht bei jeder Wiederholung, sonst waere es Laerm.
 */
function start({ identity, port, name = os.hostname(), onChange = () => {} }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const peers = new Map();

  let timer = null;
  let stopped = false;

  const snapshot = () => [...peers.values()].map((p) => ({ ...p }));

  function forget(address) {
    if (peers.delete(address)) onChange(snapshot());
  }

  function sweep() {
    const jetzt = Date.now();
    let weg = false;
    for (const [address, peer] of peers) {
      if (jetzt - peer.seen > STALE_MS) { peers.delete(address); weg = true; }
    }
    if (weg) onChange(snapshot());
  }

  socket.on('message', (buf, rinfo) => {
    const msg = parse(buf);
    if (!msg) return;
    // Sich selbst hoert man auch - das ist keine Gegenstelle.
    if (msg.address === identity.address) return;

    if (msg.bye) return forget(msg.address);

    const vorher = peers.get(msg.address);
    peers.set(msg.address, {
      address: msg.address,
      pub: msg.pub,
      name: msg.name,
      host: rinfo.address,
      port: msg.port,
      seen: Date.now()
    });
    // Nur melden, wenn sich wirklich etwas geaendert hat.
    if (!vorher || vorher.host !== rinfo.address || vorher.port !== msg.port) {
      onChange(snapshot());
    }
  });

  // Die Karten, auf denen die Gruppe wirklich angenommen wurde. Leer
  // heisst: keine einzige hat gewollt - dann wird ohne Angabe gerufen,
  // wie frueher, statt gar nicht.
  const beigetreten = new Set();

  /**
   * Tritt auf jeder Karte bei, die noch fehlt, und vergisst die, die
   * verschwunden sind. Wird nicht nur beim Start gerufen, sondern bei
   * jeder Wiederholung: ein VPN kommt und geht, ein WLAN auch, und ein
   * Rundruf, der die Karte von vor zehn Minuten benutzt, ist so blind
   * wie gar keiner.
   */
  function kartenPflegen() {
    const jetzt = new Set(karten());

    for (const adresse of jetzt) {
      if (beigetreten.has(adresse)) continue;
      try {
        socket.addMembership(GROUP, adresse);
        beigetreten.add(adresse);
      } catch {
        // Nicht jede Karte nimmt Gruppen an - abgeschaltete Adapter,
        // gesperrte Netze, virtuelle Bruecken ohne Multicast. Die
        // anderen genuegen, und wer eine Adresse von Hand eintraegt,
        // kommt ohnehin durch.
      }
    }

    for (const adresse of [...beigetreten]) {
      if (jetzt.has(adresse)) continue;
      beigetreten.delete(adresse);
      try { socket.dropMembership(GROUP, adresse); } catch { /* Karte ist ohnehin schon weg */ }
    }
  }

  // Laeuft gerade ein Ruf ueber die Karten? Dann keinen zweiten
  // daneben starten - beide wuerden sich die Karte umstellen.
  let imGange = false;

  const rufen = (bye = false) => {
    if (stopped || imGange) return;
    const msg = announcement({ address: identity.address, pub: identity.pub, port, name, bye });
    verschicken(msg);
  };

  /**
   * Schickt eine Ankuendigung ueber jede Karte raus - eine NACH der
   * anderen, nicht in einer Schleife.
   *
   * setMulticastInterface() stellt den Socket um, nicht den einzelnen
   * send(). Die Aufrufe von send() werden aber nicht sofort abgearbeitet,
   * sondern eingereiht: eine Schleife setzt also fuenfmal die Karte um
   * und schickt danach alle fuenf Pakete ueber die, die zuletzt gesetzt
   * wurde. Nachgemessen auf einem Rechner mit fuenf Karten - in der
   * Schleife kamen alle fuenf Pakete von derselben Karte, nacheinander
   * jedes von seiner eigenen.
   *
   * Deshalb: umstellen, senden, Rueckmeldung abwarten, naechste Karte.
   */
  function verschicken(msg, fertig = () => {}, trotzStopp = false) {
    // Keine Karte angenommen: rufen wie frueher und dem System die Wahl
    // lassen. Schlechter als gezielt, aber besser als Schweigen.
    if (!beigetreten.size) return void socket.send(msg, PORT, GROUP, () => fertig());

    const ziele = [...beigetreten];
    let i = 0;
    imGange = true;

    const naechste = () => {
      // Ein laufender Ruf soll nicht ueber den Abschied hinweglaufen.
      if (i >= ziele.length || (stopped && !trotzStopp)) {
        imGange = false;
        return fertig();
      }

      const adresse = ziele[i++];
      try {
        socket.setMulticastInterface(adresse);
        socket.send(msg, PORT, GROUP, () => setImmediate(naechste));
      } catch {
        // Karte zwischen Pflege und Ruf verschwunden, oder der Socket ist
        // schon zu. Beim naechsten Takt ist sie aus der Liste.
        setImmediate(naechste);
      }
    };

    naechste();
  }

  return new Promise((resolve, reject) => {
    socket.once('error', reject);

    socket.bind(PORT, () => {
      socket.off('error', reject);

      socket.setMulticastTTL(1);       // nur das eigene Netz, kein Weiterleiten
      socket.setMulticastLoopback(true);

      kartenPflegen();
      if (!beigetreten.size) {
        // Keine einzige Karte hat die Gruppe angenommen. Als Notnagel
        // der alte Weg: einmal ohne Angabe beitreten und das System
        // waehlen lassen. Geht auch das nicht, hoert man nichts, kann
        // aber weiter rufen - und wer eine Adresse von Hand eintraegt,
        // kommt trotzdem durch.
        try {
          socket.addMembership(GROUP);
        } catch (err) {
          socket.emit('quiet', err);
        }
      }

      rufen();
      timer = setInterval(() => { kartenPflegen(); rufen(); sweep(); }, HELLO_MS);
      if (timer.unref) timer.unref();

      resolve({
        get peers() { return snapshot(); },

        /** Auf welchen Karten die Gruppe angenommen wurde - fuer die Pruefungen. */
        get karten() { return [...beigetreten]; },

        /**
         * Sucht nach Anschrift oder Geraetenamen.
         *
         * Die Anschrift wird durch dieselbe Normalisierung geschickt wie
         * ueberall sonst - wer "snapkey:Wort-Wort" einfuegt oder sie sich
         * hat vorlesen lassen, soll nicht daran scheitern, dass hier
         * genau verglichen wird.
         */
        find(hint) {
          const text = String(hint || '').trim().toLowerCase();
          const address = identityMod.parseAddress(hint);
          return (address && snapshot().find((p) => p.address === address))
            || snapshot().find((p) => (p.name || '').toLowerCase() === text)
            || null;
        },

        stop() {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          // Zum Abschied Bescheid geben, statt die anderen zehn
          // Sekunden auf einen Geist warten zu lassen - auf jeder Karte,
          // auf der auch gerufen wurde. Geschlossen wird erst, wenn der
          // letzte Abschied raus ist, sonst reisst das Schliessen die
          // uebrigen mit.
          let zu = false;
          const schliessen = () => {
            if (zu) return;
            zu = true;
            try { socket.close(); } catch { /* war schon zu */ }
          };

          const bye = announcement({ address: identity.address, pub: identity.pub, port, name, bye: true });
          verschicken(bye, schliessen, true);

          // Bleibt eine Rueckmeldung aus - eine Karte genau im Moment des
          // Abschieds abgezogen -, wird trotzdem geschlossen. Sonst haengt
          // der Prozess an einem Socket, der auf ein Ereignis wartet, das
          // nicht mehr kommt.
          const notbremse = setTimeout(schliessen, 500);
          if (notbremse.unref) notbremse.unref();
        }
      });
    });
  });
}

module.exports = { GROUP, PORT, HELLO_MS, STALE_MS, karten, announcement, parse, start };
