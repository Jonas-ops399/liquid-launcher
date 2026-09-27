// test-full-launch.js
// Vollständiger Start-Test OHNE Electron-Fenster: Java -> Dateien -> JVM.
// Nutzt exakt dieselben Module, die auch instances:launch benutzt, nur
// gegen ein temporäres Verzeichnis statt gegen den echten AppData-Ordner.
//
//   node test-full-launch.js [mcVersion] [sekunden] [weltOrdnerName]
//
// Mit Welt-OrdnerName wird Quick Play getestet: das Spiel startet dann direkt
// in diese Welt, ohne den Welt-Auswahl-Bildschirm. Die Welt muss vorher unter
// <TEST_DIR>/gameDir/saves/<Name> liegen — der Test legt sie selbst an.
//
// ACHTUNG: Beim ersten Durchlauf werden ca. 500 MB Assets geladen.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ---------- electron stubben ----------
const TEST_DIR = process.env.LAUNCHER_TEST_DIR
  || path.join(os.tmpdir(), 'liquid-launcher-fulltest');
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: { app: { getPath: () => TEST_DIR } }
};

const { detectJava, downloadJava, requiredJavaMajor } = require('./src/main/java-runtime');
const { ensureVersionFiles, resolveLaunchOptions } = require('./src/main/downloader');
const { launchProcess, stopProcess } = require('./src/main/process');

const MC_VERSION = process.argv[2] || '1.21.4';
const RUN_SECONDS = Number(process.argv[3] || 45);
const WORLD_ID = process.argv[4] || null;
const GAME_DIR = path.join(TEST_DIR, 'gameDir');

let lineCount = 0;
function log(msg) { console.log(msg); }

