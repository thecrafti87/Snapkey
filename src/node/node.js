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
const tcp = require('../net/tcp');
const meetClient = require('../net/meet');
const discovery = require('../net/discovery');
const portmap = require('../net/portmap');
const store = require('./store');

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
   * Ein eingehender Anruf, gleich woher: aus dem eigenen Zuhoerer oder
   * aus einer Vermittlung ueber den Treffpunkt. Dieselbe Torkontrolle
   * gilt in beiden Faellen - der Treffpunkt beglaubigt niemanden, das
   * bleibt allein Sache des Handschlags.
   */
  async function alsAnruf(transport, von) {
    onEvent({ type: 'incoming', from: von });

    try {
      const res = await session.receive(transport, {
        identity: me,
        expect: null,          // wer es ist, entscheidet die Torkontrolle
        dir: outDir,
        dedup,
        onEvent: (e) => {
          if (e.type === 'secure') {
            const wer = pruefen(e.peer.pub);
            onEvent({ type: 'accepted', ...wer, from: von });
            return;
          }
          onEvent({ ...e, from: von });
        }
      });
      onEvent({ type: 'received', from: von, result: res, outDir });
    } catch (err) {
      onEvent({ type: 'refused', from: von, message: err.message, code: err.code });
    } finally {
      transport.close();
    }
  }

  const server = await tcp.listen(port, (transport) => alsAnruf(transport, transport.remote));

  /* -------------------------- Sich zeigen -------------------------- */

  const beacon = announce
    ? await discovery.start({
      identity: me,
      port: server.port,
      name,
      onChange: (peers) => onEvent({ type: 'peers', peers })
    })
    : null;

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
   * Schickt Pfade an eine Gegenstelle. `ziel` ist entweder ein Eintrag
   * aus der Geraetesuche oder { host, port, pub }. Traegt `ziel` statt
   * dessen ein `meet: { host, port, pass }`, wird ueber den Treffpunkt
   * verbunden - dann muss `ziel` stattdessen eine Anschrift hergeben.
   */
  async function sendTo(ziel, paths, { onProgress = () => {} } = {}) {
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
    const erwartet = bekannt ? bekannt.pub : null;

    const files = chunks.scan(paths);
    if (!files.length) throw new Error('Nichts zu senden');

    // route: 'lan' (kein Treffpunkt - eigenes Netz oder --an), 'direct'
    // (ueber den Treffpunkt vermittelt, dann aber selbst direkt
    // verbunden) oder 'relay' (tatsaechlich ueber die Umleitung).
    let transport;
    let route;

    if (ziel.meet) {
      const auskunft = await meetClient.lookup(ziel.meet.host, ziel.meet.port, { address, pass: ziel.meet.pass });

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
        route = 'direct';
      } else {
        transport = await auskunft.join();
        route = 'relay';
      }
    } else {
      transport = await tcp.connect(ziel.host, ziel.port);
      route = 'lan';
    }

    onProgress({ type: 'route', route });

    try {
      const res = await session.send(transport, {
        identity: me,
        expect: erwartet,
        files,
        onEvent: (e) => {
          if (e.type === 'secure') {
            // Gemerkt wird der Schluessel, der im Handschlag bewiesen
            // wurde - nicht der, den die Geraetesuche behauptet hat.
            const echt = identityMod.addressOf(e.peer.pub);

            // Die Geraetesuche ist ein Rundruf; dort kann jeder
            // behaupten, was er will. Wenn die Anschrift, die wir
            // angesteuert haben, nicht zu dem Schluessel passt, der
            // antwortet, ist das keine Kleinigkeit.
            if (address && echt !== address) {
              const err = new Error(
                `Angesteuert war ${address}, geantwortet hat ${echt} - die Geräteschau war irreführend`
              );
              err.code = 'PEER_CHANGED';
              throw err;
            }

            box.peers.remember(echt, e.peer.pub, ziel.name || null);
          }
          onProgress(e);
        }
      });
      return { ...res, route, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
    } finally {
      transport.close();
    }
  }

  return {
    me,
    port: server.port,
    outDir,
    store: box,

    get external() { return external; },
    get peers() { return beacon ? beacon.peers : []; },
    find: (hint) => (beacon ? beacon.find(hint) : null),

    sendTo,

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
