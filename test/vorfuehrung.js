'use strict';

/* Kein Test, sondern eine Vorfuehrung mit Zahlen: 40 MB uebertragen,
   mittendrin die Leitung kappen, neu ansetzen. Aufrufen mit
   `node test/vorfuehrung.js`. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/core/session');
const chunks = require('../src/core/chunks');
const identity = require('../src/core/identity');
const memory = require('../src/transport/memory');

const MB = 1024 * 1024;
const mb = (n) => `${(n / MB).toFixed(1)} MB`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiman-vorfuehrung-'));
const root = path.join(dir, 'quelle', 'urlaub');
const ziel = path.join(dir, 'ziel');
fs.mkdirSync(path.join(root, 'videos'), { recursive: true });

for (const [name, groesse] of [
  ['bilder.zip', 18 * MB], ['videos/clip-1.mov', 12 * MB],
  ['videos/clip-2.mov', 9 * MB], ['notiz.txt', 240]
]) {
  const out = Buffer.allocUnsafe(groesse);
  let h = crypto.createHash('sha256').update(name).digest();
  for (let at = 0; at < groesse; at += 32) {
    h = crypto.createHash('sha256').update(h).digest();
    h.copy(out, at, 0, Math.min(32, groesse - at));
  }
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), out);
}

const A = identity.create();
const B = identity.create();

async function anlauf(nummer, cutAfter) {
  const leitung = memory.pair({ cutAfter });
  const files = chunks.scan([root]);

  let gesendet = 0;
  const s = session.send(leitung.a, {
    identity: A, expect: B.pub, files,
    onEvent: (e) => { if (e.type === 'sent') gesendet += e.bytes; }
  });
  const r = session.receive(leitung.b, { identity: B, expect: A.pub, dir: ziel });

  const [se, em] = await Promise.allSettled([s, r]);
  const plan = em.status === 'fulfilled' ? em.value : null;

  console.log(`\n--- Anlauf ${nummer} ---`);
  if (se.status === 'rejected') {
    console.log(`  abgebrochen nach ${mb(leitung.delivered)}: ${se.reason.message}`);
  } else {
    console.log(`  geschickt      ${mb(gesendet)} in ${se.value.sent} Blöcken`);
    console.log(`  wiederverwendet ${plan.had} Blöcke, die schon dalagen`);
    console.log(`  vollständig    ${plan.ok ? 'ja' : 'nein'}`);
  }
  return leitung.delivered;
}

(async () => {
  const gesamt = chunks.scan([root]).reduce((n, f) => n + f.size, 0);
  console.log(`Quelle: ${mb(gesamt)} in 4 Dateien`);
  console.log(`Anschrift des Empfängers: ${B.uri}`);

  await anlauf(1, 15 * MB);          // mittendrin gekappt
  await anlauf(2, Infinity);         // fortsetzen
  await anlauf(3, Infinity);         // nichts mehr zu tun

  const heil = chunks.scan([ziel]).reduce((n, f) => n + f.size, 0);
  console.log(`\nIm Zielordner: ${mb(heil)}`);
  fs.rmSync(dir, { recursive: true, force: true });
})();
