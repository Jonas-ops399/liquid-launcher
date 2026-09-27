// test-server-ping.js
//   node test-server-ping.js
//
// Testet den Server-Ping (Server List Ping) — inklusive der Frage, was mit
// Daten passiert, die von einem FREMDEN Server kommen.
//
// Der Test startet dafür echte TCP-Server auf 127.0.0.1, die das Minecraft-
// Protokoll sprechen. Das ist der einzige Weg, die Paketebene wirklich zu
// prüfen: ein Test, der nur `pingServer()` mit einem erfundenen Rückgabewert
// füttert, prüft gar nichts.
//
// Der Schwerpunkt liegt auf dem Nicht-Vertrauenswürdigen. Eine MOTD ist ein
// Chat-Baum aus fremder Quelle, ein Favicon eine Data-URL aus fremder Quelle.
// Beides wird hier mit bewusst kaputten und bewusst hässlichen Werten gefüttert.

const net = require('node:net');
const { pingServer, formatAddress, _intern: P } = require('./src/main/mc-ping');

const problems = [];
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) {
    console.log('  OK   ' + msg);
  } else {
    console.log('  FEHLT ' + msg + (extra ? '  →  ' + extra : ''));
    problems.push(msg);
  }
}
function gleich(a, b, msg) { ok(a === b, msg, `erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)}`); }
function group(title) { console.log('\n--- ' + title + ' ---'); }

// =====================================================================
// Paket-Bausteine für den Fake-Server
// =====================================================================
function varInt(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let b = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) b |= 0x80;
    bytes.push(b);
  } while (rest !== 0);
  return Buffer.from(bytes);
}
function mcString(str) {
  const b = Buffer.from(str, 'utf-8');
  return Buffer.concat([varInt(b.length), b]);
}
function frame(id, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}
function readVarInt(buf, off) {
  let v = 0, shift = 0, pos = off;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v >>> 0, pos];
    shift += 7;
  }
  throw new Error('VarInt zu lang');
}

/** Status-Antwort als Minecraft-String verpacken. */
function statusPacket(json) {
  return frame(0x00, mcString(json));
}

/** Minimal gültiges 1x1-PNG als base64. */
const KLEINES_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Einen TCP-Server starten, der das Status-Protokoll beantwortet.
 *
 * @param {object} opts
 *   antwort        Rückgabe von buildJson(statusRequest) oder ein fertiges JSON
 *   ohnePong       true = auf den Ping nicht reagieren
 *   fruehSchliessen true = Verbindung sofort schliessen, ohne zu antworten
 *   kaputtJson     true = muell statt JSON schicken
 *   ungeheureMenge true = ein 5-MB-Paket schicken
 *   empfaengerLog  sammelt, was der Client gesendet hat
 */
function starteStatusServer(opts = {}) {
  return new Promise((resolve) => {
    const empfangen = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      if (opts.fruehSchliessen) { socket.destroy(); return; }
      let buf = Buffer.alloc(0);
      let antwortGesendet = false;
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 1) return;
          let len, start;
          try { [len, start] = readVarInt(buf, 0); } catch { return; }
          if (buf.length < start + len) return;
          const paket = buf.subarray(start, start + len);
          buf = buf.subarray(start + len);
          const [id, off] = readVarInt(paket, 0);
          empfangen.push({ id, paket: paket.subarray(off) });

          if (id === 0x00 && !antwortGesendet) {
            // Hier ist es ein Handshake ODER der Status-Request. Wir
            // unterscheiden am Inhalt: die Nutzlast des Handshakes ist
            // länger als 0 und beginnt mit einer Protokollversion.
            const nutzlast = paket.subarray(off);
            const istStatusRequest = nutzlast.length === 0;
            if (istStatusRequest) {
              antwortGesendet = true;
              if (opts.kaputtJson) { socket.write(frame(0x00, mcString('kein json {{{'))); continue; }
              if (opts.ungeheureMenge) {
                const riesig = 'x'.repeat(5 * 1024 * 1024);
                socket.write(frame(0x00, mcString(JSON.stringify({ version: { name: 'Riesig', protocol: 767 }, players: { online: 1, max: 2 }, description: riesig }))));
                continue;
              }
              const json = typeof opts.antwort === 'function' ? opts.antwort() : opts.antwort;
              socket.write(statusPacket(JSON.stringify(json)));
            }
            continue;
          }
          if (id === 0x01) {
            if (opts.ohnePong) { socket.destroy(); return; }
            socket.write(frame(0x01, paket.subarray(off)));   // Pong mit gleichem Long
          }
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        empfangen,
        // Wichtig: erst die eigenen Sockets zerstören, dann close().
        // server.close() wartet sonst auf JEDE offene Verbindung, und der
        // Client hat nur seinen eigenen Socket zerstört — der Server-Socket
        // bleibt offen und close() hängt sich endgültig fest.
        // (closeAllConnections() gibt es nur auf http.Server, nicht auf
        // net.Server — deshalb hier von Hand über die eigenen Sockets.)
        schliessen: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        })
      });
    });
  });
}

