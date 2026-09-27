// src/main/mc-ping.js
// Minecraft-Server-Ping (Server List Ping) —ohne Minecraft, ohne Fenster.
//
// Ablauf (Vanilla-Protokoll, "Status"-Zustand):
//   1. TCP verbinden
//   2. Handshake-Paket  (VarInt 0x00): Protokollversion, Adresse, Port, next_state=1
//   3. Status-Request   (VarInt 0x00): leer
//   4. Status-Response  (VarInt 0x00): ein JSON-String
//   5. Ping             (VarInt 0x01) + Long  -> Pong (VarInt 0x01) + Long
// Schritt 5 misst die Laufzeit. Manche Server ignorieren den Pong; das ist kein
// Fehler, dann bleibt die Latenz unbekannt.
//
// WICHTIG: Alles, was hier herauskommt, kommt von einem fremden Server. Es wird
// deshalb in diesem Modul schon entschärft und nicht erst im Renderer:
//   - die Antwort darf höchstens MAX_JSON_BYTES groß sein
//   - die MOTD wird zu reinem Text flachgezogen (keine HTML-Interpretation
//     irgendwo, auch nicht in diesem Modul) und auf MAX_MOTD_CHARS gekürzt
//   - das Favicon muss wirklich ein PNG sein, sonst fliegt es raus
//   - Verschachtelungstiefe und Komponentenzahl der MOTD sind begrenzt, damit
//     ein Server mit einem 10.000 Ebenen tiefen Chat-Baum nicht den Haupt-
//     Prozess blockiert
// Der Renderer bekommt ausschliesslich Strings und Zahlen.

const net = require('node:net');
const dns = require('node:dns').promises;

// Standard-Zeitlimits. Bewusst krumm: der Vanilla-Client wartet 30 s, das ist
// bei einer Liste mit vielen Servern furchtbar. 5 s reicht für die allermeisten
// Fälle, auch über Mobilfunk.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 1024 * 1024;   // 1 MB — echte Antworten sind wenige kB
const MAX_MOTD_CHARS = 600;
const MAX_MOTD_DEPTH = 12;
const MAX_MOTD_NODES = 300;
const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_SAMPLE_NAMES = 5;
const MAX_NAME_CHARS = 16;

// Vanilla übersetzt diese wenigen Chat-Schlüssel, wenn eine MOTD sie benutzt.
// Zeigt man stattdessen nur den Schlüssel, sieht die Zeile so aus:
// "multiplayer.status.ping.start 12ms" — das ist die Raw-Version dessen, was
// der Spieler sieht.
const TRANSLATIONS = {
  'multiplayer.status.ping.start': 'Ping:',
  'multiplayer.status.cannot_connect': 'Keine Verbindung möglich',
  'multiplayer.disconnect.genericReason': 'Verbindung geschlossen',
  'multiplayer.disconnect.kicked': 'Du wurdest getrennt',
  'multiplayer.disconnect.serverShutdown': 'Der Server fährt herunter',
  'multiplayer.disconnect.notWhitelisted': 'Du stehst nicht auf der Whitelist',
  'multiplayer.disconnect.banned': 'Du bist gesperrt',
  'multiplayer.disconnect.serverFull': 'Der Server ist voll',
  'multiplayer.status.playerCount': '%s von %s Spielern',
  'chat.type.text': '<%s> %s',
  'multiplayer.player.joined': '%s ist beigetreten',
  'multiplayer.player.left': '%s hat den Server verlassen'
};

// Farbcodes entfernen. §a (grün) und so weiter sind für eine einzeilige
// Launcher-Liste irrelevant und im Renderer nur über HTML machbar — was wir
// ausdrücklich nicht tun. Also fliegen sie raus, statt als Buchstaben dastehenzu.
// Die Hex-Form seit 1.16 besteht aus §x§R§R§G§G§B§B und muss als EIN Code
// entfernt werden, sonst bliebe "x1122FF" im Text stehen.
const SECTION_CODES = /§(?:[0-9A-FK-ORa-fk-or]|x(?:§[0-9A-Fa-f]){6})/g;
// Steuerzeichen ausser Tab (U+0009) und Zeilenumbruch (U+000A). Ein Server
// darf keine NUL-Bytes in seine MOTD schreiben, und ein ESC (U+001B) im Text
// kann in manchen Terminals Zeichensequenzen auslösen.
// Die Escape-Schreibweise ist hier nicht Kosmetik: als echte Bytes in der
// Datei steckt ein NUL-Byte in der Quelldatei, und das überlebt kein
// Werkzeug sauber.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// U+200B..U+200F (Zero-Width und bidi-Steuerzeichen) sowie U+2028/U+2029
// (Zeilen-/Absatztrenner) sind unsichtbar, verändern aber Höhe und Richtung
// des Textes. Auch die fliegen raus.
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\uFEFF]/g;

