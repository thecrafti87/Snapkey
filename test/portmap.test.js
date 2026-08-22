'use strict';

/* =================================================================
   Die Portfreigabe, ohne einen echten Router.

   Erst die reinen Nachrichtenfunktionen: bauen und lesen, ohne Netz,
   mit den Fehlerfaellen, die ein echter Router liefern koennte (zu
   kurz, falsche Version, falscher Opcode, ein Fehler-Ergebniscode).
   Danach ein nachgemachter Router - ein UDP-Dienst auf 127.0.0.1, der
   NAT-PMP spricht -, damit auch der echte Client-Weg geprueft ist, und
   zwei Gegenproben: ein Router, der gar nicht antwortet, und einer, der
   Unfug schickt. Beides muss `null` ergeben, nie eine Ausnahme.
   ================================================================= */

const test = require('node:test');
const assert = require('node:assert/strict');

const dgram = require('dgram');
const crypto = require('crypto');

const portmap = require('../src/net/portmap');

/* ------------------------------- NAT-PMP ------------------------------- */

test('NAT-PMP: die Anfrage nach der oeffentlichen Adresse ist 2 Byte, die Antwort liest sich zurueck', () => {
  const req = portmap.natpmp.buildExternalRequest();
  assert.equal(req.length, 2);
  assert.deepEqual([...req], [0, 0]);

  const antwort = Buffer.alloc(12);
  antwort.writeUInt8(0, 0);
  antwort.writeUInt8(128, 1);
  antwort.writeUInt16BE(0, 2);
  antwort.writeUInt32BE(4711, 4);
  antwort.writeUInt8(203, 8);
  antwort.writeUInt8(0, 9);
  antwort.writeUInt8(113, 10);
  antwort.writeUInt8(7, 11);

  assert.deepEqual(portmap.natpmp.parseExternalResponse(antwort), { epoch: 4711, ip: '203.0.113.7' });
});

test('NAT-PMP: zu kurz, falsche Version, falscher Opcode und ein Fehler-Ergebniscode ergeben null (oeffentliche Adresse)', () => {
  const gut = Buffer.alloc(12);
  gut.writeUInt8(0, 0);
  gut.writeUInt8(128, 1);

  assert.equal(portmap.natpmp.parseExternalResponse(Buffer.alloc(8)), null, 'zu kurz');
  assert.equal(portmap.natpmp.parseExternalResponse(null), null, 'kein Buffer');

  const falscheVersion = Buffer.from(gut);
  falscheVersion.writeUInt8(1, 0);
  assert.equal(portmap.natpmp.parseExternalResponse(falscheVersion), null, 'falsche Version');

  const falscherOp = Buffer.from(gut);
  falscherOp.writeUInt8(1, 1);
  assert.equal(portmap.natpmp.parseExternalResponse(falscherOp), null, 'falscher Opcode');

  const fehlerErgebnis = Buffer.from(gut);
  fehlerErgebnis.writeUInt16BE(3, 2);
  assert.equal(portmap.natpmp.parseExternalResponse(fehlerErgebnis), null, 'Fehler-Ergebniscode');
});

test('NAT-PMP: die Freigabeanfrage hat 12 Byte und die richtigen Felder', () => {
  const req = portmap.natpmp.buildMapRequest({ protocol: 'tcp', internalPort: 41999, externalPort: 12345, lifetime: 3600 });
  assert.equal(req.length, 12);
  assert.equal(req.readUInt8(0), 0);           // Version
  assert.equal(req.readUInt8(1), 2);           // TCP
  assert.equal(req.readUInt16BE(2), 0);        // reserviert
  assert.equal(req.readUInt16BE(4), 41999);    // innen
  assert.equal(req.readUInt16BE(6), 12345);    // aussen-Wunsch
  assert.equal(req.readUInt32BE(8), 3600);     // Dauer

  const reqUdp = portmap.natpmp.buildMapRequest({ protocol: 'udp', internalPort: 1, lifetime: 60 });
  assert.equal(reqUdp.readUInt8(1), 1);        // UDP
  assert.equal(reqUdp.readUInt16BE(6), 0);     // kein aussen-Wunsch angegeben -> 0
});

