// src/main/java-runtime.js
// Java erkennen (Windows-Registry + PATH) und bei Bedarf automatisch eine
// passende JRE herunterladen (Adoptium-API, kein API-Key nötig).
//
// Bewusst UNABHÄNGIG von Electron gehalten (kein `require('electron')` hier):
// die Funktionen bekommen alles, was sie brauchen, als Parameter übergeben
// (z.B. den Zielordner). Dadurch lässt sich dieses Modul auch mit einem
// einfachen `node`-Skript isoliert testen, ohne die ganze App zu starten —
// siehe test-java-runtime.js daneben.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function run(cmd, args){
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      // Bewusst nie rejecten — ein fehlgeschlagener Erkennungsversuch ist
      // kein Fehler, sondern bedeutet nur "hier nichts gefunden".
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ---------- welche Java-Version braucht welche Minecraft-Version ----------
function requiredJavaMajor(mcVersion){
  const [major, minor] = mcVersion.split('.').map(Number);
  if (major === 1 && minor >= 20) return 21; // 1.20.5+ verlangt Java 21
  if (major === 1 && minor >= 18) return 17; // 1.18–1.20.4
  if (major === 1 && minor === 17) return 16;
  return 8; // 1.16 und älter
}

function parseJavaVersionOutput(text){
  // "java version "21.0.2" ..." ODER "openjdk version "17.0.9" ..."
  const m = text.match(/version\s+"(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const first = parseInt(m[1], 10);
  // Alte Schreibweise: java 8 meldet sich als "1.8.0_xxx" -> erste Zahl ist 1,
  // die eigentliche Major-Version steckt in der zweiten Gruppe.
  return first === 1 ? parseInt(m[2], 10) : first;
}

async function checkJavaAt(javaPath){
  const { err, stderr, stdout } = await run(javaPath, ['-version']);
  if (err) return null;
  const versionText = stderr || stdout; // java -version schreibt traditionell nach stderr
  const major = parseJavaVersionOutput(versionText);
  if (major == null) return null;
  return { path: javaPath, version: major };
}

// ---------- Windows-Registry durchsuchen ----------
async function findJavaHomesInRegistry(){
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\JavaSoft\\JRE',
    'HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK',
    'HKLM\\SOFTWARE\\Eclipse Adoptium\\JRE',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\Eclipse Foundation\\JDK'
  ];
  const homes = [];
  for (const key of keys) {
    const { err, stdout } = await run('reg', ['query', key, '/s', '/v', 'JavaHome']);
    if (err) continue;
    const matches = stdout.matchAll(/JavaHome\s+REG_SZ\s+(.+)/g);
    for (const m of matches) homes.push(m[1].trim());
  }
  return [...new Set(homes)];
}

/**
 * Sucht nach einer installierten, zur Ziel-Version passenden Java-Installation.
 * @param {number} requiredMajor z.B. 21 (siehe requiredJavaMajor)
 * @returns {Promise<{found:boolean, path?:string, version?:number, isCompatible?:boolean}>}
 */
async function detectJava(requiredMajor){
  const candidates = [];

  // 1) PATH — das "java", das man auch im Terminal bekäme.
  //    Unter Windows lösen wir den Namen gleich zu den echten Dateien auf:
  //    ein blankes "java" als javaPath ist eine ticking time bomb, weil der
  //    Start später über einen PATH auflöst, der nicht der des Launchers ist.
  if (process.platform === 'win32') {
    const { stdout } = await run('where', ['java']);
    const found = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (found.length) found.forEach(p => candidates.push(p));
    else candidates.push('java');
  } else {
    candidates.push('java');
  }

  // 2) Windows-Registry
  const homes = await findJavaHomesInRegistry();
  homes.forEach(home => candidates.push(path.join(home, 'bin', 'java.exe')));

  // 3) übliche manuelle Installationsorte, falls Registry nichts findet
  const guessDirs = ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium'];
  for (const dir of guessDirs) {
    try {
      const entries = fs.readdirSync(dir);
      entries.forEach(e => candidates.push(path.join(dir, e, 'bin', 'java.exe')));
    } catch { /* Ordner existiert nicht — ignorieren */ }
  }

  let bestMatch = null;
  let bestAny = null;

  for (const candidate of candidates) {
    const result = await checkJavaAt(candidate);
    if (!result) continue;
    if (!bestAny) bestAny = result;
    if (result.version === requiredMajor || (result.version > requiredMajor && !bestMatch)) {
      // exakte Version bevorzugen, sonst die kleinste noch ausreichende
      if (!bestMatch || result.version < bestMatch.version) bestMatch = result;
    }
  }

  const chosen = bestMatch || bestAny;
  if (!chosen) return { found: false };

  return {
    found: true,
    path: chosen.path,
    version: chosen.version,
    isCompatible: chosen.version >= requiredMajor
  };
}

