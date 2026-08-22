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
const discovery = require('../net/discovery');
const store = require('./store');

/**
 * `trustNew`  ob eine unbekannte Gegenstelle beim ersten Mal
 *             angenommen wird. Aus, solange nichts anderes gesagt ist:
 *             sonst koennte jeder im selben Netz Dateien ablegen.
 */
async function open({
  home,
  outDir = process.cwd(),
  name = os.hostname().replace(/\.local$/, ''),
  port = 0,
  trustNew = false,
  announce = true,
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

  const server = await tcp.listen(port, async (transport) => {
    const von = transport.remote;
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
  });

  /* -------------------------- Sich zeigen -------------------------- */

  const beacon = announce
    ? await discovery.start({
      identity: me,
      port: server.port,
      name,
      onChange: (peers) => onEvent({ type: 'peers', peers })
    })
    : null;

  /* ------------------------- Hinausgehendes ------------------------- */

  /**
   * Schickt Pfade an eine Gegenstelle. `ziel` ist entweder ein Eintrag
   * aus der Geraetesuche oder { host, port, pub }.
   */
  async function sendTo(ziel, paths, { onProgress = () => {} } = {}) {
    if (!ziel || !ziel.host) throw new Error('Keine erreichbare Gegenstelle angegeben');

    const identityMod = require('../core/identity');
    const address = ziel.address || (ziel.pub && identityMod.addressOf(ziel.pub));

    // Eine schon gekoppelte Gegenstelle wird auf ihren Schluessel
    // festgenagelt. Ein Fremder im Netz kann sich dann nicht
    // dazwischenschieben, indem er dieselbe Anschrift ruft.
    const bekannt = address ? box.peers.get(address) : null;
    const erwartet = bekannt ? bekannt.pub : null;

    const files = chunks.scan(paths);
    if (!files.length) throw new Error('Nichts zu senden');

    const transport = await tcp.connect(ziel.host, ziel.port);
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
      return { ...res, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
    } finally {
      transport.close();
    }
  }

  return {
    me,
    port: server.port,
    outDir,
    store: box,

    get peers() { return beacon ? beacon.peers : []; },
    find: (hint) => (beacon ? beacon.find(hint) : null),

    sendTo,

    async close() {
      if (beacon) beacon.stop();
      await server.close();
    }
  };
}

module.exports = { open };
