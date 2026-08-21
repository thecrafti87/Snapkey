'use strict';

/* =================================================================
   Derselbe Kern, jetzt ueber eine echte Leitung.

   Der Transport im Speicher hat schon geprueft, dass der Ablauf
   stimmt. Hier geht es um das, was nur eine richtige Verbindung hat:
   Rueckstau, ein Abriss mitten im Satz, und die Frage, ob die
   Schlussnachricht noch rausgeht, bevor aufgelegt wird.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/core/session');
const chunks = require('../src/core/chunks');
const identity = require('../src/core/identity');
const tcp = require('../src/net/tcp');

function tempdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiman-tcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Ein Ordner, gross genug fuer mehrere Bloecke und echten Rueckstau. */
function quelle(dir, mb = 6) {
  const root = path.join(dir, 'quelle', 'daten');
  fs.mkdirSync(path.join(root, 'unter'), { recursive: true });

  const wuerfel = (n, samen) => {
    const out = Buffer.allocUnsafe(n);
    let h = crypto.createHash('sha256').update(samen).digest();
    for (let at = 0; at < n; at += 32) {
      h = crypto.createHash('sha256').update(h).digest();
      h.copy(out, at, 0, Math.min(32, n - at));
    }
    return out;
  };

  fs.writeFileSync(path.join(root, 'gross.bin'), wuerfel(mb * 1024 * 1024, 'g'));
  fs.writeFileSync(path.join(root, 'unter', 'tief.txt'), 'in einem Unterordner');
  return root;
}

/** Startet einen Zuhoerer, der genau eine Sitzung entgegennimmt. */
async function empfangsstelle(ziel, empfaenger, sender, { kappenNach = Infinity } = {}) {
  let fertig;
  const ergebnis = new Promise((resolve) => { fertig = resolve; });

  const server = await tcp.listen(0, (transport) => {
    if (kappenNach < Infinity) {
      let gesehen = 0;
      transport.socket.on('data', (bytes) => {
        gesehen += bytes.length;
        if (gesehen >= kappenNach) transport.socket.destroy();
      });
    }
    session.receive(transport, { identity: empfaenger, expect: sender.pub, dir: ziel })
      .then((r) => fertig({ status: 'fulfilled', value: r }))
      .catch((e) => fertig({ status: 'rejected', reason: e }))
      // Wer fertig ist, legt auf - sonst bleibt die Verbindung offen
      // und der Zuhoerer laesst sich nicht beenden.
      .finally(() => transport.close());
  });

  return { port: server.port, close: server.close, ergebnis };
}

/* ---------------------------- Pruefungen ---------------------------- */

test('ein Ordner wandert ueber eine echte Verbindung', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const A = identity.create();
  const B = identity.create();

  const stelle = await empfangsstelle(ziel, B, A);
  t.after(() => stelle.close());

  const transport = await tcp.connect('127.0.0.1', stelle.port);
  const gesendet = await session.send(transport, { identity: A, expect: B.pub, files: chunks.scan([root]) });
  const empfangen = await stelle.ergebnis;

  assert.equal(empfangen.status, 'fulfilled', empfangen.reason && empfangen.reason.message);
  assert.equal(empfangen.value.ok, true);
  assert.ok(gesendet.sent > 0);

  assert.ok(fs.readFileSync(path.join(ziel, 'daten', 'gross.bin'))
    .equals(fs.readFileSync(path.join(root, 'gross.bin'))));
  assert.equal(fs.readFileSync(path.join(ziel, 'daten', 'unter', 'tief.txt'), 'utf8'), 'in einem Unterordner');
});