/** §-Codes, Steuerzeichen und Unsichtbares aus einem Textstück entfernen. */
function stripCodes(text) {
  return String(text)
    .replace(SECTION_CODES, '')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE, '');
}

/**
 * Chat-Komponente zu reinem Text flachziehen.
 *
 * Der `description`-Wert einer Status-Antwort ist KEIN String, sondern ein
 * Chat-Baum. Die Formen, die real vorkommen:
 *   "text"                            (Server ohne Chat-Baum, mit §-Codes)
 *   { "text": "…", "extra": [ … ] }   (üblich)
 *   { "translate": "multiplayer.…" }   (mit "with": [ … ])
 *   { "": "…" }                        (sehr alte, flache Form)
 *   [ "a", { … }, "b" ]                (flache Liste)
 *
 * @returns {string} reiner Text, niemals HTML
 */
function flattenMotd(node, out, depth = 0) {
  // Drei Grenzen — und alle drei MÜSSEN als "gekuerzt" gemeldet werden.
  // Die Längengrenze ist der tückische Fall: bricht man dort still ab, hat
  // man den Rest der MOTD weggeworfen, ohne es zu sagen. Der Anzeiger meldet
  // dann eine vollstaendige MOTD, die es nicht ist. Genau das ist hier
  // passiert (599 Zeichen, truncated: false, 4400 Komponenten nie gelesen).
  if (out.text.length >= MAX_MOTD_CHARS) {
    out.truncated = true;
    return;
  }
  if (out.nodes >= MAX_MOTD_NODES) {
    out.truncated = true;
    return;
  }
  if (depth > MAX_MOTD_DEPTH) {
    out.truncated = true;
    return;
  }
  out.nodes++;

  if (node === null || node === undefined) return;

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.text += stripCodes(node);
    return;
  }

  if (Array.isArray(node)) {
    for (const kind of node) flattenMotd(kind, out, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  // Alte flache Form: { "": "…" } — der Schlüssel ist der Text selbst.
  if (typeof node[''] === 'string') {
    out.text += stripCodes(node['']);
    return;
  }

  // text darf auch eine Zahl oder ein Boolean sein. Sichtbare Server
  // benutzen das (z.B. {"text": 42}), und es wäre widersinnig, genau die
  // Form zu verschlucken, die man im Array-Zweig oben sehr wohl akzeptiert.
  if (typeof node.text === 'string' || typeof node.text === 'number' || typeof node.text === 'boolean') {
    out.text += stripCodes(node.text);
  }

  if (typeof node.translate === 'string') {
    const schluessel = node.translate;
    out.text += stripCodes(TRANSLATIONS[schluessel] || schluessel);
    if (Array.isArray(node.with)) {
      for (const arg of node.with) {
        out.text += ' ';
        flattenMotd(arg, out, depth + 1);
      }
    }
  }

  if (typeof node.selector === 'string') out.text += stripCodes(node.selector);

  if (Array.isArray(node.extra)) {
    for (const kind of node.extra) flattenMotd(kind, out, depth + 1);
  }

  if (out.text.length > MAX_MOTD_CHARS) {
    out.text = out.text.slice(0, MAX_MOTD_CHARS);
    out.truncated = true;
  }
}

/** description-Feld zu Text. Fängt jeden unerwarteten Typ ab. */
function motdToText(description) {
  const out = { text: '', nodes: 0, truncated: false };
  try {
    flattenMotd(description, out);
  } catch {
    return { text: '', truncated: true };
  }
  let text = out.text.replace(/[ \t]+/g, ' ').trim();
  // Harte Kappung als letzte Instanz. flattenMotd() bricht zwar an
  // MAX_MOTD_CHARS ab, aber nur in den Zweigen, die danach auch kappen — der
  // Array-Zweig tut das nicht. Hier ist die Grenze damit garantiert, und
  // gleichzeitig wird die Kürzung auch gemeldet.
  if (text.length > MAX_MOTD_CHARS) {
    text = text.slice(0, MAX_MOTD_CHARS).trimEnd();
    out.truncated = true;
  }
  // Die Auslassungspunkte NUR bei vorhandenem Text. Ein Server ohne
  // description liefert eine leere MOTD — das ist kein "gekuerzt", das ist
  // gar nichts, und " …" allein in der Zeile sieht nach einem Fehler aus.
  if (out.truncated && text) text += ' …';
  return { text, truncated: out.truncated };
}

/**
 * Favicon prüfen. Der Server schickt `data:image/png;base64,…`.
 *
 * Geprüft wird mehr als das Präfix: ein <img src="data:text/html,…"> ist zwar
 * harmlos (der Browser führt Daten-URLs in img nicht als Dokument aus), aber
 * `data:image/svg+xml` KANN Skript enthalten, das bei manchen Chromium-Pfaden
 * ausgeführt wird. Deshalb wird ausschliesslich PNG akzeptiert und zusätzlich
 * die PNG-Magic geprüft — dann kann niemand eine SVG als PNG deklarieren.
 */
function readFavicon(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const praefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(praefix)) return null;

  const b64 = dataUrl.slice(praefix.length);
  if (!b64 || b64.length > MAX_FAVICON_BYTES) return null;
  // base64 ist 4/3 so gross wie die Rohdaten; diese Grenze greift vor dem
  // Dekodieren und schont den Haupt-Prozess.
  if (b64.length > Math.floor(MAX_FAVICON_BYTES * 4 / 3) + 4) return null;

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  // Buffer.from wirft bei ungültigem base64 nicht, sondern verwirft die
  // Ungültigkeit. Deshalb gegenprüfen: die dekodierte Länge muss zu einer
  // base64-Laenge passen.
  if (buf.length < 8 || b64.length / 4 < buf.length / 3 - 1) return null;
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;

  return {
    dataUrl: praefix + buf.toString('base64'),
    bytes: buf.length
  };
}

