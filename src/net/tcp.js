'use strict';

/* =================================================================
   Die Leitung im eigenen Netz.

   Eine gewoehnliche Verbindung von Rechner zu Rechner - kein Relay,
   keine Vermittlung, niemand dazwischen. Das ist der schnellste Weg,
   den es gibt, und der einzige, an dem gar kein Server beteiligt ist.

   Nach aussen sieht diese Datei genauso aus wie der Transport im
   Speicher: senden, zuhoeren, auflegen. Der Kern merkt den Unterschied
   nicht - deshalb laesst er sich ohne Netz pruefen und laeuft trotzdem
   hier.

   Neu gegenueber dem Speicher ist `drain`: eine echte Leitung nimmt
   nicht unbegrenzt entgegen. Wer 28 GB hineinschiebt, ohne zu fragen,
   fuellt den Arbeitsspeicher, nicht die Leitung.
   ================================================================= */

const net = require('net');

const DEFAULT_PORT = 41999;

/**
 * Huellt eine Verbindung in das, was der Kern erwartet.
 *
 * Zugehoert wird erst, wenn jemand `onData` setzt - bis dahin haelt
 * Node die Verbindung an. Sonst gingen die ersten Pakete verloren,
 * bevor die Sitzung ueberhaupt steht.
 */
function wrap(socket) {
  let closed = false;
  const closers = [];

  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of closers) cb();
  };

  socket.on('close', fireClose);
  socket.on('error', fireClose);

  // Kleine Pakete sofort rausgeben statt sammeln - der Handschlag
  // besteht aus wenigen Bytes, und darauf wartet die Gegenseite.
  socket.setNoDelay(true);

  return {
    socket,

    send(bytes) {
      if (!closed) socket.write(bytes);
    },

    /**
     * Wartet, bis die Leitung wieder aufnahmefaehig ist. Der Kern fragt
     * das zwischen den Bloecken ab.
     */
    drain() {
      if (closed || !socket.writableNeedDrain) return Promise.resolve();
      return new Promise((resolve) => {
        const go = () => { socket.off('drain', go); socket.off('close', go); resolve(); };
        socket.once('drain', go);
        socket.once('close', go);
      });
    },

    onData(cb) { socket.on('data', cb); },

    onClose(cb) {
      if (closed) return setImmediate(cb);
      closers.push(cb);
    },

    close() {
      if (closed) return;
      // `end` statt `destroy`: was noch im Ausgang liegt, soll noch
      // rausgehen - sonst faellt die Schlussnachricht unter den Tisch.
      socket.end();
      socket.setTimeout(2000, () => socket.destroy());
    },

    get remote() {
      return socket.remoteAddress ? `${socket.remoteAddress}:${socket.remotePort}` : null;
    }
  };
}

/** Nimmt Verbindungen entgegen. `onPeer` bekommt je Anruf einen Transport. */
function listen(port, onPeer) {
  // Ueber die offenen Verbindungen wird selbst Buch gefuehrt. Nodes
  // eigenes Herunterfahren wartet darauf, dass die Gegenstelle auflegt -
  // eine, die das nicht tut, haelt das Programm sonst beliebig lange
  // fest. Nachgemessen: ohne dieses Buch bleibt `close()` stehen.
  const offen = new Set();

  const server = net.createServer((socket) => {
    offen.add(socket);
    socket.on('close', () => offen.delete(socket));
    onPeer(wrap(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,

        close: () => new Promise((done) => {
          server.close(done);
          for (const socket of offen) socket.destroy();
          offen.clear();
        })
      });
    });
  });
}

/** Ruft an. Bricht ab, wenn niemand abnimmt - sonst haengt es ewig. */
function connect(host, port, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    const scheitern = (err) => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeout, () => scheitern(new Error(`${host}:${port} antwortet nicht`)));
    socket.once('error', scheitern);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.off('error', scheitern);
      resolve(wrap(socket));
    });
  });
}

module.exports = { DEFAULT_PORT, wrap, listen, connect };
