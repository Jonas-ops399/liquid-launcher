// test-account-store.js
// Testet die Token-Persistenz isoliert, ohne Electron-Fenster und ohne
// Microsoft-Login. Das ist hier besonders wichtig, weil der Code Sicherheits-
// und Datenverluste verhindern soll — da loehnt sich Testen ohne Zutritt zu
// einem echten Account.
//
//   node test-account-store.js
//
// 'safeStorage' wird als Fake injiziert: er verschluesselt wie DPAPI (XOR mit
// einem Schluessel), merkt sich aber, wie oft er wirklich benutzt wurde. So
// laesst sich pruefen, dass NIEMALS ein Klartext-Token auf der Platte landet.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('./src/main/account-store');

const problems = [];
function check(condition, message) {
  console.log(`  ${condition ? 'OK  ' : 'FEHLT'} ${message}`);
  if (!condition) problems.push(message);
}

// ---------- Fake safeStorage ----------
function makeFakeSafeStorage(available = true) {
  const KEY = 'falsch-geheimer-testschluessel';
  return {
    encryptCalls: 0,
    decryptCalls: 0,
    isEncryptionAvailable: () => available,
    encryptString(text) {
      this.encryptCalls++;
      const buf = Buffer.from(text, 'utf-8');
      const mask = Buffer.from(KEY.padEnd(buf.length, '\0').slice(0, buf.length));
      // "Verschlüsselung" + etwas, das nach Zufall aussieht
      const out = Buffer.concat([Buffer.from('SENTINEL-HEADER:'), mask.map((b, i) => buf[i] ^ b)]);
      return out;
    },
    decryptString(buffer) {
      this.decryptCalls++;
      if (!buffer.toString('utf-8').startsWith('SENTINEL-HEADER:')) {
        throw new Error('kein gueltiger Blob (Falscher Schluessel?)');
      }
      const body = buffer.subarray(Buffer.from('SENTINEL-HEADER:').length);
      const mask = Buffer.from(KEY.padEnd(body.length, '\0').slice(0, body.length));
      return Buffer.from([...body].map((b, i) => b ^ mask[i])).toString('utf-8');
    }
  };
}

const USER_DATA = path.join(os.tmpdir(), 'liquid-account-store-test');
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });

const ACCOUNT = {
  id: '11111111-2222-3333-4444-555555555555',
  username: 'JonasJL',
  uuid: '11111111-2222-3333-4444-555555555555',
  avatarUrl: 'https://crafatar.com/avatars/11111111222233334444555555555555?size=64&overlay',
  skinUrl: 'https://textures.minecraft.net/texture/abc',
  xuid: '253546359469698271',
  isDemo: false,
  expiresAt: Date.now() + 3600_000,
  accessToken: 'SEHR-GEHEIMES-ACCESS-TOKEN',
  refreshToken: 'SEHR-GEHEIMER-REFRESH-TOKEN'
};

console.log('=== 1. Speichern und Laden (verschluesselt) ===');
const safe = makeFakeSafeStorage();
let store = new AccountStore(USER_DATA, safe);
store.load();
store.upsert(ACCOUNT);

check(safe.encryptCalls > 0, `safeStorage.encryptString wurde benutzt (${safe.encryptCalls}x)`);

const fileText = fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf-8');
check(!fileText.includes('SEHR-GEHEIMES-ACCESS-TOKEN'), 'accessToken steht NICHT im Klartext in der Datei');
check(!fileText.includes('SEHR-GEHEIMER-REFRESH-TOKEN'), 'refreshToken steht NICHT im Klartext in der Datei');
check(fileText.includes('JonasJL'), 'Username steht lesbar in der Datei (darf/soll)');

console.log('\n=== 2. Round-Trip: neue Instanz liest die Tokens wieder ===');
const store2 = new AccountStore(USER_DATA, safe);
store2.load();
const loaded = store2.get(ACCOUNT.id);
check(loaded !== null, 'Account wurde wiedergefunden');
check(loaded?.accessToken === ACCOUNT.accessToken, 'accessToken stimmt nach Entschlüsselung');
check(loaded?.refreshToken === ACCOUNT.refreshToken, 'refreshToken stimmt nach Entschlüsselung');
check(loaded?.xuid === ACCOUNT.xuid, 'xuid bleibt erhalten (wird als --xuid gebraucht)');
check(loaded?.expiresAt === ACCOUNT.expiresAt, 'Ablaufzeit bleibt erhalten');

console.log('\n=== 3. Nach aussen wird NICHTS von Token gezeigt ===');
const listed = store2.list();
check(listed.length === 1, 'list() liefert genau einen Account');
check(!('accessToken' in listed[0]), 'list()-Objekt hat KEIN accessToken-Feld');
check(!('refreshToken' in listed[0]), 'list()-Objekt hat KEIN refreshToken-Feld');
check(listed[0].needsRelogin === false, 'needsRelogin ist false (Token war lesbar)');