// ==================== VarInt / Paket-Bausteine ====================

/** VarInt schreiben (7 Bit pro Byte, Fortsetzungsbit oben). */
function writeVarInt(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

/** VarInt-Länge in Bytes. */
function varIntSize(value) {
  let n = 0;
  let rest = value >>> 0;
  do { rest >>>= 7; n++; } while (rest !== 0);
  return n;
}

/** Minecraft-String: VarInt-Byte-Länge + UTF-8. */
function writeString(str) {
  const bytes = Buffer.from(str, 'utf-8');
  return Buffer.concat([writeVarInt(bytes.length), bytes]);
}

/** Paket: VarInt-Länge + Paket-ID + Nutzlast. */
function frame(packetId, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([writeVarInt(packetId), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Liest Pakete aus einem Strom und löst resolve/reject ein. */
class PacketReader {
  constructor(onPacket) {
    this.buf = Buffer.alloc(0);
    this.onPacket = onPacket;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.drain();
  }

  drain() {
    for (;;) {
      // Erst die Längen-VarInt lesen. Sie ist maximal 5 Bytes lang.
      let len = 0, shift = 0, i = 0;
      for (; i < 5; i++) {
        if (i >= this.buf.length) return;          // noch nicht genug Bytes
        const byte = this.buf[i];
        len |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) { i++; break; }
        shift += 7;
      }
      if (i >= this.buf.length) return;
      if (len > MAX_JSON_BYTES) throw new Error('Paket zu groß (max. 1 MB).');

      const start = i;
      if (this.buf.length < start + len) return;   // Paket noch unvollständig

      const packet = this.buf.subarray(start, start + len);
      this.buf = this.buf.subarray(start + len);

      const [id, off] = readVarInt(packet, 0);
      this.onPacket(id, packet.subarray(off), packet);
    }
  }
}

/** VarInt aus einem Buffer lesen. Gibt [wert, offsetDanach] zurück. */
function readVarInt(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) throw new Error('VarInt abgeschnitten.');
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, pos];
    shift += 7;
  }
  throw new Error('VarInt länger als 5 Bytes.');
}

// ==================== Adresse ====================

