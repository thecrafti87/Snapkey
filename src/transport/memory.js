'use strict';

/* =================================================================
   Zwei Endpunkte im Speicher.

   Kein Netz, kein Kabel - nur zwei Puffer, die einander beliefern. Der
   Kern soll sich vollstaendig pruefen lassen, ohne dass eine Steckdose
   im Spiel ist: keine Zeitueberschreitungen, keine belegten Ports,
   keine Testlaeufe, die manchmal durchgehen.

   Zugestellt wird bewusst verzoegert und in Stuecken. Wer synchron
   zustellt, prueft einen Fall, den es draussen nicht gibt - dort kommt
   ein Paket in drei Teilen an oder drei Pakete in einem, und genau da
   sitzen die Fehler.
   ================================================================= */

/**
 * `sliceSize`  in wie grossen Stuecken zugestellt wird. Klein gewaehlt
 *              prueft es die Paketzusammensetzung besonders gruendlich.
 * `cutAfter`   nach wie vielen zugestellten Bytes die Leitung
 *              abreissen soll - fuer den Abbruch mitten in der
 *              Uebertragung.
 */
function pair({ sliceSize = 0, cutAfter = Infinity } = {}) {
  const ends = [makeEnd(0), makeEnd(1)];
  let delivered = 0;
  let dead = false;
  let closing = false;

  function makeEnd(index) {
    return {
      index,
      onDataCb: null,
      onCloseCb: null,
      bytesIn: 0,
      bytesOut: 0,
      send(bytes) {
        if (dead || closing) return;
        const other = ends[1 - index];
        this.bytesOut += bytes.length;

        // Stueckeln und verzoegern - so wie es draussen ankommt.
        const parts = [];
        if (sliceSize > 0) {
          for (let at = 0; at < bytes.length; at += sliceSize) {
            parts.push(bytes.subarray(at, Math.min(at + sliceSize, bytes.length)));
          }
        } else {
          parts.push(bytes);
        }

        for (const part of parts) {
          setImmediate(() => {
            if (dead) return;

            const room = cutAfter - delivered;
            if (room <= 0) return cut();

            const piece = part.length <= room ? part : part.subarray(0, room);
            delivered += piece.length;
            other.bytesIn += piece.length;
            if (other.onDataCb) other.onDataCb(Buffer.from(piece));

            if (delivered >= cutAfter) cut();
          });
        }
      },
      onData(cb) { this.onDataCb = cb; },
      onClose(cb) { this.onCloseCb = cb; },

      /**
       * Auflegen wie draussen: was schon im Ausgang liegt, wird noch
       * zugestellt, DANN reisst die Leitung. Echtes TCP macht es genauso
       * - tcp.js ruft socket.end(), nicht destroy(), eigens damit die
       * Schlussnachricht noch rausgeht. Ein sofortiger Abriss hier
       * prueft einen Fall, den es draussen nicht gibt - und verschluckt
       * ausgerechnet die Begruendung, die eine Seite der anderen zum
       * Abschied schickt. Der harte Schnitt mitten in der Uebertragung
       * bleibt cut() vorbehalten (cutAfter).
       */
      close() {
        if (dead || closing) return;
        closing = true;
        // Ein setImmediate NACH den schon eingereihten Zustellungen -
        // die laufen damit noch, Neues nimmt send() nicht mehr an.
        setImmediate(cut);
      }
    };
  }

  function cut() {
    if (dead) return;
    dead = true;
    for (const end of ends) {
      if (end.onCloseCb) setImmediate(() => end.onCloseCb());
    }
  }

  return {
    a: ends[0],
    b: ends[1],
    cut,
    get delivered() { return delivered; },
    get broken() { return dead; }
  };
}

module.exports = { pair };
