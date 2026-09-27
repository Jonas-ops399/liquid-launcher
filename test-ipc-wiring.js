// test-ipc-wiring.js
// Rauchtest fuer die Electron-Seite: laedt main.js und ipc-handlers.js mit
// gestubbtem Electron und prueft, dass die Startkette wirklich verdrahtet ist.
//
//   node test-ipc-wiring.js
//
// Warum das noetig ist: ipc-handlers.js requiret inzwischen java-runtime,
// downloader und process. Ein Tippfehler in einem dieser Requires faellt erst
// auf, wenn Electron startet — dann ist das Fenster schon offen und der
// Fehler landet irgendwo im DevTools. Hier ist es sofort sichtbar.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');

// ---------- winziger Minecraft-Protokollex-Server ----------
// servers:ping wird hier ueber den ECHTEN IPC-Kanal geprueft. Dafuer braucht
// es einen Server, der das Protokoll auch wirklich spricht — sonst prueft der
// Test nichts, weil der einzige erreichbare Server "nichts antwortet" waere.
function _varInt(value) {
  const b = [];
  let r = value >>> 0;
  do { let x = r & 0x7f; r >>>= 7; if (r !== 0) x |= 0x80; b.push(x); } while (r !== 0);
  return Buffer.from(b);
}
function _mcString(s) {
  const b = Buffer.from(s, 'utf-8');
  return Buffer.concat([_varInt(b.length), b]);
}
function _frame(id, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([_varInt(id), payload]);
  return Buffer.concat([_varInt(body.length), body]);
}
function _readVarInt(buf, off) {
  let v = 0, shift = 0, pos = off;
  for (let i = 0; i < 5; i++) {
    const b = buf[pos++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v >>> 0, pos];
    shift += 7;
  }
  throw new Error('VarInt zu lang');
}
function starteStatusServer(status) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      let geantwortet = false;
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 1) return;
          let len, start;
          try { [len, start] = _readVarInt(buf, 0); } catch { return; }
          if (buf.length < start + len) return;
          const paket = buf.subarray(start, start + len);
          buf = buf.subarray(start + len);
          const [id, off] = _readVarInt(paket, 0);
          const nutzlast = paket.subarray(off);
          // Handshake hat eine Nutzlast, der Status-Request keine.
          if (id === 0x00 && !geantwortet && nutzlast.length === 0) {
            geantwortet = true;
            socket.write(_frame(0x00, _mcString(JSON.stringify(status))));
          } else if (id === 0x01) {
            socket.write(_frame(0x01, paket.subarray(off)));   // Pong
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      schliessen: () => new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      })
    }));
  });
}

// ---------- electron stubben ----------
const registered = {};
const sent = [];
const USER_DATA = path.join(os.tmpdir(), 'liquid-launcher-smoketest');
// Immer sauber anfangen. Sonst hängt das Ergebnis davon ab, ob der Test
// vorher schon einmal gelaufen ist: config.json, accounts.json und instances/
// liegen sonst aus dem vorigen Lauf da und einige Prüfungen schlagen dadurch
// grundlos fehl.
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: {
      getPath: () => USER_DATA,
      on() {},
      whenReady: async () => {}
    },
    ipcMain: {
      handle: (channel, fn) => { registered[channel] = fn; },
      on() {}
    },
    // safeStorage braucht der AccountStore zum Verschluesseln der Tokens.
    // Hier reicht ein XOR, solange der Test laeuft.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(`X${t}`, 'utf-8'),
      decryptString: (b) => b.toString('utf-8').slice(1)
    },
    dialog: {},
    BrowserWindow: class {},
    shell: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
  }
};

const problems = [];

const { registerIpcHandlers } = require('./src/main/ipc-handlers');
registerIpcHandlers();

const channels = Object.keys(registered).sort();
console.log(`Registrierte IPC-Kanaele: ${channels.length}`);
channels.forEach(c => console.log('  ' + c));

console.log('\n--- Startkette ---');