test('NAT-PMP: die Antwort auf die Freigabeanfrage liest sich zurueck, falscher Opcode und Fehler-Ergebniscode ergeben null', () => {
  const antwort = Buffer.alloc(16);
  antwort.writeUInt8(0, 0);
  antwort.writeUInt8(2 + 128, 1);
  antwort.writeUInt16BE(0, 2);
  antwort.writeUInt32BE(1000, 4);
  antwort.writeUInt16BE(41999, 8);
  antwort.writeUInt16BE(55000, 10);
  antwort.writeUInt32BE(3600, 12);

  assert.deepEqual(
    portmap.natpmp.parseMapResponse(antwort, { protocol: 'tcp' }),
    { epoch: 1000, internalPort: 41999, externalPort: 55000, lifetime: 3600 }
  );

  assert.equal(portmap.natpmp.parseMapResponse(antwort, { protocol: 'udp' }), null, 'der Opcode passt nicht zum Protokoll');
  assert.equal(portmap.natpmp.parseMapResponse(Buffer.alloc(10), { protocol: 'tcp' }), null, 'zu kurz');

  const fehler = Buffer.from(antwort);
  fehler.writeUInt16BE(2, 2);
  assert.equal(portmap.natpmp.parseMapResponse(fehler, { protocol: 'tcp' }), null, 'Fehler-Ergebniscode');
});

/* --------------------------------- PCP --------------------------------- */

test('PCP: die MAP-Anfrage hat 60 Byte und die richtigen Felder', () => {
  const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const req = portmap.pcp.buildMapRequest({
    protocol: 'tcp', internalPort: 41999, externalPort: 0, lifetime: 3600, clientIp: '192.168.1.50', nonce
  });

  assert.equal(req.length, 60);
  assert.equal(req.readUInt8(0), 2);          // Version
  assert.equal(req.readUInt8(1), 1);          // Opcode MAP
  assert.equal(req.readUInt32BE(4), 3600);    // Dauer

  // Eigene IP als IPv4-abgebildete IPv6: 10 Nullbytes, zwei 0xff, dann vier Bytes.
  assert.deepEqual([...req.subarray(8, 18)], new Array(10).fill(0));
  assert.deepEqual([...req.subarray(18, 20)], [0xff, 0xff]);
  assert.deepEqual([...req.subarray(20, 24)], [192, 168, 1, 50]);

  assert.deepEqual([...req.subarray(24, 36)], [...nonce]);
  assert.equal(req.readUInt8(36), 6);         // TCP = IANA-Nummer 6
  assert.equal(req.readUInt16BE(40), 41999);  // innen
  assert.equal(req.readUInt16BE(42), 0);      // aussen-Wunsch

  const reqUdp = portmap.pcp.buildMapRequest({
    protocol: 'udp', internalPort: 1, lifetime: 60, clientIp: '10.0.0.1', nonce
  });
  assert.equal(reqUdp.readUInt8(36), 17);     // UDP = IANA-Nummer 17
});

test('PCP: die MAP-Antwort liest sich zurueck, ein falscher Nonce und ein Fehler-Ergebniscode ergeben null', () => {
  const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const antwort = Buffer.alloc(60);
  antwort.writeUInt8(2, 0);
  antwort.writeUInt8(1 + 128, 1);
  antwort.writeUInt8(0, 3);              // Ergebnis
  antwort.writeUInt32BE(3600, 4);        // Lifetime
  nonce.copy(antwort, 24);
  antwort.writeUInt8(6, 36);             // Protokoll TCP
  antwort.writeUInt16BE(41999, 40);
  antwort.writeUInt16BE(55000, 42);
  antwort[54] = 0xff; antwort[55] = 0xff;
  antwort[56] = 203; antwort[57] = 0; antwort[58] = 113; antwort[59] = 7;

  assert.deepEqual(
    portmap.pcp.parseMapResponse(antwort, { nonce }),
    { lifetime: 3600, externalPort: 55000, externalIp: '203.0.113.7' }
  );

  const falscherNonce = Buffer.from(antwort);
  falscherNonce[24] = 99;
  assert.equal(portmap.pcp.parseMapResponse(falscherNonce, { nonce }), null, 'falscher Nonce');

  assert.equal(portmap.pcp.parseMapResponse(Buffer.alloc(40), { nonce }), null, 'zu kurz');

  const fehler = Buffer.from(antwort);
  fehler.writeUInt8(1, 3);
  assert.equal(portmap.pcp.parseMapResponse(fehler, { nonce }), null, 'Fehler-Ergebniscode');

  const falscheVersion = Buffer.from(antwort);
  falscheVersion.writeUInt8(1, 0);
  assert.equal(portmap.pcp.parseMapResponse(falscheVersion, { nonce }), null, 'falsche Version');
});

/* -------------------------------- UPnP ---------------------------------- */

