'use strict';

/* =================================================================
   Den Router um einen Port bitten.

   Loecherstanzen (das Umweg-Rendezvous ueber den Treffpunkt) braucht
   man nur, wenn beide Seiten hinter einem Router sitzen, der sich
   nicht bitten laesst. Viele Router lassen sich aber bitten - dann
   reicht danach eine gewoehnliche TCP-Verbindung von aussen, ohne
   Vermittlung und ohne dass eine dritte Stelle die Bandbreite traegt.

   Drei Verfahren, aelter zuerst: NAT-PMP (RFC 6886, einfach, viele
   Router aus offener Firmware und von Apple), PCP (RFC 6887, der nach-
   folger), UPnP-IGD (am weitesten verbreitet, aber auch am meisten
   Fehlerquellen: SSDP-Rundruf, XML-Beschreibung, SOAP-Aufruf).

   WICHTIG: In vielen Netzen klappt keins von allen drei - Portfreigabe
   ist oft abgeschaltet, oder der Anschluss haengt hinter einer Adresse,
   die sich hunderte andere teilen (Carrier-Grade-NAT), und dort gibt es
   gar keinen eigenen Port zum Freigeben. Das ist der Normalfall, kein
   Fehler - `open()` gibt dann `null` zurueck, wirft nie und haengt nie.
   ================================================================= */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Standardport beider UDP-Verfahren (RFC 6886 / RFC 6887) - derselbe
// Port fuer beide, nacheinander am selben Gateway probiert.
const GATEWAY_PORT = 5351;

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// Frist je Anfrage - kurz, weil ein Router, der nicht antwortet, das
// meistens auch nach laengerem Warten nicht tut. Insgesamt macht das
// bei drei Verfahren mit je bis zu zwei Anfragen eine Wartezeit im
// einstelligen Sekundenbereich, nicht mehr.
const TRY_TIMEOUT_MS = 2000;

const DEFAULT_LIFETIME = 3600;

/* ------------------------------ gateway() ------------------------------ */

/** Zerlegt die Kernel-Hex-Schreibweise (klein-endig) in eine IPv4-Adresse. */
function hexZuIp(hex) {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const bytes = [];
  for (let i = 0; i < 8; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  bytes.reverse();
  return bytes.join('.');
}

function gatewayLinux() {
  let text;
  try {
    text = fs.readFileSync('/proc/net/route', 'utf8');
  } catch {
    return null;
  }

  for (const zeile of text.split('\n').slice(1)) {
    const spalten = zeile.trim().split(/\s+/);
    if (spalten.length < 3) continue;
    const [, ziel, gw] = spalten;
    if (ziel === '00000000' && gw && gw !== '00000000') {
      const ip = hexZuIp(gw);
      if (ip) return ip;
    }
  }
  return null;
}

function gatewayUeberBefehl() {
  // macOS/BSD: `route -n get default` gibt eine Zeile "gateway: x.x.x.x".
  try {
    const out = execFileSync('route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 2000 });
    for (const zeile of out.split('\n')) {
      const i = zeile.indexOf('gateway:');
      if (i !== -1) {
        const wert = zeile.slice(i + 'gateway:'.length).trim();
        if (wert) return wert;
      }
    }
  } catch {
    // weiter mit netstat
  }

  // Sonst `netstat -rn`: eine Zeile, deren erste Spalte "default" ist,
  // die zweite Spalte ist das Gateway.
  try {
    const out = execFileSync('netstat', ['-rn'], { encoding: 'utf8', timeout: 2000 });
    for (const zeile of out.split('\n')) {
      const spalten = zeile.trim().split(/\s+/);
      if (spalten[0] === 'default' && spalten[1]) return spalten[1];
    }
  } catch {
    // weiter mit null
  }
  return null;
}

/** Der Standardrouter dieses Rechners, oder `null` wenn er sich nicht ermitteln liess. */
function gateway() {
  if (process.platform === 'linux') return gatewayLinux();
  return gatewayUeberBefehl();
}

/* --------------------------- UDP-Hin-und-Her --------------------------- */

/** Schickt `message` per UDP, wartet auf genau eine Antwort. `null` bei Frist oder Fehler. */
function udpHinUndZurueck(host, port, message, timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let fertig = false;

    const beenden = (ergebnis) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* schon zu */ }
      resolve(ergebnis);
    };

    const timer = setTimeout(() => beenden(null), timeoutMs);
    if (timer.unref) timer.unref();

    socket.once('error', () => beenden(null));
    socket.once('message', (msg) => beenden(msg));
    socket.send(message, port, host, (err) => { if (err) beenden(null); });
  });
}

