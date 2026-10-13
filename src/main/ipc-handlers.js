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
// - skins.* ist ECHT fuer die ANZEIGE: eigene Skin-PNG waehlen, pruefen
//   (64x64 oder 64x32), im Datenordner ablegen, als Data-URI liefern.
//   skins:setActive (echter Skinwechsel bei Mojang) bleibt ein Reject,
//   weil dafuer ein angemeldetes Microsoft-Konto noetig ist - siehe README.

const { ipcMain, dialog, app, safeStorage, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Die drei Module, die vorher nur geschrieben, aber nie aufgerufen wurden.
// Erst jetzt ist die Kette vollständig: Instanz -> Java -> Dateien -> Prozess.
const { detectJava, downloadJava, requiredJavaMajor } = require('./java-runtime');
const { ensureVersionFiles, resolveLaunchOptions, getVersionManifest } = require('./downloader');
const fabricLoader = require('./fabricLoader');
const { launchProcess, stopProcess, getActiveProcesses } = require('./process');

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
// Widget-Suche, Manifest-Pruefung und die Positivliste der Daten, die ein
// Widget sehen darf. Ohne require('electron') im Modul selbst, damit
// test-widgets.js unter reinem Node laufen kann - dieselbe Regel wie bei
// app-paths.js.
const widgetsMod = require('./widgets');
// Systemwerte fuer die Overview-Widgets: CPU, RAM, Datentraeger, Ordnergroessen.
// Wie widgets.js ohne electron - test-widget-systemdaten.js laeuft unter
// reinem Node.
const systemdaten = require('./systemdaten');
// Modpacks: Anlegen, Auflisten, Umbenennen, Loeschen, Duplizieren. Bis hierher
// stand die Liste als festes Array unten im Code — siehe instancesMod weiter
// unten, dort steht, was das ersetzt hat und warum.
const instancesMod = require('./instances');
// Ressourcenpakete: Ordner resourcepacks/ lesen, .zip importieren, loeschen und
// — anders als bei den Mods — im Spiel ein- und ausschalten. Das Modul nimmt
// einen absoluten Instanzordner und benutzt weder Fenster noch Dialog, damit
// es unter reinem Node pruefbar bleibt (test-ressourcenpakete.js).
const resourcepacks = require('./resourcepacks');
// Modpack-Import: .mrpack (Modrinth) und CurseForge-Zips (manifest.json).
// Das Modul ist frei von electron (test-modpack-import.js laeuft unter reinem
// Node): hier stecken nur die IPC-Rahmen dazu — Dateidialog, Instanz-Anlage
// und die echte Download-/SHA1-Logik, analog zu mods.js.
const modpackImport = require('./modpackImport');

// userData einmal holen. Der Pfad steckt in fast jedem Aufruf weiter unten.
function userData() {
  return app.getPath('userData');
}

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
  // ---------- Modpacks ----------
  //
  // Bis hierher stand hier ein festes Array `MODPACKS` mit vier erfundenen
  // Eintraegen, zurueckgegeben von einem Handler, der sonst nichts konnte.
  // Daraus folgt, dass kein neues Modpack entstehen konnte, keines
  // verschwinden konnte, und `lastPlayed` bei jedem Start des Launchers neu
  // berechnet wurde - es stand dort `Date.now() - 2 * 3600e3`, also immer
  // "vor zwei Stunden", egal ob jemals gespielt wurde.
  //
  // Jetzt: instancesMod liest die Ordner unter %APPDATA%/instances/ und deren
  // instance.json. Ein Ordner, der ohne instance.json dasteht (Altbestand),
  // wird erkannt, aber NICHT beim Lesen beschrieben - siehe instances.js.

  /**
   * Einen Modpack fuer den Start holen, mit klarer Meldung statt undefined.
   */
  function modpackSuchen(instanceId) {
    const treffer = instancesMod.listen(userData()).find((m) => m.id === instanceId);
    if (!treffer) throw new Error(`Unbekanntes Modpack: ${instanceId}`);
    return treffer;
  }

  ipcMain.handle('instances:list', async () => instancesMod.listen(userData()));

  ipcMain.handle('instances:create', async (event, angabe) =>
    instancesMod.anlegen(userData(), angabe || {}));

  ipcMain.handle('instances:rename', async (event, instanceId, name) =>
    instancesMod.umbenennen(userData(), instanceId, name));

  ipcMain.handle('instances:setTechnik', async (event, instanceId, angabe) =>
    instancesMod.technikSetzen(userData(), instanceId, angabe || {}));

  ipcMain.handle('instances:duplicate', async (event, instanceId, name) =>
    instancesMod.duplizieren(userData(), instanceId, name));

  ipcMain.handle('instances:remove', async (event, instanceId) => {
    // Ein laufendes Spiel darf nicht unter den Fuessen weg geloescht werden:
    // die JVM schreibt weiter in Saves, Mods und Logs, und das Ergebnis waere
    // eine halb geschriebene Welt. Deshalb hier die Pruefung und NICHT
    // weiter unten im Modul - dort koennte man sie leicht umgehen.
    if (activeRunningId === instanceId || instanceStatus[instanceId] === 'running' ||
        instanceStatus[instanceId] === 'starting') {
      throw new Error('Dieses Modpack laeuft gerade. Erst beenden, dann loeschen.');
    }
    if (runningProcesses.has(instanceId)) {
      throw new Error('Dieses Modpack laeuft gerade. Erst beenden, dann loeschen.');
    }
    return instancesMod.entfernen(userData(), instanceId);
  });

  // Versionsliste fuer den Dialog "Neues Modpack". Aus dem echten
  // Manifest von Mojang, nicht aus einer Liste im Code: eine Liste hier
  // koennte nur so alt sein wie die letzte Anpassung, und dann schlaegt der
  // Start mit einer Version fehl, die es nicht gibt.
  ipcMain.handle('instances:versions', async () => {
    const manifest = await getVersionManifest();
    if (!manifest || !Array.isArray(manifest.versions)) return [];
    // Release-Versionen zuerst, und innerhalb einer Reihe das neueste zuerst.
    const heute = Date.now();
    return manifest.versions
      .filter((v) => v && typeof v.id === 'string')
      .map((v) => ({
        id: v.id,
        typ: v.type === 'release' ? 'release' : (v.type === 'snapshot' ? 'snapshot' : 'old_beta'),
        zeit: v.releaseTime ? Date.parse(v.releaseTime) : 0
      }))
      .sort((a, b) => {
        // Nur die letzten Releases zeigen: die aeltesten Eintraege des
        // Manifests sind Beta-Versionen von 2011, die niemand hier braucht.
        if (a.typ !== b.typ) return a.typ === 'release' ? -1 : 1;
        return b.zeit - a.zeit;
      })
      .filter((v) => v.typ === 'release' || v.zeit > heute - 1000 * 60 * 60 * 24 * 365)
      .slice(0, 60);
  });

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

    const modpack = modpackSuchen(instanceId);

    if (activeRunningId && activeRunningId !== instanceId) {
      throw new Error('Es läuft bereits eine andere Instanz. Bitte zuerst beenden.');
    }
    const current = instanceStatus[instanceId];
    if (current === 'running' || current === 'starting') return;

    broadcastStatus(webContents, instanceId, 'starting');
    // Die Zeile "Starte ..." kommt erst nach der Quick-Play- und der
    // Versionspruefung - sonst stuende sie im Log, bevor klar ist, ob der
    // Start ueberhaupt stattfindet.

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

    // ---- 0b) Startbarkeit des Modpacks prüfen ----
    // Steht HINTER der Quick-Play-Pruefung und absichtlich nicht davor: wer
    // auf "Verbinden" zu einem Server klickt, der nicht in der Liste steht,
    // soll genau DAS erfahren und nicht "keine Version hinterlegt". Beides
    // ist ein Fehler, aber nur einer davon betrifft die gerade geklickte
    // Aktion. Und es steht trotzdem noch vor dem Download - ein 500-MB-
    // Download fuer ein Modpack, das gar nicht starten kann, waere die
    // teuerste denkbare Form von "das hat nicht geklappt".
    if (!modpack.version) {
      broadcastStatus(webContents, instanceId, 'idle');
      throw new Error(
        `Für „${modpack.name}" ist keine Minecraft-Version hinterlegt. ` +
        'Bitte im Modpack die Version nachtragen, sonst lässt es sich nicht starten.'
      );
    }
    broadcastLog(webContents, instanceId,
      `Starte „${modpack.name}" (${modpack.version}, ${modpack.modloader}) …`);

    // ---- Modloader bestimmen ----
    // Fabric ist verdrahtet: die Loader-Version kommt aus der Instanz, sonst
    // wird die neueste stabile von meta.fabricmc.net geholt und in der
    // instance.json gemerkt, damit derselbe Stand beim naechsten Start
    // wiederkommt. Forge bleibt vorerst beim ehrlichen Vanilla-Hinweis.
    let loader = null;
    if (modpack.modloader && modpack.modloader !== 'vanilla') {
      if (modpack.modloader === 'fabric') {
        let loaderVersion = modpack.loaderVersion || null;
        if (!loaderVersion) {
          try {
            loaderVersion = await fabricLoader.empfohleneLoaderVersion(modpack.version);
          } catch (err) {
            broadcastStatus(webContents, instanceId, 'idle');
            throw new Error(
              `Fabric Loader konnte nicht ermittelt werden (${err.message}). ` +
              'Bitte die Internetverbindung prüfen.'
            );
          }
          try {
            instancesMod.loaderVersionSetzen(userData(), instanceId, loaderVersion);
          } catch (err) {
            broadcastLog(webContents, instanceId,
              `Fabric Loader ${loaderVersion} konnte nicht gespeichert werden (${err.message}).`, 'warn');
          }
          broadcastLog(webContents, instanceId, `Fabric Loader ${loaderVersion} wird verwendet.`);
        }
        loader = { art: 'fabric', version: loaderVersion };
      } else {
        broadcastLog(webContents, instanceId,
          `Hinweis: der Modloader „${modpack.modloader}" wird noch nicht geladen — ` +
          'gestartet wird Vanilla. Mods im mods-Ordner bleiben daher ohne Wirkung.', 'warn');
      }
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
    const downloadResult = await ensureVersionFiles(
      modpack.version, createProgressForwarder(webContents, instanceId), loader);

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
      // "Zuletzt gespielt" wird genau hier festgehalten, und nicht schon beim
      // Klick: process.js meldet 'running', sobald die erste echte Log-Zeile
      // aus dem Spiel kommt. Ein Klick, bei dem der Download abbricht, ist
      // kein gespielter Abend und darf den Eintrag nicht verschieben.
      instancesMod.gespieltVermerken(userData(), instanceId);
    });

    emitter.on('closed', ({ exitCode, gewollt }) => {
      clearTimeout(runningFallback);
      finish('idle');
      // Zwei Faelle, zwei woertlich verschiedene Zeilen. Der Exit-Code eines
      // von uns abgebrochenen Spiels ist eine Nebensache und erzaehlt nichts
      // ueber den Zustand — ihn in den Text zu setzen hiesse, die Zahl als
      // Diagnose anzubieten. Bei einem Spiel, das sich selbst beendet hat,
      // ist er die interessantere Angabe.
      broadcastLog(webContents, instanceId, gewollt
        ? 'Minecraft wurde beendet.'
        : `Minecraft wurde beendet (Exit-Code ${exitCode}).`);
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

  /**
   * Facets fuer die Modrinth-Suche.
   *
   * Bis hierher wurde nur `project_type:mod` gesendet, egal welches Modpack
   * offen war. Die Anzeige listete damit die 20 meistgeladenen Mods
   * ueberhaupt — in einem 1.20.1-Forge-Pack tauchen darin 1.21-Mods auf,
   * und beim Klick auf "Installieren" laedt die jeweils neueste Datei, die
   * das Spiel dann nicht laedt. Die Instanz kam als Parameter an und
   * wurde nicht benutzt.
   *
   * Modrinth kennt die Spielversion als `versions:<id>` und den Loader als
   * eigene Kategorie (`categories:fabric` usw.).
   */
  function modFacets(instanceId) {
    const facets = ['project_type:mod'];
    const modpack = instancesMod.listen(userData()).find(m => m.id === instanceId);
    if (modpack) {
      if (modpack.version) facets.push(`versions:${modpack.version}`);
      // Vanilla hat keine Loader-Kategorie. Für ein Vanilla-Pack waere
      // `categories:vanilla` eine erfundene Kategorie und Modrinth wuerde
      // nach der falschen Schnittstelle suchen - dann lieber gar nicht.
      if (modpack.modloader && modpack.modloader !== 'vanilla') {
        facets.push(`categories:${modpack.modloader}`);
      }
    }
    return encodeURIComponent(JSON.stringify([facets]));
  }

  ipcMain.handle('mods:search', async (event, query, instanceId) => {
    const q = (query || '').trim();
    const facets = modFacets(instanceId);
    const url = q
      ? `${MODRINTH_BASE}/search?query=${encodeURIComponent(q)}&limit=20&facets=${facets}`
      : `${MODRINTH_BASE}/search?limit=20&index=downloads&facets=${facets}`;
    const data = await modrinthGet(url);
    // N3: die Antwort ungeprueft zu verwenden war ein Fehler. `hits` fehlt,
    // wenn Modrinth einmal ein anderes Format liefert, und `.map` darauf
    // wirft dann im Renderer einen TypeError, der als "Suche geht nicht"
    // ankommt statt als "Netzwerk antwortete komisch".
    if (!data || !Array.isArray(data.hits)) return [];
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
    const modpack = modpackSuchen(instanceId);
    const gameVersion = modpack.version;
    const loader = modpack.modloader;
    // Ohne Version laesst sich keine Mod-Datei auswaehlen: Modrinth liefert
    // pro Spielversion eine eigene Datei, und ohne die Angabe wuerde hier
    // stillschweigend die neueste geladen - die im Spiel dann nicht laedt.
    if (!gameVersion) {
      throw new Error(
        `Für „${modpack.name}" ist keine Minecraft-Version hinterlegt. ` +
        'Ohne diese Angabe lässt sich keine passende Mod-Datei wählen.'
      );
    }

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
      compatible,
      // Das Projektbild von Modrinth mitschreiben, damit die Liste der
      // installierten Mods dasselbe Bild zeigt wie das Suchergebnis. Aeltere
      // Eintraege in mods-meta.json haben das Feld nicht - renderInstalled
      // faellt dann auf das allgemeine Symbol zurueck.
      iconUrl: project.icon_url || null
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

  // ---------- packs (Ressourcenpakete) ----------
  // Der Ordner resourcepacks/ ist hier genauso die Wahrheit wie der mods-Ordner
  // bei den Mods: was nicht darin liegt, existiert fuer das Spiel nicht. Was
  // hinzukommt, ist der Schalter — er steht in options.txt und nicht in einer
  // eigenen Datei, weil das Spiel genau dort hinschaut.
  //
  // Der Instanzordner wird einmal geholt und durchgereicht; resourcepacks.js
  // braucht den absoluten Pfad und kennt selbst nichts von app.getPath().
  function packsInstance(instanceId) {
    return instanceDir(instanceId);
  }

  ipcMain.handle('packs:list', async (event, instanceId) =>
    resourcepacks.listPacks(packsInstance(instanceId)));

  ipcMain.handle('packs:setActive', async (event, instanceId, id, an) =>
    resourcepacks.setPackAktiv(packsInstance(instanceId), id, Boolean(an)));

  ipcMain.handle('packs:remove', async (event, instanceId, id) =>
    resourcepacks.removePack(packsInstance(instanceId), id));

  // Echter Datei-Import, ohne Netzwerk. Der Fenstertitel kommt aus dem
  // Renderer, damit er uebersetzt wird — mods:importLocal hardcodiert ihn
  // noch, das ist aber eine andere Baustelle.
  ipcMain.handle('packs:importLocal', async (event, instanceId, titel) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: titel || 'Ressourcenpaket auswählen',
      filters: [{ name: 'Minecraft Ressourcenpakete', extensions: ['zip'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return resourcepacks.importZip(packsInstance(instanceId), result.filePaths[0]);
  });

  // ---------- servers ----------
  // Pro Instanz eine servers.json mit den eingetragenen Adressen. Dazu kommt
  // der echte Ping: MOTD, Spielerzahl, Version und Latenz kommen direkt vom
  // Server, ohne Minecraft zu starten.
  function serversPath(instanceId) {
    return path.join(instanceDir(instanceId), 'servers.json');
  }
  /**
   * Serverliste lesen.
   *
   * Das JSON wird ungeprueft zurueckgegeben — das war ein Fehler. Eine
   * servers.json, die ein Objekt statt eines Arrays enthaelt (etwa
   * `{"servers": [...]}`, was ein aelterer Stand geschrieben hat), kam
   * hier als Objekt heraus. `servers:add` rief darauf `.push()` auf und
   * warf `TypeError: push is not a function`, `servers:remove` rechnete mit
   * `length` und einem Filter auf einem Objekt, und der Zaehler im UI kam
   * auf `undefined` und zeigte "undefined" an.
   *
   * 40 Zeilen weiter unten, in der Widget-Ausgabe, steht dieselbe Datei
   * richtig: erst prüfen, dass es ein Array ist, sonst `[]`. Diese beiden
   * Stellen sind jetzt auf dieselbe Art abgesichert.
   */
  function loadServers(instanceId) {
    try {
      const roh = JSON.parse(fs.readFileSync(serversPath(instanceId), 'utf-8'));
      return Array.isArray(roh) ? roh : [];
    } catch {
      // Datei fehlt oder ist kaputt: eine leere Liste ist der einzige
      // Zustand, in dem sich die Oberflaeche weiterarbeiten laesst.
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

  // ---------- skins ----------
  // Was hier passiert, ist die ANZEIGE im Launcher: eine eigene Skin-PNG
  // auswaehlen, im App-Datenordner ablegen und fuer Kopf-Anzeige und
  // gedrehte Vorschau benutzen (siehe Renderer, Abschnitt "Skin-Kopf").
  //
  // Was hier NICHT passiert: der echte Skin des Mojang-Accounts. Den
  // aendert nur die Session API mit angemeldetem Microsoft-Konto, und der
  // Login ist in dieser Version weiterhin blockiert (siehe README).
  // Darum bleibt skins:setActive ein sprechender Reject.
  const SKIN_ORDNER = path.join(userData(), 'skins');
  const SKIN_DATEI = path.join(SKIN_ORDNER, 'skin.png');
  const SKIN_MAX_BYTES = 2 * 1024 * 1024;

  // PNG-Signatur plus IHDR-Masse: 64x64 (heutiges Format) oder 64x32 (alte
  // Form ohne Aermel). Alles andere ist kein Skin - die Pruefung laeuft
  // VOR dem Kopieren, damit hier nichts Fremdes im Datenordner landet.
  function skinIstGueltig(puffer) {
    if (!puffer || puffer.length < 24) return false;
    const signatur = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < signatur.length; i++) if (puffer[i] !== signatur[i]) return false;
    if (puffer.toString('ascii', 12, 16) !== 'IHDR') return false;
    const breite = puffer.readUInt32BE(16);
    const hoehe = puffer.readUInt32BE(20);
    return breite === 64 && (hoehe === 64 || hoehe === 32);
  }

  ipcMain.handle('skins:upload', async (event) => {
    const eltern = BrowserWindow.fromWebContents(event.sender);
    const optionen = {
      title: 'Skin-Datei auswaehlen',
      properties: ['openFile'],
      filters: [{ name: 'Skin (PNG)', extensions: ['png'] }]
    };
    const antwort = eltern ? await dialog.showOpenDialog(eltern, optionen)
                           : await dialog.showOpenDialog(optionen);
    if (antwort.canceled || !antwort.filePaths.length) return { abgebrochen: true };

    const quelle = antwort.filePaths[0];
    let puffer;
    try {
      puffer = fs.readFileSync(quelle);
    } catch (err) {
      return { fehler: 'Datei nicht lesbar: ' + (err && err.message) };
    }
    if (puffer.length === 0) return { fehler: 'Die Datei ist leer.' };
    if (puffer.length > SKIN_MAX_BYTES) {
      return { fehler: 'Zu gross: maximal ' + Math.round(SKIN_MAX_BYTES / 1024) + ' KB.' };
    }
    if (!skinIstGueltig(puffer)) {
      return { fehler: 'Das ist keine Skin-PNG: erwartet werden 64x64 oder 64x32 Pixel.' };
    }

    try {
      fs.mkdirSync(SKIN_ORDNER, { recursive: true });
      fs.writeFileSync(SKIN_DATEI, puffer);
    } catch (err) {
      return { fehler: 'Speichern fehlgeschlagen: ' + (err && err.message) };
    }
    settingsStore = { ...settingsStore, skinDatei: 'skin.png' };
    saveSettingsToDisk(settingsStore);
    return { name: 'skin.png', dataUri: 'data:image/png;base64,' + puffer.toString('base64') };
  });

  // Die Bytes als Data-URI, gebaut wie schriften:lesen: nur die Datei, die
  // auch wirklich eingestellt ist, und stiller Rueckfall auf null, wenn sie
  // fehlt (geloeschter Ordner, kaputte Datei).
  ipcMain.handle('skins:getActive', async () => {
    if (!settingsStore.skinDatei) return null;
    const datei = path.join(SKIN_ORDNER, path.basename(String(settingsStore.skinDatei)));
    let puffer;
    try {
      puffer = fs.readFileSync(datei);
    } catch {
      return null;
    }
    if (!puffer.length || puffer.length > SKIN_MAX_BYTES || !skinIstGueltig(puffer)) return null;
    return { name: path.basename(datei), dataUri: 'data:image/png;base64,' + puffer.toString('base64') };
  });

  // Eigene Datei wieder wegnehmen: Datei loeschen, Eintrag aus den
  // Einstellungen streichen - danach faellt die Anzeige auf den
  // Account-Skin zurueck (siehe skinTexturUrl() im Renderer).
  ipcMain.handle('skins:vergessen', async () => {
    try {
      fs.unlinkSync(SKIN_DATEI);
    } catch {
      // weg ist kein Fehler: sie war schon nicht da
    }
    const neu = { ...settingsStore };
    delete neu.skinDatei;
    settingsStore = neu;
    saveSettingsToDisk(settingsStore);
    return null;
  });

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

  // =================================================================
  // Modpack-Import (modpackQuellen): .mrpack und CurseForge-Zips
  // =================================================================
  // Zwei Wege in eine neue Instanz: eine Datei von der Platte
  // (`pruefen` + `importieren`, der uebliche Ablauf) und eine Suche auf
  // Modrinth mit direktem Download der neuesten Version
  // (`sucheModrinth` + `importiereModrinth`).
  //
  // Sicherheitsregeln, die hier gelten:
  //   - Der Renderer nennt NIEMALS einen Dateipfad. `pruefen` oeffnet den
  //     nativen Dialog und merkst sich die Auswahl im Hauptprozess
  //     (`letzteModpackAuswahl`); `importieren` nimmt nur noch den Namen.
  //     So kann das UI keine beliebige Datei des Systems importieren
  //     lassen — dieselbe Entscheidung wie bei packs:importLocal.
  //   - Zip-Slip: alle Pfade im Zip werden VOR dem Schreiben geprueft
  //     (modpackImport), ein unsicherer Pfad lehnt die ganze Datei ab.
  //   - quilt/neoforge: ein Modpack, das sie verlangt, wird ehrlich
  //     abgelehnt — die Startkette kennt nur vanilla/fabric/forge
  //     (instances.js, MODLOADER).
  //   - CurseForge-Suche nur mit API-Schluessel (Einstellung
  //     `curseforgeApiKey`); der Datei-Import funktioniert ohne ihn,
  //     solange die manifest.json downloadUrl-Eintraege mitbringt.
  let letzteModpackAuswahl = null;

  function curseforgeApiKey() {
    const schluessel = settingsStore.curseforgeApiKey;
    return typeof schluessel === 'string' && schluessel.trim() ? schluessel.trim() : null;
  }

  // Datei ueber echte HTTP-Anfrage laden und mit der erwarteten SHA1-
  // Pruefsumme verifizieren — das Gegenstueck zu downloadModForInstance,
  // nur fuer den allgemeinen Fall des Modpack-Imports.
  async function modpackLadeDatei(url, sha1Soll, zielPfad) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen (HTTP ${res.status}) fuer ${url}`);
    }
    // Eine Webseite statt einer Datei (z. B. gesperrter CurseForge-Download)
    // waere sonst als kaputte .jar im Modsordner gelandet.
    const typ = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '');
    if (/^text\/html/i.test(typ)) {
      throw new Error(`Der Server liefert eine Webseite statt einer Datei (vermutlich vom Autor fuer externe Downloads gesperrt): ${url}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (sha1Soll) {
      const echt = crypto.createHash('sha1').update(buffer).digest('hex');
      if (echt !== sha1Soll) {
        throw new Error(`Pruefsumme stimmt nicht ueberein (erwartet ${sha1Soll.slice(0, 8)}…, geladen ${echt.slice(0, 8)}…)`);
      }
    }
    fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
    fs.writeFileSync(zielPfad, buffer);
    // Dateiname aus der Endadresse nach den Weiterleitungen: bei CurseForge
    // ohne API-Schluessel kennt man ihn erst jetzt.
    let dateiname = null;
    try {
      const letzter = String(res.url || '').split('?')[0];
      dateiname = decodeURIComponent(letzter.slice(letzter.lastIndexOf('/') + 1)) || null;
    } catch { /* Name bleibt unbekannt */ }
    return { dateiname };
  }

  // CurseForge-Datei ueber die API aufloesen (nur mit API-Schluessel).
  async function curseForgeLoeseUrl(projektId, dateiId) {
    const schluessel = curseforgeApiKey();
    if (!schluessel) return null;
    const res = await fetch(`https://api.curseforge.com/v1/mods/${projektId}/files/${dateiId}`, {
      headers: { 'x-api-key': schluessel, 'User-Agent': USER_AGENT }
    });
    if (!res.ok) {
      throw new Error(`CurseForge-Datei nicht aufloesbar (HTTP ${res.status}) fuer Projekt ${projektId}, Datei ${dateiId}`);
    }
    const daten = await res.json();
    const datei = daten && daten.data;
    if (!datei || typeof datei.downloadUrl !== 'string') {
      throw new Error(`CurseForge liefert keine Download-Adresse fuer Projekt ${projektId}, Datei ${dateiId}.`);
    }
    const sha1 = (Array.isArray(datei.hashes)
      ? datei.hashes.find((h) => h && h.algo === 1)
      : null);
    return {
      url: datei.downloadUrl,
      dateiname: typeof datei.fileName === 'string' ? datei.fileName : null,
      sha1: sha1 && typeof sha1.value === 'string' ? sha1.value : null
    };
  }

  // Nichts installiert und nur Fehler: das Modpack ist nicht brauchbar.
  // Frueher blieb dann eine leere Instanz zurueck, die wie ein erfolgreicher
  // Import aussah.
  function importGescheitert(ergebnis) {
    return Boolean(ergebnis) && ergebnis.installiert === 0 && Array.isArray(ergebnis.fehler) && ergebnis.fehler.length > 0;
  }

  // Gemeinsamer Abschluss eines Imports: Instanz anlegen (mit der
  // MINECRAFT-Version, nicht der Pack-Version — die Startkette braucht
  // sie), dann installieren. Liefert das, was das UI braucht, oder
  // { ok:false, fehler } statt einer Ausnahme.
  async function importAusInfo(info, name) {
    if (!info || info.format === null) {
      return { ok: false, fehler: (info && info.fehler) || 'Keine Modpack-Datei ausgewaehlt.' };
    }
    if (!modpackImport.STARTER_LOADER.includes(info.modloader)) {
      return {
        ok: false,
        fehler: `Dieses Modpack verlangt den Modloader "${info.modloader || 'unbekannt'}". ` +
          `Der Launcher kann nur ${modpackImport.STARTER_LOADER.join(', ')} starten.`
      };
    }
    if (!info.minecraft) {
      return {
        ok: false,
        fehler: 'Das Modpack nennt keine Minecraft-Version — ohne sie laesst sich keine Instanz anlegen.'
      };
    }
    const instanz = instancesMod.anlegen(userData(), {
      name: (name && String(name).trim()) || info.name || 'Importiertes Modpack',
      version: info.minecraft,
      modloader: info.modloader === 'vanilla' ? 'vanilla' : info.modloader
    });
    const zielDir = instancesMod.instanceDir(userData(), instanz.id);
    return { ok: true, instanz, zielDir };
  }

  ipcMain.handle('modpackQuellen:pruefen', async (event) => {
    const win = event && event.sender
      ? require('electron').BrowserWindow.fromWebContents(event.sender)
      : null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Modpack-Datei auswählen',
      filters: [
        { name: 'Modpacks', extensions: ['mrpack', 'zip'] },
        { name: 'Alle Dateien', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    letzteModpackAuswahl = result.filePaths[0];
    return modpackImport.modpackAusDatei(letzteModpackAuswahl);
  });

  ipcMain.handle('modpackQuellen:importieren', async (event, name) => {
    if (!letzteModpackAuswahl) {
      throw new Error('Keine Modpack-Datei gewaehlt. Erst "Modpack importieren" und eine Datei aussuchen.');
    }
    const pfad = letzteModpackAuswahl;
    letzteModpackAuswahl = null; // ein Import gilt nur einmal
    const info = modpackImport.modpackAusDatei(pfad);
    const geruest = await importAusInfo(info, name);
    if (!geruest.ok) return geruest;

    let ergebnis;
    try {
      if (info.format === 'mrpack') {
        ergebnis = await modpackImport.installiereMrpack(geruest.zielDir, pfad, modpackLadeDatei, {});
      } else if (info.format === 'prism') {
        ergebnis = await modpackImport.installierePrism(geruest.zielDir, pfad, modpackLadeDatei, {});
      } else {
        ergebnis = await modpackImport.installiereCurseForge(
          geruest.zielDir, pfad, curseforgeApiKey() ? curseForgeLoeseUrl : null,
          modpackLadeDatei, { unterordner: 'mods' }
        );
      }
    } catch (err) {
      ergebnis = { installiert: 0, uebersprungen: 0, fehler: [(err && err.message) || String(err)], abgelehnt: false };
    }

    // Zip-Slip-Ablehnung: die Instanz ist bis hierher leer (es wurde nichts
    // geschrieben), also zurueckbauen statt einen Geisterordner zu lassen.
    if (ergebnis.abgelehnt || importGescheitert(ergebnis)) {
      try { instancesMod.entfernen(userData(), geruest.instanz.id); } catch { /* Aufraeumen darf nicht werfen */ }
      return { ok: false, fehler: [...ergebnis.fehler] };
    }

    return {
      ok: true,
      instanz: geruest.instanz,
      format: info.format,
      modpack: {
        name: info.name,
        version: info.version,
        minecraft: info.minecraft,
        modloader: info.modloader
      },
      ergebnis
    };
  });

  ipcMain.handle('modpackQuellen:sucheModrinth', async (event, query) => {
    try {
      const q = String(query || '').trim();
      const url = q
        ? `${MODRINTH_BASE}/search?query=${encodeURIComponent(q)}&limit=10&facets=${encodeURIComponent(JSON.stringify([['project_type:modpack']]))}`
        : `${MODRINTH_BASE}/search?limit=10&index=downloads&facets=${encodeURIComponent(JSON.stringify([['project_type:modpack']]))}`;
      const data = await modrinthGet(url);
      if (!data || !Array.isArray(data.hits)) return [];
      return data.hits.map((hit) => ({
        id: hit.project_id,
        name: hit.title,
        // `versions` ist die Liste der unterstuetzten SPIELversionen
        // (aufsteigend) — die letzte ist also die neueste. Fallback auf den
        // version-Id der zuletzt veroefentlichten Version.
        version: Array.isArray(hit.versions) && hit.versions.length
          ? hit.versions[hit.versions.length - 1]
          : (hit.latest_version || null),
        downloads: hit.downloads
      }));
    } catch (err) {
      // Netzwerkfehler sind hier ein normaler Zustand: die Suche soll eine
      // Meldung zeigen koennen statt den ganzen Dialog platzen zu lassen.
      return { fehler: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('modpackQuellen:importiereModrinth', async (event, projektId) => {
    const id = String(projektId || '');
    let tempDatei = null;
    try {
      if (!id) return { ok: false, fehler: 'Kein Modrinth-Projekt angegeben.' };
      const projekt = await modrinthGet(`${MODRINTH_BASE}/project/${id}`);
      const versionen = await modrinthGet(`${MODRINTH_BASE}/project/${id}/version`);
      if (!Array.isArray(versionen) || !versionen.length) {
        return { ok: false, fehler: `Fuer "${projekt.title}" gibt es keine Versionen.` };
      }
      // Nicht auf die Reihenfolge der API vertrauen: explizit nach
      // Veroeffentlichung sortieren und die neueste nehmen.
      const neueste = [...versionen].sort((a, b) =>
        new Date(b.date_published) - new Date(a.date_published))[0];
      const datei = neueste.files.find((f) => f.primary && /\.mrpack$/i.test(f.filename))
        || neueste.files.find((f) => /\.mrpack$/i.test(f.filename));
      if (!datei) {
        return { ok: false, fehler: `Version "${neueste.version_number}" von "${projekt.title}" enthaelt kein .mrpack.` };
      }

      const res = await fetch(datei.url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        return { ok: false, fehler: `Download fehlgeschlagen (HTTP ${res.status}) fuer ${datei.filename}.` };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (datei.hashes && typeof datei.hashes.sha1 === 'string') {
        const echt = crypto.createHash('sha1').update(bytes).digest('hex');
        if (echt !== datei.hashes.sha1) {
          return { ok: false, fehler: `Pruefsumme des .mrpack stimmt nicht ueberein — Download verworfen.` };
        }
      }

      tempDatei = path.join(app.getPath('userData'), `import-${Date.now()}-${Math.round(Math.random() * 1e6)}.mrpack`);
      fs.writeFileSync(tempDatei, bytes);

      const info = modpackImport.modpackAusDatei(tempDatei);
      const geruest = await importAusInfo(info);
      if (!geruest.ok) return geruest;

      const ergebnis = await modpackImport.installiereMrpack(geruest.zielDir, tempDatei, modpackLadeDatei, {});
      if (ergebnis.abgelehnt || importGescheitert(ergebnis)) {
        try { instancesMod.entfernen(userData(), geruest.instanz.id); } catch { /* s.o. */ }
        return { ok: false, fehler: [...ergebnis.fehler] };
      }
      return {
        ok: true,
        instanz: geruest.instanz,
        format: 'mrpack',
        modpack: {
          name: info.name,
          version: info.version,
          minecraft: info.minecraft,
          modloader: info.modloader
        },
        ergebnis
      };
    } catch (err) {
      return { ok: false, fehler: (err && err.message) || String(err) };
    } finally {
      if (tempDatei) {
        try { fs.unlinkSync(tempDatei); } catch { /* die Temp-Datei muss nicht ueberleben */ }
      }
    }
  });

  ipcMain.handle('modpackQuellen:sucheCurseForge', async (event, query) => {
    // Ohne API-Schluessel gibt es keine CurseForge-Suche — das ist die
    // ehrliche Grenze dieser Schnittstelle (siehe README).
    const schluessel = curseforgeApiKey();
    if (!schluessel) {
      return { fehler: 'Für die CurseForge-Suche wird ein API-Schlüssel benötigt.' };
    }
    try {
      const q = String(query || '').trim();
      const url = `https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter=${encodeURIComponent(q)}&pageSize=10`;
      const res = await fetch(url, { headers: { 'x-api-key': schluessel, 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        return { fehler: `CurseForge-Suche fehlgeschlagen (HTTP ${res.status}).` };
      }
      const daten = await res.json();
      if (!daten || !Array.isArray(daten.data)) return [];
      return daten.data.map((m) => ({
        id: m.id,
        name: m.name,
        version: (Array.isArray(m.gameVersionLatestFiles) && m.gameVersionLatestFiles[0])
          ? m.gameVersionLatestFiles[0].gameVersion
          : ((m.latestFiles && m.latestFiles[0] && Array.isArray(m.latestFiles[0].gameVersions))
              ? m.latestFiles[0].gameVersions[0]
              : null),
        downloads: m.downloadCount
      }));
    } catch (err) {
      return { fehler: (err && err.message) || String(err) };
    }
  });

  // =================================================================
  // Widgets
  // =================================================================
  // Eingebaute Widgets liegen im Projektordner neben src/, eigene in
  // %APPDATA%\Liquid Launcher\widgets\. Beide Wurzeln werden gleichzeitig
  // durchsucht, wobei die spaetere gewinnt - so kann ein Benutzer ein
  // eingebautes Widget einfach mit gleichem Namen ersetzen.
  const WIDGET_EINGEBAUT = path.join(__dirname, '..', '..', 'widgets');
  const WIDGET_BENUTZER = path.join(app.getPath('userData'), 'widgets');

  function widgetWurzeln() {
    return [
      { ordner: WIDGET_EINGEBAUT, quelle: widgetsMod.QUELLE_EINGEBAUT },
      { ordner: WIDGET_BENUTZER, quelle: widgetsMod.QUELLE_BENUTZER }
    ];
  }

  // Der Zeitpunkt, an dem der Launcher gestartet wurde. Das Widget
  // "Laufzeit" rechnet daraus seine Anzeige - es behauptet also nichts,
  // was nicht aus dieser einen Zahl folgt.
  const GESTARTET_AM = Date.now();

  // ------------------------------------------------------------------
  // Java-Erkennung fuer die Widget-Kachel "Java"
  // ------------------------------------------------------------------
  // detectJava startet echte Prozesse (reg query, java -version). Beim
  // Zeichnen einer Kachel darf nichts spawnen, deshalb: der Aufruf laeuft
  // im Hintergrund, das Ergebnis liegt bis zu 10 Minuten im Speicher, und
  // bei gleicher Zielversion wird erneut nichts gestartet.
  //
  // status ist immer einer von vier Werten - "gefunden", "keine",
  // "suchend" (gerade oder ohne Ergebnis), "unbekannt" (keine Zielversion).
  // Keiner davon ist geschaetzt.
  const JAVA_TTL_MS = 10 * 60 * 1000;
  let javaZustand = { major: null, erkannt: null, status: 'unbekannt', zeit: 0, laeuft: false };

  function javaSucheStarten(major) {
    if (javaZustand.laeuft) return;
    if (javaZustand.major === major && Date.now() - javaZustand.zeit < JAVA_TTL_MS) return;
    javaZustand = { major: major, erkannt: null, status: 'suchend', zeit: Date.now(), laeuft: true };
    detectJava(major)
      .then((r) => {
        const erkannt = r && r.found && typeof r.version === 'number' ? r.version : null;
        javaZustand = {
          major,
          erkannt,
          status: erkannt !== null ? 'gefunden' : 'keine',
          zeit: Date.now(),
          laeuft: false
        };
      })
      .catch(() => {
        // Kein Ergebnis heisst nicht "keine Java gefunden" - deshalb
        // "unbekannt" und erst nach Ablauf der Frist ein neuer Versuch.
        javaZustand = { major, erkannt: null, status: 'unbekannt', zeit: Date.now(), laeuft: false };
      });
  }

  function javaInfoFuer(version) {
    if (typeof version !== 'string' || !version) {
      return { majorErforderlich: null, erkannt: javaZustand.erkannt, status: 'unbekannt' };
    }
    const major = requiredJavaMajor(version);
    javaSucheStarten(major);
    return { majorErforderlich: major, erkannt: javaZustand.erkannt, status: javaZustand.status };
  }

  // Laufende Spiel-Prozesse als reine Anzeige-Daten: Instanz, Startzeit,
  // RAM-Bereich. Bewusst OHNE cwd und mainClass - beides sind Pfade bzw.
  // interne Angaben, die eine Kachel nicht braucht.
  function aktuelleProzesse() {
    try {
      return getActiveProcesses().map((p) => ({
        instanz: p.instanceId,
        seit: p.startTime,
        laeuftSeitMs: p.uptime,
        ramMin: p.ramMin,
        ramMax: p.ramMax
      }));
    } catch {
      return [];
    }
  }


  ipcMain.handle('widgets:list', async () => {
    // Die Sprache kommt aus den Einstellungen, damit Titel und Beschreibung
    // im Widget-Verzeichnis mit der Oberflaeche wechseln.
    return widgetsMod.listeWidgets(widgetWurzeln(), settingsStore.language || 'de');
  });

  ipcMain.handle('widgets:html', async (event, id) => {
    const r = widgetsMod.liesWidgetHtml(widgetWurzeln(), id);
    // Kein Exception werfen: der Renderer soll ein einzelnes kaputtes
    // Widget anzeigen koennen, nicht die ganze Kachelreihe verlieren.
    if (!r.ok) return { ok: false, fehler: r.fehler, id: id };
    return { ok: true, id: r.manifest.id, titel: r.manifest.titel, html: r.html };
  });

  // Der Datenkoffer, den ein Widget sehen darf.
  //
  // WICHTIG: der wird hier im Hauptprozess gebaut und nicht im Renderer.
  // Der Renderer haelt nach einem erfolgreichen Login das Konto-Objekt mit
  // dem Access-Token im Speicher. Baute er den Koffer selbst, kaeme das
  // Token in eine Struktur, die ausschliesslich zum Weiterreichen an
  // Widgets gedacht ist - und ein spaeter ergaenztes Datenfeld waere
  // einen Commit lang ungeprueft unterwegs. filtereDatenFuerWidget() arbeitet
  // deshalb auf einer Positivliste und kann ein Token nicht durchlassen,
  // auch nicht versehentlich.
  ipcMain.handle('widgets:daten', async (event, instanceId) => {
    let welten = [];
    let modAnzahl = 0;
    let server = [];
    let aktiveInstanz = null;

    // D4: Werte, die nur von der gewaehlten Instanz abhaengen. Fehlt eine
    // Instanz, bleiben sie alle null - "keine Instanz gewaehlt" ist etwas
    // anderes als "0 Bytes".
    let instanzGroesse = null;
    let modsGroesse = null;
    let ressourcenpaketeAnzahl = null;
    let instanzRam = null;
    let javaInfo = { majorErforderlich: null, erkannt: null, status: 'unbekannt' };
    let instanzVersion = null;

    if (typeof instanceId === 'string' && instanceId) {
      aktiveInstanz = instanceId;
      const dir = instanceDir(instanceId);
      try { welten = worlds.listWorlds(dir); } catch { welten = []; }
      try { modAnzahl = listInstalledMods(instanceId).length; } catch { modAnzahl = 0; }
      try {
        const roh = JSON.parse(fs.readFileSync(serversPath(instanceId), 'utf-8'));
        server = Array.isArray(roh) ? roh : (roh && Array.isArray(roh.servers) ? roh.servers : []);
      } catch { server = []; }

      instanzGroesse = systemdaten.ordnerGroesse(dir);
      modsGroesse = systemdaten.ordnerGroesse(path.join(dir, 'mods'));
      // Anzahl der Eintraege in resourcepacks/ - bewusst nicht listPacks():
      // das Modul liest fuer jeden Eintrag pack.png als Data-URI, und fuer
      // eine Zahl in einer Kachel braucht niemand ein Bild.
      ressourcenpaketeAnzahl = systemdaten.anzahlEintraege(path.join(dir, 'resourcepacks'));
      try {
        const s = instSettings.loadSettings(dir);
        instanzRam = { minGb: s.ramMinGb, maxGb: s.ramMaxGb };
      } catch { instanzRam = null; }
      try {
        const i = instancesMod.holen(userData(), instanceId);
        instanzVersion = i && typeof i.version === 'string' ? i.version : null;
      } catch { instanzVersion = null; }
      javaInfo = javaInfoFuer(instanzVersion);
    }

    return widgetsMod.filtereDatenFuerWidget({
      aktiveInstanz,
      instanzen: instancesMod.listen(userData()).map(i => ({
        id: i.id, name: i.name, version: i.version, modloader: i.modloader,
        // Ehrlich ermittelt (siehe instances.js): null, wenn nie gespielt.
        lastPlayed: i.lastPlayed || null
      })),
      welten: welten.map(w => ({
        // Die Feldnamen muessen zu dem passen, was worlds.js zurueckgibt
        // (readWorldMeta). Dort heissen sie `broken`, `sizeBytes` und
        // `iconDataUrl`. Mit `kaputt`, `groesse` und `schoen` kam hier
        // ueberall undefined an, und die Kachel "Welten" zaehlte deshalb
        // immer null kaputte Welten - egal wie viele es wirklich sind.
        // Vergleiche worlds.js und widgets/welten.
        name: w.name, version: w.version, lastPlayed: w.lastPlayed,
        groesse: w.sizeBytes, gameTypeName: w.gameTypeName,
        schoen: w.iconDataUrl, cheats: w.cheats, kaputt: w.broken
      })),
      modAnzahl,
      server: server.map(s => ({
        name: s.name, address: s.address, online: s.online,
        spieler: s.spieler, version: s.version, latenz: s.latenz, motd: s.motd
      })),
      // KEIN theme-Feld. Es gab eines, aber der Renderer legt in den
      // Einstellungen nur "blockLayout" und "language" ab - ein "theme"
      // existiert dort nicht, das Feld war also immer null und haette den
      // Widgets eine leere Farbangabe vorgetaeuscht. Die Farben kommen
      // stattdessen als eigene Nachricht direkt aus den CSS-Variablen des
      // Fensters, siehe themeFarben() in widget-host.js. Das ist die
      // Quelle, die auch nach einem Farbwechsel stimmt.
      gestartetAm: GESTARTET_AM,
      // Der Schluessel heisst "language", nicht "sprache", und der Wert ist
      // ein Sprachcode wie "de" oder "en" - kein Locale wie "de-DE". Beides
      // war in der ersten Fassung falsch, mit der Folge, dass die Uhr
      // unabhaengig von der eingestellten Sprache immer Deutsch zeigte.
      // "de" ist als toLocaleTimeString-Argument gueltig.
      sprache: settingsStore.language || 'de',

      // ---- D4: messbare Werte (Positivliste in widgets.js) --------------
      // Der leichte Teil (system, cpuLast, laufwerk) steht auch hier, damit
      // die Kacheln beim ersten Zeichnen nicht auf den ersten Takt warten
      // muessen. Ab dann aendert er sich ueber widgets:systemdaten.
      ...systemdaten.leicht(userData()),
      launcherVersion: app.getVersion(),
      netzwerk: systemdaten.netzwerkFelder(),
      prozesse: aktuelleProzesse(),
      instanzGroesse,
      modsGroesse,
      ressourcenpaketeAnzahl,
      instanzRam,
      javaInfo
    });
  });

  // Der leichte Kanal fuer den Renderer-Takt (widget-host.js, alle 4 s).
  // Nur die Felder, die sich oft und billig aendern: CPU-Auslastung,
  // freier RAM, Datentraeger, laufende Spiel-Prozesse. Ohne diese Aufteilung
  // muesste beim Polling jedes Mal die ganze Kachel-Inhaltliste neu gelesen
  // werden - inklusive Welten-NBT und mods-Ordner.
  ipcMain.handle('widgets:systemdaten', async () => {
    const leicht = systemdaten.leicht(userData());
    leicht.prozesse = aktuelleProzesse();
    return widgetsMod.filtereDatenFuerWidget(leicht);
  });

  // Den Ordner fuer eigene Widgets oeffnen. Wird er beim ersten Mal
  // angelegt, damit niemand erst einen leeren Pfad suchen muss.
  ipcMain.handle('widgets:openFolder', async () => {
    try {
      fs.mkdirSync(WIDGET_BENUTZER, { recursive: true });
    } catch (err) {
      return { ok: false, fehler: 'Ordner nicht anlegbar: ' + (err && err.message) };
    }
    const meldung = shell.openPath(WIDGET_BENUTZER);
    if (meldung) return { ok: false, fehler: meldung };
    return { ok: true, ordner: WIDGET_BENUTZER };
  });

  // =================================================================
  // Eigene Schriftdatei
  // =================================================================
  // Zugriff auf das Dateisystem gehoert in den Haupt-Prozess: der Renderer
  // laeuft mit contextIsolation + sandbox und hat gar kein fs. Er bekommt
  // deshalb nur die Bytes als Data-URI und bindet sie ueber @font-face ein.
  //
  // Warum Data-URI und nicht ein Pfad: index.html wird per loadFile() also
  // ueber file:// geladen. Eine Webseite, die selbst file:// ist, darf eine
  // andere Datei per CSS nachladen nicht ohne Weiteres - dafuer braeuchte es
  // webSecurity=false, und das ist an genau den Stellen, die die Widget-Sandbox
  // ausmachen, aus. Eine Data-URI umgeht das nicht, sondern braucht es gar nicht.
  //
  // Es wird bewusst nur EINE eigene Schrift gehalten. Mehrere wuerden nichts
  // bringen, weil die Auswahl eine einzige Stelle hat - und der Renderer
  // bekaeme sonst bei jedem Start ein Megabyte Schrift ueber IPC.
  const SCHRIFT_ORDNER = path.join(app.getPath('userData'), 'schrift');
  const SCHRIFT_MAX_BYTES = 4 * 1024 * 1024;
  // Nicht nur als Anzeigetexte, sondern ueber die Dateiendung geprueft. Eine
  // umbenannte .exe ist damit ausgeschlossen; eine umbenannte .txt, die keine
  // Schrift ist, dagegen nicht. Letzteres ist unkritisch: @font-face ignoriert
  // sie lautlos und die Oberflaeche faellt auf die eingebaute Schrift zurueck.
  const SCHRIFT_ENDUNGEN = {
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.ttc': 'font/collection',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };

  function schriftEndung(name) {
    return String(name || '').toLowerCase().match(/\.[a-z0-9]+$/);
  }

  function schriftMeldung(ok, zusatz) {
    return Object.assign({ ok: !!ok }, zusatz || {});
  }

  // Den tatsaechlich benutzten Dateinamen im Schrift-Ordner. settings.json
  // speichert nur diesen Namen, nicht die Bytes - sonst stuende ein ganzes
  // Megabyte Schrift in einer Konfigurationsdatei.
  function schriftDatei() {
    const name = settingsStore.eigeneSchrift;
    if (typeof name !== 'string' || !name) return null;
    // Kein Pfad aus settings.json uebernehmen, sondern den Namen selbst als
    // Dateinamen in unserem eigenen Ordner verwenden. Sonst koennte ein
    // manipuliertes settings.json hier "../../programme/x" einschleusen.
    const sicher = path.basename(name);
    if (sicher !== name) return null;
    if (!Object.prototype.hasOwnProperty.call(SCHRIFT_ENDUNGEN, schriftEndung(sicher))) return null;
    return path.join(SCHRIFT_ORDNER, sicher);
  }

  ipcMain.handle('schriften:waehlen', async (event) => {
    const eltern = BrowserWindow.fromWebContents(event.sender);
    const antwort = eltern
      ? await dialog.showOpenDialog(eltern, {
          title: 'Schriftdatei auswaehlen',
          properties: ['openFile'],
          filters: [
            { name: 'Schriften', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] },
            { name: 'Alle Dateien', extensions: ['*'] }
          ]
        })
      : await dialog.showOpenDialog({
          title: 'Schriftdatei auswaehlen',
          properties: ['openFile'],
          filters: [{ name: 'Schriften', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }]
        });

    if (antwort.canceled || !antwort.filePaths.length) return schriftMeldung(false, { abgebrochen: true });
    const quelle = antwort.filePaths[0];

    let groesse = 0;
    try {
      groesse = fs.statSync(quelle).size;
    } catch (err) {
      return schriftMeldung(false, { fehler: 'Datei nicht lesbar: ' + (err && err.message) });
    }
    if (groesse === 0) return schriftMeldung(false, { fehler: 'Die Datei ist leer.' });
    if (groesse > SCHRIFT_MAX_BYTES) {
      return schriftMeldung(false, {
        fehler: 'Zu gross: ' + Math.round(groesse / 1024) + ' KB, erlaubt sind ' +
                Math.round(SCHRIFT_MAX_BYTES / 1024) + ' KB.'
      });
    }

    const endung = schriftEndung(quelle);
    if (!endung || !Object.prototype.hasOwnProperty.call(SCHRIFT_ENDUNGEN, endung)) {
      return schriftMeldung(false, { fehler: 'Nur .ttf, .otf, .ttc, .woff und .woff2 werden akzeptiert.' });
    }

    const ziel = path.join(SCHRIFT_ORDNER, 'eigene' + endung);
    try {
      fs.mkdirSync(SCHRIFT_ORDNER, { recursive: true });
      // Erst die alte Datei wegräumen, damit nicht "eigene.ttf" UND
      // "eigene.otf" nebeneinander liegen und beim naechsten Start eine
      // davon zur Aussage wird, die gerade nicht in settings.json steht.
      for (const alt of fs.readdirSync(SCHRIFT_ORDNER)) {
        if (alt.startsWith('eigene') && alt !== path.basename(ziel)) {
          try { fs.unlinkSync(path.join(SCHRIFT_ORDNER, alt)); } catch { /* egal */ }
        }
      }
      fs.copyFileSync(quelle, ziel);
    } catch (err) {
      return schriftMeldung(false, { fehler: 'Kopieren fehlgeschlagen: ' + (err && err.message) });
    }

    const name = path.basename(ziel);
    settingsStore = { ...settingsStore, eigeneSchrift: name };
    saveSettingsToDisk(settingsStore);
    return schriftMeldung(true, { name: name, groesse: groesse });
  });

  // Die Bytes als Data-URI. Nur auf Abruf und nur fuer die tatsaechlich
  // eingestellte Datei - nicht fuer alles, was im Ordner liegt.
  ipcMain.handle('schriften:lesen', async () => {
    const datei = schriftDatei();
    if (!datei) return null;
    let inhalt;
    try {
      inhalt = fs.readFileSync(datei);
    } catch {
      return null; // Datei weg, Ordner geloescht: die UI faellt zurueck
    }
    if (inhalt.length === 0 || inhalt.length > SCHRIFT_MAX_BYTES) return null;
    return {
      name: path.basename(datei),
      mime: SCHRIFT_ENDUNGEN[schriftEndung(datei)],
      dataUri: 'data:' + SCHRIFT_ENDUNGEN[schriftEndung(datei)] + ';base64,' + inhalt.toString('base64')
    };
  });

  ipcMain.handle('schriften:vergessen', async () => {
    const datei = schriftDatei();
    if (datei) {
      try { fs.unlinkSync(datei); } catch { /* schon weg ist kein Fehler */ }
    }
    settingsStore = { ...settingsStore };
    delete settingsStore.eigeneSchrift;
    saveSettingsToDisk(settingsStore);
    return schriftMeldung(true);
  });

  // ---------- Screenshot der Launcher-Oberflaeche ----------
  // Der Knopf im Schnellzugriff ruft diesen Kanal. Der Hauptprozess zeichnet
  // das Fenster (webContents.capturePage) und legt das PNG im Datenordner
  // unter screenshots/ ab. Der Renderer bekommt NUR den Dateinamen zurueck:
  // kein fs, kein Pfad zum Schreiben, keine Bytes. Ein Screenshot ist eine
  // Nebensache - schlaegt er fehl, antwortet der Kanal mit { ok:false }
  // statt zu werfen, damit die Oberflaeche eine Zeile zeigen kann.
  function screenshotOrdner() {
    const ordner = path.join(app.getPath('userData'), 'screenshots');
    fs.mkdirSync(ordner, { recursive: true });
    return ordner;
  }
  ipcMain.handle('screenshot:capture', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return { ok: false, fehler: 'Kein Fenster gefunden.' };
      const bild = await win.webContents.capturePage();
      if (bild.isEmpty()) return { ok: false, fehler: 'Das Fenster konnte nicht gezeichnet werden.' };
      const jetzt = new Date();
      const zz = (n) => String(n).padStart(2, '0');
      const name = 'liquid-' + jetzt.getFullYear() + zz(jetzt.getMonth() + 1) + zz(jetzt.getDate())
        + '-' + zz(jetzt.getHours()) + zz(jetzt.getMinutes()) + zz(jetzt.getSeconds()) + '.png';
      fs.writeFileSync(path.join(screenshotOrdner(), name), bild.toPNG());
      return { ok: true, datei: name };
    } catch (err) {
      return { ok: false, fehler: err && err.message ? err.message : 'Screenshot fehlgeschlagen.' };
    }
  });
  ipcMain.handle('screenshot:openFolder', async () => {
    const fehler = await shell.openPath(screenshotOrdner());
    return { ok: !fehler, fehler: fehler || null };
  });
}

module.exports = { registerIpcHandlers };