const BEISPIEL_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <controlURL>/ctl/IPConn</controlURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`;

test('UPnP: controlURL wird in einer Geraetebeschreibung gefunden', () => {
  assert.deepEqual(
    portmap.upnp.findControlUrl(BEISPIEL_XML),
    { controlUrl: '/ctl/IPConn', serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1' }
  );
});

test('UPnP: verstuemmeltes oder unpassendes XML ergibt null, kein Rateversuch', () => {
  assert.equal(portmap.upnp.findControlUrl('<root><device>kaputt'), null, 'unvollstaendiges Dokument');
  assert.equal(
    portmap.upnp.findControlUrl(
      '<root><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType></service></root>'
    ),
    null, 'controlURL fehlt'
  );
  assert.equal(portmap.upnp.findControlUrl('<root><service><serviceType>was-anderes</serviceType>'
    + '<controlURL>/x</controlURL></service></root>'), null, 'kein passender Dienst');
  assert.equal(portmap.upnp.findControlUrl(''), null, 'leer');
  assert.equal(portmap.upnp.findControlUrl(null), null, 'kein String');
});

/* --------------------------- Der nachgemachte Router --------------------------- */

/**
 * Ein UDP-Dienst auf 127.0.0.1, der NAT-PMP spricht - von Hand gebaut,
 * ohne portmap.js's eigene Bau-Funktionen zu benutzen, damit die
 * Pruefung wirklich den Draht entlanggeht statt sich selbst zu
 * bestaetigen.
 */
function nachgemachterRouter({ externalIp = [203, 0, 113, 7], epoch = 1000, unfug = false } = {}) {
  const socket = dgram.createSocket('udp4');
  let letzteMapAnfrage = null;

  socket.on('message', (msg, rinfo) => {
    if (unfug) {
      socket.send(crypto.randomBytes(20), rinfo.port, rinfo.address);
      return;
    }

    if (msg.length === 2 && msg[0] === 0 && msg[1] === 0) {
      const antwort = Buffer.alloc(12);
      antwort.writeUInt8(0, 0);
      antwort.writeUInt8(128, 1);
      antwort.writeUInt16BE(0, 2);
      antwort.writeUInt32BE(epoch, 4);
      Buffer.from(externalIp).copy(antwort, 8);
      socket.send(antwort, rinfo.port, rinfo.address);
      return;
    }

    if (msg.length === 12) {
      letzteMapAnfrage = msg;
      const op = msg.readUInt8(1);
      const innenPort = msg.readUInt16BE(4);
      const aussenWunsch = msg.readUInt16BE(6);
      const dauer = msg.readUInt32BE(8);
      const aussenPort = dauer === 0 ? 0 : (aussenWunsch || 55000);

      const antwort = Buffer.alloc(16);
      antwort.writeUInt8(0, 0);
      antwort.writeUInt8(op + 128, 1);
      antwort.writeUInt16BE(0, 2);
      antwort.writeUInt32BE(epoch, 4);
      antwort.writeUInt16BE(innenPort, 8);
      antwort.writeUInt16BE(aussenPort, 10);
      antwort.writeUInt32BE(dauer, 12);
      socket.send(antwort, rinfo.port, rinfo.address);
    }
  });

  return {
    letzteMapAnfrage: () => letzteMapAnfrage,
    start: () => new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(portmap.GATEWAY_PORT, '127.0.0.1', () => { socket.off('error', reject); resolve(); });
    }),
    close: () => socket.close()
  };
}

test('mit einem nachgemachten NAT-PMP-Router: Freigabe erhalten, oeffentliche Adresse gelesen, release() schickt Dauer 0', async (t) => {
  const router = nachgemachterRouter();
  await router.start();
  t.after(() => router.close());

  const ergebnis = await portmap.open({ port: 41999, gateway: '127.0.0.1' });
  assert.ok(ergebnis, 'die Freigabe haette gelingen muessen');
  assert.equal(ergebnis.method, 'natpmp');
  assert.deepEqual(ergebnis.external, { host: '203.0.113.7', port: 55000 });

  await ergebnis.release();
  const letzte = router.letzteMapAnfrage();
  assert.ok(letzte, 'keine Freigabeanfrage beim nachgemachten Router angekommen');
  assert.equal(letzte.readUInt32BE(8), 0, 'release() haette Dauer 0 schicken muessen');
});

test('ein Router, der gar nicht antwortet, ergibt binnen der Frist null - keine Ausnahme', async () => {
  // Auf 127.0.0.1:5351 (und :1900 fuer UPnP) laeuft in dieser Pruefung
  // nichts - die Anfragen gehen ins Leere, die Antwort bleibt aus.
  const start = Date.now();
  const ergebnis = await portmap.open({ port: 41999, gateway: '127.0.0.1' });
  assert.equal(ergebnis, null);
  assert.ok(Date.now() - start < 15000, 'open() haette binnen kurzer Frist aufgeben muessen, nicht haengen');
});

test('ein Router, der Unfug antwortet (zufaellige Bytes), ergibt null', async (t) => {
  const router = nachgemachterRouter({ unfug: true });
  await router.start();
  t.after(() => router.close());

  const ergebnis = await portmap.open({ port: 41999, gateway: '127.0.0.1' });
  assert.equal(ergebnis, null);
});