// 1) Die drei Kanaele, ohne die "Spielen" nichts tut.
for (const required of ['instances:list', 'instances:launch', 'instances:stop']) {
  const ok = typeof registered[required] === 'function';
  console.log(`  ${ok ? 'OK  ' : 'FEHLT'} ${required}`);
  if (!ok) problems.push(`${required} ist nicht registriert`);
}

// 2) instances:list liefert die Modpacks, die das UI anzeigt.
(async () => {
  const modpacks = await registered['instances:list']();
  console.log(`  Modpacks: ${modpacks.map(m => `${m.id} (${m.version})`).join(', ')}`);
  if (!Array.isArray(modpacks) || modpacks.length === 0) {
    problems.push('instances:list liefert keine Modpacks');
  }

  // 3) Eine unbekannte Instanz muss sauber scheitern, nicht stillschweigend
  //    "starten" — sonst wuerde der UI-Bereit Status einen toten Start zeigen.
  try {
    await registered['instances:launch']({ sender: { send: (...a) => sent.push(a) } }, 'gibtsnicht');
    problems.push('instances:launch akzeptiert eine unbekannte Instanz');
    console.log('  FEHLT unbekannte Instanz wird abgelehnt');
  } catch (err) {
    console.log(`  OK   unbekannte Instanz wird abgelehnt: "${err.message}"`);
  }

  // 4) Die Log-Ausgabe darf keine Geheimnisse enthalten.
  const token = 'secret-token-12345';
  const { maskSensitiveData } = require('./src/main/process');
  const masked = maskSensitiveData(`--accessToken ${token} --uuid abc`, { gameArgs: [`--accessToken`, token] });
  if (masked.includes(token)) {
    problems.push('maskSensitiveData laesst das accessToken im Log stehen');
    console.log('  FEHLT accessToken wird maskiert');
  } else {
    console.log('  OK   accessToken wird im Log maskiert');
  }

  console.log('\n--- Microsoft-Login: keine Client-ID hinterlegt ---');

  // 5) Ohne Client-ID muss addAccount mit einer BENUTZERFUEHRLICHEN Anleitung
  //    scheitern, nicht mit "Cannot read property of undefined". Genau das ist
  //    der Fehler, den man sonst stundenlang sucht.
  delete process.env.LIQUID_LAUNCHER_CLIENT_ID;
  const authModule = require('./src/main/auth');
  authModule.resetClientIdCache();
  try {
    await registered['auth:addAccount']({ sender: { send: (...a) => sent.push(a) } });
    problems.push('auth:addAccount meldet Erfolg, obwohl keine Client-ID hinterlegt ist');
    console.log('  FEHLT addAccount wird trotz fehlender Client-ID nicht abgelehnt');
  } catch (err) {
    const helpful = err.message.includes('App registrations')
      && err.message.includes('oauth20_desktop.srf')
      && err.message.includes('config.json');
    console.log(`  ${helpful ? 'OK  ' : 'FEHLT'} Fehlermeldung nennt App registrations, Redirect-URI und config.json`);
    if (!helpful) {
      problems.push('Die Fehlermeldung bei fehlender Client-ID ist nicht actionable: ' + err.message.slice(0, 80));
    }
  }

  // 6) Der Redirect-URI muss der sein, den msmc auch benutzt. Andernfalls gibt
  //    es mit gueltiger Client-ID trotzdem AADSTS50011.
  const { DEFAULT_REDIRECT_URI } = authModule;
  if (DEFAULT_REDIRECT_URI !== 'https://login.live.com/oauth20_desktop.srf') {
    problems.push(`Falscher Default-Redirect: ${DEFAULT_REDIRECT_URI}`);
    console.log('  FEHLT Redirect-URI passt nicht zu msmcs Legacy-Endpoint');
  } else {
    console.log('  OK   Redirect-URI passt zu msmcs Legacy-Endpoint (oauth20_token.srf)');
  }

  console.log('\n--- Tokens erreichen den Renderer nicht ---');

  // 7) Ein gespeicherter Account darf nach aussen nur die oeffentliche Form
  //    liefern. Das ist die wichtigste Zusicherung im ganzen Auth-Block.
  const { AccountStore } = require('./src/main/account-store');
  const fakeSafeStorage = require.cache[electronEntry].exports.safeStorage;
  const store = new AccountStore(USER_DATA, fakeSafeStorage);
  store.load();
  store.upsert({
    id: 'test-uuid-1234',
    username: 'TokenTest',
    uuid: 'test-uuid-1234',
    avatarUrl: null,
    skinUrl: null,
    xuid: '12345',
    isDemo: false,
    expiresAt: Date.now() + 3600_000,
    accessToken: 'TOP-SECRET-ACCESS-TOKEN',
    refreshToken: 'TOP-SECRET-REFRESH-TOKEN'
  });

  const viaIpc = await registered['auth:listAccounts']();
  if (JSON.stringify(viaIpc).includes('TOP-SECRET')) {
    problems.push('auth:listAccounts gibt ein Secret preis!');
    console.log('  FEHLT TOP-SECRET taucht in auth:listAccounts auf');
  } else {
    console.log('  OK   auth:listAccounts enthaelt kein accessToken/refreshToken');
  }
  if (viaIpc.some(a => 'accessToken' in a || 'refreshToken' in a)) {
    problems.push('Ein Account-Objekt aus auth:listAccounts hat Token-Felder');
    console.log('  FEHLT Token-Felder im zurueckgegebenen Objekt');
  } else {
    console.log('  OK   zurueckgegebene Objekte haben gar keine Token-Felder');
  }

  const activeViaIpc = await registered['auth:getActiveAccount']();
  if (activeViaIpc && JSON.stringify(activeViaIpc).includes('TOP-SECRET')) {
    problems.push('auth:getActiveAccount gibt ein Secret preis!');
    console.log('  FEHLT TOP-SECRET taucht in auth:getActiveAccount auf');
  } else {
    console.log('  OK   auth:getActiveAccount ist ebenfalls token-frei');
  }

  // 8) toLaunchAccount() ist die EINZIGE Stelle, die den Token benutzt —
  //    und sie bleibt im Haupt-Prozess.
  const launch = authModule.toLaunchAccount(store.getActive(), USER_DATA);
  if (launch?.accessToken !== 'TOP-SECRET-ACCESS-TOKEN') {
    problems.push('toLaunchAccount liefert kein accessToken an den Spielstart');
    console.log('  FEHLT toLaunchAccount liefert kein accessToken');
  } else {
    console.log('  OK   toLaunchAccount liefert das echte Token an process.js (nur main)');
  }
  if (launch?.xuid !== '12345') {
    problems.push('toLaunchAccount verliert die XUID (wird als --xuid gebraucht)');
    console.log('  FEHLT XUID geht beim Spielstart verloren');
  } else {
    console.log('  OK   XUID wird an den Spielstart durchgereicht (--xuid)');
  }
  // Ohne hinterlegte Client-ID bleibt der Wert leer. Er darf aber NICHT
  // undefined sein — sonst stuende im Argument-Array "--clientId" direkt
  // "--xuid", und das Spiel laesst den XUID-Wert weg.
  if (typeof launch?.clientId !== 'string') {
    problems.push('toLaunchAccount liefert clientId nicht als String (undefined wuerde die Argumente verschieben)');
    console.log('  FEHLT clientId ist kein String');
  } else {
    console.log(`  OK   clientId ist ein String (leer, weil keine config.json existiert): "${launch.clientId}"`);
  }

  // 9) Abgelaufenes Token muss als "neu anmelden" erkannt werden, sonst
  //    startet Minecraft mit einem toten Token und zeigt 401.
  if (authModule.isAccountTokenValid({ accessToken: 'x', expiresAt: Date.now() - 1000 })) {
    problems.push('isAccountTokenValid haelt ein abgelaufenes Token fuer gueltig');
    console.log('  FEHLT abgelaufenes Token wird als gueltig eingestuft');
  } else {
    console.log('  OK   abgelaufenes Token wird als ungueltig erkannt');
  }
  // Reserve: ein Token, das in 2 Minuten ablaeuft, gilt schon als zu knapp,
  // weil der Asset-Download laenger dauern kann.
  if (authModule.isAccountTokenValid({ accessToken: 'x', expiresAt: Date.now() + 2 * 60 * 1000 })) {
    problems.push('isAccountTokenValid ignoriert die Reserve vor dem Ablauf');
    console.log('  FEHLT knapp ablaufendes Token wird noch als gueltig eingestuft');
  } else {
    console.log('  OK   knapp ablaufendes Token wird vorsorglich als ungueltig eingestuft');
  }

  console.log('\n--- Azure-Client-ID im UI einstellbar ---');

  // 10) Die Client-ID muss sich ohne Neustart setzen lassen — sonst muss man
  //     fuer die Ersteinrichtung den Quellcode anfassen. Der haeufigste
  //     Kopierfehler ist die Directory (tenant) ID statt der Application ID;
  //     beide sind gueltige GUIDs, aber nur eine funktioniert.
  const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cf = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'config.json'), 'utf-8'));

  if (!registered['auth:setClientId'] || !registered['auth:getClientId']) {
    problems.push('auth:setClientId / auth:getClientId fehlen (Client-ID nur per Handeditierbar)');
    console.log('  FEHLT Handler fuer die Client-ID fehlen');
  } else {
    console.log('  OK   auth:getClientId und auth:setClientId sind registriert');

    const vorher = await registered['auth:getClientId']();
    if (vorher.configured !== false || vorher.clientId !== '') {
      // kann ein Reststand aus einem anderen Lauf sein — das ist kein Fehler
      console.log(`  INFO  config.json war nicht leer: "${vorher.clientId}" (wird jetzt ueberschrieben)`);
    } else {
      console.log('  OK   Ausgangszustand: keine Client-ID hinterlegt');
    }
    if (!vorher.redirectUri || !vortherRedirectOk(vorher.redirectUri)) {
      problems.push('auth:getClientId liefert keinen gueltigen Redirect-URI: ' + vorher.redirectUri);
      console.log('  FEHLT Redirect-URI ungueltig: ' + vorher.redirectUri);
    } else {
      console.log('  OK   der Redirect-URI wird mitgeliefert (fuer den Azure-Hinweis im UI)');
    }

    const res = await registered['auth:setClientId'](null, GUID);
    if (res.clientId !== GUID) {
      problems.push('auth:setClientId liefert eine andere ID zurueck als gesetzt wurde');
      console.log('  FEHLT zurueckgeliefert: ' + res.clientId);
    } else {
      console.log('  OK   gueltige GUID wird akzeptiert und zurueckgeliefert');
    }
    if (cf().microsoftClientId !== GUID) {
      problems.push('config.json enthaelt die Client-ID nicht — sie ueberlebt keinen Neustart');
      console.log('  FEHLT config.json wurde nicht geschrieben');
    } else {
      console.log('  OK   sie steht in config.json und ueberlebt einen Neustart');
    }

    // Ohne Cache-Reset wuerde der naechste Login noch die alte ID nutzen.
    authModule.resetClientIdCache();
    if (authModule.resolveClientId(USER_DATA) !== GUID) {
      problems.push('resolveClientId liest die frisch geschriebene Client-ID nicht');
      console.log('  FEHLT resolveClientId sieht die neue ID nicht');
    } else {
      console.log('  OK   resolveClientId sieht die neue ID ohne Neustart');
    }

    // Kopierfehler: Beschriftung mitkopiert
    try {
      await registered['auth:setClientId'](null, 'Application (client) ID');
      problems.push('auth:setClientId akzeptiert eine Beschriftung statt einer GUID');
      console.log('  FEHLT Beschriftung "Application (client) ID" wurde akzeptiert');
    } catch {
      console.log('  OK   mitkopierte Beschriftung wird abgelehnt');
    }
    if (cf().microsoftClientId !== GUID) {
      problems.push('ein abgelehnter Wert hat die gueltige ID ueberschrieben');
      console.log('  FEHLT abgelehnter Wert hat config.json beschaedigt');
    } else {
      console.log('  OK   ein abgelehnter Wert laesst die gueltige ID unberuehrt');
    }

    // Leer ist erlaubt (= zuruecksetzen), das ist eine nuetzliche Aktion.
    await registered['auth:setClientId'](null, '   ');
    if (cf().microsoftClientId !== undefined) {
      problems.push('Leerer Wert setzt die Client-ID nicht zurueck');
      console.log('  FEHLT leerer Wert hat nicht zurueckgesetzt');
    } else {
      console.log('  OK   leerer Wert setzt zurueck (Leerzeichen werden getrimmt)');
    }
  }

  console.log('\n--- Serverliste und Live-Ping ---');

  // 11) servers:ping muss existieren und einen NICHT ERREICHBAREN Server nicht
  //     als Fehler behandeln. "Server antwortet nicht" ist in einer
  //     Serverliste ein ganz normaler Zustand; wirft der Handler, poppt im
  //     UI ein Fehlerdialog auf, statt eine Zeile als offline zu zeigen.
  if (typeof registered['servers:ping'] !== 'function') {
    problems.push('servers:ping ist nicht registriert — die Serverliste bleibt blind');
    console.log('  FEHLT servers:ping fehlt');
  } else {
    console.log('  OK   servers:ping ist registriert');

    // Auf Port 1 laeuft mit Sicherheit kein Minecraft-Server.
    const offline = await registered['servers:ping'](null, '127.0.0.1:1', { timeout: 2000 });
    if (offline.online !== false || !offline.error) {
      problems.push('servers:ping meldet einen nicht erreichbaren Server nicht als offline');
      console.log('  FEHLT nicht erreichbarer Server wird nicht als offline gemeldet');
    } else {
      console.log(`  OK   nicht erreichbarer Server -> online:false, "${offline.error}"`);
    }

    // Gegen einen echten, lokalen Protokollex-Server: kommt die MOTD an?
    const ping = require('./src/main/mc-ping');
    const fake = await starteStatusServer({
      version: { name: 'Fake 1.21.4', protocol: 767 },
      players: { online: 3, max: 20 },
      description: { text: 'Lokaler Testsrv' }
    });
    const online = await registered['servers:ping'](null, `127.0.0.1:${fake.port}`, { timeout: 4000 });
    if (online.online !== true || online.motd !== 'Lokaler Testsrv' || !online.players
        || online.players.online !== 3 || online.latencyMs === null) {
      problems.push('servers:ping liefert fuer einen erreichbaren Server keine brauchbaren Daten: '
        + JSON.stringify({ online: online.online, motd: online.motd, players: online.players }));
      console.log('  FEHLT erreichbarer Server liefert keine Daten');
    } else {
      console.log(`  OK   erreichbarer Server -> MOTD "${online.motd}", ${online.players.online}/${online.players.max}, ${online.latencyMs} ms`);
    }
    await fake.schliessen();

    // Was der Renderer zu sehen bekommt, muss serialisierbar sein UND darf
    // keine Serverinhalte als HTML durchreichen.
    let alsJson = null;
    try { alsJson = JSON.parse(JSON.stringify(online)); } catch (err) {
      problems.push('servers:ping liefert nichts Serialisierbares: ' + err.message);
    }
    if (alsJson && typeof alsJson.motd === 'string' && /<[a-z/]/i.test(alsJson.motd)) {
      // Kein Fehler — die MOTD darf HTML-Text enthalten. Es muss nur im
      // Renderer escaped werden, und das ist eine Eigenschaft des Renderers.
      console.log('  INFO  MOTD enthaelt HTML-Text, der Renderer muss escapen');
    }
  }

  // 12) servers:add muss die Adresse pruefen und normalisieren, BEVOR sie
  //     gespeichert wird. Sonst steht eine kaputte Adresse ewig in der Liste.
  const instanzDir = path.join(USER_DATA, 'instances', 'talberg');
  fs.mkdirSync(instanzDir, { recursive: true });
  const serversFile = path.join(instanzDir, 'servers.json');
  fs.rmSync(serversFile, { force: true });
  // Fuer die Startoptionen. Vorher loeschen: ein Rest aus einem frueheren
  // Lauf wuerde den Test der Voreinstellung mit einem alten Wert kippen.
  const instanceSettingsFile = path.join(instanzDir, 'instance-settings.json');
  fs.rmSync(instanceSettingsFile, { force: true });

  const ohnePort = await registered['servers:add'](null, 'talberg', { name: 'Ohne Port', address: 'example.net' });
  const letzter = ohnePort[ohnePort.length - 1];
  if (letzter.address !== 'example.net:25565') {
    problems.push('servers:add speichert die Adresse unnormalisiert: ' + letzter.address);
    console.log('  FEHLT Adresse wurde nicht normalisiert: ' + letzter.address);
  } else {
    console.log('  OK   "example.net" wird als "example.net:25565" gespeichert');
  }
  try {
    await registered['servers:add'](null, 'talberg', { name: 'Kaputt', address: 'host:abc' });
    problems.push('servers:add akzeptiert eine Adresse mit nichtnumerischem Port');
    console.log('  FEHLT "host:abc" wurde gespeichert');
  } catch (err) {
    console.log(`  OK   ungültige Adresse wird abgelehnt: "${err.message}"`);
  }
  try {
    await registered['servers:add'](null, 'talberg', { name: 'Leer', address: '   ' });
    problems.push('servers:add akzeptiert eine leere Adresse');
    console.log('  FEHLT leere Adresse wurde gespeichert');
  } catch {
    console.log('  OK   leere Adresse wird abgelehnt');
  }
  try {
    await registered['servers:add'](null, 'talberg', { name: 'Doppelt', address: 'example.net:25565' });
    problems.push('servers:add legt denselben Server zweimal an');
    console.log('  FEHLT Duplikat wurde angelegt');
  } catch {
    console.log('  OK   derselbe Server wird nicht doppelt angelegt');
  }
  const nachAdds = await registered['servers:list'](null, 'talberg');
  if (nachAdds.length !== 1) {
    problems.push(`nach vier Aufrufen von servers:add stehen ${nachAdds.length} Eintraege in der Liste (erwartet: 1)`);
    console.log(`  FEHLT ${nachAdds.length} Eintraege statt 1`);
  } else {
    console.log('  OK   nur der gueltige Eintrag steht in der Liste');
  }

  // 13) Quick Play ueber den Server: instances:launch muss die serverId gegen
  //     die echte servers.json pruefen. Ein Server, den es nicht gibt, darf
  //     den Start nicht bis zum 500-MB-Download durchlassen lassen.
  const fremderStart = async (serverId) => {
    try {
      await registered['instances:launch']({ sender: { send: (...a) => sent.push(a) } },
        { instanceId: 'talberg', serverId });
      return null;
    } catch (err) { return err.message; }
  };
  const nichtGelistet = await fremderStart('srv-erfunden');
  if (!nichtGelistet || !/steht nicht in der Serverliste/.test(nichtGelistet)) {
    problems.push('instances:launch startet einen unbekannten Server: ' + nichtGelistet);
    console.log('  FEHLT unbekannter Server wird nicht abgelehnt: ' + nichtGelistet);
  } else {
    console.log('  OK   unbekannter Server wird vor dem Download abgelehnt');
  }
  // Beide Ziele gleichzeitig sind widersinnig und muessen abgelehnt werden,
  // BEVOR irgendetwas passiert. Dieser Fall bricht genau an der Doppelangabe
  // ab und laeuft deshalb nicht in den Download.
  //
  // Bewusst KEIN Test fuer "leeres serverId fuehrt zum normalen Start": das
  // waere ein vollstaendiger Startversuch, und im Test heisst das ein echter
  // 500-MB-Download. Einen Startweg zu beweisen, indem man ihn wirklich
  // ausfuehrt, gehoert in test-launch-chain.js — nicht hierher.
  let doppeltesZiel = null;
  try {
    await registered['instances:launch']({ sender: { send: (...a) => sent.push(a) } },
      { instanceId: 'talberg', worldId: 'irgendeine-welt', serverId: 'srv-erfunden' });
  } catch (err) { doppeltesZiel = err.message; }
  if (doppeltesZiel && /nur ein Ziel/.test(doppeltesZiel)) {
    console.log(`  OK   Welt und Server gleichzeitig werden abgelehnt: "${doppeltesZiel}"`);
  } else {
    problems.push('instances:launch nimmt Welt UND Server gleichzeitig an: ' + doppeltesZiel);
    console.log('  FEHLT beide Ziele gleichzeitig werden nicht abgelehnt: ' + doppeltesZiel);
  }
  fs.rmSync(serversFile, { force: true });

  // 14) Startoptionen pro Instanz: die beiden Kanaele, und vor allem ihre
  //     Fehlerbehandlung. Erwartet wird NICHT, dass instanceSettings:set
  //     wirft — es soll mit `fehler` antworten und den alten Stand lassen.
  //     Ein Reject wuerde im Renderer als unbehandelte Ablehnung landen,
  //     waehrend der Benutzer noch tippt.
  if (typeof registered['instanceSettings:get'] !== 'function' ||
      typeof registered['instanceSettings:set'] !== 'function') {
    problems.push('instanceSettings:get/set fehlt — RAM und Aufloesung sind nicht einstellbar');
    console.log('  FEHLT instanceSettings:get oder :set nicht registriert');
  } else {
    console.log('  OK   instanceSettings:get und :set sind registriert');

    const gelesen = await registered['instanceSettings:get'](null, 'talberg');
    const felder = ['settings', 'vorschlag', 'limits', 'physicalRamGb',
      'recommendedRamGb', 'problem', 'warnungen', 'fehler'];
    const fehlend = felder.filter(k => !(k in gelesen));
    if (fehlend.length) {
      problems.push('instanceSettings:get antwortet unvollstaendig, es fehlt: ' + fehlend.join(', '));
      console.log('  FEHLT Antwort unvollstaendig: ' + fehlend.join(', '));
    } else {
      console.log('  OK   die Antwort traegt alle acht Felder');
    }
    if (!gelesen.limits || typeof gelesen.limits.ramMax !== 'number') {
      problems.push('instanceSettings:get liefert keine RAM-Grenzen — die Oberflaeche muesste raten');
    } else {
      console.log(`  OK   Grenzen kommen mit (RAM ${gelesen.limits.ramMin}–${gelesen.limits.ramMax} GB, ` +
        `physisch ${gelesen.physicalRamGb} GB, empfohlen ${gelesen.recommendedRamGb} GB)`);
    }
    // Die Voreinstellung muss selbst startbar sein, sonst waere die
    // Oberflaeche die Ursache fuer einen Startabbruch.
    const s = gelesen.settings;
    if (s.ramMinGb < 1 || s.ramMaxGb > 64 || s.ramMinGb > s.ramMaxGb) {
      problems.push(`die Voreinstellung ist nicht startbar: ${JSON.stringify(s)}`);
      console.log('  FEHLT Voreinstellung nicht startbar: ' + JSON.stringify(s));
    } else {
      console.log(`  OK   Voreinstellung ist startbar (${s.ramMinGb}–${s.ramMaxGb} GB, ${s.width}x${s.height})`);
    }

    // ---- Speichern
    const gespeichert = await registered['instanceSettings:set'](null, 'talberg',
      { ramMinGb: 2, ramMaxGb: 6, width: 1920, height: 1080 });
    if (gespeichert.fehler) {
      problems.push('instanceSettings:set weigert korrekte Werte: ' + gespeichert.fehler);
      console.log('  FEHLT korrekte Werte abgewiesen: ' + gespeichert.fehler);
    } else if (gespeichert.settings.ramMaxGb !== 6 || gespeichert.settings.width !== 1920) {
      problems.push('instanceSettings:set speichert nicht, was man angegeben hat: ' +
        JSON.stringify(gespeichert.settings));
      console.log('  FEHLT nicht gespeichert: ' + JSON.stringify(gespeichert.settings));
    } else {
      console.log('  OK   Werte werden gespeichert und bestaetigt');
    }

    // Und sie muessen den Weg durch die Datei ueberstehen.
    const nachher = await registered['instanceSettings:get'](null, 'talberg');
    if (nachher.settings.ramMaxGb !== 6 || nachher.settings.height !== 1080) {
      problems.push('instanceSettings:get liest nach dem Speichern etwas anderes: ' +
        JSON.stringify(nachher.settings));
      console.log('  FEHLT nach dem Speichern falscher Stand: ' + JSON.stringify(nachher.settings));
    } else {
      console.log('  OK   der Wert kommt wieder aus der Datei');
    }

    // ---- Ablehnungen. Der alte Stand muss dabei EXAKT erhalten bleiben.
    const abgelehnt = [
      [{ ramMaxGb: 99999 }, /zwischen 1 und 64/, '99999 GB'],
      [{ ramMinGb: 4, ramMaxGb: 2 }, /nicht groesser/, 'min groesser als max'],
      [{ width: 5 }, /Breite/, '5 px Breite'],
      [{ height: 99999 }, /Hoehe/, '99999 px Hoehe'],
      [{ ramMaxGb: '4G -Dfoo=bar' }, /keine Zahl|zwischen/, 'Text statt Zahl'],
      [{ width: 0x10 }, /Breite/, 'Hexadezimal']
    ];
    for (const [teil, muster, was] of abgelehnt) {
      const r = await registered['instanceSettings:set'](null, 'talberg', teil);
      if (!r.fehler) {
        problems.push(`instanceSettings:set akzeptiert ${was}`);
        console.log(`  FEHLT akzeptiert: ${was}`);
        continue;
      }
      if (!muster.test(r.fehler)) {
        problems.push(`instanceSettings:set lehnt ${was} ab, aber die Meldung passt nicht: ${r.fehler}`);
        console.log(`  FEHLT Meldung passt nicht (${was}): ${r.fehler}`);
        continue;
      }
      const stand = await registered['instanceSettings:get'](null, 'talberg');
      if (stand.settings.ramMaxGb !== 6 || stand.settings.width !== 1920) {
        problems.push(`instanceSettings:set hat beim Ablehnen von ${was} den alten Stand veraendert: ` +
          JSON.stringify(stand.settings));
        console.log(`  FEHLT alter Stand veraendert (${was}): ` + JSON.stringify(stand.settings));
        continue;
      }
      console.log(`  OK   abgelehnt, alter Stand unveraendert: ${was}`);
    }

    // Nur die Aufloesung aendern darf den RAM nicht zuruecksetzen. Ohne
    // Merge mit dem aktuellen Stand waere das ein stiller Datenverlust.
    const nurAufloesung = await registered['instanceSettings:set'](null, 'talberg', { width: 1280 });
    if (nurAufloesung.settings.ramMaxGb !== 6) {
      problems.push('eine reine Aufloesungsaenderung setzt den RAM zurueck: ' +
        JSON.stringify(nurAufloesung.settings));
      console.log('  FEHLT RAM wurde zurueckgesetzt: ' + JSON.stringify(nurAufloesung.settings));
    } else {
      console.log('  OK   eine Aufloesungsaenderung laesst den RAM unberuehrt');
    }

    // Der Reset-Knopf braucht den Vorschlag des Haupt-Prozesses, weil der
    // vom physischen Speicher abhaengt.
    if (!gelesen.vorschlag || !(gelesen.vorschlag.ramMinGb <= gelesen.vorschlag.ramMaxGb)) {
      problems.push('instanceSettings:get liefert keinen brauchbaren Vorschlag fuer den Reset-Knopf');
      console.log('  FEHLT Vorschlag fehlt oder ist unbrauchbar');
    } else {
      console.log(`  OK   Vorschlag fuer den Reset: ${gelesen.vorschlag.ramMinGb}–${gelesen.vorschlag.ramMaxGb} GB`);
    }

    fs.rmSync(instanceSettingsFile, { force: true });
  }

  console.log('\n' + '='.repeat(60));
  if (problems.length) {
    console.log('❌ Probleme:');
    problems.forEach(p => console.log('   - ' + p));
    process.exitCode = 1;
  } else {
    console.log('✅ Electron-Seite laedt, Startkette verdrahtet, Log maskiert Tokens,');
    console.log('   keine Tokens im Renderer, Client-ID und Startoptionen im UI einstellbar.');
  }
})();

function vortherRedirectOk(uri) {
  return typeof uri === 'string' && uri.startsWith('https://');
}