/**
 * "host:port" zerlegen. Es gibt vier Formen, alle kommen in der Praxis vor:
 *   play.example.net:25565   normal
 *   example.net              Port weglassen -> 25565
 *   1.2.3.4:25565            IPv4
 *   [2001:db8::1]:25565      IPv6 — die Klammern sind Pflicht, sonst ist das
 *                            Doppelpunkt mehrdeutig
 */
function parseAddress(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Server-Adresse fehlt.');
  if (raw.length > 300) throw new Error('Server-Adresse ist zu lang.');
  // Whitespace im Hostnamen macht nur Aerger und ist nie gueltig.
  if (/\s/.test(raw)) throw new Error('Server-Adresse darf kein Leerzeichen enthalten.');

  let host;
  let port = 25565;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) throw new Error('IPv6-Adresse: fehlende schließende Klammer ].');
    host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest) {
      if (rest[0] !== ':') throw new Error('IPv6-Adresse: hinter ] kommt nur :port.');
      port = Number(rest.slice(1));
    }
  } else {
    const lastColon = raw.lastIndexOf(':');
    const colons = (raw.match(/:/g) || []).length;
    if (colons === 1) {
      host = raw.slice(0, lastColon);
      port = Number(raw.slice(lastColon + 1));
    } else if (colons === 0) {
      host = raw;
    } else {
      // Mehrere Doppelpunkte ohne Klammern = nackte IPv6-Adresse.
      host = raw;
    }
  }

  if (!host) throw new Error('Server-Adresse enthält keinen Hostnamen.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Ungültiger Port: ${raw.slice(-8)}`);
  }
  // viaSrv steht hier schon drin, damit der Rückgabewert dieselbe Form hat,
  // egal ob die SRV-Auflösung danach noch läuft oder übersprungen wird.
  return { host, port, viaSrv: false };
}

/**
 * Adresse in die Form bringen, die das Spiel beim Mehrspieler-Beitritt will.
 *
 * Der Benutzer tippt im Mehrspieler-Menü "example.net" und lässt den Port
 * weg. Für den Pinger ist das kein Problem, für --quickPlayMultiplayer aber
 * schon: das Argument geht unverändert an das Spiel, und ein leerer Port ist
 * dort ein gültiger Wert mit der Folge, dass die Verbindung ins Leere läuft.
 * Deshalb wird der Port hier immer ausgeschrieben.
 *
 * Bei IPv6 sind die Klammern Pflicht, weil der Doppelpunkt sonst als
 * Trennzeichen zum Port gelesen wird.
 *
 * @throws {Error} wenn die Adresse nicht parsebar ist (dann: kein Start)
 */
