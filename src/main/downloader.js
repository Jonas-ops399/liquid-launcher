/**
 * Minecraft Version Downloader
 * Lädt Version-Manifest, Libraries, Assets, Natives und baut Launch-Optionen.
 * Verwendet SHA1-Verifikation für alle Downloads (Mojang-Standard).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('https');
const AdmZip = require('adm-zip');
const { app } = require('electron');

// ==================== KONFIGURATION ====================

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const ASSETS_CDN_BASE = 'https://resources.download.minecraft.net';
const USER_AGENT = 'liquid-launcher/0.1 (privates Hobby-Projekt)';
const MANIFEST_TTL_MS = 60 * 60 * 1000; // 1 Stunde
const CONCURRENCY_LIMIT = 6; // Parallele Downloads
const LAUNCHER_VERSION = '0.1'; // an das Spiel melden wir uns hiermit

// App-Daten-Verzeichnisse
function getVersionsDir() {
  const dir = path.join(app.getPath('userData'), 'versions');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAssetsDir() {
  const dir = path.join(app.getPath('userData'), 'assets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getVersionDir(versionId) {
  const dir = path.join(getVersionsDir(), versionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getNativesDir(versionId) {
  const dir = path.join(getVersionDir(versionId), 'natives');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLibrariesDir(versionId) {
  const dir = path.join(getVersionDir(versionId), 'libraries');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAssetsIndexDir() {
  const dir = path.join(getAssetsDir(), 'indexes');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAssetsObjectsDir() {
  const dir = path.join(getAssetsDir(), 'objects');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ==================== HILFSFUNKTIONEN ====================

/**
 * HTTP GET mit Promise, gibt JSON zurück
 */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} für ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON Parse Fehler: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => reject(new Error('Timeout')));
  });
}

/**
 * Datei herunterladen mit SHA1-Verifikation (Buffer-basiert, wie Modrinth)
 * Prüft vorher ob Datei existiert + Hash stimmt (Skip-Logik)
 */
