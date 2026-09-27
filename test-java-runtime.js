// test-java-runtime.js
// Isolierter Test für java-runtime.js — läuft mit reinem "node", braucht
// KEIN Electron. Einfach im Projektordner ausführen:
//
//   node test-java-runtime.js
//
// Testet nacheinander: Erkennung, und (nur falls nötig) den Download einer
// passenden JRE. Nichts davon startet Minecraft — das kommt erst in einer
// späteren Phase.

const path = require('node:path');
const os = require('node:os');
const { detectJava, downloadJava, requiredJavaMajor } = require('./src/main/java-runtime');

async function main(){
  const mcVersion = '1.21.4';
  const needed = requiredJavaMajor(mcVersion);
  console.log(`Minecraft ${mcVersion} braucht Java ${needed}.`);

  console.log('\n--- Suche installiertes Java ---');
  const result = await detectJava(needed);
  console.log(result);

  if (result.found && result.isCompatible) {
    console.log(`\n✅ Passendes Java gefunden: ${result.path} (Java ${result.version})`);
    return;
  }

  if (result.found && !result.isCompatible) {
    console.log(`\n⚠️  Java gefunden (${result.path}, Version ${result.version}), aber zu alt für Java ${needed}.`);
  } else {
    console.log('\n⚠️  Kein Java gefunden.');
  }

  console.log(`\n--- Lade Java ${needed} herunter (Adoptium) ---`);
  // Testordner im temporären Verzeichnis statt im echten App-Datenordner,
  // damit dieser Test nichts an der "echten" App-Installation verändert.
  const testDir = path.join(os.tmpdir(), 'liquid-launcher-java-test');
  try {
    const downloaded = await downloadJava(needed, testDir);
    console.log(`\n✅ Java heruntergeladen und entpackt: ${downloaded.path}`);
  } catch (err) {
    console.error('\n❌ Download fehlgeschlagen:', err.message);
    process.exitCode = 1;
  }
}

main();
