// test-fabric-loader.js
//   node test-fabric-loader.js
//
// Testet src/main/fabricLoader.js unter reinem Node - OHNE Netzwerk und ohne
// Electron. Die Netzwerk-Funktionen (holeLoaderListe/holeProfil) werden nicht
// aufgerufen; geprueft wird alles, was aus einer Antwort wird:
//
//   - Maven-Namen zerlegen und URLs bauen (das Format von meta.fabricmc.net)
//   - Fabric-Libraries auf die Mojang-Form normalisieren
//   - Vanilla-version.json und Fabric-Profil verschmelzen (Dedupe, Argumente,
//     MainClass, unveraenderte Eingaben)
//   - die Loader-Version waehlen (neueste stabile / Wunsch / Fehlerfall)
//   - dass die verschmolzene version.json mit dem ECHTEN downloader
//     zusammenpasst: buildClasspath muss die Fabric-Libraries enthalten und
//     die Client-JAR an erster Stelle fuehren.
//
// Warum der letzte Punkt wichtig ist: "sieht wie eine version.json aus" beweist
// nichts. Die normalisierten Libraries muessen genau die Felder tragen, die
// downloader.js liest (downloads.artifact.url und .path) - sonst faellt der
// Fehler erst nach dem Download auf, und das Spiel steigt mit
// ClassNotFoundException aus.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fab = require('./src/main/fabricLoader.js');

// ---------- electron stubben (nur fuer buildClasspath) ----------
// downloader.js braucht app.getPath('userData'). buildClasspath liest nur
// Pfade, keine Dateien - es wird also nichts heruntergeladen.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'll-fabric-'));
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: { app: { getPath: () => TEST_DIR } }
};
const { buildClasspath } = require('./src/main/downloader');

let bestanden = 0;
let gescheitert = 0;
const fehlerListe = [];

function pruefe(bezeichnung, bedingung, zusatz) {
  if (bedingung) {
    bestanden++;
    console.log(`  OK   ${bezeichnung}`);
  } else {
    gescheitert++;
    fehlerListe.push(bezeichnung);
    console.log(`  FEHL ${bezeichnung}${zusatz ? '  -> ' + zusatz : ''}`);
  }
}

function gleich(bezeichnung, ist, soll) {
  pruefe(bezeichnung, ist === soll, `ist ${JSON.stringify(ist)}, erwartet ${JSON.stringify(soll)}`);
}

function wirft(bezeichnung, fn) {
  try {
    fn();
    pruefe(bezeichnung, false, 'hat NICHT geworfen');
    return null;
  } catch (err) {
    pruefe(bezeichnung, true);
    return err;
  }
}

// ===================== Fixtures =====================

