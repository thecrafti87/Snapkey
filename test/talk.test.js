'use strict';

/* =================================================================
   Kurznachrichten ueber denselben Handschlag wie die Dateien - ohne
   Netz, ueber zwei Endpunkte im Speicher (wie in session.test.js).
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const session = require('../src/core/session');
const talk = require('../src/core/talk');
const identity = require('../src/core/identity');
const memory = require('../src/transport/memory');

/* ----------------------------- Aufbau ----------------------------- */

/**
 * Wartet auf die naechste Nachricht nach dem Handschlag - dasselbe
 * Muster wie in src/node/node.js: erst nachsehen, ob sie schon in der
 * Warteschlange liegt, sonst darauf warten.
 */
function naechsteNachricht(handshake) {
  return new Promise((resolve, reject) => {
    const schonDa = handshake.next();
    if (schonDa) { resolve(schonDa); return; }

    handshake.channel.setOwner({
      onData: () => {
        const packet = handshake.next();
        if (packet) resolve(packet);
      },
      onError: reject,
      onClose: () => reject(new Error('Die Verbindung wurde getrennt'))
    });
  });
}

/**
 * Ein Durchlauf: `sender` schickt `texte` an `empfaenger`, ueber
 * memory.pair(). Gibt zurueck, was beide Seiten am Ende sagen, plus
 * die Liste dessen, was beim Empfaenger tatsaechlich abgelegt wurde
 * (sofern `onMessage` nicht selbst uebergeben wurde).
 */
async function talkLauf(texte, { sender, empfaenger, gekoppelt = true, onMessage } = {}) {
  const leitung = memory.pair();
  const abgelegt = [];
  const merken = onMessage || ((m) => abgelegt.push(m));

  const gesendet = talk.say(leitung.a, {
    identity: sender,
    expect: gekoppelt ? empfaenger.pub : null,
    texts: texte
  });

  const empfangen = (async () => {
    const h = await session.connect(leitung.b, {
      identity: empfaenger,
      expect: gekoppelt ? sender.pub : null,
      initiator: false
    });
    const erste = await naechsteNachricht(h);
    return talk.listen(h.channel, h.peer, { onMessage: merken }, erste);
  })();

  const [s, e] = await Promise.allSettled([gesendet, empfangen]);
  return { s, e, abgelegt };
}

/* ---------------------------- Pruefungen ---------------------------- */

test('eine Nachricht kommt an', async () => {
  const sender = identity.create();
  const empfaenger = identity.create();

  const { s, e, abgelegt } = await talkLauf(['hallo, ist da wer?'], { sender, empfaenger });

  assert.equal(s.status, 'fulfilled', s.reason && s.reason.message);
  assert.equal(e.status, 'fulfilled', e.reason && e.reason.message);
  assert.equal(s.value.delivered, 1);
  assert.equal(e.value.received, 1);

  assert.equal(abgelegt.length, 1);
  assert.equal(abgelegt[0].text, 'hallo, ist da wer?');
  assert.equal(typeof abgelegt[0].at, 'string');
  assert.ok(!Number.isNaN(Date.parse(abgelegt[0].at)), 'at ist kein brauchbarer Zeitstempel');
});

test('mehrere Nachrichten in einer Sitzung - die Reihenfolge bleibt', async () => {
  const sender = identity.create();
  const empfaenger = identity.create();
  const texte = ['eins', 'zwei', 'drei', 'vier', 'fuenf'];

  const { s, e, abgelegt } = await talkLauf(texte, { sender, empfaenger });

  assert.equal(s.status, 'fulfilled', s.reason && s.reason.message);
  assert.equal(e.status, 'fulfilled', e.reason && e.reason.message);
  assert.equal(s.value.delivered, texte.length);
  assert.equal(e.value.received, texte.length);
  assert.deepEqual(abgelegt.map((m) => m.text), texte);
});

test('eine zu lange Nachricht wird abgewiesen', () => {
  const sender = identity.create();
  const empfaenger = identity.create();
  const leitung = memory.pair();

  const zuLang = 'x'.repeat(talk.MAX_TEXT_LENGTH + 1);

  assert.throws(
    () => talk.say(leitung.a, { identity: sender, expect: empfaenger.pub, texts: [zuLang] }),
    (err) => {
      assert.equal(err.code, 'TEXT_TOO_LONG');
      return true;
    }
  );
});

test('zu viele Nachrichten in einer Sitzung werden abgewiesen', () => {
  const sender = identity.create();
  const empfaenger = identity.create();
  const leitung = memory.pair();

  const zuViele = Array.from({ length: talk.MAX_MESSAGES + 1 }, (_, i) => `nachricht ${i}`);

  assert.throws(
    () => talk.say(leitung.a, { identity: sender, expect: empfaenger.pub, texts: zuViele }),
    (err) => {
      assert.equal(err.code, 'TOO_MANY_MESSAGES');
      return true;
    }
  );
});

test('etwas, das kein Text ist, wird abgewiesen', () => {
  const sender = identity.create();
  const empfaenger = identity.create();
  const leitung = memory.pair();

  assert.throws(
    () => talk.say(leitung.a, { identity: sender, expect: empfaenger.pub, texts: [42] }),
    (err) => {
      assert.equal(err.code, 'BAD_TEXT');
      return true;
    }
  );
});

test('ohne Bestaetigung (got) gilt eine Nachricht nicht als zugestellt', async () => {
  const sender = identity.create();
  const empfaenger = identity.create();

  let versucht = 0;
  const { s, e } = await talkLauf(['bitte nicht ablegen'], {
    sender,
    empfaenger,
    onMessage: () => {
      versucht++;
      // Der Rueckruf wirft absichtlich - laut Vertrag geht dann kein
      // "got" raus, und der Sender darf die Nachricht nicht als
      // zugestellt zaehlen.
      throw new Error('Ablage verweigert (nur zum Pruefen der Bestaetigung)');
    }
  });

  assert.equal(versucht, 1, 'die Nachricht kam nie beim Rueckruf an');
  assert.equal(s.status, 'rejected', 'der Sender haette auf das Ausbleiben von "got" reagieren muessen');
  assert.equal(e.status, 'rejected');
});
