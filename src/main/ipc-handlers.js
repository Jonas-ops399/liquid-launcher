// src/main/ipc-handlers.js
// Registriert alle ipcMain.handle-Kanäle, die preload.js erwartet.
//
// Status:
// - instances.* ist ECHT: Download der Version, Java-Erkennung, Argumentbau
//   und der Start des Prozesses. Quick Play (Welt oder Server) schaltet
//   --quickPlaySingleplayer bzw. --quickPlayMultiplayer.
// - mods.* ist ECHT: reale Modrinth-Suche/Download/SHA1-Verifikation.
// - settings.* ist ECHT: persistiert als settings.json im App-Datenordner,
//   überlebt Neustarts (Theme, Sprache, Fenster-Block-Layout usw.).
// - auth.* ist ECHT: Microsoft-OAuth über msmc, Tokens verschlüsselt.
// - worlds.* ist ECHT: listWorlds liest das level.dat, deleteWorld löscht.
// - servers.* ist ECHT: servers.json pro Instanz plus echter Server-Ping.
// - skins.* ist noch ein PLATZHALTER, der auf die Team-Implementierung wartet.
//   Die Reject-Meldung ist absichtlich sprechend, damit im UI klar sichtbar
//   wird, was noch fehlt, statt stumm mit leeren Daten zu antworten.

