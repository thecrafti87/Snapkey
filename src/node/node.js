'use strict';

/* =================================================================
   Ein laufender Knoten.

   Kuendigt sich im Netz an, nimmt Verbindungen entgegen, und kann
   selbst welche aufbauen. Das ist die Stelle, an der Kern, Leitung und
   Geraetesuche zusammenkommen - jedes fuer sich weiss vom anderen
   nichts.

   Wer hereingelassen wird, entscheidet sich hier und nirgends sonst.
   ================================================================= */

const os = require('os');

const session = require('../core/session');
const chunks = require('../core/chunks');
const frame = require('../core/frame');
const talk = require('../core/talk');
const tcp = require('../net/tcp');
const meetClient = require('../net/meet');
const discovery = require('../net/discovery');
const portmap = require('../net/portmap');
const store = require('./store');
const messagesMod = require('./messages');

// Wie lange nach einem gescheiterten Anlauf am Treffpunkt gewartet wird,
// bevor der Knoten es erneut versucht - wachsend, aber gedeckelt: ein
// Treffpunkt, der laenger down ist, soll nicht zum Dauerklopfen fuehren.
const MEET_RETRY_MS = 5000;
const MEET_RETRY_MAX_MS = 30000;

/** Wartet, laesst sich aber vorzeitig durch ein AbortSignal aufwecken. */
function warten(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    if (!signal) return;
    if (signal.aborted) { clearTimeout(timer); resolve(); return; }
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** "host:port" auseinandernehmen - der Doppelpunkt trennt von hinten wegen IPv6. */
function parseHostPort(text) {
  if (!text || typeof text !== 'string') return null;
  const i = text.lastIndexOf(':');
  if (i === -1) return null;
  const host = text.slice(0, i);
  const port = Number(text.slice(i + 1));
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port };
}

/**
 * `trustNew`  ob eine unbekannte Gegenstelle beim ersten Mal
 *             angenommen wird. Aus, solange nichts anderes gesagt ist:
 *             sonst koennte jeder im selben Netz Dateien ablegen.
 * `meet`      { host, port, pass } - ist das gesetzt, meldet sich der
 *             Knoten zusaetzlich zum eigenen Zuhoerer an einem
 *             Treffpunkt an, fuer Gegenstellen, die er im eigenen Netz
 *             nicht erreicht.
 * `portmap`   aus, solange nichts anderes gesagt ist. Ist es an,
 *             versucht der Knoten nach dem Zuhoeren, seinen Router um
 *             eine Portfreigabe zu bitten (`net/portmap.js`) - klappt
 *             das, ist er unter `node.external` direkt von aussen
 *             erreichbar, und meldet das bei `meet` gleich als `direct`
 *             mit. Klappt es nicht (der Normalfall in vielen Netzen),
 *             laeuft alles wie ohne diese Option weiter.
 */