/* -------------------------------- NAT-PMP -------------------------------- */

function natpmpBuildExternalRequest() {
  return Buffer.from([0, 0]);
}

function natpmpParseExternalResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.readUInt8(0) !== 0) return null;      // Version
  if (buf.readUInt8(1) !== 128) return null;    // Opcode 0, geantwortet als 0+128
  if (buf.readUInt16BE(2) !== 0) return null;   // Ergebnis: nur 0 heisst gelungen
  const epoch = buf.readUInt32BE(4);
  const ip = `${buf[8]}.${buf[9]}.${buf[10]}.${buf[11]}`;
  return { epoch, ip };
}

function natpmpBuildMapRequest({ protocol, internalPort, externalPort = 0, lifetime }) {
  const op = protocol === 'udp' ? 1 : 2;
  const buf = Buffer.alloc(12);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(op, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(externalPort, 6);
  buf.writeUInt32BE(lifetime, 8);
  return buf;
}

function natpmpParseMapResponse(buf, { protocol }) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.readUInt8(0) !== 0) return null;
  const erwarteterOp = (protocol === 'udp' ? 1 : 2) + 128;
  if (buf.readUInt8(1) !== erwarteterOp) return null;
  if (buf.readUInt16BE(2) !== 0) return null;
  const epoch = buf.readUInt32BE(4);
  const internalPort = buf.readUInt16BE(8);
  const externalPort = buf.readUInt16BE(10);
  const lifetime = buf.readUInt32BE(12);
  return { epoch, internalPort, externalPort, lifetime };
}

async function versuchNatPmp(gw, { protocol, port, lifetime }) {
  const extBuf = await udpHinUndZurueck(gw, GATEWAY_PORT, natpmpBuildExternalRequest(), TRY_TIMEOUT_MS);
  if (!extBuf) return null;
  const ext = natpmpParseExternalResponse(extBuf);
  if (!ext) return null;

  async function anfordern(externalPortWunsch, dauer) {
    const buf = await udpHinUndZurueck(
      gw, GATEWAY_PORT,
      natpmpBuildMapRequest({ protocol, internalPort: port, externalPort: externalPortWunsch, lifetime: dauer }),
      TRY_TIMEOUT_MS
    );
    return buf ? natpmpParseMapResponse(buf, { protocol }) : null;
  }

  const zugesagt = await anfordern(0, lifetime);
  if (!zugesagt) return null;

  return {
    method: 'natpmp',
    external: { host: ext.ip, port: zugesagt.externalPort },

    async renew() {
      const neu = await anfordern(zugesagt.externalPort, lifetime);
      if (!neu) return null;
      return { external: { host: ext.ip, port: neu.externalPort } };
    },

    async release() {
      // Dauer 0 heisst "zurueckgeben" - laut RFC dasselbe Verfahren wie
      // das Anlegen, nur mit einer Lebenszeit von null Sekunden.
      await anfordern(zugesagt.externalPort, 0);
    }
  };
}

/* ---------------------------------- PCP ---------------------------------- */

const PCP_VERSION = 2;
const PCP_OP_MAP = 1;

/** 10 Nullbytes, zwei 0xff, dann die vier Bytes der IPv4-Adresse. */
function ipv4AlsAbgebildetesIpv6(ipv4) {
  const teile = String(ipv4).split('.').map(Number);
  if (teile.length !== 4 || teile.some((t) => !Number.isInteger(t) || t < 0 || t > 255)) return null;
  const buf = Buffer.alloc(16);
  buf[10] = 0xff;
  buf[11] = 0xff;
  buf[12] = teile[0]; buf[13] = teile[1]; buf[14] = teile[2]; buf[15] = teile[3];
  return buf;
}

/** Nimmt die letzten vier Bytes - unabhaengig davon, was genau davorsteht. */
function abgebildetesIpv6AlsIpv4(buf) {
  return `${buf[buf.length - 4]}.${buf[buf.length - 3]}.${buf[buf.length - 2]}.${buf[buf.length - 1]}`;
}