const { ipcMain, dialog, app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Die drei Module, die vorher nur geschrieben, aber nie aufgerufen wurden.
// Erst jetzt ist die Kette vollständig: Instanz -> Java -> Dateien -> Prozess.
const { detectJava, downloadJava, requiredJavaMajor } = require('./java-runtime');
const { ensureVersionFiles, resolveLaunchOptions } = require('./downloader');
const { launchProcess, stopProcess } = require('./process');

// Microsoft-Login. auth.js kapselt die OAuth-Kette, account-store.js das
// verschluesselte Speichern der Tokens.
const auth = require('./auth');
const { AccountStore } = require('./account-store');
const worlds = require('./worlds');
// Server-Ping (MOTD, Spielerzahl, Latenz). formatAddress wird schon VOR dem
// Download gebraucht: eine kaputte Adresse in der servers.json soll den
// Start abbrechen und nicht erst das Spiel mit einer kaputten Option wecken.
const { pingServer, formatAddress } = require('./mc-ping');
// Startoptionen pro Instanz (RAM, Aufloesung). Die Pruefung sitzt in diesem
// Modul und nicht im UI: die Werte landen als `-Xmx…` bzw. `--width …` in der
// Befehlszeile, und eine falsche Zahl ist dort kein Formularfehler, sondern
// ein Spiel, das gar nicht erst startet. Siehe der Kommentar am Dateianfang.
const instSettings = require('./instance-settings');

const MODPACKS = [
  { id: 'talberg', name: 'Talberg', version: '1.21.4', modloader: 'fabric', lastPlayed: new Date(Date.now() - 2 * 3600e3).toISOString(), iconUrl: null },
  { id: 'vanilla-survival', name: 'Vanilla Survival', version: '1.21.4', modloader: 'vanilla', lastPlayed: new Date(Date.now() - 26 * 3600e3).toISOString(), iconUrl: null },
  { id: 'atm10', name: 'All the Mods 10', version: '1.20.1', modloader: 'forge', lastPlayed: new Date(Date.now() - 5 * 86400e3).toISOString(), iconUrl: null },
  { id: 'create-ab', name: 'Create: Above and Below', version: '1.20.1', modloader: 'forge', lastPlayed: new Date(Date.now() - 12 * 86400e3).toISOString(), iconUrl: null }
];

const instanceStatus = {};       // instanceId -> 'idle' | 'starting' | 'running' | 'crashed'
let activeRunningId = null;      // nur eine Instanz gleichzeitig "läuft", wie bei echten Launchern üblich
const runningProcesses = new Map(); // instanceId -> die instanceId, die process.js selbst vergibt

// ---------- Logdatei ----------
// Das UI zeigt die Log-Zeilen bisher nur in der DevTools-Konsole. Nach dem
// Schließen des Fensters ist ein Absturz damit weg — und "warum ist das
// gerade abgestürzt?" lässt sich nicht beantworten. Deshalb landet alles
// zusätzlich in %APPDATA%/liquid-launcher/logs/launch.log
let runLogStream = null;
function appendRunLog(line, level) {
  try {
    if (!runLogStream) {
      const dir = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      runLogStream = fs.createWriteStream(path.join(dir, 'launch.log'), { flags: 'a' });
    }
    runLogStream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
  } catch {
    // Logging darf einen Start nie zum Scheitern bringen.
  }
}

// ---------- gemeinsame Instanz-Ordnerstruktur ----------
// %APPDATA%/liquid-launcher/instances/<instanceId>/mods|resourcepacks|...
// Wird hier zentral definiert, weil mods.js, servers.js, resourcepacks
// (und später downloader.js) alle denselben Ordner pro Instanz brauchen.
function instanceDir(instanceId) {
  // Das UI ruft z.B. mods:listInstalled schon beim Öffnen des Mod-Panels auf —
  // und zu dem Zeitpunkt ist unter Umständen noch keine Instanz gewählt
  // (currentInstanceId === null). Ohne diese Prüfung wirft path.join() mit
  // null einen ERR_INVALID_ARG_TYPE, der im Main-Prozess nur als kryptischer
  // Stacktrace auftaucht. Eine klare Meldung kann das UI anzeigen.
  if (!instanceId || typeof instanceId !== 'string') {
    throw new Error('Keine Instanz ausgewählt.');
  }
  const dir = path.join(app.getPath('userData'), 'instances', instanceId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function instanceSubDir(instanceId, sub) {
  const dir = path.join(instanceDir(instanceId), sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function broadcastStatus(webContents, instanceId, status) {
  instanceStatus[instanceId] = status;
  webContents.send('instances:statusChange', { instanceId, status });
}

function broadcastLog(webContents, instanceId, line, level = 'info') {
  appendRunLog(line, level);
  webContents.send('instances:log', { instanceId, line, level, timestamp: Date.now() });
}

// ---------- Fortschritt des Downloaders an das UI weiterreichen ----------
// ensureVersionFiles() sendet über 'downloader:progress' zwei Sorten Events:
//   { phase: 'log', line, level }        -> wird 1:1 als Log-Zeile durchgereicht
//   { phase: 'assets'|'libraries', current, total } -> Fortschritt
// Der Asset-Downloader meldet nach jeder der ~3000 Dateien, das wird
// gedrosselt (alle 10 Prozentpunkte), sonst flutet es das UI.
function createProgressForwarder(webContents, instanceId) {
  const lastPercent = {};
  return {
    send(channel, payload) {
      if (channel !== 'downloader:progress' || !payload) return;

      if (payload.phase === 'log') {
        broadcastLog(webContents, instanceId, payload.line, payload.level || 'info');
        return;
      }

      if (typeof payload.current === 'number' && payload.total) {
        const percent = Math.floor((payload.current / payload.total) * 100);
        const previous = lastPercent[payload.phase];
        if (percent < 100 && previous !== undefined && percent - previous < 10) return;
        lastPercent[payload.phase] = percent;

        const label = { libraries: 'Libraries', assets: 'Assets', client: 'Client-JAR' }[payload.phase]
          || payload.phase;
        broadcastLog(webContents, instanceId,
          `${label}: ${percent}% (${payload.current}/${payload.total})`);
      }
    }
  };
}

function registerIpcHandlers() {
  // ---------- instances (lauffähiger Demo-Stub, mehrere Modpacks) ----------
  ipcMain.handle('instances:list', async () => MODPACKS);

  ipcMain.handle('instances:launch', async (event, arg) => {
    const webContents = event.sender;

    // Bisher stand hier nur die Instanz-ID. Für Quick Play kommt ein Objekt
    // mit worldId dazu, später auch serverId. Beide Formen werden akzeptiert,
    // damit die älteren Aufrufe im Renderer (die noch die nackte ID schicken)
    // weiterlaufen.
    const opts = (arg && typeof arg === 'object') ? arg : { instanceId: arg };
    const instanceId = opts.instanceId;
    const worldId = opts.worldId || null;
    const serverId = opts.serverId || null;

    const modpack = MODPACKS.find(m => m.id === instanceId);
    if (!modpack) throw new Error(`Unbekannte Instanz: ${instanceId}`);

    if (activeRunningId && activeRunningId !== instanceId) {
      throw new Error('Es läuft bereits eine andere Instanz. Bitte zuerst beenden.');
    }
    const current = instanceStatus[instanceId];
    if (current === 'running' || current === 'starting') return;

    broadcastStatus(webContents, instanceId, 'starting');
    broadcastLog(webContents, instanceId,
      `Starte „${modpack.name}" (${modpack.version}, ${modpack.modloader}) …`);

    // ---- 0a) Quick-Play-Ziel prüfen ----
    // Muss VOR dem Download passieren: eine nicht existierende Welt oder ein
    // Server, den es nicht gibt, soll nicht erst nach 500 MB Download
    // scheitern. Beide Ziele werden gegen die echte Liste geprüft, damit ein
    // manipulierter Wert aus dem Renderer hier schon auffällt und nicht erst
    // beim Spiel.
    let quickPlay = null;

    if (worldId && serverId) {
      broadcastStatus(webContents, instanceId, 'idle');
      throw new Error('Ein Start kann nur ein Ziel haben — entweder eine Welt oder einen Server.');
    }

    if (serverId) {
      // Aus der echten servers.json, nicht aus dem mitgeschickten Wert. Der
      // Renderer könnte sonst eine beliebige Adresse einschleusen; wir nehmen
      // nur, was in der Liste steht.
      const eintraege = loadServers(instanceId);
      const treffer = eintraege.find(s => s && s.id === serverId);
      if (!treffer) {
        broadcastStatus(webContents, instanceId, 'idle');
        throw new Error(`Server "${serverId}" steht nicht in der Serverliste dieser Instanz.`);
      }
      // Die Adresse wird hier noch einmal zerlegt. Ein Eintrag in der
      // servers.json kann von Hand kaputt sein ("host:abc") — das darf nicht
      // erst das Spiel mit einer kaputten Option aufwecken.
      let ziel;
      try {
        ziel = formatAddress(treffer.address);
      } catch (err) {
        broadcastStatus(webContents, instanceId, 'idle');
        throw new Error(`Server „${treffer.name}" hat eine ungültige Adresse: ${err.message}`);
      }
      quickPlay = { multiplayer: ziel };
      broadcastLog(webContents, instanceId, `Direkt auf „${treffer.name}" (${ziel}) beitreten.`);
    }

    if (worldId) {
      const verfuegbar = worlds.listWorlds(instanceDir(instanceId));
      const treffer = verfuegbar.find(w => w.id === worldId);
      if (!treffer) {
        broadcastStatus(webContents, instanceId, 'idle');
        throw new Error(`Welt "${worldId}" gibt es in dieser Instanz nicht.`);
      }
      if (treffer.broken) {
        broadcastStatus(webContents, instanceId, 'idle');
        throw new Error(`Welt "${treffer.name}" ist beschädigt (${treffer.error}). Start ohne Quick Play.`);
      }
      quickPlay = { singleplayer: treffer.id };
      broadcastLog(webContents, instanceId, `Direkt in die Welt „${treffer.name}" starten.`);
    }

    if (modpack.modloader && modpack.modloader !== 'vanilla') {
      broadcastLog(webContents, instanceId,
        `Hinweis: der Modloader „${modpack.modloader}" wird noch nicht geladen — ` +
        'gestartet wird Vanilla. Mods im mods-Ordner bleiben daher ohne Wirkung.', 'warn');
    }

    // ---- 0) Account prüfen und Token auffrischen ----
    // Muss VOR dem Download passieren: bei einem frischen Token sind die
    // schnell, aber wenn hier ein 401 herausfällt, war der 500-MB-Download die
    // reine Verschwendung.
    let launchAccount = null;
    {
      const active = accountStore.getActive();
      if (!active) {
        broadcastLog(webContents, instanceId,
          'Kein Microsoft-Account angemeldet — Minecraft startet ohne Anmeldung. ' +
          'Du kommst auf den Titelbildschirm, kannst aber keine Welt laden. ' +
          'Zum Anmelden: oben rechts auf das Avatar-Symbol klicken.', 'warn');
      } else {
        if (!auth.isAccountTokenValid(active)) {
          broadcastLog(webContents, instanceId, `Anmeldedaten für ${active.username} sind abgelaufen — erneuere …`);
          try {
            const refreshed = await auth.refreshAccount(userDataDir, active);
            accountStore.upsert(refreshed);
            broadcastLog(webContents, instanceId, `Als ${refreshed.username} angemeldet.`);
          } catch (err) {
            broadcastLog(webContents, instanceId,
              `Anmeldedaten konnten nicht erneuert werden (${err.message}). ` +
              'Bitte neu anmelden — Minecraft startet sonst ohne gültige Anmeldung.', 'error');
          }
        } else {
          broadcastLog(webContents, instanceId, `Angemeldet als ${active.username}.`);
        }
        launchAccount = buildLaunchAccount();
        if (launchAccount) {
          broadcastLog(webContents, instanceId, `XUID: ${launchAccount.xuid || '(nicht gesetzt)'}`);
        }
      }
    }

    // ---- 1) Java finden (oder die passende JRE automatisch nachladen) ----
    const javaMajor = requiredJavaMajor(modpack.version);
    let java = await detectJava(javaMajor);
    if (!java.found || !java.isCompatible) {
      broadcastLog(webContents, instanceId, java.found
        ? `Installiertes Java ${java.version} ist zu alt — lade Java ${javaMajor} (Adoptium) …`
        : `Kein passendes Java gefunden — lade Java ${javaMajor} (Adoptium) …`, 'warn');
      const installed = await downloadJava(javaMajor, path.join(app.getPath('userData'), 'java'));
      java = { found: true, path: installed.path, isCompatible: true };
      broadcastLog(webContents, instanceId, `Java ${javaMajor} bereit.`);
    } else {
      broadcastLog(webContents, instanceId, `Java ${java.version} gefunden: ${java.path}`);
    }

    // ---- 2) Fehlende Dateien nachladen (Libraries, Client-JAR, Assets) ----
    // gameDir ist der Instanzordner: saves/, mods/ und config/ landen damit
    // pro Instanz getrennt voneinander.
    const gameDir = instanceDir(instanceId);
    const downloadResult = await ensureVersionFiles(modpack.version, createProgressForwarder(webContents, instanceId));

    // ---- 3) Launch-Optionen zusammenbauen ----
    // RAM und Aufloesung kommen aus den Startoptionen DIESER Instanz. Vorher
    // standen hier fest 1G/2G und 1280x720 — auf einem 32-GB-Rechner damit
    // furchtbar unterversorgt und auf einem 4-GB-Notebook eine Einladung, in
    // den Swap zu laufen.
    //
    // loadSettings() kann nicht werfen: eine kaputte oder von Hand
    // manipulierte Einstellungsdatei faellt auf die Standardwerte zurueck.
    // Sie darf einen Start nie verhindern — nur nicht beeinflussen.
    const opts2 = instSettings.loadSettings(instanceDir(instanceId));
    const eingaben = instSettings.toLaunchInputs(opts2);
    broadcastLog(webContents, instanceId,
      `RAM: ${opts2.ramMinGb}–${opts2.ramMaxGb} GB, Fenster: ${opts2.width}×${opts2.height}`);
    // Die Warnungen kommen ins Log, nicht in den Vordergrund: "8 GB auf einem
    // 4-GB-Rechner" ist erlaubt, aber der Benutzer sollte es wissen.
    for (const w of instSettings.warnungen(opts2)) {
      broadcastLog(webContents, instanceId, `Hinweis zur Speicherzuweisung: ${w}`, 'warn');
    }

    const launchOptions = resolveLaunchOptions(
      downloadResult,
      launchAccount,
      java.path,
      gameDir,
      eingaben.resolution,
      eingaben.memory,
      quickPlay
    );

    // ---- 4) Prozess starten und seine Events durchreichen ----
    broadcastLog(webContents, instanceId, `Starte JVM: ${launchOptions.mainClass}`);
    const emitter = launchProcess(launchOptions);
    // process.js vergibt eine EIGENE instanceId (mc-<zeit>-<zufall>) — die
    // wird hier gemerkt, damit instances:stop den richtigen Prozess findet.
    runningProcesses.set(instanceId, emitter.instanceId);

    const finish = (status) => {
      if (runningProcesses.get(instanceId) === emitter.instanceId) {
        runningProcesses.delete(instanceId);
      }
      if (activeRunningId === instanceId) activeRunningId = null;
      broadcastStatus(webContents, instanceId, status);
    };

    // process.js meldet 'running', sobald die erste echte Log-Zeile da ist.
    // Fallback: sonst bleibt das UI bei einem hängenden JVM ewig auf
    // "Startet …" stehen.
    const runningFallback = setTimeout(() => {
      if (runningProcesses.has(instanceId) && instanceStatus[instanceId] === 'starting') {
        activeRunningId = instanceId;
        broadcastStatus(webContents, instanceId, 'running');
      }
    }, 20000);

    emitter.on('log', ({ line, level }) => broadcastLog(webContents, instanceId, line, level));

    emitter.on('running', () => {
      clearTimeout(runningFallback);
      activeRunningId = instanceId;
      broadcastStatus(webContents, instanceId, 'running');
    });

    emitter.on('closed', ({ exitCode }) => {
      clearTimeout(runningFallback);
      finish('idle');
      broadcastLog(webContents, instanceId, `Minecraft wurde beendet (Exit-Code ${exitCode}).`);
    });

    emitter.on('crashed', ({ exitCode, lastLogLines, error }) => {
      clearTimeout(runningFallback);
      finish('crashed');
      broadcastLog(webContents, instanceId, `Minecraft ist abgestürzt (Exit-Code ${exitCode}).`, 'error');
      if (error) broadcastLog(webContents, instanceId, error, 'error');
      (lastLogLines || []).slice(-15).forEach(line => broadcastLog(webContents, instanceId, line, 'error'));
    });
  });

  ipcMain.handle('instances:stop', async (event, instanceId) => {
    const webContents = event.sender;
    const processInstanceId = runningProcesses.get(instanceId);

    if (!processInstanceId) {
      // Nichts läuft (mehr) — trotzdem den zurücksetzen, damit der Button
      // nicht auf einem verklemmten "läuft"-Status sitzen bleibt.
      if (activeRunningId === instanceId) activeRunningId = null;
      instanceStatus[instanceId] = 'idle';
      broadcastStatus(webContents, instanceId, 'idle');
      return;
    }

    broadcastLog(webContents, instanceId, 'Beende Minecraft …');
    // 10 s Timeout: danach wird der Prozessbaum erzwungen beendet, damit kein
    // JVM als Waisenprozess zurückbleibt.
    const stopped = await stopProcess(processInstanceId);
    runningProcesses.delete(instanceId);
    if (activeRunningId === instanceId) activeRunningId = null;
    broadcastLog(webContents, instanceId, stopped ? 'Minecraft beendet.' : 'Minecraft beendet (erzwungen).');
    broadcastStatus(webContents, instanceId, 'idle');
  });

  // ---------- auth (echter Microsoft-Login) ----------
  // Bis hierher stand hier eine Demo: addAccount erfand einfach einen Namen.
  // Jetzt laeuft die echte OAuth-Kette ueber auth.js, und die Tokens werden
  // verschluesselt in accounts.json abgelegt (siehe account-store.js).
  //
  // Grundregel fuer diesen ganzen Block: Was ueber ipcMain zurueckgeht, ist
  // immer die *oeffentliche* Form (toPublicAccount / store.list()). Das echte
  // accessToken bleibt im Haupt-Prozess. Der Renderer ist die Stelle, die am
  // leichtesten kompromittiert wird — dort darf ein Credential nicht liegen.
  const userDataDir = app.getPath('userData');
  const accountStore = new AccountStore(userDataDir, safeStorage);
  accountStore.load();

  // Loggt alle abgelaufenen Tokens still im Hintergrund auf. Wird beim Start
  // und vor jedem Spielstart aufgerufen.
  async function refreshExpiredAccounts() {
    const refreshed = [];
    for (const publicAccount of accountStore.list()) {
      const stored = accountStore.get(publicAccount.id);
      if (!stored || auth.isAccountTokenValid(stored)) continue;
      if (!stored.refreshToken) continue;

      try {
        const updated = await auth.refreshAccount(userDataDir, stored);
        accountStore.upsert(updated);
        refreshed.push(updated.username);
      } catch (err) {
        // Ein fehlgeschlagener Refresh darf den Launcher nicht blockieren —
        // der Start meldet dann eben, dass neu angemeldet werden muss.
        console.error(`[auth] Token-Auffrischung für ${stored.username} fehlgeschlagen: ${err.message}`);
      }
    }
    return refreshed;
  }

  // Beim Start still auffrischen, damit der erste Klick auf "Spielen" nicht
  // auf ein abgelaufenes Token trifft. blockiert app.whenReady() nicht.
  setTimeout(() => {
    refreshExpiredAccounts().catch(() => {});
  }, 1000);

  ipcMain.handle('auth:listAccounts', async () => accountStore.list());

  ipcMain.handle('auth:addAccount', async (event) => {
    const webContents = event.sender;
    // Fortschritt an das UI, damit das 20-Sekunden-Fenster nicht wie ein
    // Haenger wirkt.
    const status = (text) => webContents.send('auth:status', { text });

    try {
      status('Anmeldung wird gestartet …');
      const account = await auth.loginWithMicrosoft(userDataDir, status);
      accountStore.upsert(account);
      accountStore.setActive(account.id);
      status(`Angemeldet als ${account.username}`);
      return auth.toPublicAccount(account);
    } catch (err) {
      status('');
      // Fenster wurden geschlossen -> kein Fehler, sondern einfach abgebrochen.
      const msg = String(err?.message || err);
      if (msg.includes('error.gui.closed') || msg.includes('abgebrochen')) {
        throw new Error('Anmeldung abgebrochen.');
      }
      throw err;
    }
  });

  ipcMain.handle('auth:removeAccount', async (event, accountId) => {
    if (!accountStore.remove(accountId)) throw new Error('Unbekannter Account.');
  });

  ipcMain.handle('auth:setActiveAccount', async (event, accountId) => {
    if (!accountStore.setActive(accountId)) throw new Error('Unbekannter Account.');
  });

  ipcMain.handle('auth:getActiveAccount', async () => {
    const active = accountStore.getActive();
    return active ? auth.toPublicAccount(active) : null;
  });

  // Neu anmelden ohne den Account zu ersetzen: praktisch, wenn die
  // accounts.json von einem anderen Rechner kopiert wurde (dann laesst sich
  // der Token nicht entschluesseln) oder das Token abgelaufen ist.
  ipcMain.handle('auth:needsRelogin', async (event, accountId) => {
    const stored = accountStore.get(accountId);
    return !stored || !stored.accessToken;
  });

  // ---------- Azure-Client-ID ----------
  // Vorher stand die Client-ID als Platzhalter im Quellcode, den man von Hand
  // austauschen und neu bauen musste. Sie kommt jetzt aus config.json und ist
  // zur Laufzeit aenderbar. Das ist wichtig fuer zwei Faelle: erstens die
  // Ersteinrichtung (der haeufigste Grund fuer den Abbruch), zweitens wenn
  // jemand die App-Registration wechselt.
  //
  // Eine Client-ID ist uebrigens kein Geheimnis: Public Client IDs stehen in
  // jedem Installer, den man herunterlaedt. Sie wird hier also zu Recht im UI
  // angezeigt und nicht wie ein Token behandelt.
  function configPath() {
    return path.join(userDataDir, 'config.json');
  }

  function readConfig() {
    try {
      if (!fs.existsSync(configPath())) return {};
      return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    } catch (err) {
      console.error('[config] config.json unlesbar:', err.message);
      return {};
    }
  }

  function writeConfig(config) {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Neben die bestehende Datei schreiben und dann umbenennen, damit ein
    // Stromausfall mitten im Schreiben nicht die Konfiguration zerstört.
    const tmp = `${configPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath());
  }

  // Wie in setup-client-id.js: Azure-Client-IDs sind immer eine UUID. Das
  // haeufigste Problem beim Einfuegen ist eine kopierte Beschriftung statt
  // der GUID, und das faellt hier sofort auf.
  const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  ipcMain.handle('auth:getClientId', async () => {
    const config = readConfig();
    return {
      clientId: config.microsoftClientId || '',
      redirectUri: config.microsoftRedirectUri || auth.DEFAULT_REDIRECT_URI,
      // Immer false, weil eine "vollstaendig konfigurierte" App-Registrierung
      // sich technisch nicht pruefen laesst — das zeigt erst der Login.
      configured: !!(config.microsoftClientId || '').trim()
    };
  });

  ipcMain.handle('auth:setClientId', async (event, clientId) => {
    const wert = String(clientId || '').trim();

    // Leer heisst: zuruecksetzen. Das ist eine legitime Aktion (z.B. wenn man
    // den Login erst einrichten will und nicht weiss, welche ID man hat) und
    // muss nicht blockiert werden.
    if (wert === '') {
      const config = readConfig();
      delete config.microsoftClientId;
      writeConfig(config);
      auth.resetClientIdCache();
      return { ok: true, clientId: '' };
    }

    if (!CLIENT_ID_PATTERN.test(wert)) {
      throw new Error(
        `"${wert}" ist keine GUID. Erwartet wird 12345678-1234-1234-1234-123456789012.\n\n` +
        'In Azure gibt es zwei aehnlich aussehende Werte:\n' +
        '  Directory (tenant) ID    -> falsch, ergibt einen leeren Login\n' +
        '  Application (client) ID  -> richtig\n\n' +
        'Oder die Umgebungsvariable LIQUID_LAUNCHER_CLIENT_ID setzen.'
      );
    }

    const config = readConfig();
    config.microsoftClientId = wert.toLowerCase();
    writeConfig(config);
    // Ohne das Leeren des Caches wuerde die neue ID erst nach einem Neustart
    // verwendet — und der naechste Loginversuch schlaege mit der alten fehl.
    auth.resetClientIdCache();

    return { ok: true, clientId: config.microsoftClientId };
  });

  // ---------- Account für den Spielstart ----------
  // Wandelt den aktiven Account in das Objekt, das downloader.buildGameArgs()
  // braucht. Enthaelt das ECHTE accessToken — dieser Aufruf bleibt daher
  // ausschliesslich im Haupt-Prozess und geht nie zum Renderer.
  function buildLaunchAccount() {
    const active = accountStore.getActive();
    if (!active) return null;
    return auth.toLaunchAccount(active, userDataDir);
  }

  // ---------- Welten ----------
  // Liest die Spielstände aus <instanz>/saves/. Die Metadaten kommen aus der
  // level.dat (NBT, kein JSON) — siehe src/main/nbt.js.
  //
  // Der Ordner wird beim Auflisten NICHT angelegt. instanceDir() erzeugt ihn
  // zwar, aber eine frische Instanz soll auch ohne saves-Ordner sauber
  // funktionieren — und nicht schon beim bloßen Ansehen der Ansicht Spuren im
  // Dateisystem hinterlassen.
  ipcMain.handle('worlds:list', async (event, instanceId) => {
    return worlds.listWorlds(instanceDir(instanceId));
  });

  ipcMain.handle('worlds:delete', async (event, instanceId, worldId) => {
    const dir = instanceDir(instanceId);

    // Löschen ist endgültig. Deshalb zwei Sperren:
    //  1. Die Instanz darf nicht laufen — sonst schreibt das Spiel gerade in
    //     genau die Ordner, die weg sollen.
    //  2. Es muss mehrere Welten geben, damit der Button nicht versehentlich
    //     die einzige Welt eines frischen Spielstands entfernt. Die Rückfrage
    //     im UI deckt den Rest ab.
    const laeuft = runningProcesses.has(instanceId) || instanceStatus[instanceId] === 'running';
    if (laeuft) {
      throw new Error('Diese Instanz läuft gerade. Beende sie zuerst — sonst wird die Welt beim Speichern neu angelegt.');
    }
    const vorhanden = worlds.listWorlds(dir);
    if (vorhanden.length <= 1) {
      throw new Error(
        'Das ist die einzige Welt dieser Instanz. Um sie zu löschen, zuerst im Spiel ' +
        'eine neue Welt anlegen — sonst wäre der Spielstand weg.'
      );
    }

    worlds.deleteWorld(dir, worldId);
    appendRunLog(`Welt "${worldId}" aus Instanz ${instanceId} gelöscht.`, 'warn');
    return { ok: true, remaining: worlds.listWorlds(dir).length };
  });

  // ---------- mods ----------
  // Echte Modrinth-Anbindung: Suche, Versions-Auflösung passend zu
  // Minecraft-Version + Modloader der Instanz, Download, SHA1-Verifikation.
  // Kein API-Key nötig (öffentliche, kostenlose API).
  const MODRINTH_BASE = 'https://api.modrinth.com/v2';
  const USER_AGENT = 'liquid-launcher/0.1 (privates Hobby-Projekt)';

  async function modrinthGet(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      throw new Error(`Modrinth-Anfrage fehlgeschlagen (HTTP ${res.status}) für ${url}`);
    }
    return res.json();
  }

  let installedMods = []; // { id, name, source: 'catalog'|'local', filePath? }

  function modsDir(instanceId) {
    return instanceSubDir(instanceId, 'mods');
  }

  // ---------- Metadaten pro Instanz (überlebt Neustarts) ----------
  // Eine bloße .jar-Datei sagt uns nicht, von welchem Modrinth-Projekt sie
  // kommt oder ob sie als "eventuell inkompatibel" markiert war — das legen
  // wir daneben in einer kleinen JSON-Datei ab. Die Dateien selbst im
  // mods-Ordner bleiben die eigentliche Wahrheit (siehe listInstalledMods
  // unten, das den Ordner tatsächlich ausliest statt nur der Metadaten zu
  // vertrauen).
  function modsMetaPath(instanceId) {
    return path.join(instanceDir(instanceId), 'mods-meta.json');
  }
  function loadModsMeta(instanceId) {
    try {
      return JSON.parse(fs.readFileSync(modsMetaPath(instanceId), 'utf-8'));
    } catch {
      return {};
    }
  }
  function saveModsMeta(instanceId, meta) {
    try {
      fs.writeFileSync(modsMetaPath(instanceId), JSON.stringify(meta, null, 2));
    } catch (err) {
      console.error('Konnte mods-meta.json nicht schreiben:', err);
    }
  }

  ipcMain.handle('mods:search', async (event, query) => {
    const q = (query || '').trim();
    const facets = encodeURIComponent(JSON.stringify([['project_type:mod']]));
    const url = q
      ? `${MODRINTH_BASE}/search?query=${encodeURIComponent(q)}&limit=20&facets=${facets}`
      : `${MODRINTH_BASE}/search?limit=20&index=downloads&facets=${facets}`;
    const data = await modrinthGet(url);
    return data.hits.map(hit => ({
      id: hit.project_id,
      name: hit.title,
      description: hit.description,
      downloads: hit.downloads,
      iconUrl: hit.icon_url || null
    }));
  });

  // Lädt eine zur Instanz (Minecraft-Version + Modloader) passende Version
  // herunter, prüft die SHA1-Checksumme, legt die Datei im Mods-Ordner GENAU
  // DIESER Instanz ab (nicht mehr in einem gemeinsamen Demo-Ordner). Wird
  // sowohl für Neuinstallation als auch für "Update" genutzt.
  async function downloadModForInstance(instanceId, modId) {
    const modpack = MODPACKS.find(m => m.id === instanceId);
    const gameVersion = modpack ? modpack.version : null;
    const loader = modpack ? modpack.modloader : null;

    const project = await modrinthGet(`${MODRINTH_BASE}/project/${modId}`);

    let versions = [];
    let compatible = true;
    if (loader && loader !== 'vanilla' && gameVersion) {
      const loaderParam = encodeURIComponent(JSON.stringify([loader]));
      const versionParam = encodeURIComponent(JSON.stringify([gameVersion]));
      versions = await modrinthGet(
        `${MODRINTH_BASE}/project/${modId}/version?loaders=${loaderParam}&game_versions=${versionParam}`
      );
    }
    if (!versions.length) {
      // Keine exakt passende Version gefunden — neueste verfügbare nehmen,
      // aber als potenziell inkompatibel markieren statt einfach zu scheitern.
      compatible = false;
      versions = await modrinthGet(`${MODRINTH_BASE}/project/${modId}/version`);
    }
    if (!versions.length) {
      throw new Error(`Keine herunterladbare Version für "${project.title}" gefunden.`);
    }

    const version = versions[0];
    const file = version.files.find(f => f.primary) || version.files[0];
    if (!file) throw new Error(`Keine Datei in Version ${version.version_number} von "${project.title}" gefunden.`);

    const res = await fetch(file.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}) für ${file.filename}.`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const expectedSha1 = file.hashes && file.hashes.sha1;
    if (expectedSha1) {
      const actualSha1 = crypto.createHash('sha1').update(buffer).digest('hex');
      if (actualSha1 !== expectedSha1) {
        throw new Error(`Prüfsumme stimmt nicht überein für "${file.filename}" — Download verworfen, Datei nicht gespeichert.`);
      }
    }

    const targetPath = path.join(modsDir(instanceId), file.filename);
    fs.writeFileSync(targetPath, buffer);

    return {
      id: modId,
      name: project.title,
      source: 'modrinth',
      filename: file.filename,
      version: version.version_number,
      gameVersion: gameVersion || '—',
      loader: loader || '—',
      compatible
    };
  }

  // Der mods-Ordner selbst ist die Wahrheit: wir lesen ihn tatsächlich aus,
  // statt uns nur auf die Metadaten-Datei zu verlassen. So tauchen auch
  // Mods auf, die jemand von Hand reingelegt hat, und Mods, die von Hand
  // gelöscht wurden, verschwinden automatisch aus der Liste (statt als
  // "Geistereintrag" stehen zu bleiben).
  function listInstalledMods(instanceId) {
    const dir = modsDir(instanceId);
    const meta = loadModsMeta(instanceId);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'));
    } catch {
      files = [];
    }

    const byFilename = {};
    Object.entries(meta).forEach(([id, entry]) => { byFilename[entry.filename] = { id, ...entry }; });

    const result = files.map(filename => {
      const known = byFilename[filename];
      if (known) return known;
      // Datei ohne Metadaten-Eintrag (z.B. von Hand reingelegt) -> als lokale Datei behandeln
      return { id: `local:${filename}`, name: filename, source: 'local', filename };
    });

    // Verwaiste Metadaten-Einträge (Datei wurde von Hand gelöscht) aufräumen.
    let changed = false;
    Object.keys(meta).forEach(id => {
      if (!files.includes(meta[id].filename)) { delete meta[id]; changed = true; }
    });
    if (changed) saveModsMeta(instanceId, meta);

    return result;
  }

  ipcMain.handle('mods:install', async (event, instanceId, modId) => {
    const meta = loadModsMeta(instanceId);
    if (meta[modId]) return listInstalledMods(instanceId); // schon installiert
    const entry = await downloadModForInstance(instanceId, modId);
    meta[modId] = entry;
    saveModsMeta(instanceId, meta);
    return listInstalledMods(instanceId);
  });

  ipcMain.handle('mods:update', async (event, instanceId, modId) => {
    const meta = loadModsMeta(instanceId);
    const old = meta[modId];
    const entry = await downloadModForInstance(instanceId, modId);
    // Falls sich der Dateiname zwischen Versionen geändert hat, alte Datei entfernen.
    if (old && old.filename && old.filename !== entry.filename) {
      const oldPath = path.join(modsDir(instanceId), old.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    meta[modId] = entry;
    saveModsMeta(instanceId, meta);
    return listInstalledMods(instanceId);
  });

  ipcMain.handle('mods:remove', async (event, instanceId, modId) => {
    const meta = loadModsMeta(instanceId);
    const entry = meta[modId];
    if (entry && entry.filename) {
      const filePath = path.join(modsDir(instanceId), entry.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    delete meta[modId];
    saveModsMeta(instanceId, meta);
    return listInstalledMods(instanceId);
  });

  ipcMain.handle('mods:listInstalled', async (event, instanceId) => listInstalledMods(instanceId));

  // Echter, voll funktionierender Datei-Import — braucht keine Netzwerk-API,
  // funktioniert schon jetzt komplett fertig.
  ipcMain.handle('mods:importLocal', async (event, instanceId) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Mod-Datei auswählen',
      filters: [{ name: 'Minecraft Mods', extensions: ['jar'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const sourcePath = result.filePaths[0];
    const fileName = path.basename(sourcePath);
    const targetPath = path.join(modsDir(instanceId), fileName);
    fs.copyFileSync(sourcePath, targetPath);

    // Lokal importierte Dateien brauchen keinen Metadaten-Eintrag —
    // listInstalledMods() erkennt sie automatisch anhand der Datei selbst.
    return { id: `local:${fileName}`, name: fileName, source: 'local', filename: fileName };
  });

  // ---------- servers ----------
  // Pro Instanz eine servers.json mit den eingetragenen Adressen. Dazu kommt
  // der echte Ping: MOTD, Spielerzahl, Version und Latenz kommen direkt vom
  // Server, ohne Minecraft zu starten.
  function serversPath(instanceId) {
    return path.join(instanceDir(instanceId), 'servers.json');
  }
  function loadServers(instanceId) {
    try {
      return JSON.parse(fs.readFileSync(serversPath(instanceId), 'utf-8'));
    } catch {
      return [];
    }
  }
  function saveServers(instanceId, list) {
    try {
      fs.writeFileSync(serversPath(instanceId), JSON.stringify(list, null, 2));
    } catch (err) {
      console.error('Konnte servers.json nicht schreiben:', err);
    }
  }

  ipcMain.handle('servers:list', async (event, instanceId) => loadServers(instanceId));

  ipcMain.handle('servers:add', async (event, instanceId, { name, address } = {}) => {
    if (!address || !String(address).trim()) throw new Error('Server-Adresse darf nicht leer sein.');
    // Die Adresse wird sofort geprüft und auf die kanonische Form gebracht.
    // Ein Eintrag, der beim Tippen kaputt ist, wird so gar nicht erst gespeichert
    // — sonst steht er ewig in der Liste und der Ping meldet jedes Mal
    // "Adresse ungültig", ohne dass man den Fehler beim Eintragen gesehen hat.
    const kanonisch = formatAddress(String(address).trim());
    const list = loadServers(instanceId);
    const entry = {
      id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: (name && String(name).trim()) || kanonisch,
      address: kanonisch
    };
    // Doppelte Einträge sind ein Klassiker: der Benutzer tippt denselben
    // Server zweimal ein und wundert sich über zwei Zeilen. Das ist kein
    // Fehler, den man dem Benutzer aufbürden muss.
    if (list.some(s => s && String(s.address).toLowerCase() === kanonisch.toLowerCase())) {
      throw new Error(`„${kanonisch}" steht schon in der Liste.`);
    }
    list.push(entry);
    saveServers(instanceId, list);
    return list;
  });

  ipcMain.handle('servers:remove', async (event, instanceId, serverId) => {
    const list = loadServers(instanceId).filter(s => s.id !== serverId);
    saveServers(instanceId, list);
    return list;
  });

  // Live-Ping. Nimmt eine Adresse und liefert IMMER ein Objekt mit
  // `online: boolean` — nie ein Reject. Der Grund: "Server nicht erreichbar"
  // ist ein ganz normaler Zustand in einer Serverliste und kein Fehler im
  // Programm. Ein Reject wuerde im Renderer einen Fehlerdialog aufpoppen
  // lassen, statt eine Zeile als offline zu zeigen.
  ipcMain.handle('servers:ping', async (event, address, opts = {}) => {
    try {
      return await pingServer(String(address || '').trim(), {
        // Der Renderer darf ein kuerzeres Zeitlimit setzen, damit die Liste
        // nicht minutenlang steht. Mehr als 15 s lässt pingServer nicht zu.
        timeout: Number(opts?.timeout) || 5000
      });
    } catch (err) {
      // pingServer wirft nicht — aber ein Fehler hier oben waere ein Bug, und
      // ein Bug darf die Liste nicht leeren.
      console.error('servers:ping unerwartet:', err);
      return {
        online: false,
        address: String(address || '').trim(),
        error: 'Ping fehlgeschlagen.',
        errorCode: 'internal',
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
      };
    }
  });

  // ---------- Startoptionen pro Instanz (RAM, Aufloesung) ----------
  // Zwei Kanaele, und beide antworten mit demselben Aufbau:
  //   { settings, limits, physicalRamGb, recommendedRamGb, warnungen, fehler }
  // Der Renderer bekommt damit alles, was er zum Anzeigen braucht, und muss
  // die Limits nicht selbst kennen. Dass die Grenzen im Haupt-Prozess stehen
  // und nicht im HTML, ist Absicht: sonst koennte eine veraenderte Oberflaeche
  // einen anderen Bereich erlauben als der Start dann tatsaechlich akzeptiert.
  function instSettingsAntwort(instanceId, settings) {
    const basis = instSettings.describe();
    return {
      settings: settings || basis.settings,
      // Wofuer der Knopf "Zuruecksetzen" zuruecksetzt. Steht hier und nicht
      // im Renderer, weil die Empfehlung vom physischen Speicher abhaengt —
      // den kennt nur der Haupt-Prozess.
      vorschlag: basis.settings,
      limits: basis.limits,
      physicalRamGb: basis.physicalRamGb,
      recommendedRamGb: basis.recommendedRamGb,
      // Ein Problem aus der Datei (unlesbar, teilweise kaputt) wird
      // mitgeschickt, damit die Oberflaeche darauf hinweisen kann, statt die
      // Einstellungen kommentarlos zu ersetzen.
      problem: settings?._problem || null,
      warnungen: settings ? instSettings.warnungen(settings) : [],
      fehler: null
    };
  }

  ipcMain.handle('instanceSettings:get', async (event, instanceId) => {
    // instanceDir() validiert die ID und legt den Ordner an. Wichtig: erst
    // hier, und nicht schon beim Auflisten — sonst entstuenden beim blosser
    // Ansehen der Startoptionen Ordner fuer Instanzen, die es nicht gibt.
    const settings = instSettings.loadSettings(instanceDir(instanceId));
    return instSettingsAntwort(instanceId, settings);
  });

  ipcMain.handle('instanceSettings:set', async (event, instanceId, partial) => {
    const dir = instanceDir(instanceId);
    // Ausgangspunkt ist der aktuelle Stand auf der Platte, nicht der
    // Standard: sonst wuerde ein Aufruf, der nur die Aufloesung aendert, den
    // RAM auf den Standard zuruecksetzen.
    const alt = instSettings.loadSettings(dir);
    let geprueft;
    try {
      geprueft = instSettings.validateSettings({ ...alt, ...(partial || {}) });
    } catch (err) {
      // Die Meldung geht an den Renderer zurueck und wird dort angezeigt.
      // Der alte Stand bleibt unangetastet — ein Tippfehler darf keine
      // Einstellungen zerstoeren.
      return { ...instSettingsAntwort(instanceId, alt), fehler: err.message };
    }
    instSettings.saveSettings(dir, geprueft.settings);
    return instSettingsAntwort(instanceId, geprueft.settings);
  });

  // ---------- skins (Platzhalter, wartet auf Team 2 / skins.js + Mojang Services API) ----------
  ipcMain.handle('skins:getActive', async () => null);
  ipcMain.handle('skins:upload', () =>
    Promise.reject(new Error('skins.js ist noch nicht implementiert (Team 2).'))
  );
  ipcMain.handle('skins:setActive', () =>
    Promise.reject(new Error('skins.js ist noch nicht implementiert (Team 2).'))
  );

  // ---------- settings (persistiert auf Festplatte, überlebt Neustarts) ----------
  // Läuft über eine einfache JSON-Datei im App-Datenordner — kein
  // electron-store nötig, das Prinzip ist identisch zu window-state.json
  // in main.js. Hier landen: Theme, Sprache, Fenster-Block-Layout usw.
  function settingsPath(){
    return path.join(app.getPath('userData'), 'settings.json');
  }

  function loadSettingsFromDisk(){
    try {
      const raw = fs.readFileSync(settingsPath(), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {}; // Datei existiert noch nicht (erster Start) oder ist beschädigt
    }
  }

  function saveSettingsToDisk(store){
    try {
      fs.writeFileSync(settingsPath(), JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('Konnte settings.json nicht schreiben:', err);
    }
  }

  let settingsStore = loadSettingsFromDisk();

  ipcMain.handle('settings:get', async () => settingsStore);
  ipcMain.handle('settings:set', async (event, partial) => {
    settingsStore = { ...settingsStore, ...partial };
    saveSettingsToDisk(settingsStore);
    return settingsStore;
  });
}

module.exports = { registerIpcHandlers };