async function open({
  home,
  outDir = process.cwd(),
  name = os.hostname().replace(/\.local$/, ''),
  port = 0,
  trustNew = false,
  announce = true,
  // Ruft der Knoten von selbst in den Raum? Aus heisst: er hoert zu,
  // bleibt aber selbst unsichtbar, bis jemand `scan()` drueckt. Das ist
  // etwas anderes als `announce: false` - dort gibt es gar keinen
  // Rundruf, hier nur keinen selbsttaetigen.
  autoScan = true,
  // Einwilligung vor dem Empfang: bekommt {from, address, name, files,
  // bytes, names} und antwortet (auch verspaetet) mit wahr oder falsch.
  // Ohne Haken wird wie bisher sofort angenommen - die Kommandozeile
  // und alle bestehenden Aufrufer bleiben unveraendert.
  onApprove = null,
  meet = null,
  portmap: mitPortfreigabe = false,
  // Blockwiedererkennung: was schon irgendwo im Zielordner liegt, wird
  // nicht noch einmal uebertragen. Abschaltbar, weil das Durchlesen des
  // Zielordners bei sehr grossen Ablagen spuerbar sein kann.
  dedup = true,
  onEvent = () => {}
} = {}) {
  const box = store.open(home);
  const me = box.me;
  const inbox = messagesMod.open(box.dir);

  /* ------------------------ Hereinkommendes ------------------------ */

  /**
   * Die Torkontrolle. Wird mitten im Handschlag gerufen, sobald
   * feststeht, wer da ist - und wirft, wenn er nicht herein soll. Der
   * Kern bricht daraufhin ab, bevor eine einzige Datei fliesst.
   */
  function pruefen(peerPub) {
    const address = require('../core/identity').addressOf(peerPub);
    const bekannt = box.peers.get(address);

    if (bekannt) {
      const res = box.peers.remember(address, peerPub);
      if (res.status === 'changed') {
        const err = new Error(
          `${address} meldet sich mit einem anderen Schlüssel als bisher. `
          + 'Entweder wurde dort neu installiert, oder jemand gibt sich als diese Gegenstelle aus.'
        );
        err.code = 'PEER_CHANGED';
        throw err;
      }
      return { address, neu: false };
    }

    if (!trustNew) {
      const err = new Error(`${address} ist unbekannt - mit --neue-annehmen starten, um zu koppeln`);
      err.code = 'UNKNOWN_PEER';
      throw err;
    }

    box.peers.remember(address, peerPub, null);
    return { address, neu: true };
  }

  /**
   * Wartet auf die naechste Nachricht nach dem Handschlag - vielleicht
   * liegt sie schon in der Warteschlange des Kanals (im selben Paket
   * wie das letzte Handschlagpaket), sonst wird auf sie gewartet.
   * Dasselbe Muster wie in session.receive(), hier gebraucht, weil erst
   * diese eine Nachricht zeigt, ob eine Datei- oder eine
   * Nachrichtensitzung folgt (siehe alsAnruf).
   */
  function naechsteNachricht(handshake) {
    return new Promise((resolve, reject) => {
      const schonDa = handshake.next();
      if (schonDa) { resolve(schonDa); return; }

      // Die Zustaendigkeit fuer neue Bytes geht ab hier auf uns ueber
      // (siehe Channel.setOwner in session.js) - der Transport selbst
      // wird kein zweites Mal angefasst (ein echter Socket haengt
      // Zuhoerer nur an, ersetzt sie nicht).
      handshake.channel.setOwner({
        onData: () => {
          const packet = handshake.next();
          if (!packet) return;
          // Bis der naechste Besitzer (session.receiveOn oder
          // talk.listen) sich nach dem "await" gleich meldet, wird nur
          // noch stumm weitergepuffert - dasselbe Muster wie in
          // session.connect().
          handshake.channel.setOwner({ onData: () => {}, onError: () => {}, onClose: () => {} });
          resolve(packet);
        },
        onError: reject,
        onClose: () => reject(new Error('Die Verbindung wurde getrennt'))
      });
    });
  }

  /**
   * Ein eingehender Anruf, gleich woher: aus dem eigenen Zuhoerer oder
   * aus einer Vermittlung ueber den Treffpunkt. Dieselbe Torkontrolle
   * gilt in beiden Faellen - der Treffpunkt beglaubigt niemanden, das
   * bleibt allein Sache des Handschlags.
   *
   * Nach dem Handschlag entscheidet die erste Nachricht, was folgt:
   * 'manifest' eine Dateiuebertragung, 'say' eine Nachrichtensitzung.
   * Kein eigenes Vorwort im Protokoll - genau diese eine Nachricht ist
   * die Weiche.
   */
  // Laufende Datei-Empfaenge, nach Anrufkennung. Damit laesst sich ein
  // einzelner Empfang von aussen anhalten, ohne die anderen zu
  // beruehren - jede Verbindung ist ihr eigener Ablauf.
  const eingehende = new Map();

  async function alsAnruf(transport, von) {
    onEvent({ type: 'incoming', from: von });

    let address = null;

    try {
      const handshake = await session.connect(transport, {
        identity: me,
        expect: null,          // wer es ist, entscheidet die Torkontrolle
        initiator: false,
        onEvent: (e) => {
          if (e.type === 'secure') {
            const wer = pruefen(e.peer.pub);
            address = wer.address;
            onEvent({ type: 'accepted', ...wer, from: von });
            return;
          }
          onEvent({ ...e, from: von });
        }
      });

      const erste = await naechsteNachricht(handshake);
      const ersteMsg = erste.type === frame.CONTROL ? frame.readControl(erste.body) : null;

      if (ersteMsg && ersteMsg.t === 'say') {
        const res = await talk.listen(handshake.channel, handshake.peer, {
          onMessage: ({ text, at }) => {
            inbox.add(address, { dir: 'in', text, at });
            onEvent({ type: 'message', from: von, address, text, at });
          },
          onEvent: (e) => onEvent({ ...e, from: von })
        }, erste);
        onEvent({ type: 'talked', address, count: res.received, from: von });
      } else {
        const anhalter = new AbortController();
        eingehende.set(von, anhalter);

        const res = await session.receiveOn(handshake, {
          dir: outDir,
          dedup,
          signal: anhalter.signal,
          // Die Anschrift kommt dazu, damit die Frage einen Absender
          // hat - der Name, falls die Gegenstelle als Geraet bekannt
          // ist. Wer sie ablehnt, laesst keinen Rest zurueck: bis zur
          // Antwort ist nichts geschrieben (siehe session.receiveOn).
          approve: onApprove
            ? (angebot) => onApprove({
                ...angebot,
                from: von,
                address,
                name: (box.peers.get(address) || {}).name || null
              })
            : null,
          onEvent: (e) => onEvent({ ...e, from: von })
        }, erste);
        onEvent({ type: 'received', from: von, result: res, outDir });
      }
    } catch (err) {
      onEvent({ type: 'refused', from: von, message: err.message, code: err.code });
    } finally {
      eingehende.delete(von);
      transport.close();
    }
  }

  const server = await tcp.listen(port, (transport) => alsAnruf(transport, transport.remote));

  /* -------------------------- Sich zeigen -------------------------- */

  // Ein gescheitertes Binden (Port 41998 schon belegt, oder ein System,
  // das reuseAddr anders behandelt als erwartet) soll nicht den ganzen
  // Knoten mitreissen - server.listen() oben ist schon geglueckt, und
  // ohne Geraetesuche bleibt der Knoten trotzdem ueber eine von Hand
  // eingetragene Anschrift erreichbar.
  let beacon = null;
  if (announce) {
    try {
      beacon = await discovery.start({
        identity: me,
        port: server.port,
        name,
        auto: autoScan,
        onChange: (peers) => onEvent({ type: 'peers', peers })
      });
    } catch (err) {
      onEvent({ type: 'discovery', state: 'none', message: err.message });
    }
  }

  /* --------------------------- Portfreigabe --------------------------- */

  // `external` ist bewusst ein `let`, keine Konstante: eine Erneuerung
  // kann den aussen sichtbaren Port aendern, und wer nach `node.external`
  // fragt oder sich am Treffpunkt anmeldet, soll immer den aktuellen
  // Stand sehen.
  let external = null;
  let portmapHandle = null;

  if (mitPortfreigabe) {
    portmapHandle = await portmap.open({
      port: server.port,
      onEvent: (e) => {
        if (e.type === 'renewed') {
          external = e.external;
          onEvent({ type: 'portmap', state: 'mapped', external, method: e.method });
        } else if (e.type === 'lost') {
          external = null;
          onEvent({ type: 'portmap', state: 'lost', external: null, method: e.method });
        }
      }
    });

    if (portmapHandle) {
      external = portmapHandle.external;
      onEvent({ type: 'portmap', state: 'mapped', external, method: portmapHandle.method });
    } else {
      onEvent({ type: 'portmap', state: 'none', external: null, method: null });
    }
  }

  /* --------------------- Am Treffpunkt erreichbar --------------------- */

  const meetAbbruch = meet ? new AbortController() : null;
  let meetSchliessend = false;
  let meetLaufend = null;   // die gerade offene Verbindung zum Treffpunkt

  async function meetSchleife() {
    let warteZeit = MEET_RETRY_MS;

    while (!meetSchliessend) {
      let transport;
      try {
        onEvent({
          type: 'meet',
          state: 'verbinden',
          message: `Melde mich am Treffpunkt ${meet.host}:${meet.port} an ...`
        });
        transport = await meetClient.register(meet.host, meet.port, {
          address: me.address,
          pass: meet.pass,
          // Der jeweils aktuelle Stand - eine Erneuerung koennte den
          // aussen sichtbaren Port seit der letzten Anmeldung geaendert
          // haben.
          direct: external ? `${external.host}:${external.port}` : undefined,
          signal: meetAbbruch.signal
        });
      } catch (err) {
        if (meetSchliessend) break;
        onEvent({ type: 'meet', state: 'fehler', message: err.message });
        await warten(warteZeit, meetAbbruch.signal);
        warteZeit = Math.min(warteZeit + MEET_RETRY_MS, MEET_RETRY_MAX_MS);
        continue;
      }

      warteZeit = MEET_RETRY_MS;    // ein geglueckter Anlauf setzt zurueck
      if (meetSchliessend) { transport.close(); break; }

      meetLaufend = transport;
      onEvent({ type: 'meet', state: 'angemeldet', message: `Erreichbar über ${meet.host}:${meet.port}` });

      // Genau dieselbe Torkontrolle wie bei einem eingehenden Anruf im
      // eigenen Netz - der Treffpunkt hat niemanden beglaubigt.
      await alsAnruf(transport, `treffpunkt ${meet.host}:${meet.port}`);
      meetLaufend = null;
      // Egal ob die Uebertragung glueckte oder nicht: sofort wieder
      // anmelden, damit der Knoten weiter erreichbar bleibt.
    }
  }

  const meetPromise = meet ? meetSchleife() : null;

  /* ------------------------- Hinausgehendes ------------------------- */

  /**
   * Baut die Verbindung zu einer Zielangabe auf - dieselbe Wegewahl fuer
   * Dateien wie fuer Nachrichten: eigenes Netz direkt, sonst ueber den
   * Treffpunkt vermittelt (moeglichst direkt, sonst als Umleitung).
   *
   * route: 'lan' (kein Treffpunkt - eigenes Netz oder --an), 'direct'
   * (ueber den Treffpunkt vermittelt, dann aber selbst direkt
   * verbunden) oder 'relay' (tatsaechlich ueber die Umleitung).
   */
  async function verbinde(ziel, address) {
    if (!ziel.meet) {
      return { transport: await tcp.connect(ziel.host, ziel.port), route: 'lan' };
    }

    const auskunft = await meetClient.lookup(ziel.meet.host, ziel.meet.port, { address, pass: ziel.meet.pass });

    let transport = null;
    const direktZiel = parseHostPort(auskunft.direct);
    if (direktZiel) {
      try {
        transport = await tcp.connect(direktZiel.host, direktZiel.port, { timeout: 4000 });
      } catch {
        // Der direkte Weg hat nicht geklappt - es bleibt bei der
        // Umleitung ueber den Treffpunkt, kein Grund zum Abbrechen.
        transport = null;
      }
    }

    if (transport) {
      auskunft.cancel();
      return { transport, route: 'direct' };
    }
    return { transport: await auskunft.join(), route: 'relay' };
  }

  /**
   * `ziel` ist entweder ein Eintrag aus der Geraetesuche oder
   * { host, port, pub }. Traegt `ziel` statt dessen ein
   * `meet: { host, port, pass }`, wird ueber den Treffpunkt verbunden -
   * dann muss `ziel` stattdessen eine Anschrift hergeben. Wirft, wenn
   * `address` gesetzt ist und `ziel` weder `host` noch `meet` hat.
   */
  function zielPruefen(ziel) {
    if (!ziel || (!ziel.host && !ziel.meet)) throw new Error('Keine erreichbare Gegenstelle angegeben');

    const identityMod = require('../core/identity');
    const address = ziel.address || (ziel.pub && identityMod.addressOf(ziel.pub));

    if (ziel.meet && !address) {
      throw new Error('Für den Weg über den Treffpunkt wird eine Anschrift der Gegenstelle gebraucht');
    }

    // Eine schon gekoppelte Gegenstelle wird auf ihren Schluessel
    // festgenagelt. Ein Fremder im Netz kann sich dann nicht
    // dazwischenschieben, indem er dieselbe Anschrift ruft.
    const bekannt = address ? box.peers.get(address) : null;
    return { identityMod, address, erwartet: bekannt ? bekannt.pub : null };
  }

  /**
   * Prueft, ob der im Handschlag bewiesene Schluessel zu der
   * angesteuerten Anschrift passt - die Geraetesuche ist ein Rundruf,
   * dort kann jeder behaupten, was er will. Gemerkt wird immer der
   * bewiesene Schluessel, nicht der behauptete.
   */
  function schluesselPruefen(identityMod, address, ziel, e) {
    const echt = identityMod.addressOf(e.peer.pub);
    if (address && echt !== address) {
      const err = new Error(
        `Angesteuert war ${address}, geantwortet hat ${echt} - die Geräteschau war irreführend`
      );
      err.code = 'PEER_CHANGED';
      throw err;
    }
    box.peers.remember(echt, e.peer.pub, ziel.name || null);
    return echt;
  }

  /** Schickt Pfade an eine Gegenstelle. `signal` haelt die Sendung an (siehe session.send). */
  async function sendTo(ziel, paths, { onProgress = () => {}, signal = null } = {}) {
    const { identityMod, address, erwartet } = zielPruefen(ziel);

    const files = chunks.scan(paths);
    if (!files.length) throw new Error('Nichts zu senden');

    const { transport, route } = await verbinde(ziel, address);
    onProgress({ type: 'route', route });

    try {
      const res = await session.send(transport, {
        identity: me,
        expect: erwartet,
        files,
        signal,
        onEvent: (e) => {
          if (e.type === 'secure') schluesselPruefen(identityMod, address, ziel, e);
          onProgress(e);
        }
      });
      return { ...res, route, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
    } finally {
      transport.close();
    }
  }

  /**
   * Schickt Kurznachrichten an eine Gegenstelle - dieselbe Wegewahl und
   * dasselbe Festnageln auf den bekannten Schluessel wie sendTo, nur
   * mit dem Nachrichtenprotokoll (talk.js) statt der Dateiuebertragung.
   * Abgeschickte Nachrichten werden ebenfalls abgelegt, mit demselben
   * Zeitstempel, der auch an die Gegenstelle ging.
   */
  async function say(ziel, texte, { onProgress = () => {} } = {}) {
    const { identityMod, address, erwartet } = zielPruefen(ziel);

    const { transport, route } = await verbinde(ziel, address);
    onProgress({ type: 'route', route });

    let peerAdresse = address;

    try {
      const res = await talk.say(transport, {
        identity: me,
        expect: erwartet,
        texts: texte,
        onEvent: (e) => {
          if (e.type === 'secure') peerAdresse = schluesselPruefen(identityMod, address, ziel, e);
          if (e.type === 'delivered') inbox.add(peerAdresse, { dir: 'out', text: e.text, at: e.at });
          onProgress(e);
        }
      });
      return { delivered: res.delivered, route, peer: res.peer };
    } finally {
      transport.close();
    }
  }

  return {
    me,
    port: server.port,
    outDir,
    store: box,
    messages: inbox,

    get external() { return external; },
    get peers() { return beacon ? beacon.peers : []; },
    find: (hint) => (beacon ? beacon.find(hint) : null),

    // Ohne Rundruf (announce: false, oder das Binden ist misslungen)
    // gibt es nichts zu rufen und nichts zu schalten. Dann false statt
    // eines Wurfes - der Aufrufer soll das als "geht hier nicht"
    // behandeln koennen, so wie beim Finder-Kurzbefehl.
    get autoScan() { return beacon ? beacon.auto : false; },
    scan: () => (beacon ? beacon.jetztRufen() : false),
    setAutoScan: (an) => (beacon ? beacon.setAuto(an) : false),

    /**
     * Haelt einen laufenden Empfang an. Was schon dalag, bleibt liegen
     * - schickt die Gegenstelle spaeter erneut, geht nur der Rest
     * ueber die Leitung. false, wenn unter dieser Kennung gerade
     * nichts laueft.
     */
    stopIncoming(from) {
      const anhalter = eingehende.get(from);
      if (!anhalter) return false;
      anhalter.abort(Object.assign(new Error('Übertragung angehalten'), { code: 'STOPPED' }));
      return true;
    },

    sendTo,
    say,

    async close() {
      if (beacon) beacon.stop();

      if (meetAbbruch) {
        meetSchliessend = true;
        meetAbbruch.abort();
        // Eine offene Anmeldung (angemeldet oder mitten in einer
        // Uebertragung) wird zwangsweise beendet - genau wie eine
        // eingehende Verbindung im eigenen Netz, die server.close()
        // auch nicht abwartet.
        if (meetLaufend) meetLaufend.close();
        await meetPromise;
      }

      if (portmapHandle) await portmapHandle.release();

      await server.close();
    }
  };
}

module.exports = { open };
