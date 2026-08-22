'use strict';

/* =================================================================
   Der Treffpunkt.

   Zwei Geraete, die sich sonst nicht erreichen - hinter zwei
   verschiedenen Routern, keins von beiden mit einer festen Adresse -,
   finden sich hier ueber eine Anschrift statt ueber ein Kabel. Das
   eine meldet sich erreichbar (`here`) und wartet, das andere sucht es
   (`reach`). Sobald beide da sind, schaltet die Stelle die beiden
   Verbindungen zusammen und deutet danach kein einziges Byte mehr.

   WICHTIG ZUR SICHERHEIT: Die Vermittlungsstelle beglaubigt niemanden.
   Wer sich unter einer fremden Anschrift anmeldet, erreicht damit
   hoechstens, dass die echte Gegenstelle nicht mehr erreichbar ist -
   Daten bekommt er nicht, weil der Handschlag der Sitzung darueber
   (handshake.js) ihn abweist: der dort bewiesene Schluessel muss zu
   dem passen, den der Sender erwartet, und den hat ein Fremder nicht.
   Das Passwort ist der Schutz gegen genau diese Belegung einer
   Anschrift, nicht gegen Mitlesen - die Stelle sieht nach der
   Vermittlung ohnehin nur noch verschluesselte Bytes und weiss nicht
   einmal, dass es welche sind.
   ================================================================= */

const net = require('net');

const frame = require('../core/frame');
const protocol = require('./protocol');

const DEFAULT_PORT = 41997;

// Wer binnen dieser Frist weder 'here' noch 'reach' sagt, haelt sonst
// einen Portscanner oder eine vergessene Verbindung fuer immer offen.
const DEFAULT_IDLE_MS = 30000;

/**
 * `port`         woran gelauscht wird
 * `pass`         leer = offen fuer jede Anschrift; sonst muessen
 *                `here` und `reach` es mitschicken
 * `idleTimeout`  Frist in ms, siehe DEFAULT_IDLE_MS. Konfigurierbar
 *                vor allem fuer Pruefungen, die nicht 30 s warten
 *                wollen.
 */
function start({ port = DEFAULT_PORT, pass = '', idleTimeout = DEFAULT_IDLE_MS, onEvent = () => {} } = {}) {
  // Wer angemeldet ist und auf 'reach' wartet. Ein Token je Anmeldung,
  // damit die alte Verbindung beim Schliessen nicht versehentlich die
  // Anmeldung loescht, die eine neuere Anmeldung inzwischen an ihre
  // Stelle gesetzt hat.
  const registrations = new Map();

  // Ueber alle offenen Verbindungen wird selbst Buch gefuehrt - genau
  // wie in tcp.js, aus demselben Grund: server.close() allein wartet
  // sonst auf Gegenstellen, die nie auflegen.
  const offen = new Set();

  function verbindeDurch(reachSocket, hereSocket, address) {
    // Ab hier deutet die Stelle nichts mehr. Beide Seiten bekommen
    // 'joined', danach ist jedes weitere Byte roh und ungedeutet -
    // Sitzungsdaten, kein Steuerwort mehr.
    reachSocket.removeAllListeners('data');
    hereSocket.removeAllListeners('data');

    const joined = frame.pack(frame.control(protocol.joinedMsg()));
    reachSocket.write(joined);
    hereSocket.write(joined);

    reachSocket.pipe(hereSocket);
    hereSocket.pipe(reachSocket);

    onEvent({ type: 'joined', address });

    const beenden = () => {
      reachSocket.unpipe(hereSocket);
      hereSocket.unpipe(reachSocket);
      if (!reachSocket.destroyed) reachSocket.destroy();
      if (!hereSocket.destroyed) hereSocket.destroy();
    };
    reachSocket.once('close', beenden);
    hereSocket.once('close', beenden);
  }

  const server = net.createServer((socket) => {
    offen.add(socket);
    socket.setNoDelay(true);

    const decoder = new frame.Decoder();
    let meineAnschrift = null;
    let meinToken = null;

    const send = (msg) => {
      if (!socket.destroyed) socket.write(frame.pack(frame.control(msg)));
    };

    const idle = setTimeout(() => socket.destroy(), idleTimeout);
    if (idle.unref) idle.unref();

    socket.on('close', () => {
      offen.delete(socket);
      clearTimeout(idle);

      // Nur loeschen, wenn wirklich noch die eigene Anmeldung dort
      // steht - eine neuere koennte die eigene laengst verdraengt
      // haben, und die soll bestehen bleiben.
      if (meineAnschrift && registrations.get(meineAnschrift)?.token === meinToken) {
        registrations.delete(meineAnschrift);
        onEvent({ type: 'gone', address: meineAnschrift });
      }
    });

    // 'error' fuehrt ohnehin zu 'close' - hier reicht es, den Absturz
    // des Prozesses durch eine unbehandelte Ausnahme zu verhindern.
    socket.on('error', () => {});

    socket.on('data', (bytes) => {
      let frames;
      try {
        frames = decoder.push(bytes);
      } catch {
        // Eine unmoegliche Laengenangabe ist kein Ungluecksfall, den
        // man abwarten muesste - die Verbindung ist es nicht wert.
        socket.destroy();
        return;
      }

      for (const payload of frames) {
        const split = frame.split(payload);
        const msg = split && split.type === frame.CONTROL ? protocol.read(split.body) : null;
        if (!msg) {
          socket.destroy();
          return;
        }

        if (msg.t === 'ping') {
          send(protocol.pongMsg());
          continue;
        }

        if (msg.t === 'here') {
          if (pass && msg.pass !== pass) {
            send(protocol.deniedMsg('falsches Passwort'));
            onEvent({ type: 'denied', reason: 'here', address: msg.address });
            socket.destroy();
            return;
          }
          clearTimeout(idle);

          // Mehrere Anmeldungen auf dieselbe Anschrift sind erlaubt -
          // die neueste gilt, die vorherige verliert ihre Verbindung.
          const vorherige = registrations.get(msg.address);
          if (vorherige && vorherige.socket !== socket) vorherige.socket.destroy();

          meineAnschrift = msg.address;
          meinToken = Symbol('meet-registration');
          registrations.set(meineAnschrift, { token: meinToken, socket });

          onEvent({ type: 'registered', address: meineAnschrift });
          send(protocol.okMsg());
          continue;
        }

        if (msg.t === 'reach') {
          if (pass && msg.pass !== pass) {
            send(protocol.deniedMsg('falsches Passwort'));
            onEvent({ type: 'denied', reason: 'reach', address: msg.address });
            socket.destroy();
            return;
          }
          clearTimeout(idle);

          const partner = registrations.get(msg.address);
          if (!partner) {
            send(protocol.nobodyMsg());
            onEvent({ type: 'nobody', address: msg.address });
            socket.destroy();
            return;
          }

          // Die Anmeldung ist damit verbraucht - ein zweites 'reach'
          // auf dieselbe Anschrift findet niemanden mehr, bis sich
          // wieder wer meldet.
          registrations.delete(msg.address);
          verbindeDurch(socket, partner.socket, msg.address);
          return;
        }

        // 'ok', 'joined', 'nobody', 'denied', 'pong' sind Antworten der
        // Stelle, keine Anfragen an sie - von einem Klienten hier zu
        // bekommen ist Unfug.
        socket.destroy();
        return;
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,

        get registered() { return registrations.size; },

        close: () => new Promise((done) => {
          server.close(done);
          for (const socket of offen) socket.destroy();
          offen.clear();
        })
      });
    });
  });
}

module.exports = { DEFAULT_PORT, DEFAULT_IDLE_MS, start };