async function downloadFileWithSha1(url, destPath, expectedSha1, onProgress) {
  // Skip-Check: Datei existiert + Hash stimmt
  if (fs.existsSync(destPath) && expectedSha1) {
    const existingBuffer = fs.readFileSync(destPath);
    const existingSha1 = crypto.createHash('sha1').update(existingBuffer).digest('hex');
    if (existingSha1.toLowerCase() === expectedSha1.toLowerCase()) {
      if (onProgress) onProgress({ skipped: true, path: destPath });
      return { skipped: true, path: destPath };
    }
  }

  // Elternverzeichnis sicherstellen
  const parentDir = path.dirname(destPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} für ${url}`));
        return;
      }

      const chunks = [];
      let received = 0;
      const total = parseInt(res.headers['content-length'], 10) || 0;
      const hash = crypto.createHash('sha1');

      res.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        hash.update(chunk);
        if (onProgress) onProgress({ received, total });
      });

      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const actualSha1 = hash.digest('hex');

        if (expectedSha1 && actualSha1.toLowerCase() !== expectedSha1.toLowerCase()) {
          reject(new Error(`SHA1 mismatch: expected ${expectedSha1}, got ${actualSha1}`));
          return;
        }

        fs.writeFileSync(destPath, buffer);
        resolve({ skipped: false, path: destPath, sha1: actualSha1 });
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => reject(new Error('Download Timeout')));
  });
}

/**
 * Parallele Downloads mit echtem Concurrency-Limit.
 *
 * Bewusste Design-Entscheidung: ein fehlgeschlagener Download wird
 * GESAMMELT und nicht weitergeworfen. Bei ~200 Libraries und ~3000 Assets
 * ist ein einzelner Time-out kein Grund, den kompletten Start abzubrechen —
 * der Aufrufer bekommt die Fehlerliste zurück und kann sie protokollieren.
 *
 * (Die erste Version hier hat im .catch() neu geworfen. Das erzeugt eine
 * unhandled rejection, die unter Electron den Main-Prozessor abschießt, und
 * benutzt p.isFulfilled — eine Property, die es auf Promises nicht gibt,
 * womit das Limit nie gegriffen hat. Beides ist hier behoben.)
 *
 * @returns {Promise<{results: Array, failures: Array<{item:any, error:Error}>}>}
 */
async function downloadWithConcurrency(items, downloadFn, progressCb) {
  if (!items.length) return { results: [], failures: [] };

  const results = new Array(items.length);
  const failures = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    // Jeder Worker zieht sich solange neue Aufgaben, bis nichts mehr da ist.
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = { item, result: await downloadFn(item), error: null };
      } catch (error) {
        results[index] = { item, result: null, error };
        failures.push({ item, error });
      }
      completed++;
      if (progressCb) progressCb({ completed, total: items.length });
    }
  }

  const workerCount = Math.min(CONCURRENCY_LIMIT, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { results, failures };
}

/**
 * Natives-JAR entpacken (nur .dll/.so/.dylib behalten)
 */
function extractNatives(jarPath, destDir) {
  const zip = new AdmZip(jarPath);
  const entries = zip.getEntries();
  let extracted = 0;

  for (const entry of entries) {
    const name = entry.entryName;
    if (name.endsWith('.dll') || name.endsWith('.so') || name.endsWith('.dylib')) {
      // Flach ablegen (ohne Pfad-Präfix)
      const baseName = path.basename(name);
      const targetPath = path.join(destDir, baseName);
      fs.writeFileSync(targetPath, entry.getData());
      extracted++;
    }
  }
  return extracted;
}

/**
 * Platzhalter in Argumenten ersetzen (Minecraft Launch-Argument-Syntax)
 */
function replacePlaceholders(arg, placeholders) {
  return arg.replace(/\$\{([^}]+)\}/g, (match, key) => {
    return placeholders[key] !== undefined ? placeholders[key] : match;
  });
}

// ---------- Regeln (os / features) auswerten ----------
// Minecraft liefert Argument- und Library-Einträge mit `rules`. Semantik:
// - Eintrag ohne `rules` -> gilt immer (z.B. "-Djava.library.path=...")
// - Eintrag MIT `rules`  -> gilt nur, wenn mindestens eine Regel zutrifft.
//   Deshalb der Default "disallow", sobald `rules` vorhanden sind: so wird
//   z.B. "-XstartOnFirstThread" (nur macOS) unter Windows korrekt weggelassen.
function currentOsName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function currentArchName() {
  // Mojang schreibt "x86", meint damit aber 32-Bit — ein 64-Bit-Windows
  // muss also NICHT matchen (betrifft z.B. "-Xss1M").
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'ia32') return 'x86';
  return process.arch; // arm64 & Co.
}

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== currentOsName()) return false;
    if (rule.os.arch && rule.os.arch !== currentArchName()) return false;
    if (rule.os.version && !rule.os.version.test(process.version)) return false;
  }
  if (rule.features) {
    // WICHTIG: hier wird nicht "alle Werte truthy -> erlauben" geprüft wie
    // vorher, sondern der Wert muss EXAKT passen. Sonst hängt `--demo`
    // automatisch am Startaufruf, weil is_demo_user auf true steht.
    for (const [name, value] of Object.entries(rule.features)) {
      if (!features || features[name] !== value) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action !== 'disallow';
  }
  return allowed;
}

// Welche optionalen Spiel-Features beim Start aktiviert sind. Alles was hier
// nicht bewusst auf true steht, wird weggelassen — insbesondere is_demo_user.
//
// quickPlay: null | { singleplayer: '<Ordnername der Welt>' }
//          | { multiplayer: '<host:port>' }
// Die Quick-Play-Argumente haengen in der version.json an vier Features.
// Aus der echten 1.21.4-version.json ausgelesen, nicht geraten:
//   has_quick_plays_support     -> --quickPlayPath
//   is_quick_play_singleplayer  -> --quickPlaySingleplayer
//   is_quick_play_multiplayer   -> --quickPlayMultiplayer
//   is_quick_play_realms        -> --quickPlayRealms
//
// WICHTIG: has_quick_plays_support ist KEINE gemeinsame Voraussetzung fuer
// die anderen drei, sondern schaltet allein --quickPlayPath frei — und das ist
// der Pfad zum Spielstand, also eindeutig etwas fuer den Einzelspieler. Beim
// Serverstart muss er deshalb false bleiben: sonst schleppt der Start
// --quickPlayPath "" mit, und das Spiel wertet einen leeren Pfad als
// fehlgeschlagenen Quick-Play-Versuch. Genau das hat der Test gefunden, als
// gegen die echte version.json geprueft wurde — gegen eine selbstgebaute
// haette man es nie gesehen.
function launchFeatures(resolution, isDemo, quickPlay) {
  const qp = quickPlay && (quickPlay.singleplayer || quickPlay.multiplayer) ? quickPlay : null;
  // Genau EIN Ziel pro Start. Ein Start ist entweder "in diese Welt" oder
  // "auf diesen Server". Beides gleichzeitig wuerde zwei sich widersprechende
  // Argumentpaare erzeugen, und welches gewinnt, entscheidet dann die
  // Argumentreihenfolge — nicht etwas, worauf man sich verlassen sollte.
  // Der Aufrufer (instances:launch) verhindert die Doppelangabe ohnehin.
  const einzelspieler = !!(qp && qp.singleplayer);
  return {
    // Nur wirklich true, wenn es ECHT ein Demo-Account ist. Ein normal
    // angemeldeter Account bekommt kein --demo; ein Demo-Account dagegen
    // braucht es, sonst startet das Spiel in einem Zustand, in dem weder
    // Spielen noch Demo-Start moeglich ist.
    is_demo_user: !!isDemo,
    has_custom_resolution: !!resolution,
    has_quick_plays_support: einzelspieler,
    is_quick_play_singleplayer: einzelspieler,
    is_quick_play_multiplayer: !!(qp && !einzelspieler && qp.multiplayer),
    is_quick_play_realms: false
  };
}

/**
 * Argument-Liste mit Regeln filtern (os, features)
 */
function filterArguments(args, features = {}) {
  if (!Array.isArray(args)) return [];

  return args.flatMap(arg => {
    if (typeof arg === 'string') return arg;

    // Regel-Objekt: { rules: [...], value: "..." | [...] }
    if (arg.rules && arg.value !== undefined) {
      if (!rulesAllow(arg.rules, features)) return [];
      return Array.isArray(arg.value) ? arg.value : [arg.value];
    }

    return [];
  });
}

// ==================== HAUPT-FUNKTIONEN ====================

/**
 * Version-Manifest laden (mit Cache)
 */
async function getVersionManifest() {
  const manifestPath = path.join(getVersionsDir(), 'version_manifest.json');

  // Cache prüfen
  if (fs.existsSync(manifestPath)) {
    const stat = fs.statSync(manifestPath);
    if (Date.now() - stat.mtimeMs < MANIFEST_TTL_MS) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
  }

  // Neu laden
  const manifest = await httpsGetJson(MANIFEST_URL);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifest;
}

/**
 * version.json für eine Version laden (mit Cache)
 */
async function getVersionJson(versionId) {
  const versionDir = getVersionDir(versionId);
  const versionJsonPath = path.join(versionDir, `${versionId}.json`);

  // Cache prüfen
  if (fs.existsSync(versionJsonPath)) {
    return JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
  }

  // Manifest laden, URL finden
  const manifest = await getVersionManifest();
  const versionInfo = manifest.versions.find(v => v.id === versionId);
  if (!versionInfo) {
    throw new Error(`Version ${versionId} nicht im Manifest gefunden`);
  }

  const versionJson = await httpsGetJson(versionInfo.url);
  fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson));
  return versionJson;
}

// ---------- Natives ermitteln ----------
// Es gibt zwei Formate, wie der Native-Classifier in der version.json steht:
//  - MODERN (1.20+): Er steckt im Namen, z.B.
//      "org.lwjgl:lwjgl:3.3.3:natives-windows"  -> downloads.artifact
//    Das ist der Normalfall bei allen aktuellen Versionen.
//  - ALT: Er steckt in downloads.classifiers, z.B.
//      "org.lwjgl:lwjgl:2.9.4" + classifiers["natives-windows"]
// Die erste Implementierung schaute ausschliesslich nach downloads.classifiers
// und hat damit bei modernen Versionen NULL Natives geladen — Minecraft
// startet dann nicht, weil die LWJGL-DLLs fehlen.
function nativeClassifierForCurrentOs() {
  return `natives-${currentOsName()}`;
}

// Classifier, die ausschliesslich fuer ein anderes Betriebssystem gedacht
// sind, werden uebersprungen ("natives-linux", "natives-macos-arm64",
// "linux-x86_64" usw.). Classifier ohne OS-Bezug (z.B. "all") sind fuer alle.
function classifierMatchesCurrentOs(classifier) {
  if (!classifier) return true;
  const osName = currentOsName();
  if (classifier.includes('windows')) return osName === 'windows';
  if (classifier.includes('linux')) return osName === 'linux';
  if (classifier.includes('macos') || classifier.includes('osx')) return osName === 'osx';
  return true;
}

/**
 * Lokaler Pfad einer Library. Bevorzugt wird "downloads.artifact.path" aus
 * der version.json — das ist die verlaesslichste Quelle, weil Mojang dort den
 * Classifier (z.B. "-natives-windows") korrekt eingerechnet hat. Nur wenn der
 * Pfad fehlt, wird er aus dem Namen konstruiert.
 */
function libraryLocalPath(lib, librariesDir, classifierOverride) {
  const artifactPath = lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path;
  if (artifactPath) return path.join(librariesDir, ...artifactPath.split('/'));

  const parts = lib.name.split(':');
  const [group, artifactId, version] = parts;
  if (!group || !artifactId || !version) return null;

  const classifier = classifierOverride || (parts.length > 3 ? parts[3] : null);
  const fileName = classifier
    ? `${artifactId}-${version}-${classifier}.jar`
    : `${artifactId}-${version}.jar`;

  return path.join(
    librariesDir,
    ...`${group.replace(/\./g, '/')}/${artifactId}/${version}/${fileName}`.split('/')
  );
}

/**
 * Libraries + Natives herunterladen
 */
async function downloadLibraries(versionJson, versionId, progressCb) {
  const libraries = versionJson.libraries || [];
  const librariesDir = getLibrariesDir(versionId);
  const nativesDir = getNativesDir(versionId);
  const nativeClassifier = nativeClassifierForCurrentOs();

  const downloadableLibs = [];

  for (const lib of libraries) {
    // rules gelten fuer den kompletten Library-Eintrag. Ohne diese Pruefung
    // landen macOS-only-Bibliotheken (ca.weblite:java-objc-bridge) auf der
    // Windows-Classpath.
    if (!rulesAllow(lib.rules)) continue;

    const parts = lib.name.split(':');
    const nameClassifier = parts.length > 3 ? parts[3] : null;
    if (!classifierMatchesCurrentOs(nameClassifier)) continue;

    const downloads = lib.downloads || {};
    const legacyNative = downloads.classifiers && downloads.classifiers[nativeClassifier];
    if (legacyNative && legacyNative.rules && !rulesAllow(legacyNative.rules)) continue;

    const isNative = nameClassifier === nativeClassifier
      || (!!legacyNative && !(downloads.artifact && downloads.artifact.url));

    // Datei-Quelle bestimmen: Natives aus dem Classifier (alt) bzw. direkt
    // aus dem Artifact (modern), normale Libraries immer aus dem Artifact.
    const file = (isNative && legacyNative)
      ? legacyNative
      : (downloads.artifact && downloads.artifact.url ? downloads.artifact : null);
    if (!file) continue;

    const destPath = libraryLocalPath(lib, librariesDir, isNative ? nativeClassifier : null);
    if (!destPath) continue;

    downloadableLibs.push({
      type: isNative ? 'native' : 'library',
      name: lib.name,
      url: file.url,
      sha1: file.sha1,
      size: file.size,
      destPath,
      isNative,
      nativeDestDir: nativesDir
    });
  }

  if (downloadableLibs.length === 0) return { libraries: 0, natives: 0, failures: [] };

  const { failures } = await downloadWithConcurrency(downloadableLibs, async (item) => {
    await downloadFileWithSha1(item.url, item.destPath, item.sha1);

    if (item.isNative) {
      // Natives-JAR entpacken: nur die .dll/.so/.dylib uebernehmen.
      const extracted = extractNatives(item.destPath, item.nativeDestDir);
      if (extracted === 0) {
        throw new Error(`enthält keine nativen Bibliotheken (${item.name})`);
      }
    }

    if (progressCb) {
      progressCb({ phase: 'libraries', file: item.name, total: downloadableLibs.length });
    }
  }, (p) => {
    if (progressCb) progressCb({ phase: 'libraries', current: p.completed, total: p.total });
  });

  return {
    libraries: downloadableLibs.length - failures.length,
    natives: downloadableLibs.filter(l => l.isNative).length - failures.filter(f => f.item.isNative).length,
    failures
  };
}

/**
 * Assets herunterladen
 */
async function downloadAssets(versionJson, progressCb) {
  const assetIndex = versionJson.assetIndex;
  if (!assetIndex || !assetIndex.url) return { assets: 0 };

  const assetIndexId = assetIndex.id; // z.B. "1.21"
  const assetIndexPath = path.join(getAssetsIndexDir(), `${assetIndexId}.json`);

  // Asset Index laden (cached)
  let indexJson;
  if (fs.existsSync(assetIndexPath)) {
    indexJson = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
  } else {
    indexJson = await httpsGetJson(assetIndex.url);
    fs.writeFileSync(assetIndexPath, JSON.stringify(indexJson));
  }

  const objects = indexJson.objects || {};
  const objectEntries = Object.entries(objects);
  if (objectEntries.length === 0) return { assets: 0 };

  const assetsObjectsDir = getAssetsObjectsDir();

  // Download-Items vorbereiten
  const downloadItems = objectEntries.map(([virtualPath, obj]) => {
    const hash = obj.hash;
    const prefix = hash.substring(0, 2);
    const destDir = path.join(assetsObjectsDir, prefix);
    const destPath = path.join(destDir, hash);

    return {
      virtualPath,
      hash,
      url: `${ASSETS_CDN_BASE}/${prefix}/${hash}`,
      destPath,
      size: obj.size
    };
  });

  const { failures } = await downloadWithConcurrency(downloadItems, async (item) => {
    // Hash = Dateiname → Selbstverifikation
    await downloadFileWithSha1(item.url, item.destPath, item.hash);
  }, (p) => {
    if (progressCb) progressCb({ phase: 'assets', current: p.completed, total: p.total });
  });

  return { assets: downloadItems.length - failures.length, failures };
}

// ==================== CLIENT-JAR ====================
// KRITISCH: Die Minecraft-JAR ist KEINE Library. Sie liegt in der version.json
// unter `downloads.client` (https://piston-data.mojang.com/.../client.jar).
// Die alte Implementierung suchte stattdessen in `libraries` nach
// "com.mojang:minecraft-client" — das existiert seit Jahren nicht mehr, also
// wurde stattdessen irgendeine xbeliebige Library auf die Classpath gehangen
// und das Spiel crashte sofort mit ClassNotFoundException.

function getClientJarPath(versionId) {
  return path.join(getVersionDir(versionId), 'client.jar');
}

async function downloadClientJar(versionJson, versionId, progressCb) {
  const client = versionJson.downloads && versionJson.downloads.client;
  if (!client || !client.url) {
    throw new Error(
      `version.json für ${versionId} enthält kein "downloads.client" — ` +
      'die Minecraft-JAR kann nicht geladen werden.'
    );
  }

  const destPath = getClientJarPath(versionId);
  const result = await downloadFileWithSha1(client.url, destPath, client.sha1);

  if (progressCb) progressCb({ phase: 'client', current: 1, total: 1, file: 'client.jar' });
  return { path: destPath, skipped: !!result.skipped };
}

// ---------- log4j-Konfiguration ----------
// versionJson.logging.client.argument ist z.B.
// "-Dlog4j.configurationFile=${path}". Ohne diese Datei startet das Spiel,
// log4j räumt aber Warnungen auf ("no log4j2 configuration file found") und
// die Logausgabe landet nicht im erwarteten Format.
function getLogConfigsDir() {
  const dir = path.join(getAssetsDir(), 'log_configs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function ensureLoggingConfig(versionJson) {
  const logging = versionJson.logging && versionJson.logging.client;
  if (!logging || !logging.file || !logging.file.url || !logging.argument) return null;

  const destPath = path.join(getLogConfigsDir(), `${logging.file.id}.xml`);
  await downloadFileWithSha1(logging.file.url, destPath, logging.file.sha1);

  return {
    argument: logging.argument.replace(/\$\{path\}/g, destPath),
    path: destPath
  };
}

/**
 * Classpath aus Client-JAR + Libraries bauen
 */
function buildClasspath(versionJson, versionId) {
  const librariesDir = getLibrariesDir(versionId);
  const entries = [];

  // Client-JAR zuerst — sie enthält die eigentliche Spiel-Implementierung
  // (net.minecraft.client.main.Main liegt in ihr, nicht in einer Library).
  entries.push(getClientJarPath(versionId));

  for (const lib of versionJson.libraries || []) {
    if (!lib.downloads?.artifact?.url) continue;
    if (!rulesAllow(lib.rules)) continue;

    // Natives gehören NICHT auf die Classpath: das sind reine DLL-Container,
    // die nach natives/ entpackt und über java.library.path geladen werden.
    // Ein Eintrag mit vier Namens-Teilen hat immer einen Classifier.
    if (lib.name.split(':').length > 3) continue;

    const localPath = libraryLocalPath(lib, librariesDir);
    if (localPath) entries.push(localPath);
  }

  return entries.join(path.delimiter); // ; auf Windows, : auf Unix
}

/**
 * JVM-Argumente aus version.json bauen
 *
 * Bewusst KEINE fest verdrahteten Tuning-Flags wie "-XX:+UseG1GC" oder
 * "-XX:MaxGCPauseMillis=100" — das waren Mojangs Vorgaben für Minecraft 1.8.
 * Seit Java 9 ist G1 der Standard-Garbage-Collector, und was der aktuelle
 * Launcher wirklich mitgibt, steht vollständig in der version.json. Alles
 * hier fest zu setzen hieße, dem Spiel Vorschriften zu machen.
 */
function buildJvmArgs(versionJson, javaPath, nativesDir, loggingConfig) {
  const args = [];

  // Natives Directory
  args.push(`-Djava.library.path=${nativesDir}`);

  // log4j-Konfiguration (versionJson.logging.client.argument ist z.B.
  // "-Dlog4j.configurationFile=${path}" — der Pfad kommt von ensureLoggingConfig).
  if (loggingConfig && loggingConfig.argument) {
    args.push(loggingConfig.argument);
  }

  // System-Properties, die wir selbst gesetzt haben. Die version.json setzt
  // einige davon ("-Djava.library.path=${natives_directory}") ein zweites Mal
  // mit identischem Wert — unübersichtlich, und HotSpot gewinnt einfach das
  // zuletzt genannte. Also entfernen wir die Dubletten hier.
  const ownSystemProperties = new Set(
    args.filter(a => a.startsWith('-D')).map(a => a.slice(2).split('=')[0])
  );

  // Aus version.json arguments.jvm
  const jvmArgs = filterArguments(versionJson.arguments?.jvm, launchFeatures(null, false));
  for (const arg of jvmArgs) {
    if (typeof arg !== 'string') continue;

    // "-cp" und "${classpath}" werden hier rausgeworfen: process.js setzt
    // -cp selbst aus launchOptions.classpath. Ohne dieses Herausfiltern
    // stünde im Aufruf zweimal "-cp" — einmal aus der version.json und
    // einmal aus process.js.
    if (arg === '-cp') continue;
    if (arg === '${classpath}') continue;

    const propertyKey = arg.startsWith('-D') ? arg.slice(2).split('=')[0] : null;
    if (propertyKey && ownSystemProperties.has(propertyKey)) continue;

    args.push(replacePlaceholders(arg, {
      natives_directory: nativesDir,
      launcher_name: 'liquid-launcher',
      launcher_version: LAUNCHER_VERSION,
      version_name: versionJson.id,
      library_directory: getLibrariesDir(versionJson.id),
      class_path: '' // wird von process.js gesetzt
    }));
  }

  return args;
}

/**
 * Game-Argumente aus version.json + Account bauen
 */
function buildGameArgs(versionJson, account, gameDir, resolution, assetIndexId, quickPlay) {
  const args = [];

  const features = launchFeatures(resolution, account?.isDemo, quickPlay);
  // Zwei getrennte Ziel-Variablen, damit ein Multiplayer-Start nicht
  // versehentlich in den Singleplayer-Zweig rutscht. `qpSP` traegt nur den
  // Ordnernamen einer Welt, `qpMP` nur "host:port".
  const qpSP = features.is_quick_play_singleplayer ? quickPlay : null;
  const qpMP = features.is_quick_play_multiplayer ? quickPlay : null;

  // Aus version.json arguments.game
  const gameArgs = filterArguments(versionJson.arguments?.game, features);
  const placeholders = {
    auth_player_name: account?.username || 'Player',
    version_name: versionJson.id,
    game_directory: gameDir,
    assets_root: getAssetsDir(),
    assets_index_name: assetIndexId || versionJson.assetIndex?.id || 'legacy',
    auth_uuid: account?.uuid || '00000000-0000-0000-0000-000000000000',
    // Echtes Token nach dem Microsoft-Login. Ohne Account (oder wenn die
    // Anmeldung fehlschlug) bleibt der Platzhalter: das Spiel startet dann
    // offline bis zum Titelbildschirm, statt mit einem erfundenen Token einen
    // 401 zu erzeugen, der schwerer zu deuten ist.
    auth_access_token: account?.accessToken || '0',
    // Ohne echten Login gibt es keine Client-ID. Der Platzhalter MUSS trotzdem
    // ersetzt werden, sonst bekommt das Spiel die literale Zeichenkette
    // "${clientid}" übergeben.
    clientid: account?.clientId || '',
    auth_xuid: account?.xuid || '',
    user_type: account?.userType || 'msa',
    version_type: 'release',
    auth_session: account?.accessToken || '0',
    game_assets: path.join(getAssetsDir(), 'objects'),
    launcher_name: 'liquid-launcher',
    launcher_version: LAUNCHER_VERSION,
    resolution_width: resolution?.width || '1280',
    resolution_height: resolution?.height || '720',
    // Quick-Play. Das Spiel erwartet hier den ORDNERNAMEN unter saves/, nicht
    // den im Spiel angezeigten Namen — "Neue Welt (3)" auf der Platte heisst
    // im Spiel "Neue Welt". Deshalb kommt der Wert aus dem Dateisystem.
    // Fuer den Serverstart ist es umgekehrt: "host:port", im Spiel genau so
    // einzugeben wie im Mehrspieler-Menü.
    // Ist Quick Play nicht aktiv, bleiben die Werte leer; die zugehoerigen
    // Argumente werden dann von filterArguments ohnehin entfernt, weil das
    // passende Feature false ist.
    quickPlayPath: qpSP ? String(qpSP.singleplayer) : '',
    quickPlaySingleplayer: qpSP ? String(qpSP.singleplayer) : '',
    quickPlayMultiplayer: qpMP ? String(qpMP.multiplayer) : '',
    quickPlayRealms: ''
  };

  for (const arg of gameArgs) {
    if (typeof arg === 'string') {
      args.push(replacePlaceholders(arg, placeholders));
    }
  }

  // Ersatz-Argumentliste für sehr alte Versionen, die noch kein
  // arguments.game in der version.json haben.
  if (args.length === 0) {
    args.push(
      '--username', placeholders.auth_player_name,
      '--version', placeholders.version_name,
      '--gameDir', placeholders.game_directory,
      '--assetsDir', placeholders.assets_root,
      '--assetIndex', placeholders.assets_index_name,
      '--uuid', placeholders.auth_uuid,
      '--accessToken', placeholders.auth_access_token,
      '--userType', placeholders.user_type,
      '--versionType', placeholders.version_type,
      '--width', placeholders.resolution_width,
      '--height', placeholders.resolution_height
    );
  }

  return args;
}

/**
 * HAUPT-FUNKTION: Alles für eine Version sicherstellen
 */
async function ensureVersionFiles(versionId, webContents = null) {
  const log = (line, level = 'info') => {
    if (webContents) {
      webContents.send('downloader:progress', { phase: 'log', line, level });
    }
  };

  log(`Lade Version-Manifest…`);
  const manifest = await getVersionManifest();

  log(`Lade ${versionId}.json…`);
  const versionJson = await getVersionJson(versionId);

  log(`Prüfe/Downloade Libraries…`);
  const libResult = await downloadLibraries(versionJson, versionId, (p) => {
    if (webContents) webContents.send('downloader:progress', p);
  });
  log(`Libraries: ${libResult.libraries} fertig, Natives entpackt: ${libResult.natives}`);
  if (libResult.failures.length) {
    log(`${libResult.failures.length} Library/Libraries fehlgeschlagen: ` +
      libResult.failures.slice(0, 3).map(f => f.item.name).join(', '), 'warn');
  }

  log(`Prüfe/Downloade Client-JAR…`);
  const clientResult = await downloadClientJar(versionJson, versionId, (p) => {
    if (webContents) webContents.send('downloader:progress', p);
  });
  log(`Client-JAR: ${clientResult.skipped ? 'bereits vorhanden' : 'heruntergeladen'}`);

  log(`Lade log4j-Konfiguration…`);
  const loggingConfig = await ensureLoggingConfig(versionJson);

  log(`Prüfe/Downloade Assets… (das dauert beim ersten Mal ein paar Minuten)`);
  const assetResult = await downloadAssets(versionJson, (p) => {
    if (webContents) webContents.send('downloader:progress', p);
  });
  log(`Assets: ${assetResult.assets} fertig`);
  if (assetResult.failures.length) {
    log(`${assetResult.failures.length} Assets fehlgeschlagen — das Spiel kann dadurch hängen bleiben.`, 'warn');
  }

  if (webContents) {
    webContents.send('downloader:complete', { versionId });
  }

  return {
    versionId,
    versionJson,
    assetIndexId: versionJson.assetIndex?.id,
    classpath: buildClasspath(versionJson, versionId),
    mainClass: versionJson.mainClass,
    nativesDir: getNativesDir(versionId),
    versionDir: getVersionDir(versionId),
    loggingConfig,
    failures: [...libResult.failures, ...assetResult.failures]
  };
}

/**
 * Launch-Optionen für process.js bauen
 */
function resolveLaunchOptions(downloadResult, account, javaPath, gameDir, resolution, memory, quickPlay) {
  return {
    javaPath,
    classpath: downloadResult.classpath,
    mainClass: downloadResult.mainClass,
    jvmArgs: buildJvmArgs(downloadResult.versionJson, javaPath, downloadResult.nativesDir, downloadResult.loggingConfig),
    gameArgs: buildGameArgs(downloadResult.versionJson, account, gameDir, resolution, downloadResult.assetIndexId, quickPlay),
    cwd: gameDir,
    nativesDir: downloadResult.nativesDir,
    ramMin: memory?.min || '1G',
    ramMax: memory?.max || '2G'
  };
}

module.exports = {
  getVersionManifest,
  getVersionJson,
  downloadLibraries,
  downloadAssets,
  downloadClientJar,
  ensureVersionFiles,
  resolveLaunchOptions,
  buildClasspath,
  buildJvmArgs,
  buildGameArgs,
  launchFeatures,
  getClientJarPath,
  getVersionDir,
  getNativesDir,
  getLibrariesDir,
  getAssetsDir
};