// test-launch-chain.js
// Isolierter Test für downloader.js — läuft mit reinem "node", braucht KEIN
// Electron-Fenster. downloader.js braucht an sich Electron (app.getPath),
// deshalb wird 'electron' hier vor dem Require durch einen Stub ersetzt.
//
//   node test-launch-chain.js
//
// Prüft die Argument-Kette, die sonst erst nach ~500 MB Download auffallen
// würde: Classpath, JVM-Argumente, Game-Argumente — und lädt die Client-JAR
// wirklich herunter (~25 MB), weil genau DIE vorher komplett fehlte.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// ---------- electron stubben ----------
// downloader.js ruft app.getPath('userData') zur Laufzeit auf, nicht beim
// Laden. Also reicht es, 'electron' vor dem ersten Require zu ersetzen.
const TEST_DIR = path.join(os.tmpdir(), 'liquid-launcher-downloader-test');
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: { getPath: () => TEST_DIR }
  }
};

const {
  getVersionJson,
  downloadClientJar,
  buildClasspath,
  buildJvmArgs,
  buildGameArgs,
  launchFeatures,
  resolveLaunchOptions,
  getClientJarPath
} = require('./src/main/downloader');

const MC_VERSION = process.argv[2] || '1.21.4';
// Form eines echten Accounts, wie ihn toLaunchAccount() liefert: UUID mit
// Bindestrichen, numerische XUID, JWT-förmiges Token. Mit 'demo-token' sieht
// die Befehlszeile zwar gleich aus, aber ein Blick auf die Länge des Tokens
// und auf --clientId war mit Platzhaltern nicht möglich.
const ACCOUNT = {
  username: 'TestSpieler',
  uuid: '11111111-2222-3333-4444-555555555555',
  accessToken: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIG',
  xuid: '253546359469698271',
  userType: 'msa',
  isDemo: false,
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
};

function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

