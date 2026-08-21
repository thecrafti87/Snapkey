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

const KIND = 'kaiman-hello-v1';

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

  const rufen = (bye = false) => {
    if (stopped) return;
    const msg = announcement({ address: identity.address, pub: identity.pub, port, name, bye });
    socket.send(msg, PORT, GROUP, () => {});
  };

  return new Promise((resolve, reject) => {
    socket.once('error', reject);

    socket.bind(PORT, () => {
      socket.off('error', reject);
      try {
        socket.addMembership(GROUP);
      } catch (err) {
        // Manche Netze lassen keine Gruppen zu. Dann hoert man nichts,
        // kann aber weiter rufen - und wer eine Adresse von Hand
        // eintraegt, kommt trotzdem durch.
        socket.emit('quiet', err);
      }
      socket.setMulticastTTL(1);       // nur das eigene Netz, kein Weiterleiten
      socket.setMulticastLoopback(true);

      rufen();
      timer = setInterval(() => { rufen(); sweep(); }, HELLO_MS);
      if (timer.unref) timer.unref();

      resolve({
        get peers() { return snapshot(); },

        /**
         * Sucht nach Anschrift oder Geraetenamen.
         *
         * Die Anschrift wird durch dieselbe Normalisierung geschickt wie
         * ueberall sonst - wer "kaiman:Wort-Wort" einfuegt oder sie sich
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
          // Sekunden auf einen Geist warten zu lassen.
          const bye = announcement({ address: identity.address, pub: identity.pub, port, name, bye: true });
          socket.send(bye, PORT, GROUP, () => socket.close());
        }
      });
    });
  });
}

module.exports = { GROUP, PORT, HELLO_MS, STALE_MS, announcement, parse, start };