console.log('\n=== 4. Mehrere Accounts, aktiver Account, Loeschen ===');
const ACCOUNT2 = { ...ACCOUNT, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'ZweiterAcc' };
store2.upsert(ACCOUNT2);
check(store2.count === 2, 'zwei Accounts gespeichert');
check(store2.getActive()?.id === ACCOUNT.id, 'beim ersten Login wird automatisch der erste Account aktiv');

store2.setActive(ACCOUNT2.id);
check(store2.getActive()?.id === ACCOUNT2.id, 'aktiver Account laesst sich umschalten');
const store3 = new AccountStore(USER_DATA, safe);
store3.load();
check(store3.getActive()?.id === ACCOUNT2.id, 'aktiver Account ueberlebt einen Neustart');

store3.remove(ACCOUNT2.id);
check(store3.count === 1, 'Account wurde geloescht');
check(store3.getActive()?.id === ACCOUNT.id, 'nach dem Loeschen des aktiven Accounts wird ein anderer aktiv');
check(!fs.readFileSync(path.join(USER_DATA, 'accounts.json'), 'utf-8').includes('ZweiterAcc'),
  'geloeschter Account ist wirklich aus der Datei verschwunden');

console.log('\n=== 5. Aktualisieren statt Duplizieren ===');
store3.upsert({ ...ACCOUNT, username: 'NeuerName' });
check(store3.count === 1, 'gleiche UUID erzeugt keinen zweiten Account');
check(store3.get(ACCOUNT.id)?.username === 'NeuerName', 'Username wurde aktualisiert');
check(store3.get(ACCOUNT.id)?.accessToken === ACCOUNT.accessToken, 'Token beim Update nicht verloren');

console.log('\n=== 6. Falscher Schluessel / fremde Datei ===');
const fremd = makeFakeSafeStorage();
fremd.isEncryptionAvailable = () => true;
fremd.decryptString = () => { throw new Error('kein gueltiger Blob (Falscher Schluessel?)'); };
const store4 = new AccountStore(USER_DATA, fremd);
store4.load();
const unlesbar = store4.get(ACCOUNT.id);
check(unlesbar !== null, 'Account ist noch gelistet (Metadaten stehen ja im Klartext)');
check(unlesbar?.needsRelogin === true, 'needsRelogin ist true, weil das Token nicht lesbar war');
check(unlesbar?.accessToken === null, 'kein Token reingeschmuggelt, das nicht entschluesselt werden konnte');

console.log('\n=== 7. Kein Klartext-Fallback, wenn keine Verschluesselung da ist ===');
const USER_DATA2 = path.join(os.tmpdir(), 'liquid-account-store-test-nokeys');
fs.rmSync(USER_DATA2, { recursive: true, force: true });
fs.mkdirSync(USER_DATA2, { recursive: true });
const keinSafe = makeFakeSafeStorage(false);
const store5 = new AccountStore(USER_DATA2, keinSafe);
store5.load();
store5.upsert(ACCOUNT);
const text2 = fs.readFileSync(path.join(USER_DATA2, 'accounts.json'), 'utf-8');
check(!text2.includes('SEHR-GEHEIMES-ACCESS-TOKEN'),
  'OHNE Verschluesselung wird das Token gar nicht erst gespeichert (kein Klartext-Fallback!)');
check(text2.includes('JonasJL'), 'die oeffentlichen Metadaten werden trotzdem gespeichert');

console.log('\n=== 8. Kaputte Datei killt den Launcher nicht ===');
const USER_DATA3 = path.join(os.tmpdir(), 'liquid-account-store-test-kaputt');
fs.rmSync(USER_DATA3, { recursive: true, force: true });
fs.mkdirSync(USER_DATA3, { recursive: true });
fs.writeFileSync(path.join(USER_DATA3, 'accounts.json'), '{ das ist kein gueltiges JSON');
const store6 = new AccountStore(USER_DATA3, safe);
let geladen = null;
let geworfen = false;
try { geladen = store6.load(); } catch { geworfen = true; }
check(!geworfen, 'load() wirft bei kaputter Datei NICHT');
check(Array.isArray(geladen) && geladen.length === 0, 'stattdessen: leere, benutzbare Account-Liste');
const backups = fs.readdirSync(USER_DATA3).filter(f => f.includes('.kaputt-'));
check(backups.length === 1, 'die kaputte Datei wurde zur Pruefung beibehalten statt still ueberschrieben');

console.log('\n' + '='.repeat(66));
if (problems.length) {
  console.log('❌ Probleme:');
  problems.forEach(p => console.log('   - ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ Account-Persistenz korrekt: Tokens verschluesselt, nichts im Klartext,');
  console.log('   nichts geht nach aussen, kaputte Datei faellt nicht um.');
}