function formatAddress(input) {
  const { host, port } = parseAddress(input);
  if (host.includes(':')) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

/**
 * SRV-Auflösung, genau wie Vanilla: nur beim Standardport, und der SRV-Name
 * ist _minecraft._tcp.<host>. Fehlt der Record, wird der Host direkt benutzt.
 * Der Aufruf ist in ein eigenes Promise mit Timeout gepackt, weil ein
 * DNS-Server, der nicht antwortet, den ganzen Auflistvorgang blockieren würde.
 */
async function resolveSrv(host, port) {
  if (port !== 25565) return { host, port, viaSrv: false };
  let records;
  try {
    records = await Promise.race([
      dns.resolveSrv(`_minecraft._tcp.${host}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS-Timeout')), 2000))
    ]);
  } catch {
    return { host, port, viaSrv: false };   // kein SRV ist der Normalfall
  }
  if (!Array.isArray(records) || records.length === 0) return { host, port, viaSrv: false };
  // Ganz am Anfang: Eintraege mit Gewicht 0 sind "kein Service" und
  // gehoeren uebersprungen.
  // übersprungen.
  const brauchbar = records.filter(r => (r.weight || 0) > 0);
  const auswahl = (brauchbar.length ? brauchbar : records)
    .slice()
    .sort((a, b) => (a.weight || 0) - (b.weight || 0))[0];
  if (!auswahl || !auswahl.name) return { host, port, viaSrv: false };
  return {
    host: auswahl.name.replace(/\.$/, ''),
    port: auswahl.port || 25565,
    viaSrv: true
  };
}

// ==================== Der Ping selbst ====================

/**
 * Einen Server abfragen.
 *
 * @param {string} address  "host", "host:port" oder "[ipv6]:port"
 * @param {object} [opts]
 * @param {number} [opts.timeout=5000]   Zeitlimit in ms (max. 15000)
 * @param {boolean} [opts.resolveSrv=true]
 * @returns {Promise<object>} immer mit `online: boolean`; nie wirft
 */
async function pingServer(address, opts = {}) {
  const timeout = Math.min(Math.max(Number(opts.timeout) || DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS);
  const eingabe = (() => {
    try { return String(address || '').trim(); }
    catch { return ''; }
  })();

  const fehler = (grund, code) => ({
    online: false,
    address: eingabe,
    error: grund,
    errorCode: code || 'unreachable',
    latencyMs: null,
    motd: '',
    motdTruncated: false,
    version: null,
    protocol: null,
    players: null,
    sample: [],
    faviconDataUrl: null,
    faviconBytes: null,
    resolvedHost: null,
    resolvedPort: null,
    viaSrv: false
  });

  let ziel;
  try {
    ziel = parseAddress(eingabe);
    if (opts.resolveSrv !== false) ziel = await resolveSrv(ziel.host, ziel.port);
  } catch (err) {
    const klare = /Adresse|Port|Leerzeichen|Klammern|IPv6/.test(err.message)
      ? err.message
      : `Adresse ungültig: ${err.message}`;
    return fehler(klare, 'bad-address');
  }

  let roh;
  try {
    roh = await handshakeAndStatus(ziel, timeout);
  } catch (err) {
    return fehler(fuerMenschen(err), err.code || 'unreachable');
  }

  // ---- JSON auswerten ------------------------------------------------
  // roh ist { latencyMs, json } — der String steckt in .json.
  let daten;
  try {
    daten = JSON.parse(roh.json);
  } catch {
    return fehler('Antwort ist kein gültiges JSON.', 'bad-json');
  }
  if (!daten || typeof daten !== 'object') {
    return fehler('Antwort enthält kein JSON-Objekt.', 'bad-json');
  }

  const motd = motdToText(daten.description);
  const version = daten.version && typeof daten.version === 'object'
    ? {
        name: typeof daten.version.name === 'string' ? stripCodes(daten.version.name).slice(0, 60) : '',
        protocol: Number.isInteger(daten.version.protocol) ? daten.version.protocol : null
      }
    : null;

  // Spielerzahlen. Ein Server kann hier beliebige Zahlen schicken, auch
  // negative oder NaN — deshalb einzeln prüfen statt nur Number() zu nehmen.
  const zahlOderNull = (v) => (Number.isInteger(v) && v >= 0 && v <= 1000000 ? v : null);
  const players = daten.players && typeof daten.players === 'object'
    ? {
        online: zahlOderNull(daten.players.online),
        max: zahlOderNull(daten.players.max)
      }
    : null;

  const sample = [];
  if (daten.players && Array.isArray(daten.players.sample)) {
    for (const eintrag of daten.players.sample) {
      if (sample.length >= MAX_SAMPLE_NAMES) break;
      if (eintrag && typeof eintrag === 'object' && typeof eintrag.name === 'string') {
        sample.push(stripCodes(eintrag.name).slice(0, MAX_NAME_CHARS));
      }
    }
  }

  const favicon = readFavicon(daten.favicon);

  return {
    online: true,
    address: eingabe,
    error: null,
    errorCode: null,
    latencyMs: roh.latencyMs,
    motd: motd.text,
    motdTruncated: motd.truncated,
    version,
    protocol: version ? version.protocol : null,
    players,
    sample,
    faviconDataUrl: favicon ? favicon.dataUrl : null,
    faviconBytes: favicon ? favicon.bytes : null,
    resolvedHost: ziel.host,
    resolvedPort: ziel.port,
    viaSrv: ziel.viaSrv
  };
}

/** Fehlermeldung so formulieren, dass sie beim Tippen hilft. */
function fuerMenschen(err) {
  switch (err.code) {
    case 'ECONNREFUSED': return 'Verbindung abgelehnt — auf dieser Adresse läuft kein Server.';
    case 'ENOTFOUND':    return 'Hostname nicht gefunden — Tippfehler?';
    case 'EAI_AGAIN':     return 'DNS antwortet gerade nicht.';
    case 'ETIMEDOUT':     return 'Zeitüberschreitung — der Server antwortet nicht.';
    case 'ECONNRESET':    return 'Verbindung vom Server abgerissen.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':   return 'Netzwerk nicht erreichbar.';
    case 'EACCES':        return 'Zugriff verweigert (Firewall?).';
    default:              return err.message || 'Server nicht erreichbar.';
  }
}

/** Verbindung aufbauen, Handshake, Status holen, Latenz messen. */
function handshakeAndStatus(ziel, timeout) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let erledigt = false;
    let antwort = null;
    let latency = null;
    let messBeginn = 0;

    const fertig = (fn, wert) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      fn(wert);
    };

    const timer = setTimeout(() => {
      const e = new Error('Zeitüberschreitung — der Server antwortet nicht.');
      e.code = 'ETIMEDOUT';
      fertig(reject, e);
    }, timeout);

    const reader = new PacketReader((id, nutzlast) => {
      try {
        if (id === 0x00 && antwort === null) {
          // Status-Response: ein einzelner String.
          const [laenge, off] = readVarInt(nutzlast, 0);
          if (laenge > MAX_JSON_BYTES) throw Object.assign(new Error('Antwort zu groß.'), { code: 'EPROTO' });
          if (nutzlast.length < off + laenge) throw Object.assign(new Error('Antwort abgeschnitten.'), { code: 'EPROTO' });
          const json = nutzlast.subarray(off, off + laenge).toString('utf-8');
          antwort = json;
          // Jetzt die Latenz messen. Der Vanilla-Server beantwortet den Ping
          // auch nach der Status-Antwort, deshalb geht das auf derselben
          // Verbindung. Manche Server tun es nicht — dann bleibt latency null,
          // das ist kein Fehler.
          messBeginn = process.hrtime.bigint();
          socket.write(frame(0x01, (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(0n); return b; })()));
          return;
        }
        if (id === 0x01) {
          latency = Number(process.hrtime.bigint() - messBeginn) / 1e6;
          if (antwort !== null) fertig(resolve, { latencyMs: Math.round(latency), json: antwort });
          return;
        }
        // Unbekanntes Paket ignorieren: ein Server darf Zusatzpakete schicken
        // (Plugins, Proxys). Wir warten einfach weiter.
      } catch (err) {
        fertig(reject, err);
      }
    });

    try {
      socket = net.connect({ host: ziel.host, port: ziel.port });
    } catch (err) {
      fertig(reject, err);
      return;
    }

    socket.setNoDelay(true);
    socket.on('error', err => fertig(reject, err));
    socket.on('close', () => {
      // Der Server hat die Verbindung geschlossen, ohne zu antworten.
      if (antwort === null) {
        const e = new Error('Verbindung geschlossen, ohne zu antworten.');
        e.code = 'ECONNRESET';
        fertig(reject, e);
      } else {
        // Antwort da, aber kein Pong gekommen. Die Daten sind gut genug.
        fertig(resolve, { latencyMs: null, json: antwort });
      }
    });

    socket.on('data', chunk => {
      try { reader.push(chunk); }
      catch (err) { fertig(reject, err); }
    });

    socket.on('connect', () => {
      const handshake = Buffer.concat([
        writeVarInt(767),              // Protokollversion von 1.21.4
        writeString(ziel.host),        // getHostAddress(): der Name, nicht die IP
        (() => { const p = Buffer.alloc(2); p.writeUInt16BE(ziel.port); return p; })(),
        writeVarInt(1)                 // next_state = 1 (Status)
      ]);
      socket.write(frame(0x00, handshake));
      // Status-Request: leere Nutzlast.
      socket.write(frame(0x00, Buffer.alloc(0)));
    });
  }).then((r) => ({ latencyMs: r.latencyMs, json: r.json }));
}

module.exports = {
  pingServer,
  formatAddress,
  // Exportiert für den Test — die Hilfsfunktionen sind einzeln prüfbar, ohne
  // dafür einen TCP-Server aufzubauen.
  _intern: {
    parseAddress,
    formatAddress,
    resolveSrv,
    writeVarInt,
    varIntSize,
    writeString,
    frame,
    readVarInt,
    flattenMotd,
    motdToText,
    readFavicon,
    stripCodes,
    PacketReader,
    MAX_JSON_BYTES,
    MAX_MOTD_CHARS
  }
};