function standardAntwort() {
  return {
    version: { name: 'Paper 1.21.4', protocol: 767 },
    players: { online: 7, max: 40, sample: [{ name: 'Notch' }, { name: 'Jeb_' }, { name: 'Dinnerbone' }] },
    description: { text: 'Willkommen! ' },
    favicon: 'data:image/png;base64,' + KLEINES_PNG
  };
}

(async () => {
  // ================================================================
  group('Adressen zerlegen');
  // ================================================================
  const paare = [
    ['play.example.net:25565', { host: 'play.example.net', port: 25565 }],
    ['example.net', { host: 'example.net', port: 25565 }],
    ['example.net:1', { host: 'example.net', port: 1 }],
    ['example.net:65535', { host: 'example.net', port: 65535 }],
    ['1.2.3.4:25565', { host: '1.2.3.4', port: 25565 }],
    ['[2001:db8::1]:25577', { host: '2001:db8::1', port: 25577 }],
    ['[::1]', { host: '::1', port: 25565 }],
    ['2001:db8::1', { host: '2001:db8::1', port: 25565 }],
    ['localhost:8080', { host: 'localhost', port: 8080 }]
  ];
  for (const [eingabe, erwartet] of paare) {
    let r = null, fehler = null;
    try { r = P.parseAddress(eingabe); } catch (e) { fehler = e.message; }
    ok(fehler === null && r && r.host === erwartet.host && r.port === erwartet.port,
      `"${eingabe}" -> ${erwartet.host}:${erwartet.port}`,
      fehler ? 'Fehler: ' + fehler : `war ${JSON.stringify(r)}`);
  }
  const boese = ['', '   ', 'host:0', 'host:65536', 'host:abc', 'host:-1', 'a b:25565', '[2001:db8::1', '[2001:db8::1]x', ':25565', 'x'.repeat(400)];
  for (const b of boese) {
    let abgelehnt = false;
    try { P.parseAddress(b); } catch { abgelehnt = true; }
    ok(abgelehnt, `"${b.slice(0, 20)}" wird abgelehnt`);
  }

  // ================================================================
  group('Protokoll: echter Rundlauf');
  // ================================================================
  {
    const s = await starteStatusServer({ antwort: standardAntwort() });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    ok(r.online === true, 'Server antwortet, online: true', r.error);
    gleich(r.error, null, 'kein Fehlertext');
    ok(typeof r.latencyMs === 'number' && r.latencyMs >= 0 && r.latencyMs < 3000,
      `Latenz gemessen: ${r.latencyMs} ms`);
    gleich(r.version && r.version.name, 'Paper 1.21.4', 'Versionsname');
    gleich(r.protocol, 767, 'Protokollnummer');
    gleich(r.players && r.players.online, 7, 'Spieler online');
    gleich(r.players && r.players.max, 40, 'Spieler max');
    gleich(r.sample.length, 3, 'drei Beispielnamen');
    gleich(r.motd, 'Willkommen!', 'MOTD als Text');
    ok(r.faviconDataUrl && r.faviconDataUrl.startsWith('data:image/png;base64,'),
      'Favicon als PNG-Data-URL übernommen');
    gleich(r.resolvedHost, '127.0.0.1', 'aufgelöster Host');
    gleich(r.viaSrv, false, 'kein SRV (abgeschaltet)');

    // Das, was der Client wirklich gesendet hat, nachsehen.
    const handshake = s.empfangen.find(p => p.id === 0x00 && p.paket.length > 0);
    ok(handshake !== undefined, 'Handshake-Paket gesendet');
    if (handshake) {
      const [protokoll, o1] = readVarInt(handshake.paket, 0);
      const [hostlen, o2] = readVarInt(handshake.paket, o1);
      const host = handshake.paket.subarray(o2, o2 + hostlen).toString('utf-8');
      const port = handshake.paket.readUInt16BE(o2 + hostlen);
      const [next] = readVarInt(handshake.paket, o2 + hostlen + 2);
      gleich(protokoll, 767, 'Handshake: Protokollversion 767');
      gleich(host, '127.0.0.1', 'Handshake: Hostname (nicht die IP)');
      gleich(port, s.port, 'Handshake: Port');
      gleich(next, 1, 'Handshake: next_state = 1 (Status)');
    }
    const statusReq = s.empfangen.find(p => p.id === 0x00 && p.paket.length === 0);
    ok(statusReq !== undefined, 'Status-Request als eigenes leeres Paket gesendet');
    const ping = s.empfangen.find(p => p.id === 0x01);
    ok(ping !== undefined && ping.paket.length === 8, 'Ping mit 8-Byte-Long gesendet');
    await s.schliessen();
  }

  // ================================================================
  group('Server ohne Pong: trotzdem online');
  // ================================================================
  {
    const s = await starteStatusServer({ antwort: standardAntwort(), ohnePong: true });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    ok(r.online === true, 'fehlender Pong ist kein Fehler');
    gleich(r.latencyMs, null, 'Latenz bleibt unbekannt');
    gleich(r.motd, 'Willkommen!', 'MOTD trotzdem da');
    await s.schliessen();
  }

  // ================================================================
  group('Fehlerfälle');
  // ================================================================
  {
    // Nichts lauscht -> ECONNREFUSED
    const r1 = await pingServer('127.0.0.1:1', { timeout: 3000, resolveSrv: false });
    ok(r1.online === false, 'kein Server -> online: false');
    gleich(r1.errorCode, 'ECONNREFUSED', 'Fehlercode ECONNREFUSED');
    ok(/abgelehnt/i.test(r1.error || ''), `Meldung nennt "abgelehnt": ${r1.error}`);
  }
  {
    // Server nimmt an, schweigt aber -> Zeitüberschreitung
    const stummSockets = new Set();
    const stumm = net.createServer((sock) => {
      stummSockets.add(sock);
      sock.on('close', () => stummSockets.delete(sock));
      sock.on('error', () => {});        // der zerstörte Client-Socket erzeugt
    });                                  // sonst hier einen Fehler
    await new Promise((r) => stumm.listen(0, '127.0.0.1', r));
    const port = stumm.address().port;
    const r2 = await pingServer(`127.0.0.1:${port}`, { timeout: 900, resolveSrv: false });
    ok(r2.online === false, 'stummer Server -> offline');
    gleich(r2.errorCode, 'ETIMEDOUT', 'Fehlercode ETIMEDOUT');
    for (const s of stummSockets) s.destroy();
    await new Promise((r) => stumm.close(r));
  }
  {
    const s = await starteStatusServer({ fruehSchliessen: true });
    const r3 = await pingServer(`127.0.0.1:${s.port}`, { timeout: 3000, resolveSrv: false });
    ok(r3.online === false, 'Verbindung sofort geschlossen -> offline');
    ok(!!r3.error, `Fehlertext vorhanden: ${r3.error}`);
    await s.schliessen();
  }
  {
    const s = await starteStatusServer({ kaputtJson: true });
    const r4 = await pingServer(`127.0.0.1:${s.port}`, { timeout: 3000, resolveSrv: false });
    ok(r4.online === false, 'Müll statt JSON -> offline');
    gleich(r4.errorCode, 'bad-json', 'Fehlercode bad-json');
    await s.schliessen();
  }
  {
    const s = await starteStatusServer({ ungeheureMenge: true });
    const r5 = await pingServer(`127.0.0.1:${s.port}`, { timeout: 6000, resolveSrv: false });
    ok(r5.online === false, '5-MB-Antwort wird abgewiesen');
    ok(!!r5.error, `Fehlertext: ${r5.error}`);
    await s.schliessen();
  }
  {
    // Ungültige Adresse: kein TCP-Kontakt, klare Meldung
    const r6 = await pingServer('host:70000', { resolveSrv: false });
    ok(r6.online === false, 'Port 70000 -> offline');
    gleich(r6.errorCode, 'bad-address', 'Fehlercode bad-address');
    ok(/Port/i.test(r6.error || ''), `Meldung nennt den Port: ${r6.error}`);
  }

  // ================================================================
  group('Kein Socket bleibt offen');
  // ================================================================
  {
    // Ein Pinger, der nach jedem Aufruf eine Verbindung offen lässt, baut
    // über eine Serverliste hinweg Dutzende Handles auf — und im Launcher
    // blockiert irgendwann der Prozess. Geprüft wird deshalb die Zahl der
    // offenen TCP-Handles vor und nach einer ganzen Serie gemischter Pings.
    const tcpHandles = () => process.getActiveResourcesInfo()
      .filter((r) => r.includes('TCP') || r.includes('Socket')).length;

    const vorher = tcpHandles();
    const server = await starteStatusServer({ antwort: standardAntwort() });
    for (let i = 0; i < 12; i++) {
      await pingServer(`127.0.0.1:${server.port}`, { timeout: 3000, resolveSrv: false });
      await pingServer('127.0.0.1:1', { timeout: 1500, resolveSrv: false });   // abgelehnt
    }
    // Der Server-Socket des Tests zählt mit; erst nach dem Schliessen des
    // Servers vergleichen, sonst ist der Vergleich wertlos.
    await server.schliessen();
    await new Promise((r) => setTimeout(r, 300));
    const nachher = tcpHandles();
    ok(nachher <= vorher,
      `nach 24 Pings noch ${nachher} Socket-Handle(s), vorher ${vorher}`,
      `vorher ${vorher}, nachher ${nachher}`);
  }

  // ================================================================
  group('Adresse für den Spielstart formatieren');
  // ================================================================
  // Was an --quickPlayMultiplayer geht, darf nicht das sein, was der Benutzer
  // getippt hat. Ohne Port laeuft die Verbindung ins Leere — und leer ist ein
  // gueltiger Port, also faellt das nicht einmal auf.
  {
    const faelle = [
      ['example.net', 'example.net:25565'],
      ['example.net:25566', 'example.net:25566'],
      ['127.0.0.1', '127.0.0.1:25565'],
      ['127.0.0.1:25565', '127.0.0.1:25565'],
      ['  example.net  ', 'example.net:25565'],          // Leerzeichen drumherum
      ['[2001:db8::1]', '[2001:db8::1]:25565'],         // IPv6 ohne Port
      ['[2001:db8::1]:25577', '[2001:db8::1]:25577'],   // IPv6 mit Port
      ['2001:db8::1', '[2001:db8::1]:25565'],           // nackte IPv6
      ['example.net:1', 'example.net:1']                 // Randport bleibt
    ];
    for (const [eingabe, erwartet] of faelle) {
      let r = null, fehler = null;
      try { r = formatAddress(eingabe); } catch (e) { fehler = e.message; }
      gleich(r, erwartet, `formatAddress("${eingabe}") = "${erwartet}"`,
        );
    }
    // Und die Umkehrung: was formatAddress liefert, muss wieder zerlegbar sein.
    // Sonst waere die Ausgabe nur schoener und nicht brauchbar.
    for (const [, erwartet] of faelle) {
      const { host, port } = P.parseAddress(erwartet);
      const neu = formatAddress(erwartet);
      gleich(neu, erwartet, `formatAddress ist idempotent bei "${erwartet}"`);
      ok(typeof host === 'string' && Number.isInteger(port), `"${erwartet}" laesst sich wieder zerlegen`);
    }
    // Eine kaputte Adresse wirft — das ist der Grund, warum instances:launch
    // damit den Start abbrechen kann.
    for (const boese of ['', 'host:abc', 'host:0', 'host:70000', '[2001:db8::1']) {
      let geworfen = false;
      try { formatAddress(boese); } catch { geworfen = true; }
      ok(geworfen, `formatAddress("${boese}") wirft statt zu raten`);
    }
  }

  // ================================================================
  group('MOTD: alle Formen des Chat-Baums');
  // ================================================================
  // Hinweis zu den Erwartungen ohne Trennzeichen: Minecraft setzt zwischen
  // zwei Chat-Komponenten KEIN Trennzeichen. "ABC" ist die richtige Antwort,
  // nicht "A B C". Wer hier Leerzeichen erwartet, hat die Chat-Semantik falsch
  // verstanden — im echten Spiel stünde dort ein zusammenklebender Text.
  const motdFaelle = [
    ['reiner String', 'Einfach so', 'Einfach so'],
    ['§-Codes', '§aGrün §lFett §r§nNeu', 'Grün Fett Neu'],
    ['§-Hex', '§x§1§2§3§4§5§6Farbe', 'Farbe'],
    ['Text + extra', { text: 'Hallo ', extra: [{ text: 'Welt' }] }, 'Hallo Welt'],
    ['nur extra', { extra: ['A', 'B', 'C'] }, 'ABC'],
    ['verschachtelt', { text: 'a', extra: [{ text: 'b', extra: [{ text: 'c', extra: [{ text: 'd' }] }] }] }, 'abcd'],
    ['flaches Array', ['Teil1 ', { text: 'Teil2' }, ' Teil3'], 'Teil1 Teil2 Teil3'],
    ['alte Form {"":…}', { '': 'Legacy-Text' }, 'Legacy-Text'],
    ['translate', { translate: 'multiplayer.status.ping.start', with: ['12ms'] }, 'Ping: 12ms'],
    ['unbekannter translate', { translate: 'irgendwas.neues' }, 'irgendwas.neues'],
    ['selector', { selector: '@a' }, '@a'],
    ['Zahl als text', { text: 42 }, '42'],
    ['Boolean als text', { text: true }, 'true'],
    ['leeres extra', { text: '', extra: [] }, ''],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['Zahlen-Array', [1, 2, 3], '123']
  ];
  for (const [name, eingabe, erwartet] of motdFaelle) {
    const r = P.motdToText(eingabe);
    gleich(r.text, erwartet, `MOTD ${name}`);
  }

  // ================================================================
  group('MOTD: feindliche Werte');
  // ================================================================
  {
    // HTML darf nicht durchkommen. Der Wert landet zwar escaped im Renderer,
    // aber er darf hier schon gar nicht als HTML-fähiger String entstehen.
    // Geprüft wird deshalb: die spitzen Klammern sind noch da (es ist Text,
    // kein Markup) und es kam kein HTML-Baum heraus.
    const r = P.motdToText('<img src=x onerror="window.__X=1">');
    gleich(r.text, '<img src=x onerror="window.__X=1">', 'HTML bleibt Text (nicht entfernt, nicht interpretiert)');
    const r2 = P.motdToText('<b>fett</b>');
    gleich(r2.text, '<b>fett</b>', 'Tags werden nicht entfernt — sie sind Text, keine Markup-Erlaubnis');
  }
  {
    // 10.000 Ebenen Verschachtelung: muss abbrechen, nicht den Stack sprengen.
    let tief = { text: 'ENDE' };
    for (let i = 0; i < 10000; i++) tief = { text: '', extra: [tief] };
    const r = P.motdToText(tief);
    ok(r.text.length <= P.MAX_MOTD_CHARS + 2,
      `10.000 Ebenen tief: Ergebnis ${r.text.length} Zeichen (Grenze ${P.MAX_MOTD_CHARS})`);
    ok(r.truncated === true, 'Tiefe wurde als "gekuerzt" gemeldet');
    ok(!r.text.includes('ENDE'), 'der eigentliche Text wird nicht erreicht (Tiefengrenze greift)');
  }
  {
    // Längengrenze: 5000 Komponenten mit Text. Die Grenze greift schon nach
    // gut 140 Komponenten, der Rest wird nie gelesen. Wichtig ist deshalb
    // nicht nur die Länge, sondern dass es als "gekuerzt" GEMELDET wird —
    // sonst zeigt die Liste eine MOTD an, die 4400 Teile kuerzer ist als
    // die des Servers.
    const breit = { extra: Array.from({ length: 5000 }, (_, i) => ({ text: 'x' + i + ' ' })) };
    const r = P.motdToText(breit);
    ok(r.text.length <= P.MAX_MOTD_CHARS + 2, `5000 Komponenten: ${r.text.length} Zeichen`);
    ok(r.truncated === true, 'Längengrenze meldet "gekuerzt"');
    ok(r.text.endsWith('…'), 'die Kürzung ist in der Anzeige sichtbar');
  }
  {
    // Knotengrenze ALLEIN: 5000 Komponenten, die alle leeren Text liefern.
    // Da kein Zeichen entsteht, kann die Längengrenze nicht greifen — was
    // hier scheitert, muss die Knotenzahl sein.
    const leer = { extra: Array.from({ length: 5000 }, () => ({ text: '' })) };
    const r = P.motdToText(leer);
    gleich(r.text.length, 0, '5000 leere Komponenten ergeben keinen Text');
    ok(r.truncated === true, 'Knotengrenze meldet "gekuerzt"');
  }
  {
    // Längengrenze ALLEIN: ein einziger Knoten, alles andere unberührt.
    const r = P.motdToText({ text: 'A'.repeat(5000) });
    ok(r.text.length <= P.MAX_MOTD_CHARS + 2, `5000 Zeichen in einem Knoten: ${r.text.length}`);
    ok(r.truncated === true, 'auch hier wird die Kürzung gemeldet');
  }
  {
    const riesig = 'A'.repeat(500000);
    const r = P.motdToText({ text: riesig });
    ok(r.text.length <= P.MAX_MOTD_CHARS + 2, `500.000 Zeichen MOTD: ${r.text.length} Zeichen`);
  }
  {
    // Steuerzeichen und Unsichtbares
    const r = P.motdToText({ text: 'a bcd‏e﻿f' });
    gleich(r.text, 'abcdef', 'NUL, ESC, DEL, U+200F und BOM entfernt');
  }
  {
    // Zeitlimit: der Flachzieher darf nicht hängen
    let tief = { text: 'x' };
    for (let i = 0; i < 5000; i++) tief = { extra: [tief] };
    const von = process.hrtime.bigint();
    P.motdToText(tief);
    const ms = Number(process.hrtime.bigint() - von) / 1e6;
    ok(ms < 500, `5000 Ebenen flachgezogen in ${ms.toFixed(1)} ms (< 500 ms)`);
  }

  // ================================================================
  group('Favicon-Prüfung');
  // ================================================================
  {
    const gut = P.readFavicon('data:image/png;base64,' + KLEINES_PNG);
    ok(gut !== null && gut.dataUrl.startsWith('data:image/png;base64,'), 'gültiges PNG wird übernommen');
    ok(gut && gut.bytes > 8, `Byte-Anzahl wird mitgegeben: ${gut && gut.bytes}`);

    gleich(P.readFavicon(null), null, 'null -> kein Favicon');
    gleich(P.readFavicon(''), null, 'leerer String -> kein Favicon');
    gleich(P.readFavicon(undefined), null, 'undefined -> kein Favicon');
    gleich(P.readFavicon('https://evil.example/f.png'), null, 'http-URL -> kein Favicon');
    // SVG kann Skript enthalten. Wird abgelehnt, auch wenn es als PNG deklariert ist.
    const svg = 'data:image/png;base64,' + Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
    gleich(P.readFavicon(svg), null, 'SVG-Masche mit PNG-Präfix -> kein Favicon');
    gleich(P.readFavicon('data:image/svg+xml;base64,' + KLEINES_PNG), null, 'data:image/svg+xml -> kein Favicon');
    gleich(P.readFavicon('data:text/html,<script>alert(1)</script>'), null, 'data:text/html -> kein Favicon');
    // Falsche PNG-Magic
    const fakeMagic = 'data:image/png;base64,' + Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]).toString('base64');
    gleich(P.readFavicon(fakeMagic), null, 'falsche PNG-Magic -> kein Favicon');
    // Zu gross
    const zuGross = 'data:image/png;base64,' + Buffer.alloc(400 * 1024, 0x41).toString('base64');
    gleich(P.readFavicon(zuGross), null, '400-kB-Favicon -> kein Favicon');
  }

  // ================================================================
  group('Spielerzahlen und Version aus fremder Quelle');
  // ================================================================
  {
    const s = await starteStatusServer({
      antwort: {
        version: { name: 123, protocol: 'keine-zahl' },
        players: { online: -5, max: 999999999, sample: [{ name: 'ok' }, null, { name: 42 }, 'string', { name: 'x'.repeat(100) }] },
        description: 'Test'
      }
    });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    ok(r.online === true, 'Antwort mit kaputten Feldern wird nicht zum Absturz');
    gleich(r.protocol, null, 'Protokoll als String -> null');
    gleich(r.version.name, '', 'Versionsname als Zahl -> leerer String');
    gleich(r.players.online, null, 'negative Spielerzahl -> null');
    gleich(r.players.max, null, 'unrealistisch grosse Spielerzahl -> null');
    gleich(r.sample.length, 2, 'nur die zwei brauchbaren Beispielnamen');
    gleich(r.sample[1].length, 16, 'langer Name wird auf 16 Zeichen gekuerzt');
    await s.schliessen();
  }
  {
    const s = await starteStatusServer({ antwort: { description: 'nur MOTD' } });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    gleich(r.version, null, 'kein version-Feld -> null');
    gleich(r.players, null, 'kein players-Feld -> null');
    gleich(r.sample.length, 0, 'keine Beispielnamen');
    gleich(r.motd, 'nur MOTD', 'MOTD wird auch ohne Rest gelesen');
    await s.schliessen();
  }
  {
    // JSON, das selbst kein Objekt ist
    const s = await starteStatusServer({ antwort: 'nur ein String' });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    ok(r.online === false, 'JSON-String statt Objekt -> offline');
    await s.schliessen();
  }

  // ================================================================
  group('VarInt und Paketrahmen');
  // ================================================================
  {
    const werte = [0, 1, 127, 128, 255, 300, 16383, 16384, 2097151, 2097152, 268435455, 767];
    for (const w of werte) {
      const b = P.writeVarInt(w);
      gleich(b.length, P.varIntSize(w), `VarInt-Größe für ${w}`);
      const [zurueck, off] = P.readVarInt(b, 0);
      gleich(zurueck, w, `VarInt ${w} überlebt Hin- und Rückweg`);
      gleich(off, b.length, `VarInt ${w}: Offset landet am Ende`);
    }
    let geworfen = false;
    try { P.readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]), 0); } catch { geworfen = true; }
    ok(geworfen, 'VarInt mit 6 Bytes am Stück wird abgelehnt');
    geworfen = false;
    try { P.readVarInt(Buffer.from([0x80]), 0); } catch { geworfen = true; }
    ok(geworfen, 'abgeschnittener VarInt wird abgelehnt (nicht als 0 gelesen)');

    // Ganze Nachricht mit führendem Null-Byte
    const s = P.writeString('A');
    // Inhaltlich vergleichen, nicht per ===: zwei Arrays sind nie dieselbe
    // Referenz, "gleicht" würde hier immer "FEHLT" melden.
    ok([...s].join(' ') === '1 65', 'String wird längenpräfix-basiert kodiert',
      `war [${[...s]}]`);
  }
  {
    // Der PacketReader muss Pakete auch über Paketgrenzen hinweg lesen
    const empfangen = [];
    const reader = new P.PacketReader((id, nutzlast) => empfangen.push({ id, laenge: nutzlast.length }));
    const ganz = Buffer.concat([
      frame(0x00, mcString('erste')),
      frame(0x01, Buffer.alloc(8)),
      frame(0x00, mcString('zweite'))
    ]);
    // Byte für Byte schieben — der härteste Fall
    for (const b of ganz) reader.push(Buffer.from([b]));
    gleich(empfangen.length, 3, 'drei Pakete auch bei Ein-Byte-Zuständen');
    gleich(empfangen[0].id, 0x00, 'erstes Paket: Status-Response');
    gleich(empfangen[1].id, 0x01, 'zweites Paket: Pong');
    gleich(empfangen[2].id, 0x00, 'drittes Paket: Status-Response');
    gleich(empfangen[1].laenge, 8, 'Pong-Nutzlast ist 8 Byte');
  }

  // ================================================================
  group('Was der Renderer zu sehen bekommt');
  // ================================================================
  {
    const s = await starteStatusServer({ antwort: standardAntwort() });
    const r = await pingServer(`127.0.0.1:${s.port}`, { timeout: 4000, resolveSrv: false });
    // Der ganze Rückgabewert geht als JSON über IPC. Alles muss serialisierbar
    // sein (kein Buffer, kein Error, keine Funktion) — sonst landet im
    // Renderer ein {} und die Anzeige bleibt leer.
    let json = null, fehler = null;
    try { json = JSON.stringify(r); } catch (e) { fehler = e.message; }
    ok(fehler === null, 'Rückgabewert ist JSON-serialisierbar', fehler);
    const zurueck = JSON.parse(json);
    for (const feld of ['online', 'address', 'error', 'errorCode', 'latencyMs', 'motd', 'motdTruncated', 'version', 'protocol', 'players', 'sample', 'faviconDataUrl', 'faviconBytes', 'resolvedHost', 'resolvedPort', 'viaSrv']) {
      ok(Object.prototype.hasOwnProperty.call(zurueck, feld), `Feld "${feld}" ist vorhanden`,
        'fehlt in: ' + Object.keys(zurueck).join(','));
    }
    // Und: keine unerwarteten. Ein Feld, das hier nicht steht, ist eins, das
    // später jemand hinzufügt und im Renderer dann nicht kennt.
    const erlaubt = new Set(['online', 'address', 'error', 'errorCode', 'latencyMs', 'motd', 'motdTruncated', 'version', 'protocol', 'players', 'sample', 'faviconDataUrl', 'faviconBytes', 'resolvedHost', 'resolvedPort', 'viaSrv']);
    const extra = Object.keys(zurueck).filter((k) => !erlaubt.has(k));
    gleich(extra.length, 0, 'keine unerwarteten Felder im Rückgabewert');
    await s.schliessen();
  }

  // ================================================================
  console.log('\n' + '='.repeat(72));
  if (problems.length === 0) {
    console.log(`✅ Alle ${checks} Prüfungen bestanden.`);
    console.log('   Der Pinger spricht das echte Protokoll, und Daten von fremden');
    console.log('   Servern kommen flachgezogen, gekuerzt und geprueft an.');
  } else {
    console.log(`❌ ${problems.length} von ${checks} Prüfungen fehlgeschlagen:`);
    problems.forEach((p) => console.log('   - ' + p));
  }
  console.log('='.repeat(72));
  process.exit(problems.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nABBRUCH: Test ist abgestürzt statt durchzulaufen.');
  console.error(err);
  process.exit(1);
});
