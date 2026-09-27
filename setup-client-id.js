// setup-client-id.js
// Traegt die Azure-Client-ID in die config.json ein, damit der
// Microsoft-Login funktioniert.
//
// Warum ein Skript statt "Datei von Hand aufmachen": die haeufigste
// Fehlerquelle bei der Ersteinrichtung ist eine kaputte JSON-Datei (fehlendes
// Komma, falsche Anfuehrungszeichen). Dieses Skript kann das nicht, und es
// prueft das Format der GUID gleich mit.
//
// Verwendung (mit der GUID aus dem Azure-Portal als Argument):
//   node setup-client-id.js 12345678-1234-1234-1234-123456789012
//
// Ohne Argument fragt es interaktiv ab. Zum Pruefen:
//   node setup-client-id.js --show

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { DEFAULT_REDIRECT_URI } = require('./src/main/auth');
const { userDataDir, appDirName } = require('./src/main/app-paths');

// userData liegt NICHT im Projektordner: die config.json muss beim Update und
// beim Neuinstallieren erhalten bleiben, sonst verliert man die eingetragene
// Client-ID.
//
// Der Ordnername kommt aus app-paths.js und damit aus package.json. Er war hier
// vorher fest als "liquid-launcher" eingetragen — und das war falsch: Electron
// nimmt "productName", also "Liquid Launcher". Diese Datei hat dadurch in
// einen Ordner geschrieben, den der Launcher nie liest.
const CONFIG_PATH = path.join(userDataDir(), 'config.json');

// Azure-Client-IDs sind immer eine UUID. Diese Pruefung faengt die haeufigsten
// Kopierfehler ab: Leerzeichen am Ende, "Application (client) ID" statt der
// GUID selbst, oder die Directory-(Tenant-)ID, die aehnlich aussieht.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    console.error(`\nconfig.json existiert, ist aber kein gueltiges JSON: ${err.message}`);
    console.error('Es wird eine neue Datei geschrieben. Aufraeumen: ' + CONFIG_PATH);
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  // Erst daneben schreiben, dann umbenennen: bricht der Stromausfall mitten
  // im Schreiben, bleibt die alte config.json intakt.
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_PATH);
}

async function main() {
  const arg = process.argv[2];

  // ---- --show: nur anzeigen, nichts aendern ----
  if (arg === '--show' || arg === '-s') {
    const config = readConfig();
    const id = config.microsoftClientId || '(nicht gesetzt)';
    console.log(`\nconfig.json: ${CONFIG_PATH}`);
    console.log(`microsoftClientId: ${id}`);
    console.log(`microsoftRedirectUri: ${config.microsoftRedirectUri || '(Standard) ' + DEFAULT_REDIRECT_URI}`);
    console.log(id !== '(nicht gesetzt)'
      ? '\nDie Client-ID ist gesetzt. Starte den Launcher mit "npm start".'
      : '\nNoch keine Client-ID. Eintragen mit:  node setup-client-id.js <GUID>');
    return;
  }

  // ---- ID aus dem Argument, sonst interaktiv ----
  let clientId = (arg || '').trim();

  if (!clientId) {
    console.log('\nMicrosoft-Login einrichten');
    console.log('='.repeat(50));
    console.log('\nDu brauchst die "Application (client) ID" aus dem Azure-Portal:\n');
    console.log('  portal.azure.com -> Microsoft Entra ID -> App registrations -> New registration');
    console.log('  1. Name: z.B. "Liquid Launcher"');
    console.log('  2. Supported account types: "Accounts in any organizational directory and personal accounts"');
    console.log('     (WICHTIG: sonst werden Konten ohne Minecraft gefunden)');
    console.log(`  3. Redirect URI, Plattform "Mobile and desktop applications":`);
    console.log(`     ${DEFAULT_REDIRECT_URI}`);
    console.log('  4. Create -> "Application (client) ID" kopieren\n');
    console.log('Es wird KEIN Client-Secret benoetigt — bitte auch keines anlegen.\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    clientId = (await rl.question('Application (client) ID: ')).trim();
    rl.close();
  }

  if (!clientId) {
    console.error('\nKeine Client-ID eingegeben — nichts geaendert.');
    process.exitCode = 1;
    return;
  }

  if (!GUID_RE.test(clientId)) {
    console.error(`\n"${clientId}" ist keine GUID in der Form 12345678-1234-1234-1234-123456789012.`);
    console.error('Meist wurde die Beschriftung mitkopiert oder ein falscher Wert aus Azure.');
    console.error('');
    console.error('Was dieses Skript pruefen kann: das Format. Was es nicht pruefen kann:');
    console.error('ob es die RICHTIGE GUID ist. Eine Directory (Tenant) ID ist ebenfalls eine');
    console.error(' Gueltige GUID und faellt hier nicht auf. In Azure stehen zwei:');
    console.error('  - "Directory (tenant) ID"      -> falsch, ergibt einen leeren Login');
    console.error('  - "Application (client) ID"   -> richtig');
    process.exitCode = 1;
    return;
  }

  const config = readConfig();
  const vorher = config.microsoftClientId;
  config.microsoftClientId = clientId.toLowerCase();
  writeConfig(config);

  console.log(`\nGespeichert: ${CONFIG_PATH}`);
  console.log(`  microsoftClientId: ${config.microsoftClientId}`);
  if (vorher && vorher.toLowerCase() !== config.microsoftClientId) {
    console.log(`  (vorher: ${vorher})`);
    console.log('  Achtung: mit einer anderen Client-ID sind alte Anmeldungen ungueltig —');
    console.log('  die Konten muessen neu angemeldet werden.');
  }
  console.log('\nFertig. Jetzt "npm start" und im Launcher auf "Account hinzufuegen" klicken.');
}

main().catch(err => {
  console.error(`\nFehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
});