async function main() {
  const t0 = Date.now();
  const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

  // ---------- 1) Java ----------
  log(`${stamp()} Schritt 1/4 — Java suchen`);
  const major = requiredJavaMajor(MC_VERSION);
  let java = await detectJava(major);
  if (!java.found || !java.isCompatible) {
    log(`${stamp()}   kein passendes Java -> lade Java ${major} (Adoptium)`);
    const installed = await downloadJava(major, path.join(TEST_DIR, 'java'));
    java = { found: true, path: installed.path, isCompatible: true };
  }
  log(`${stamp()}   Java ${java.version}: ${java.path}`);

  // ---------- 2) Dateien ----------
  log(`${stamp()} Schritt 2/4 — Libraries, Client-JAR und Assets sicherstellen`);
  log(`${stamp()}   (Erster Lauf: das dauert ein paar Minuten)`);
  const result = await ensureVersionFiles(MC_VERSION, {
    send(channel, payload) {
      if (channel !== 'downloader:progress' || !payload) return;
      if (payload.phase === 'log') {
        log(`${stamp()}   ${payload.line}`);
      } else if (typeof payload.current === 'number' && payload.total
                 && payload.current % 250 === 0) {
        log(`${stamp()}   ${payload.phase}: ${payload.current}/${payload.total}`);
      }
    }
  });
  log(`${stamp()}   classpath: ${result.classpath.split(path.delimiter).length} Einträge`);

  // ---------- 3) Startoptionen ----------
  log(`${stamp()} Schritt 3/4 — Startoptionen bauen`);

  // Quick Play: Welt muss real unter saves/ liegen, sonst ist der Test wertlos
  // (das Spiel würde nur den Titelbildschirm zeigen).
  let quickPlay = null;
  if (WORLD_ID) {
    const saves = path.join(GAME_DIR, 'saves', WORLD_ID);
    if (!fs.existsSync(path.join(saves, 'level.dat'))) {
      throw new Error(`Testwelt "${WORLD_ID}" fehlt unter ${saves}. Bitte vorher anlegen.`);
    }
    quickPlay = { singleplayer: WORLD_ID };
    log(`${stamp()}   Quick Play: starte direkt in Welt "${WORLD_ID}"`);
  }

  const options = resolveLaunchOptions(
    result,
    { username: 'TestSpieler', uuid: '11111111-2222-3333-4444-555555555555', accessToken: 'demo-token', userType: 'msa' },
    java.path,
    GAME_DIR,
    { width: 1280, height: 720 },
    { min: '1G', max: '2G' },
    quickPlay
  );
  fs.mkdirSync(GAME_DIR, { recursive: true });
  log(`${stamp()}   mainClass: ${options.mainClass}`);
  log(`${stamp()}   jvmArgs:   ${options.jvmArgs.length}, gameArgs: ${options.gameArgs.length}`);

  // Die Quick-Play-Argumente ausgeben — das ist das eigentliche Prüfstück:
  // sie muessen als PAAR (Flag, Wert) dastehen und duerfen nicht als
  // leerer String durchrutschen.
  if (quickPlay) {
    const paare = [];
    for (let i = 0; i < options.gameArgs.length - 1; i++) {
      if (/^--quickPlay/.test(options.gameArgs[i])) {
        paare.push(`${options.gameArgs[i]} [${options.gameArgs[i + 1]}]`);
      }
    }
    log(`${stamp()}   quickPlay-Argumente: ${paare.join('  ') || '(KEINE!)'}`);
    if (paare.length === 0) throw new Error('Quick Play wurde angefordert, aber kein Argument erzeugt.');
    const leer = options.gameArgs.some((a, i) =>
      /^--quickPlay/.test(options.gameArgs[i - 1] || '') && a === '');
    if (leer) throw new Error('Ein quickPlay-Argument hat einen leeren Wert bekommen.');
  }

  // ---------- 4) Starten ----------
  log(`${stamp()} Schritt 4/4 — JVM starten, ${RUN_SECONDS}s laufen lassen`);
  const emitter = launchProcess(options);
  const procId = emitter.instanceId;

  let sawRunning = false;
  let exitInfo = null;
  const interesting = [
    /Exception in thread/i, /Caused by/, /at [a-z].*\.java:\d+/i, /error/i,
    /Setting user:/, /Loading/, /Backend library/, /Created:.*texture/i,
    /session/i, /auth/i, /Failed/i, /Crash report/i
  ];

  emitter.on('log', (data) => {
    lineCount++;
    if (data.level === 'error' || interesting.some(re => re.test(data.line))) {
      log(`${stamp()}   [${data.level}] ${data.line}`);
    }
  });
  emitter.on('running', () => {
    if (sawRunning) return;
    sawRunning = true;
    log(`${stamp()}   >>> JVM läuft, erste Log-Zeile nach ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });
  emitter.on('closed', (d) => { exitInfo = { art: 'beendet', code: d.exitCode }; });
  emitter.on('crashed', (d) => { exitInfo = { art: 'abgestürzt', code: d.exitCode, last: d.lastLogLines }; });

  await new Promise(resolve => setTimeout(resolve, RUN_SECONDS * 1000));

  log('\n' + '='.repeat(70));
  if (exitInfo) {
    log(`PROZESS SELBST BEENDET: ${exitInfo.art} (Exit-Code ${exitInfo.code})`);
    if (exitInfo.last) {
      log('Letzte Log-Zeilen:');
      exitInfo.last.slice(-20).forEach(l => log('   ' + l));
    }
  } else {
    log('PROZESS LÄUFT NOCH — das Spiel ist also nicht abgestürzt.');
  }
  log(`Log-Zeilen vom Spiel insgesamt: ${lineCount}`);
  log('='.repeat(70));

  log(`${stamp()} Beende JVM …`);
  const stopped = await stopProcess(procId, 8000);
  log(`${stamp()} Beendet: ${stopped ? 'ja' : 'nur erzwungen'}`);

  // Kein Waisenprozess darf übrig bleiben.
  await new Promise(r => setTimeout(r, 1500));
  log('\nTestordner:', TEST_DIR);
  log(`Assets belegen: ${(dirSize(path.join(TEST_DIR, 'assets')) / 1024 / 1024).toFixed(0)} MB`);
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

main().catch(err => {
  console.error('\n❌ Fehlgeschlagen:', err.message);
  process.exitCode = 1;
});