async function main() {
  const versionJson = await getVersionJson(MC_VERSION);

  section(`${MC_VERSION} — Eckdaten aus version.json`);
  console.log('mainClass:      ', versionJson.mainClass);
  console.log('assetIndex:     ', versionJson.assetIndex?.id);
  console.log('Libraries:      ', (versionJson.libraries || []).length);
  console.log('downloads.client:', versionJson.downloads?.client ? 'JA (wird gebraucht)' : 'NEIN');

  section('Client-JAR herunterladen (der Bug, der vorher alles blockiert hat)');
  const client = await downloadClientJar(versionJson, MC_VERSION, () => {});
  console.log('Pfad:   ', client.path);
  console.log('Status: ', client.skipped ? 'war schon da (SHA1 stimmt)' : 'heruntergeladen + SHA1 verifiziert');
  console.log('Größe:  ', (require('node:fs').statSync(client.path).size / 1024 / 1024).toFixed(1), 'MB');
  if (!require('node:fs').existsSync(getClientJarPath(MC_VERSION))) {
    throw new Error('client.jar liegt nicht da, wo buildClasspath() es erwartet.');
  }

  section('Classpath');
  const classpath = buildClasspath(versionJson, MC_VERSION);
  const entries = classpath.split(path.delimiter);
  console.log('Einträge gesamt:', entries.length);
  console.log('  [0] ', entries[0], '  <- muss die Client-JAR sein');
  if (!/client\.jar$/.test(entries[0])) {
    throw new Error('Die Client-JAR steht NICHT an erster Stelle der Classpath.');
  }
  const macOnly = entries.filter(e => /objc-bridge|macos|osx/.test(e));
  console.log('  macOS-only-JARs auf der Classpath:', macOnly.length, '(muss 0 sein)');
  if (macOnly.length) throw new Error('Regel-Filter kaputt: macOS-Bibliotheken landen auf der Windows-Classpath.');

  section('Natives-Erkennung (der Bug, der Minecraft gar nicht erst starten ließ)');
  const nativeClassifier = `natives-${
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  }`;
  const withClassifier = (versionJson.libraries || []).filter(l => l.name.split(':').length > 3);
  const legacyClassifiers = (versionJson.libraries || [])
    .filter(l => l.downloads && l.downloads.classifiers);
  const ourNatives = withClassifier.filter(l => l.name.split(':')[3] === nativeClassifier);

  console.log('Libraries mit Classifier im Namen:', withClassifier.length);
  console.log('  davon für unser System (' + nativeClassifier + '):', ourNatives.length);
  console.log('Libraries im ALTEN Format (downloads.classifiers):', legacyClassifiers.length);
  console.log('  -> Es gibt nur EIN relevantes Format. Code muss beide können.');
  if (ourNatives.length === 0 && legacyClassifiers.length === 0) {
    throw new Error('Weder modernes noch altes Natives-Format gefunden — Test ist ungültig.');
  }
  const expectedSource = ourNatives.length > 0 ? 'modern' : 'legacy';
  console.log('  maßgebliches Format in dieser Version:', expectedSource);
  console.log('Beispiele:', ourNatives.slice(0, 3).map(l => l.name).join(', ') || '(n/a)');
  // Gegenprobe: die Classpath darf die Natives-JARs NICHT enthalten.
  const cp = buildClasspath(versionJson, MC_VERSION).split(path.delimiter);
  const nativesOnCp = cp.filter(e => /natives-(windows|linux|macos)/.test(e));
  console.log('Natives-JARs auf der Classpath:', nativesOnCp.length, '(muss 0 sein)');
  if (nativesOnCp.length) throw new Error('Natives-JARs gehören nicht auf die Classpath.');

  section('JVM-Argumente');
  const jvmArgs = buildJvmArgs(versionJson, 'C:\\Java\\bin\\java.exe', path.join(TEST_DIR, 'natives'), {
    argument: '-Dlog4j.configurationFile=C:\\logs\\client.xml',
    path: 'C:\\logs\\client.xml'
  });
  jvmArgs.forEach(a => console.log('  ', a));

  const problems = [];
  if (jvmArgs.filter(a => a === '-cp').length > 0) problems.push('-cp kommt doppelt vor (version.json + process.js)');
  if (jvmArgs.some(a => a.includes('${'))) problems.push('unersetzter Platzhalter in den JVM-Args');
  if (jvmArgs.some(a => a === '-XstartOnFirstThread')) problems.push('macOS-Argument unter Windows');
  if (!jvmArgs.some(a => a.startsWith('-Dlog4j.configurationFile='))) problems.push('log4j-Konfiguration fehlt');

  // Doppelte -D Properties: HotSpot nimmt stillschweigend die letzte, also
  // ist es nicht fatal — aber es versteckt Fehler und macht Logs unlesbar.
  const seenProps = new Map();
  jvmArgs.filter(a => a.startsWith('-D')).forEach(a => {
    const key = a.slice(2).split('=')[0];
    seenProps.set(key, (seenProps.get(key) || 0) + 1);
  });
  const dupProps = [...seenProps.entries()].filter(([, n]) => n > 1);
  if (dupProps.length) {
    problems.push('doppelte System-Properties: ' + dupProps.map(([k, n]) => `${k} (${n}x)`).join(', '));
  }

  section('Game-Argumente');
  const gameArgs = buildGameArgs(
    versionJson, ACCOUNT, 'C:\\games\\talberg', { width: 1280, height: 720 }, versionJson.assetIndex?.id
  );
  gameArgs.forEach(a => console.log('  ', a));

  if (gameArgs.includes('--demo')) problems.push('--demo ist aktiv, obwohl is_demo_user=false');
  if (gameArgs.some(a => a.includes('${'))) {
    problems.push('unersetzter Platzhalter: ' + gameArgs.filter(a => a.includes('${')).join(' '));
  }
  if (gameArgs.includes('demo-token') === false && !gameArgs.includes(ACCOUNT.accessToken)) {
    problems.push('accessToken fehlt in den Game-Args');
  }
  // --width/--height müssen als Zahlen dastehen, nicht als Text
  const w = gameArgs[gameArgs.indexOf('--width') + 1];
  if (!/^\d+$/.test(w)) problems.push(`--width ist "${w}" statt einer Zahl`);

  section('Feature-Filter');
  console.log('features:', launchFeatures({ width: 1280, height: 720 }));
  console.log('  --demo vorhanden?        ', gameArgs.includes('--demo'), '(muss false sein)');
  console.log('  --width/--height da?    ', gameArgs.includes('--width'), '(muss true sein)');
  console.log('  --quickPlay* da?        ', gameArgs.some(a => a.startsWith('--quickPlay')), '(muss false sein)');

  section('Account-Argumente (das, was ein echter Microsoft-Login liefert)');
  // Diese vier Werte entscheiden, ob das Spiel den Account erkennt und eine
  // Welt oeffnen kann. Sind sie leer oder falsch formatiert, landet man zwar
  // auf dem Titelbildschirm, aber jede Session-Logon scheitert mit 401.
  function valueOf(flag) {
    const i = gameArgs.indexOf(flag);
    return i >= 0 ? gameArgs[i + 1] : undefined;
  }
  const rows = [
    ['--username', valueOf('--username'), ACCOUNT.username],
    ['--uuid', valueOf('--uuid'), ACCOUNT.uuid],
    ['--accessToken', valueOf('--accessToken'), ACCOUNT.accessToken],
    ['--userType', valueOf('--userType'), 'msa'],
    ['--xuid', valueOf('--xuid'), ACCOUNT.xuid],
    ['--clientId', valueOf('--clientId'), ACCOUNT.clientId]
  ];
  for (const [flag, ist, soll] of rows) {
    const ok = ist === soll;
    console.log(`  ${ok ? 'OK  ' : 'FEHLT'} ${flag.padEnd(13)} ${ok ? ist : `ist "${ist}", soll "${soll}"`}`);
    if (!ok) problems.push(`${flag} ist "${ist}" statt "${soll}"`);
  }
  // Leere Argumente sind tückisch: beim spawn als Array bleibt der Leerstring
  // zwar erhalten, aber sobald jemand die Argumente zum Loggen in einen String
  // joint, rueckt der naechste Wert um eine Position nach vorn — und das Spiel
  // liest z.B. "--xuid" als Wert von "--clientId".
  const leere = gameArgs.map((a, i) => ({ a, i })).filter(x => x.a === '' && x.i > 0);
  console.log(`  ${leere.length === 0 ? 'OK  ' : 'FEHLT'} keine leeren Argumente (gefunden: ${leere.length})`);
  if (leere.length) {
    problems.push(`${leere.length} leere Argumente in der Befehlszeile — Positionsverschiebung beim String-Join`);
    leere.forEach(x => console.log(`         leer an Position ${x.i}, davor: "${gameArgs[x.i - 1]}"`));
  }
  if (!/^\d+$/.test(valueOf('--xuid') || '')) {
    problems.push('XUID ist keine reine Ziffernfolge — Minecraft akzeptiert nur Ziffern');
  } else {
    console.log('  OK   XUID ist eine reine Ziffernfolge (nicht die UUID)');
  }

  // ---------- Quick Play ----------
  // "Aus der Weltenliste direkt in die Welt starten" ist das, worum es hier
  // geht. Geprueft wird gegen die ECHTE version.json dieser Version, nicht
  // gegen eine nachgebaute — sonst wuerde der Test genau das besteigen, was
  // wir selbst geschrieben haben.
  section('Quick Play (Welt direkt starten)');

  // 1) Ohne Aufruf darf kein quickPlay-Argument auftauchen. Das ist wichtig:
  //    ein leerer --quickPlayPath sieht fuer das Spiel wie ein fehlgeschlagener
  //    Quick-Play-Versuch aus und nicht wie "kein Quick Play".
  const ohneQP = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null);
  const qpOhne = ohneQP.filter(a => /^--quickPlay/.test(a));
  if (qpOhne.length === 0) {
    console.log('  OK   ohne Quick-Play-Aufruf erscheint kein --quickPlay-Argument');
  } else {
    problems.push(`ohne Quick Play werden ${qpOhne.length} Argumente mitgeschickt: ${qpOhne.join(' ')}`);
    console.log(`  FEHLT ${qpOhne.join(' ')}`);
  }

  // 2) Mit Aufruf: beide Argumente muessen als PAAR (Flag, Wert) dastehen.
  //    In Main.class sind beide Optionen per withRequiredArg() deklariert,
  //    verlangen also je genau einen Wert -- fehlt er, rutscht das naechste
  //    Argument an seine Stelle.
  const weltenName = 'Meine Welt (3)';
  const mitQP = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { singleplayer: weltenName });
  for (const flag of ['--quickPlayPath', '--quickPlaySingleplayer']) {
    const pos = mitQP.indexOf(flag);
    if (pos < 0) {
      problems.push(`${flag} fehlt ganz in der Argumentliste (Quick Play angefordert)`);
      console.log(`  FEHLT ${flag} fehlt`);
      continue;
    }
    const wert = mitQP[pos + 1];
    if (wert === weltenName) {
      console.log(`  OK   ${flag.padEnd(23)} bekommt "${wert}"`);
    } else {
      // Ein leerer Wert ist der haeufigste Fehler: er sieht aus, als waere
      // alles ok, verschiebt aber beim String-Join alle folgenden Werte.
      problems.push(`${flag} bekommt "${wert}" statt "${weltenName}"${wert === '' ? ' (LEER — das ist der gefährliche Fall)' : ''}`);
      console.log(`  FEHLT ${flag} -> "${wert}"`);
    }
    if (wert === undefined) {
      problems.push(`${flag} steht am Ende ohne Wert`);
    }
  }

  // 3) Der Ordnername muss unveraendert ankommen. Windows erlaubt Umlaute,
  //    Anfuehrungszeichen und & in Ordnernamen; process.js spawnt ohne Shell,
  //    also darf daran nichts verloren gehen. Ein String-Join wuerde genau
  //    hier zerstoeren.
  for (const name of ['Welt mit Umlaut äöüß', 'Welt "mit" Anführungszeichen', 'Welt&mit<Sonderzeichen>']) {
    const a = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { singleplayer: name });
    const p = a.indexOf('--quickPlaySingleplayer');
    if (a[p + 1] === name) {
      console.log(`  OK   Ordnername unveraendert: ${JSON.stringify(name)}`);
    } else {
      problems.push(`Ordnername wurde veraendert: ${JSON.stringify(name)} -> ${JSON.stringify(a[p + 1])}`);
      console.log(`  FEHLT ${JSON.stringify(name)} -> ${JSON.stringify(a[p + 1])}`);
    }
  }

  // 4) Ein leerer Weltname darf NICHT als Argument rausgehen. Sonst startet
  //    das Spiel mit --quickPlaySingleplayer "" und versucht ein Level mit
  //    leerem Namen zu oeffnen.
  const leerName = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { singleplayer: '' });
  if (!leerName.some(a => /^--quickPlay/.test(a))) {
    console.log('  OK   leerer Weltname wird nicht als Argument geschickt');
  } else {
    problems.push('leerer Weltname erzeugt trotzdem ein --quickPlay-Argument');
    console.log('  FEHLT leerer Weltname erzeugt ein Argument');
  }

  // 5) Quick Play darf --demo nicht versehentlich einschalten.
  if (!mitQP.includes('--demo')) {
    console.log('  OK   Quick Play aktiviert kein --demo');
  } else {
    problems.push('Quick Play schaltet --demo mit ein');
    console.log('  FEHLT --demo ist mit angeschaltet');
  }

  // ---------- Quick Play: Server ----------
  // "Aus der Serverliste direkt beitreten" ist die zweite Quick-Play-Variante.
  // Sie ist nicht einfach dieselbe wie die Welt: das Argument ist ein
  // anderes (--quickPlayMultiplayer), es haengt an einem anderen Feature
  // (is_quick_play_multiplayer) und es darf unter keinen Umstaenden das
  // Singleplayer-Argument mitschleppen.
  section('Quick Play (Server direkt beitreten)');

  const adresse = 'play.example.net:25565';
  const mitMP = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { multiplayer: adresse });

  // 1) Das Argument muss vorhanden sein UND den Wert direkt dahinter haben.
  //    Ohne den Wert rueckt beim Spawnen jedes naechste Argument eine Stelle
  //    vor, und das Spiel behauptet "unbekannte Option".
  const posMP = mitMP.indexOf('--quickPlayMultiplayer');
  if (posMP < 0) {
    problems.push('--quickPlayMultiplayer fehlt ganz in der Argumentliste (Server-Start angefordert)');
    console.log('  FEHLT --quickPlayMultiplayer fehlt');
  } else if (mitMP[posMP + 1] === adresse) {
    console.log(`  OK   --quickPlayMultiplayer    bekommt "${adresse}"`);
  } else {
    problems.push(`--quickPlayMultiplayer bekommt "${mitMP[posMP + 1]}" statt "${adresse}"${mitMP[posMP + 1] === '' ? ' (LEER)' : ''}`);
    console.log(`  FEHLT --quickPlayMultiplayer -> "${mitMP[posMP + 1]}"`);
  }

  // 2) Der entscheidende Punkt: fuer einen Serverstart darf KEIN
  //    Singleplayer-Argument mitgehen. --quickPlayPath mit leerem Wert
  //    wertet das Spiel als fehlgeschlagenen Quick-Play-Versuch, und der
  //    Serverstart laeuft nie.
  const singleplayerLeak = mitMP.filter(a => /^--quickPlay(Path|Singleplayer|Realms)$/.test(a));
  if (singleplayerLeak.length === 0) {
    console.log('  OK   kein Singleplayer-Argument beim Serverstart');
  } else {
    problems.push(`beim Serverstart mitgeschickt: ${singleplayerLeak.join(' ')}`);
    console.log(`  FEHLT ${singleplayerLeak.join(' ')}`);
  }

  // 3) Umgekehrt: ein Weltstart darf kein Serverargument erzeugen.
  const mpLeak = mitQP.filter(a => a === '--quickPlayMultiplayer');
  if (mpLeak.length === 0) {
    console.log('  OK   kein Server-Argument beim Weltstart');
  } else {
    problems.push('Weltstart schickt --quickPlayMultiplayer mit');
    console.log('  FEHLT Weltstart schickt --quickPlayMultiplayer mit');
  }

  // 4) Adressen, die in der Praxis vorkommen, muessen unveraendert
  //    durchgehen — inkl. IPv6 in Klammern und Tor/Proxy-Schreibweisen.
  for (const adr of [
    'example.net',
    'example.net:25566',
    '127.0.0.1:25565',
    '[2001:db8::1]:25577',
    'mc.example.net:25565'
  ]) {
    const a = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { multiplayer: adr });
    const p = a.indexOf('--quickPlayMultiplayer');
    if (a[p + 1] === adr) {
      console.log(`  OK   Adresse unveraendert: ${adr}`);
    } else {
      problems.push(`Adresse veraendert: ${adr} -> ${a[p + 1]}`);
      console.log(`  FEHLT ${adr} -> ${a[p + 1]}`);
    }
  }

  // 5) Leere Adresse darf NICHT als Argument rausgehen.
  const mpLeer = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null, { multiplayer: '' });
  if (!mpLeer.some(a => /^--quickPlay/.test(a))) {
    console.log('  OK   leere Adresse wird nicht als Argument geschickt');
  } else {
    problems.push('leere Serveradresse erzeugt trotzdem ein --quickPlay-Argument');
    console.log('  FEHLT leere Serveradresse erzeugt ein Argument');
  }

  // 6) Sind beide Ziele angegeben, darf nur EINS durchgehen. Sonst stehen
  //    zwei sich widersprechende Argumentpaare in der Liste.
  const beideZiele = buildGameArgs(versionJson, ACCOUNT, TEST_DIR, { width: 1280, height: 720 }, null,
    { singleplayer: weltenName, multiplayer: adresse });
  const beideFlags = beideZiele.filter(a => /^--quickPlay/.test(a));
  const paare = new Set(beideFlags.map(a => a.replace(/^--/, '').toLowerCase()));
  if (!paare.has('quickplaymultiplayer') || !paare.has('quickplaysingleplayer') || beideFlags.length <= 2) {
    console.log('  OK   bei doppeltem Ziel nur eine Variante aktiv');
  } else {
    problems.push(`bei doppeltem Ziel kommen beide vor: ${beideFlags.join(' ')}`);
    console.log(`  FEHLT beide Ziele gleichzeitig: ${beideFlags.join(' ')}`);
  }

  // 7) RAM und Aufloesung aus den Startoptionen der Instanz. Geprueft wird
  //    die vollstaendige Kette von der Einstellungsdatei bis zum Argument:
  //
  //      instance-settings.json -> loadSettings -> toLaunchInputs
  //                             -> resolveLaunchOptions -> Befehlszeile
  //
  //    Gerade die letzte Haelfte ist interessant. `resolveLaunchOptions` hat
  //    `memory` und `resolution` lange als Parameter entgegengenommen und
  //    trotzdem nie benutzt — wer nur die Argumente zaehlt, haelt es fuer
  //    verdrahtet. Der Test laeuft ohne Download, weil er die bereits
  //    gecachte version.json und eine erfundene downloadResult-Huelle nutzt.
  section('Startoptionen: RAM und Auflösung');
  const instSettings = require('./src/main/instance-settings');
  const instOrdner = path.join(TEST_DIR, 'instanz-test');
  fs.mkdirSync(instOrdner, { recursive: true });
  fs.writeFileSync(
    path.join(instOrdner, 'instance-settings.json'),
    JSON.stringify({ ramMinGb: 1.5, ramMaxGb: 6, width: 2560, height: 1440 })
  );
  const geladen = instSettings.loadSettings(instOrdner);
  console.log('aus der Datei:    ', JSON.stringify(geladen));
  const eingaben = instSettings.toLaunchInputs(geladen);
  console.log('Launch-Eingaben:  ', JSON.stringify(eingaben));

  const fakeResult = {
    versionJson,
    classpath: buildClasspath(versionJson, MC_VERSION),
    mainClass: versionJson.mainClass,
    nativesDir: path.join(TEST_DIR, 'natives'),
    loggingConfig: path.join(TEST_DIR, 'log4j.xml')
  };
  const opts = resolveLaunchOptions(fakeResult, ACCOUNT, 'C:\\Java\\bin\\javaw.exe',
    TEST_DIR, eingaben.resolution, eingaben.memory, null);
  console.log('ramMin / ramMax:  ', opts.ramMin, '/', opts.ramMax);
  console.log('gameArgs:         ', opts.gameArgs.filter(a => /^-{1,2}(w|h|width|height)/.test(a)).join(' '));

  if (opts.ramMin === '1.5G' && opts.ramMax === '6G') {
    console.log('  OK   halbe GB kommen als -Xms1.5G / -Xmx6G an');
  } else {
    problems.push(`RAM falsch angekommen: ramMin=${opts.ramMin} ramMax=${opts.ramMax}`);
    console.log(`  FEHLT RAM falsch: ${opts.ramMin} / ${opts.ramMax}`);
  }

  // Das Spiel bekommt die Aufloesung ueber --width/--height. positioniert
  // werden sie an den specificArguments-Eintraegen der echten version.json,
  // deshalb zaehlt hier nur, dass die Werte irgendwo als Paar stehen.
  const breiteIdx = opts.gameArgs.indexOf('--width');
  const hoeheIdx = opts.gameArgs.indexOf('--height');
  if (breiteIdx >= 0 && hoeheIdx === breiteIdx + 2 &&
      opts.gameArgs[breiteIdx + 1] === '2560' && opts.gameArgs[hoeheIdx + 1] === '1440') {
    console.log('  OK   --width 2560 --height 1440 stehen als Paar in der Argumentliste');
  } else {
    problems.push(`Aufloesung falsch angekommen: ${opts.gameArgs.slice(breiteIdx, hoeheIdx + 2).join(' ')}`);
    console.log(`  FEHLT Aufloesung falsch: ${opts.gameArgs.slice(breiteIdx, hoeheIdx + 2).join(' ')}`);
  }

  // has_custom_resolution muss true sein, sonst streicht filterArguments
  // das Paar wieder weg — die Werte waeren dann zwar gesetzt, aber nicht
  // angekommen. Genau diese Kopplung ist beim Aendern leicht zu verlieren.
  const mitRes = launchFeatures(eingaben.resolution, false, null);
  const ohneRes = launchFeatures(null, false, null);
  if (mitRes.has_custom_resolution === true && ohneRes.has_custom_resolution === false) {
    console.log('  OK   has_custom_resolution folgt der Auflösung');
  } else {
    problems.push('has_custom_resolution reagiert nicht auf die uebergebene Aufloesung');
    console.log('  FEHLT has_custom_resolution falsch');
  }

  // Ohne Einstellungsdatei kommen die Standardwerte, und die muessen selbst
  // startbar sein. Ein Standard, den validateSettings zurueckweisen wuerde,
  // waere ein Startabbruch, den die Oberflaeche verursacht.
  fs.rmSync(path.join(instOrdner, 'instance-settings.json'), { force: true });
  const standard = instSettings.loadSettings(instOrdner);
  let standardOk = true;
  try {
    instSettings.validateSettings({ ...standard });
  } catch (err) {
    standardOk = false;
    problems.push('der Standardwert besteht die eigene Pruefung nicht: ' + err.message);
  }
  const standardEingaben = instSettings.toLaunchInputs(standard);
  if (standardOk) {
    console.log('  OK   ohne Datei: ' + standardEingaben.memory.min + ' / ' +
      standardEingaben.memory.max + ', ' + standardEingaben.resolution.width +
      '×' + standardEingaben.resolution.height);
  }

  // Und die was waechst, wenn der Benutzer die Empfehlung uebernimmt.
  const empfehlung = instSettings.describe();
  const empfEingaben = instSettings.toLaunchInputs(empfehlung.settings);
  console.log('Empfehlung fuer ' + empfehlung.physicalRamGb + ' GB Rechner: ' +
    empfEingaben.memory.min + ' / ' + empfEingaben.memory.max);
  if (parseFloat(empfEingaben.memory.max) > parseFloat(standardEingaben.memory.max)) {
    console.log('  OK   die Empfehlung liegt ueber dem festen Standard');
  } else {
    console.log('  OK   die Empfehlung ist nicht groesser als der Standard — unkritisch');
  }

  fs.rmSync(instOrdner, { recursive: true, force: true });

  section('Ergebnis');
  if (problems.length) {
    console.log('❌ Probleme gefunden:');
    problems.forEach(p => console.log('   -', p));
    process.exitCode = 1;
  } else {
    console.log('✅ Argument-Kette ist in Ordnung — ein Start würde jetzt funktionieren.');
  }
  console.log('\nTestordner:', TEST_DIR);
}

main().catch(err => {
  console.error('\n❌ Test fehlgeschlagen:', err.message);
  process.exitCode = 1;
});