function pcpBuildMapRequest({ protocol, internalPort, externalPort = 0, lifetime, clientIp, nonce }) {
  const buf = Buffer.alloc(60);
  buf.writeUInt8(PCP_VERSION, 0);
  buf.writeUInt8(PCP_OP_MAP, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(lifetime, 4);
  (ipv4AlsAbgebildetesIpv6(clientIp) || Buffer.alloc(16)).copy(buf, 8);
  nonce.copy(buf, 24);
  buf.writeUInt8(protocol === 'udp' ? 17 : 6, 36);   // IANA-Protokollnummer
  buf.writeUInt16BE(internalPort, 40);
  buf.writeUInt16BE(externalPort, 42);
  // Byte 44..59 (aussen-ip): 0 = "irgendeine", bleibt beim Alloc auf null.
  return buf;
}

function pcpParseMapResponse(buf, { nonce } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 60) return null;
  if (buf.readUInt8(0) !== PCP_VERSION) return null;
  if (buf.readUInt8(1) !== (PCP_OP_MAP | 128)) return null;
  if (buf.readUInt8(3) !== 0) return null;   // Ergebnis: nur 0 heisst gelungen
  if (nonce && !buf.subarray(24, 36).equals(nonce)) return null;

  const lifetime = buf.readUInt32BE(4);
  const externalPort = buf.readUInt16BE(42);
  const externalIp = abgebildetesIpv6AlsIpv4(buf.subarray(44, 60));
  return { lifetime, externalPort, externalIp };
}

function lokaleIpv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

async function versuchPcp(gw, { protocol, port, lifetime }) {
  const nonce = crypto.randomBytes(12);
  const clientIp = lokaleIpv4();

  async function anfordern(dauer, externalPortWunsch) {
    const req = pcpBuildMapRequest({ protocol, internalPort: port, externalPort: externalPortWunsch, lifetime: dauer, clientIp, nonce });
    const buf = await udpHinUndZurueck(gw, GATEWAY_PORT, req, TRY_TIMEOUT_MS);
    return buf ? pcpParseMapResponse(buf, { nonce }) : null;
  }

  const zugesagt = await anfordern(lifetime, 0);
  if (!zugesagt) return null;

  return {
    method: 'pcp',
    external: { host: zugesagt.externalIp, port: zugesagt.externalPort },

    async renew() {
      const neu = await anfordern(lifetime, zugesagt.externalPort);
      if (!neu) return null;
      return { external: { host: neu.externalIp, port: neu.externalPort } };
    },

    async release() {
      await anfordern(0, zugesagt.externalPort);
    }
  };
}

/* --------------------------------- UPnP-IGD --------------------------------- */

/**
 * Schneidet den Inhalt des ersten Elements mit diesem Namen heraus.
 * Bewusst anspruchslos: kein Namensraum, keine Verschachtelung, kein
 * Escaping - das reicht fuer die schmale Menge an Antworten, die ein
 * Heimrouter hier schickt. Alles Unerwartete (fehlendes Schlusstag,
 * kaputtes Dokument) ergibt `null` statt eines geratenen Treffers; ein
 * richtiger XML-Parser waere hier ein Fremdpaket fuer einen einzigen,
 * schmalen Zweck.
 */
function extractTag(xml, tag) {
  if (typeof xml !== 'string') return null;
  const openAt = xml.indexOf(`<${tag}`);
  if (openAt === -1) return null;
  const openEnd = xml.indexOf('>', openAt);
  if (openEnd === -1) return null;
  if (xml[openEnd - 1] === '/') return '';   // selbstschliessend, kein Inhalt
  const closeTag = `</${tag}>`;
  const closeAt = xml.indexOf(closeTag, openEnd);
  if (closeAt === -1) return null;
  return xml.slice(openEnd + 1, closeAt).trim();
}

const IGD_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

/** Findet den ersten Dienst vom gesuchten Typ und dessen controlURL, oder `null`. */
function findControlUrl(xml, { types = IGD_SERVICE_TYPES } = {}) {
  if (typeof xml !== 'string') return null;

  let ab = 0;
  for (;;) {
    const start = xml.indexOf('<service>', ab);
    if (start === -1) return null;
    const end = xml.indexOf('</service>', start);
    if (end === -1) return null;   // kaputtes Dokument - kein Rateversuch

    const block = xml.slice(start, end + '</service>'.length);
    ab = end + 1;

    const serviceType = extractTag(block, 'serviceType');
    if (serviceType && types.includes(serviceType)) {
      const controlUrl = extractTag(block, 'controlURL');
      return controlUrl ? { controlUrl, serviceType } : null;
    }
  }
}