test('die Leitung wird nicht schneller befuellt, als sie abnimmt', async (t) => {
  // Ohne Rueckstaubehandlung landen 28 GB im Arbeitsspeicher statt auf
  // der Leitung. Geprueft wird, dass der Ausgangspuffer beim Senden
  // nicht unbegrenzt waechst.
  const dir = tempdir(t);
  const root = quelle(dir, 8);
  const ziel = path.join(dir, 'ziel');

  const A = identity.create();
  const B = identity.create();

  const stelle = await empfangsstelle(ziel, B, A);
  t.after(() => stelle.close());

  const transport = await tcp.connect('127.0.0.1', stelle.port);
  let hoechststand = 0;
  const beobachter = setInterval(() => {
    hoechststand = Math.max(hoechststand, transport.socket.writableLength);
  }, 5);

  await session.send(transport, { identity: A, expect: B.pub, files: chunks.scan([root]) });
  clearInterval(beobachter);
  await stelle.ergebnis;

  // Grosszuegig bemessen: es geht nicht um einen genauen Wert, sondern
  // darum, dass nicht die ganzen 8 MB auf einmal drinstehen.
  assert.ok(hoechststand < 6 * 1024 * 1024,
    `der Ausgang staute sich auf ${(hoechststand / 1048576).toFixed(1)} MB`);
});

test('ein Abriss mitten im Satz wird ueberlebt und fortgesetzt', async (t) => {
  const dir = tempdir(t);
  const root = quelle(dir);
  const ziel = path.join(dir, 'ziel');

  const A = identity.create();
  const B = identity.create();

  // --- Erster Anlauf, unterbrochen ---
  const erst = await empfangsstelle(ziel, B, A, { kappenNach: 2 * 1024 * 1024 });
  const t1 = await tcp.connect('127.0.0.1', erst.port);
  const s1 = await session.send(t1, { identity: A, expect: B.pub, files: chunks.scan([root]) })
    .then(() => 'durch').catch(() => 'abgebrochen');
  await erst.ergebnis;
  await erst.close();

  assert.equal(s1, 'abgebrochen', 'der Abriss blieb unbemerkt');
  const angefangen = chunks.scan([ziel]).reduce((n, f) => n + f.size, 0);
  assert.ok(angefangen > 0, 'es kam gar nichts an');

  // --- Zweiter Anlauf ---
  const zweit = await empfangsstelle(ziel, B, A);
  t.after(() => zweit.close());

  const t2 = await tcp.connect('127.0.0.1', zweit.port);
  const alle = chunks.totalChunks(chunks.buildManifest(chunks.scan([root])));
  const s2 = await session.send(t2, { identity: A, expect: B.pub, files: chunks.scan([root]) });
  const e2 = await zweit.ergebnis;

  assert.equal(e2.status, 'fulfilled', e2.reason && e2.reason.message);
  assert.equal(e2.value.ok, true);
  assert.ok(s2.sent < alle, `es wurden wieder alle ${alle} Blöcke geschickt`);
  assert.ok(e2.value.had > 0, 'nichts wiederverwendet');

  assert.ok(fs.readFileSync(path.join(ziel, 'daten', 'gross.bin'))
    .equals(fs.readFileSync(path.join(root, 'gross.bin'))));
});

test('wer nicht abnimmt, laesst niemanden haengen', async () => {
  // Ein Anruf ins Leere muss aufgeben, nicht ewig warten.
  await assert.rejects(
    () => tcp.connect('127.0.0.1', 1, { timeout: 1500 }),
    (err) => err instanceof Error
  );
});

test('die Schlussnachricht geht noch raus, bevor aufgelegt wird', async (t) => {
  // `end` statt `destroy`: sonst faellt das letzte Paket unter den
  // Tisch, und der Sender erfaehrt nie, ob alles ankam.
  const dir = tempdir(t);
  const root = quelle(dir, 1);
  const ziel = path.join(dir, 'ziel');

  const A = identity.create();
  const B = identity.create();

  const stelle = await empfangsstelle(ziel, B, A);
  t.after(() => stelle.close());

  const transport = await tcp.connect('127.0.0.1', stelle.port);
  const res = await session.send(transport, { identity: A, expect: B.pub, files: chunks.scan([root]) });

  assert.equal(res.ok, true, 'das Schlusswort der Gegenstelle kam nicht an');
  assert.deepEqual(res.missing, []);
});