// ---------- fehlende Java-Version automatisch laden (Adoptium-API) ----------
async function fetchJson(url){
  const res = await fetch(url, { headers: { 'User-Agent': 'liquid-launcher/0.1' } });
  if (!res.ok) throw new Error(`Adoptium-Anfrage fehlgeschlagen (HTTP ${res.status}) für ${url}`);
  return res.json();
}

/**
 * Lädt eine passende JRE herunter und legt sie in targetDir ab
 * (App-eigener Ordner, keine Systeminstallation).
 * @param {number} majorVersion z.B. 21
 * @param {string} targetDir z.B. path.join(app.getPath('userData'), 'java')
 * @returns {Promise<{path:string}>}
 */
async function downloadJava(majorVersion, targetDir){
  const url = `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot`
    + `?image_type=jre&os=windows&architecture=x64`;
  const assets = await fetchJson(url);
  if (!assets || !assets.length) {
    throw new Error(`Adoptium hat keine JRE für Java ${majorVersion} (Windows x64) gefunden.`);
  }
  const asset = assets[0];
  const binary = asset.binary;
  const downloadUrl = binary.package.link;
  const expectedSha256 = binary.package.checksum;
  const versionFolderName = `jre-${majorVersion}`;
  const extractDir = path.join(targetDir, versionFolderName);

  // Schon vorhanden? Dann nicht nochmal laden.
  const existingJavaExe = findJavaExeUnder(extractDir);
  if (existingJavaExe) return { path: existingJavaExe };

  fs.mkdirSync(targetDir, { recursive: true });
  const zipPath = path.join(targetDir, `${versionFolderName}.zip`);

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Java-Download fehlgeschlagen (HTTP ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error('Prüfsumme des Java-Downloads stimmt nicht überein — Download verworfen.');
  }

  fs.writeFileSync(zipPath, buffer);

  // Kein zusätzliches npm-Paket fürs Entpacken nötig: PowerShell kann das
  // auf jedem Windows-Rechner bereits von Haus aus (Expand-Archive).
  await new Promise((resolve, reject) => {
    execFile('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`
    ], { windowsHide: true, timeout: 60000 }, (err) => {
      if (err) reject(new Error('Java-Archiv konnte nicht entpackt werden: ' + err.message));
      else resolve();
    });
  });

  fs.unlinkSync(zipPath); // Zip nach dem Entpacken nicht mehr nötig

  const javaExe = findJavaExeUnder(extractDir);
  if (!javaExe) throw new Error('Java wurde entpackt, aber java.exe wurde darin nicht gefunden.');
  return { path: javaExe };
}

// Adoptium packt die JRE in einen Unterordner mit Versionsnamen (z.B.
// "jdk-21.0.2+13-jre") — daher rekursiv (aber flach genug) nach java.exe suchen.
function findJavaExeUnder(dir){
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'java.exe') return full;
      if (entry.isDirectory()) {
        const found = findJavaExeUnder(full);
        if (found) return found;
      }
    }
  } catch { /* Ordner existiert noch nicht */ }
  return null;
}

module.exports = { detectJava, downloadJava, requiredJavaMajor };