function loeseUrlAuf(basis, pfadOderUrl) {
  try {
    return new URL(pfadOderUrl, basis).toString();
  } catch {
    return null;
  }
}

function extractLocation(ssdpText) {
  for (const roh of ssdpText.split('\r\n')) {
    const zeile = roh.trim();
    const i = zeile.indexOf(':');
    if (i === -1) continue;
    if (zeile.slice(0, i).trim().toLowerCase() === 'location') return zeile.slice(i + 1).trim();
  }
  return null;
}

function ssdpSuche(timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const orte = new Set();

    const nachricht = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n'
      + `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n`
      + 'MAN: "ssdp:discover"\r\n'
      + 'MX: 2\r\n'
      + 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n'
      + '\r\n',
      'utf8'
    );

    const beenden = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* schon zu */ }
      resolve([...orte]);
    };
    const timer = setTimeout(beenden, timeoutMs);
    if (timer.unref) timer.unref();

    socket.on('message', (buf) => {
      const ort = extractLocation(buf.toString('utf8'));
      if (ort) orte.add(ort);
    });
    socket.once('error', beenden);
    socket.bind(0, () => {
      socket.send(nachricht, SSDP_PORT, SSDP_ADDR, (err) => { if (err) beenden(); });
    });
  });
}

function httpHolen(urlText, timeoutMs) {
  return new Promise((resolve) => {
    let ziel;
    try { ziel = new URL(urlText); } catch { resolve(null); return; }

    const req = http.get(ziel, (res) => {
      const teile = [];
      res.on('data', (t) => teile.push(t));
      res.on('end', () => resolve(Buffer.concat(teile).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function soapEinschlag(serviceType, action, argsXml) {
  return '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
    + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${argsXml}</u:${action}></s:Body></s:Envelope>`;
}

function soapSchicken(controlUrl, serviceType, action, argsXml, timeoutMs) {
  return new Promise((resolve) => {
    let ziel;
    try { ziel = new URL(controlUrl); } catch { resolve(null); return; }

    const body = soapEinschlag(serviceType, action, argsXml);
    const req = http.request(ziel, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        SOAPACTION: `"${serviceType}#${action}"`
      }
    }, (res) => {
      const teile = [];
      res.on('data', (t) => teile.push(t));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(teile).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function versuchUpnp({ protocol, port, lifetime }) {
  const orte = await ssdpSuche(TRY_TIMEOUT_MS);

  for (const ort of orte) {
    const beschreibung = await httpHolen(ort, TRY_TIMEOUT_MS);
    if (!beschreibung) continue;

    const gefunden = findControlUrl(beschreibung);
    if (!gefunden) continue;

    const controlUrl = loeseUrlAuf(ort, gefunden.controlUrl);
    if (!controlUrl) continue;
    const { serviceType } = gefunden;
    const innenIp = lokaleIpv4();

    const mapArgs =
      '<NewRemoteHost></NewRemoteHost>'
      + `<NewExternalPort>${port}</NewExternalPort>`
      + `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>`
      + `<NewInternalPort>${port}</NewInternalPort>`
      + `<NewInternalClient>${innenIp}</NewInternalClient>`
      + '<NewEnabled>1</NewEnabled>'
      + '<NewPortMappingDescription>snapkey</NewPortMappingDescription>'
      + `<NewLeaseDuration>${lifetime}</NewLeaseDuration>`;

    const delArgs =
      '<NewRemoteHost></NewRemoteHost>'
      + `<NewExternalPort>${port}</NewExternalPort>`
      + `<NewProtocol>${protocol.toUpperCase()}</NewProtocol>`;

    const antwort = await soapSchicken(controlUrl, serviceType, 'AddPortMapping', mapArgs, TRY_TIMEOUT_MS);
    if (!antwort || antwort.status >= 300) continue;

    const ipAntwort = await soapSchicken(controlUrl, serviceType, 'GetExternalIPAddress', '', TRY_TIMEOUT_MS);
    const externalIp = ipAntwort && ipAntwort.status < 300 ? extractTag(ipAntwort.body, 'NewExternalIPAddress') : null;

    return {
      method: 'upnp',
      external: { host: externalIp, port },

      async renew() {
        const r = await soapSchicken(controlUrl, serviceType, 'AddPortMapping', mapArgs, TRY_TIMEOUT_MS);
        if (!r || r.status >= 300) return null;
        return { external: { host: externalIp, port } };
      },

      async release() {
        await soapSchicken(controlUrl, serviceType, 'DeletePortMapping', delArgs, TRY_TIMEOUT_MS);
      }
    };
  }
  return null;
}

/* ------------------------------- Das Tor ------------------------------- */

/**
 * Umhuellt das Ergebnis eines Verfahrens mit dem Erneuerungs-Wecker:
 * bei der Haelfte der Laufzeit wird nachgefragt, ob der Router die
 * Freigabe noch mag. `onEvent` bekommt `renewed` bei Erfolg, `lost`
 * wenn der Router nicht mehr mitspielt - danach wird nicht weiter
 * versucht, die Freigabe gilt als weg.
 */
function mitErneuerung(ergebnis, { lifetime, onEvent }) {
  let external = ergebnis.external;
  let timer = null;
  let vorbei = false;

  const einplanen = () => {
    if (vorbei) return;
    const ms = Math.max(1000, Math.floor((lifetime * 1000) / 2));
    timer = setTimeout(tick, ms);
    if (timer.unref) timer.unref();
  };

  async function tick() {
    if (vorbei) return;
    let neu;
    try {
      neu = await ergebnis.renew();
    } catch {
      neu = null;
    }
    if (!neu) {
      vorbei = true;
      onEvent({ type: 'lost', method: ergebnis.method });
      return;
    }
    external = neu.external;
    onEvent({ type: 'renewed', external, method: ergebnis.method });
    einplanen();
  }

  einplanen();

  return {
    get external() { return external; },
    method: ergebnis.method,

    renew: tick,

    async release() {
      vorbei = true;
      clearTimeout(timer);
      try {
        await ergebnis.release();
      } catch {
        // Der Router antwortet nicht mehr - release() soll trotzdem
        // zurueckkehren, nicht ewig warten oder werfen.
      }
    }
  };
}

/**
 * Bittet den Standardrouter um eine Portfreigabe. Probiert NAT-PMP,
 * dann PCP, dann UPnP - beim ersten Erfolg wird abgebrochen. `null`
 * heisst: keins der drei Verfahren hat geklappt. Das ist in vielen
 * Netzen der Normalfall (abgeschaltet, oder eine geteilte Adresse ohne
 * eigenen Port) und kein Fehler - `open` wirft nie und haengt nie.
 *
 * `gateway` (optional) ueberschreibt die automatische Suche nach dem
 * Standardrouter - vor allem fuer Pruefungen mit einem nachgemachten
 * Router auf `127.0.0.1`.
 */
async function open({ port, protocol = 'tcp', lifetime = DEFAULT_LIFETIME, onEvent = () => {}, gateway: gatewayUeberschrieben } = {}) {
  if (!port) return null;

  const gw = gatewayUeberschrieben || gateway();
  if (!gw) return null;

  const versuche = [
    () => versuchNatPmp(gw, { protocol, port, lifetime }),
    () => versuchPcp(gw, { protocol, port, lifetime }),
    () => versuchUpnp({ protocol, port, lifetime })
  ];

  for (const versuch of versuche) {
    let ergebnis;
    try {
      ergebnis = await versuch();
    } catch {
      ergebnis = null;
    }
    if (ergebnis) {
      onEvent({ type: 'mapped', external: ergebnis.external, method: ergebnis.method });
      return mitErneuerung(ergebnis, { lifetime, onEvent });
    }
  }
  return null;
}

module.exports = {
  GATEWAY_PORT,
  DEFAULT_LIFETIME,
  gateway,
  open,

  // Reine Nachrichtenfunktionen und die XML-Hilfe - fuer Pruefungen
  // ohne echten Router.
  natpmp: {
    buildExternalRequest: natpmpBuildExternalRequest,
    parseExternalResponse: natpmpParseExternalResponse,
    buildMapRequest: natpmpBuildMapRequest,
    parseMapResponse: natpmpParseMapResponse
  },
  pcp: {
    buildMapRequest: pcpBuildMapRequest,
    parseMapResponse: pcpParseMapResponse
  },
  upnp: {
    extractTag,
    findControlUrl
  }
};