// Ein Ausschnitt einer echten Vanilla-version.json - nur die Felder, die die
// Startkette liest, plus drei Libraries in Mojang-Form.
const VANILLA = {
  id: '1.21.11',
  mainClass: 'net.minecraft.client.main.Main',
  type: 'release',
  assetIndex: { id: '1.21', url: 'https://piston-meta.mojang.com/1.21.json' },
  downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1: 'client-sha' } },
  logging: {
    client: {
      argument: '-Dlog4j.configurationFile=${path}',
      file: { id: 'client-1.12.xml', url: 'https://piston-data.mojang.com/log.xml', sha1: 'log-sha' }
    }
  },
  javaVersion: { majorVersion: 21 },
  arguments: {
    jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    game: ['--username', '${auth_player_name}', '--version', '${version_name}']
  },
  libraries: [
    {
      name: 'com.mojang:brigadier:1.3.10',
      downloads: { artifact: { url: 'https://libraries/brigadier-1.3.10.jar', path: 'com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar', sha1: 's1' } }
    },
    {
      name: 'org.ow2.asm:asm:9.7',
      downloads: { artifact: { url: 'https://libraries/asm-9.7.jar', path: 'org/ow2/asm/asm/9.7/asm-9.7.jar', sha1: 's2' } }
    },
    {
      name: 'org.lwjgl:lwjgl:3.3.3:natives-windows',
      downloads: { artifact: { url: 'https://libraries/lwjgl-natives.jar', path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', sha1: 's3' } }
    }
  ]
};

// Ein Ausschnitt des ECHTEN Fabric-Profils (meta.fabricmc.net). Entscheidend:
// die Libraries stehen im MAVEN-Format, ohne downloads.artifact.
const FABRIC = {
  id: 'fabric-loader-0.19.5-1.21.11',
  inheritsFrom: '1.21.11',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [
    { name: 'org.ow2.asm:asm:9.10.1', url: 'https://maven.fabricmc.net/', sha1: 'a1', size: 126151 },
    { name: 'net.fabricmc:intermediary:1.21.11', url: 'https://maven.fabricmc.net/' },
    { name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' }
  ]
};

const META = [
  { loader: { version: '0.19.5', stable: true }, intermediary: { version: '1.21.11' } },
  { loader: { version: '0.20.0-beta.1', stable: false } },
  { loader: { version: '0.18.0', stable: true } }
];

console.log('Fabric-Loader');
console.log('');

// ------------------------------------------------------------------ Maven
console.log('[1] Maven-Namen zerlegen');
const einfach = fab.mavenNameZerlegen('net.fabricmc:fabric-loader:0.19.5');
gleich('einfacher Name: Gruppe', einfach && einfach.gruppe, 'net.fabricmc');
gleich('einfacher Name: Artefakt', einfach && einfach.artefakt, 'fabric-loader');
gleich('einfacher Name: Version', einfach && einfach.version, '0.19.5');
gleich('einfacher Name: Datei', einfach && einfach.dateiName, 'fabric-loader-0.19.5.jar');
gleich('einfacher Name: Pfad', einfach && einfach.pfad,
  'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');

const klass = fab.mavenNameZerlegen('org.lwjgl:lwjgl:3.3.3:natives-windows');
gleich('Classifier: Dateiname', klass && klass.dateiName, 'lwjgl-3.3.3-natives-windows.jar');
gleich('Classifier: erkannt', klass && klass.klassifikator, 'natives-windows');
gleich('Classifier: Pfad', klass && klass.pfad,
  'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');

const mitExt = fab.mavenNameZerlegen('com.example:lib:1.0:all@zip');
gleich('Endung @zip: erweiterung', mitExt && mitExt.erweiterung, 'zip');
gleich('Endung @zip: Dateiname', mitExt && mitExt.dateiName, 'lib-1.0-all.zip');

gleich('zu kurz -> null', fab.mavenNameZerlegen('abc'), null);
gleich('zwei Teile -> null', fab.mavenNameZerlegen('a:b'), null);
gleich('leer -> null', fab.mavenNameZerlegen(''), null);
gleich('keine Zeichenkette -> null', fab.mavenNameZerlegen(42), null);

console.log('');
console.log('[2] Maven-URLs bauen');
gleich('mit Schraegstrich am Ende', fab.mavenUrl('https://maven.fabricmc.net/', 'net.fabricmc:fabric-loader:0.19.5'),
  'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
gleich('ohne Schraegstrich am Ende', fab.mavenUrl('https://maven.fabricmc.net', 'net.fabricmc:fabric-loader:0.19.5'),
  'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
gleich('unbekannter Name -> null', fab.mavenUrl('https://maven.fabricmc.net/', 'quatsch'), null);
gleich('leere Basis -> null', fab.mavenUrl('', 'net.fabricmc:intermediary:1.21.11'), null);

// ------------------------------------------------------- Normalisieren
console.log('');
console.log('[3] Fabric-Libraries normalisieren');
const norm = fab.normalisiereLoaderBibliothek(FABRIC.libraries[0]);
gleich('downloads.artifact entstanden', !!(norm.downloads && norm.downloads.artifact), true);
gleich('artifact.url zeigt aufs Repository', norm.downloads.artifact.url,
  'https://maven.fabricmc.net/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
gleich('artifact.path bestimmt die Ablage', norm.downloads.artifact.path,
  'org/ow2/asm/asm/9.10.1/asm-9.10.1.jar');
gleich('sha1 uebernommen', norm.downloads.artifact.sha1, 'a1');

const ohneSha = fab.normalisiereLoaderBibliothek(FABRIC.libraries[2]);
gleich('ohne sha1: URL trotzdem gebaut', ohneSha.downloads.artifact.url,
  'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
gleich('ohne sha1: kein Feld erfunden', 'sha1' in ohneSha.downloads.artifact, false);

const schonMojang = fab.normalisiereLoaderBibliothek(VANILLA.libraries[0]);
pruefe('bereits Mojang-Form: identisches Objekt', schonMojang === VANILLA.libraries[0]);

pruefe('Original nicht veraendert', FABRIC.libraries[0].downloads === undefined);

// --------------------------------------------------------- Verschmelzen
console.log('');
console.log('[4] version.json verschmelzen');
const gemischt = fab.verschmelze(VANILLA, FABRIC);

gleich('id bleibt die Vanilla-id', gemischt.id, '1.21.11');
gleich('profilId nennt die Herkunft', gemischt.profilId, 'fabric-loader-0.19.5-1.21.11');
gleich('MainClass kommt von Fabric', gemischt.mainClass,
  'net.fabricmc.loader.impl.launch.knot.KnotClient');
gleich('assetIndex bleibt von Vanilla', gemischt.assetIndex && gemischt.assetIndex.id, '1.21');
gleich('downloads.client bleibt von Vanilla', gemischt.downloads.client.sha1, 'client-sha');
gleich('logging bleibt von Vanilla', gemischt.logging.client.file.sha1, 'log-sha');
gleich('javaVersion bleibt von Vanilla', gemischt.javaVersion.majorVersion, 21);

// 3 Vanilla + 3 Fabric - 1 Doppel (asm) = 5
gleich('Libraries zusammengefuehrt, Dublette raus', gemischt.libraries.length, 5);
const asms = gemischt.libraries.filter((l) => /:asm:/.test(l.name));
gleich('nur EIN asm im Ergebnis', asms.length, 1);
gleich('und zwar Fabric-asm (spaeter gewinnt)', asms[0].name, 'org.ow2.asm:asm:9.10.1');
const fabLib = gemischt.libraries.find((l) => l.name === 'net.fabricmc:fabric-loader:0.19.5');
gleich('fabric-loader liegt auf der Classpath-Ablage',
  fabLib && fabLib.downloads.artifact.path,
  'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
pruefe('intermediary laedt ohne Pruefsumme',
  gemischt.libraries.some((l) => l.name.startsWith('net.fabricmc:intermediary') && !l.downloads.artifact.sha1));

const jvmAct = gemischt.arguments.jvm;
pruefe('Vanilla-jvm-Argumente bleiben', jvmAct.includes('-Djava.library.path=${natives_directory}'));
pruefe('Fabric-jvm-Argument angehaengt', jvmAct.some((a) => /^-DFabricMcEmu=/.test(a)));
gleich('game-Argumente bleiben vollstaendig', gemischt.arguments.game.length, 4);

// Eingaben sauber
gleich('Vanilla-Libraries unveraendert', VANILLA.libraries.length, 3);
gleich('Fabric-Profil unveraendert', FABRIC.libraries.length, 3);
pruefe('Vanilla-mainClass unveraendert', VANILLA.mainClass === 'net.minecraft.client.main.Main');
gleich('Rueckgabe ist ein neues Objekt', gemischt === VANILLA, false);

console.log('');
console.log('[4b] Fehler- und Sonderfaelle');
wirft('ohne Vanilla wirft', () => fab.verschmelze(null, FABRIC));
wirft('ohne Profil wirft', () => fab.verschmelze(VANILLA, null));
const nurMain = fab.verschmelze({ id: 'x', mainClass: 'Main' }, { id: 'p', mainClass: 'Knot' });
gleich('leere Libraries erlaubt', nurMain.libraries.length, 0);
gleich('leere Argumente erlaubt', nurMain.arguments.jvm.length + nurMain.arguments.game.length, 0);

// ------------------------------------------------------ Version waehlen
console.log('');
console.log('[5] Loader-Version waehlen');
gleich('ohne Wunsch: neueste stabile', fab.waehleLoaderVersion(META, null), '0.19.5');
gleich('leerer Wunsch = kein Wunsch', fab.waehleLoaderVersion(META, '   '), '0.19.5');
gleich('Wunsch exakt getroffen', fab.waehleLoaderVersion(META, '0.20.0-beta.1'), '0.20.0-beta.1');
wirft('unbekannter Wunsch wirft', () => fab.waehleLoaderVersion(META, '9.9.9'));
wirft('leere Liste wirft', () => fab.waehleLoaderVersion([], null));
gleich('nur instabil -> erste genommen',
  fab.waehleLoaderVersion([{ loader: { version: '0.20.0-beta.1', stable: false } }], null),
  '0.20.0-beta.1');
gleich('Kandidaten filtert Unbrauchbares',
  fab.loaderKandidaten([null, {}, { loader: {} }, { loader: { version: '0.1.0', stable: true } }]).length, 1);

// -------------------------------------------- Zusammenspiel mit downloader
console.log('');
console.log('[6] Zusammenspiel mit downloader.buildClasspath');
// downloader wurde oben mit electron-Stub geladen.
const downloader = require('./src/main/downloader');
const classpath = downloader.buildClasspath(gemischt, '1.21.11');
const eintraege = classpath.split(path.delimiter);
pruefe('Client-JAR steht an erster Stelle', /client\.jar$/.test(eintraege[0]));
pruefe('fabric-loader.jar liegt auf der Classpath',
  eintraege.some((e) => e.endsWith(path.join('fabric-loader', '0.19.5', 'fabric-loader-0.19.5.jar'))));
pruefe('Fabric-asm (9.10.1) liegt auf der Classpath',
  eintraege.some((e) => e.endsWith(path.join('asm', '9.10.1', 'asm-9.10.1.jar'))));
pruefe('altes Vanilla-asm (9.7) NICHT mehr doppelt', !eintraege.some((e) => e.endsWith(path.join('asm', '9.7', 'asm-9.7.jar'))));
pruefe('Native-Classifiertren bleiben draussen', !eintraege.some((e) => /natives-windows\.jar$/.test(e)));

// Die Vanilla-Classpath bleibt unveraendert - kein heimlicher Fabric-Einfluss.
const vanillaCp = downloader.buildClasspath(VANILLA, '1.21.11').split(path.delimiter);
gleich('Vanilla ohne Loader: 1 Client-JAR + 2 Libraries (Native faellt raus)', vanillaCp.length, 3);
pruefe('Vanilla-Classpath enthaelt kein Fabric',
  !vanillaCp.some((e) => /fabricmc/.test(e)));

// ------------------------------------------------------------------ Ergebnis
console.log('');
console.log('='.repeat(60));
console.log(`bestanden: ${bestanden}   gescheitert: ${gescheitert}`);
if (fehlerListe.length) {
  console.log('');
  console.log('Fehlgeschlagen:');
  for (const f of fehlerListe) console.log('  - ' + f);
}
console.log('='.repeat(60));
process.exit(gescheitert ? 1 : 0);
