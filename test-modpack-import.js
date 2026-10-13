// test-modpack-import.js
// Prueft src/main/modpackImport.js (rein Node, kein electron) UND die
// IPC-Kanaele modpackQuellen.* gegen einen gestubten Electron-Hauptprozess
// (Muster wie test-ipc-wiring.js).
//
//   node test-modpack-import.js
//
// Was hier ehrlich geprueft wird:
//   - Formaterkennung: mrpack / curseforge / null (auch kaputte Dateien)
//   - Modloader-Normalisierung (fabric/forge/quilt/neoforge)
//   - Zip-Slip-Schutz: JEDER unsichere Pfad lehnt die GANZE Datei ab,
//     nichts wird geschrieben — auch nicht innerhalb des Zielordners
//   - Installation mit injizierter Download-Funktion (kein Netz noetig):
//     Overrides, client-overrides-Vorrang, mods/-Unterordner bei
//     CurseForge, uebersprungen/fehler-Zaehler, required=false
//   - modpackAusDatei: version (Pack) und minecraft (Spiel) getrennt
//   - IPC: Kanaele registriert, CurseForge-Suche ohne API-Schluessel
//     antwortet mit der exakten vorgeschriebenen Meldung, Suche und
//     Import funktionieren mit gestubbtem Netz, importierte Instanz
//     landet als echter Ordner auf der Platte.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const modpack = require('./src/main/modpackImport');

// ---------- Testregistratur (wie in den anderen tests/) ----------
let checks = 0;
const fehl = [];
function check(name, bedingung, detail) {
  checks++;
  if (!bedingung) {
    fehl.push(name + (detail !== undefined ? ' :: ' + detail : ''));
    console.log(`  FEHLT ${name}${detail !== undefined ? ' :: ' + detail : ''}`);
  }
}
function zaehle(name, bedingung, detail) {
  checks++;
  if (!bedingung) {
    fehl.push(name + (detail !== undefined ? ' :: ' + detail : ''));
    console.log(`  FEHLT ${name}`);
  }
  return bedingung;
}

// ---------- Arbeitsordner ----------
const TESTDIR = path.join(os.tmpdir(), 'liquid-launcher-modpack-test-' + Date.now());
const FIX = path.join(TESTDIR, 'fix');
fs.mkdirSync(FIX, { recursive: true });

// ---------- Roh-Zip-Bauer fuer Slippery Dateien ----------
// adm-zip saeubert Eintragsnamen beim SCHREIBEN selbst (gemessen); ein
// boeswilliges Zip von aussen enthaelt aber ROH geschriebene Namen wie
// "../boese.txt" oder "C:/absolut.txt". Deshalb baut der Test solche Zips
// hier von Hand (Methode stored, kein Data-Descriptor) — exakt so, wie sie
// ein Angreifer bauen wuerde.
function crc32(buf) { return zlib.crc32(buf); }

function rohZipBauen(paare) {
  const stuecke = [];
  const zentral = [];
  let offset = 0;
  for (const [name, inhalt] of paare) {
    const nb = Buffer.from(name, 'utf8');
    const cb = Buffer.from(inhalt, 'utf8');
    const crc = crc32(cb) >>> 0;
    const lokal = Buffer.alloc(30);
    lokal.writeUInt32LE(0x04034b50, 0);
    lokal.writeUInt16LE(20, 4);
    lokal.writeUInt16LE(0, 6);
    lokal.writeUInt16LE(0, 8);
    lokal.writeUInt16LE(0, 10);
    lokal.writeUInt16LE(0, 12);
    lokal.writeUInt32LE(crc, 14);
    lokal.writeUInt32LE(cb.length, 18);
    lokal.writeUInt32LE(cb.length, 22);
    lokal.writeUInt16LE(nb.length, 26);
    lokal.writeUInt16LE(0, 28);
    stuecke.push(lokal, nb, cb);

    const zh = Buffer.alloc(46);
    zh.writeUInt32LE(0x02014b50, 0);
    zh.writeUInt16LE(20, 4);
    zh.writeUInt16LE(20, 6);
    zh.writeUInt16LE(0, 8);
    zh.writeUInt16LE(0, 10);
    zh.writeUInt16LE(0, 12);
    zh.writeUInt32LE(crc, 16);
    zh.writeUInt32LE(cb.length, 20);
    zh.writeUInt32LE(cb.length, 24);
    zh.writeUInt16LE(nb.length, 28);
    zh.writeUInt16LE(0, 30);
    zh.writeUInt16LE(0, 32);
    zh.writeUInt16LE(0, 34);
    zh.writeUInt16LE(0, 36);
    zh.writeUInt32LE(0, 38);
    zh.writeUInt32LE(offset, 42);
    zentral.push(zh, nb);
    offset += 30 + nb.length + cb.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(zentral);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(paare.length, 8);
  eocd.writeUInt16LE(paare.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...stuecke, cd, eocd]);
}

let nummer = 0;
function schreiben(name, inhalt) {
  const pfad = path.join(FIX, 'f' + (++nummer) + '-' + name);
  fs.writeFileSync(pfad, inhalt);
  return pfad;
}

// ---------- Fixtures ----------

// Echte Jar-Inhalte mit bekannter SHA1 fuer den Download-Test.
const JAR_INHALT = Buffer.from('JAR-INHALT-BEISPIEL-MOD-0123456789');
const JAR_SHA1 = crypto.createHash('sha1').update(JAR_INHALT).digest('hex');
const ZIP_INHALT = Buffer.from('RESOURCE-PACK-ARCHIV');
const JAR_OHNE_URL = Buffer.from('NOCH-EIN-JAR');

// 1) Gueltiges Modrinth-Pack (modrinth.index.json + overrides +
//    client-overrides). Die Downloads sind Angabe des Packs — im Zip liegen
//    nur die Overrides.
function baueMrpack(ueberlagerung) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.2.3',
    name: 'Test-Paket Alpha',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    files: [
      { path: 'mods/beispielmod.jar', hashes: { sha1: JAR_SHA1 }, downloads: ['https://cdn.test/beispielmod.jar'], env: { client: 'required', server: 'unsupported' } },
      { path: 'resourcepacks/extra.zip', downloads: ['https://cdn.test/extra.zip'] },
      { path: '' },
      { path: 'mods/ohne-url.jar' }
    ]
  })));
  zip.addFile('overrides/config/settings.toml', Buffer.from('s=\"a\"\n'));
  zip.addFile('overrides/resourcepacks/pack.zip', Buffer.from('PACK-X'));
  zip.addFile('overrides/config/extra.json', Buffer.from('{"quelle":"overrides"}'));
  zip.addFile('client-overrides/config/extra.json', Buffer.from('{"quelle":"client-overrides"}'));
  if (ueberlagerung) ueberlagerung(zip);
  return schreiben('modrinth.mrpack', zip.toBuffer());
}

// 2) Gueltiges CurseForge-Zip (manifest.json + overrides).
function baueCurse(ueberlagerung) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [
      { id: 'forge-44.1.0', primary: true },
      { id: 'fabric-0.15.0', primary: false }
    ] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'Curse-Paket Beta',
    version: '1.0.0',
    files: [
      { projectID: 1, fileID: 10, required: true, downloadUrl: 'https://cdn.test/curse-a.jar' },
      { projectID: 2, fileID: 20, required: true },
      { projectID: 3, fileID: 30, required: false },
      { projectID: 4, fileID: 40, required: true }
    ]
  })));
  zip.addFile('overrides/config/curse.cfg', Buffer.from('settings=1\n'));
  if (ueberlagerung) ueberlagerung(zip);
  return schreiben('curseforge.zip', zip.toBuffer());
}

const MRPACK = baueMrpack();
const CURSE = baueCurse();

// 3) Slippery Modrinth-Zip: rohe Eintragsnamen, wie ein Angreifer sie baut.
const MRPACK_SLIP = schreiben('slip.mrpack', rohZipBauen([
  ['modrinth.index.json', JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: 'x', name: 'Slip',
    dependencies: { minecraft: '1.20.1' },
    files: [
      { path: 'mods/gut.jar', downloads: ['https://cdn.test/gut.jar'] },
      { path: '../../ausbruch.jar', downloads: ['https://cdn.test/ausbruch.jar'] }
    ]
  })],
  ['../boese.txt', 'BOESE_AUSSEN'],
  ['overrides/../../raus.txt', 'RAUS'],
  ['C:/absolut.txt', 'LAUFWERK'],
  ['\\server\\share\\f.txt', 'UNC'],
  ['overrides/pfad//x.txt', 'LEERES_SEGMENT'],
  ['overrides/config/ok.txt', 'EIGENTLICH_GUT']
]));

// 4) Slippery CurseForge-Zip. Der boese Pfad steckt UNTER overrides/, denn
//    nur dorthin wird ueberhaupt geschrieben — ein Eintrag auf Zip-Root-Ebene
//    wird nie extrahiert und kann deshalb auch nichts anrichten.
const CURSE_SLIP = schreiben('curse-slip.zip', rohZipBauen([
  ['manifest.json', JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-44.1.0', primary: true }] },
    name: 'Slip-Curse', version: '1', files: []
  })],
  ['overrides/../../raus2.txt', 'RAUS2'],
  ['overrides/config/gut.txt', 'EIGENTLICH_GUT']
]));

// 5) Slippery per Steuerzeichen im Pfad.
const MRPACK_STEUERZEICHEN = schreiben('steuer.mrpack', rohZipBauen([
  ['modrinth.index.json', JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: 'x', name: 'Steuer',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15' }, files: []
  })],
  ['overrides/gut/\u0001.txt', 'STEUER']
]));

// 6) Kein Modpack: Zip ohne Index, Textdatei als .mrpack, Muell als .zip.
const KEIN_INDEX = schreiben('keinindex.zip', (() => {
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('kein modpack'));
  return zip.toBuffer();
})());
const TEXT_ALS_MRPACK = schreiben('text.mrpack', Buffer.from('das ist kein zip'));
const MUELL_ZIP = schreiben('muell.zip', Buffer.from('3062 3063 3064'));

// 7) CurseForge-Zip ohne overrides-Eintrag -> kein Modpack.
const CURSE_OHNE_OVERRIDES = schreiben('curse-ohne-overrides.zip', (() => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [] },
    name: 'Ohne Overrides', version: '1', files: []
  })));
  return zip.toBuffer();
})());

// 8) CurseForge-Zip, das den overrides-Ordner NUR als Ordner-Eintrag nennt.
const CURSE_ORDNER_NUR = schreiben('curse-ordner.zip', (() => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [] },
    name: 'Nur Ordner', version: '1', files: []
  })));
  zip.addFile('overrides/', Buffer.alloc(0));
  return zip.toBuffer();
})());

// 9) Zip mit beiden Indizes -> mrpack gewinnt.
const BEIDES = schreiben('beides.zip', (() => {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: 'x', name: 'Beides',
    dependencies: { minecraft: '1.20.1' }, files: []
  })));
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [] }, name: 'Beides', version: '1', files: []
  })));
  zip.addFile('overrides/config/x.txt', Buffer.from('x'));
  return zip.toBuffer();
})());

// 10) aussagekraeftige Packversionen: versionId anders als minecraft.
const MRPACK_LEERES_ZIP = schreiben('leer.mrpack', rohZipBauen([]));

// ---------- gemeinsame Helfer ----------
function baum(ordner) {
  const out = [];
  const stapel = [ordner];
  while (stapel.length) {
    const d = stapel.pop();
    let eintraege = [];
    try { eintraege = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of eintraege) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stapel.push(p);
      else out.push(p);
    }
  }
  return out;
}

function allePfadeUnter(ordner) {
  return baum(ordner).map((p) => p.slice(ordner.length + 1).replace(/\\/g, '/'));
}

// ladeDatei-Attrappe: schreibt Dummy-Inhalt, protokolliert jeden Aufruf.
function attrapenLader(protokoll) {
  return async (url, sha1Soll, zielPfad) => {
    const inhalt = Buffer.from('dummy-' + path.basename(zielPfad));
    protokoll.push({ url, sha1Soll, zielPfad, bytes: inhalt });
    fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
    fs.writeFileSync(zielPfad, inhalt);
  };
}

(async () => {
  console.log('=== Formaterkennung ===');
  check('mrpack erkannt', modpack.erkenneFormat(MRPACK) === 'mrpack');
  check('curseforge erkannt', modpack.erkenneFormat(CURSE) === 'curseforge');
  check('zip ohne index -> null', modpack.erkenneFormat(KEIN_INDEX) === null);
  check('textdatei als .mrpack -> null', modpack.erkenneFormat(TEXT_ALS_MRPACK) === null);
  check('muell als .zip -> null', modpack.erkenneFormat(MUELL_ZIP) === null);
  check('nicht vorhandene datei -> null', modpack.erkenneFormat(path.join(FIX, 'gibtsnicht.zip')) === null);
  check('curseforge ohne overrides-Ordner, aber mit Packinhalt -> curseforge', modpack.erkenneFormat(CURSE_OHNE_OVERRIDES) === 'curseforge');
  check('beide indizes -> mrpack gewinnt', modpack.erkenneFormat(BEIDES) === 'mrpack');
  check('overrides nur als ordnereintrag -> curseforge', modpack.erkenneFormat(CURSE_ORDNER_NUR) === 'curseforge');
  check('leeres zip -> null', modpack.erkenneFormat(MRPACK_LEERES_ZIP) === null);

  console.log('=== Modloader-Normalisierung (Modrinth) ===');
  check('kein loader -> vanilla', modpack.normalisiereLoader({ minecraft: '1.20.1' }) === 'vanilla');
  check('fabric-loader -> fabric', modpack.normalisiereLoader({ 'fabric-loader': '0.15' }) === 'fabric');
  check('quilt-loader -> quilt', modpack.normalisiereLoader({ 'quilt-loader': '0.20' }) === 'quilt');
  check('forge -> forge', modpack.normalisiereLoader({ forge: '44' }) === 'forge');
  check('neoforge -> neoforge', modpack.normalisiereLoader({ neoforge: '20' }) === 'neoforge');
  check('forge UND neoforge -> neoforge', modpack.normalisiereLoader({ forge: '1', neoforge: '1' }) === 'neoforge');
  check('null/undefined -> vanilla', modpack.normalisiereLoader(null) === 'vanilla'
    && modpack.normalisiereLoader(undefined) === 'vanilla'
    && modpack.normalisiereLoader('kaputt') === 'vanilla');

  console.log('=== Modloader aus CurseForge-Id ===');
  check('fabric-0.15.0 -> fabric', modpack.loaderAusCurseId('fabric-0.15.0').modloader === 'fabric');
  check('forge-44.1.0 -> forge', modpack.loaderAusCurseId('forge-44.1.0').modloader === 'forge');
  check('minecraft-1.20.1 -> vanilla', modpack.loaderAusCurseId('minecraft-1.20.1').modloader === 'vanilla');
  check('neoforge-20.2.0 -> neoforge', modpack.loaderAusCurseId('neoforge-20.2.0').modloader === 'neoforge');
  check('leere id -> vanilla', modpack.loaderAusCurseId('').modloader === 'vanilla');
  check('rohe id wird mitgeliefert', modpack.loaderAusCurseId('fabric-0.15.0').loaderRoh === 'fabric-0.15.0');

  console.log('=== sichere Zielpfade (Zip-Slip) ===');
  const basis = path.join(TESTDIR, 'basis');
  check('normaler pfad ok', modpack.sichererZielPfad(basis, 'mods/x.jar') !== null);
  check('nur dateiname ok', modpack.sichererZielPfad(basis, 'x.jar') !== null);
  check('.. abgelehnt', modpack.sichererZielPfad(basis, '../raus.txt') === null);
  check('overrides/../../ abgelehnt', modpack.sichererZielPfad(basis, 'overrides/../../raus.txt') === null);
  check('absoluter pfad abgelehnt', modpack.sichererZielPfad(basis, '/absolut.txt') === null);
  check('laufwerksbuchstabe abgelehnt', modpack.sichererZielPfad(basis, 'C:/absolut.txt') === null);
  check('segment mit doppelpunkt abgelehnt', modpack.sichererZielPfad(basis, 'C:foo') === null);
  check('leeres segment abgelehnt', modpack.sichererZielPfad(basis, 'a//b') === null);
  check('punkt-segment abgelehnt', modpack.sichererZielPfad(basis, 'a/./b') === null);
  check('leerer string abgelehnt', modpack.sichererZielPfad(basis, '') === null);
  check('null abgelehnt', modpack.sichererZielPfad(basis, null) === null);
  check('steuerzeichen abgelehnt', modpack.sichererZielPfad(basis, 'gut/\u0001x.txt') === null);

  console.log('=== leseMrpack ===');
  const mrp = modpack.leseMrpack(MRPACK);
  check('name gelesen', mrp.name === 'Test-Paket Alpha');
  check('versionId gelesen', mrp.versionId === '1.2.3');
  check('minecraft gelesen', mrp.minecraft === '1.20.1');
  check('loader normalisiert (fabric)', mrp.modloader === 'fabric');
  check('dateien: leerer pfad gefiltert', mrp.dateien.length === 3);
  const beispiel = mrp.dateien.find((f) => f.pfad === 'mods/beispielmod.jar');
  check('sha1 aus hashes', beispiel && beispiel.sha1 === JAR_SHA1);
  check('url aus downloads[0]', beispiel && beispiel.url === 'https://cdn.test/beispielmod.jar');
  const ohneUrl = mrp.dateien.find((f) => f.pfad === 'mods/ohne-url.jar');
  check('fehlender download -> url null', ohneUrl && ohneUrl.url === null);
  const ohneSha = mrp.dateien.find((f) => f.pfad === 'resourcepacks/extra.zip');
  check('fehlende hashes -> sha1 null', ohneSha && ohneSha.sha1 === null);

  console.log('=== leseCurseManifest ===');
  const cm = modpack.leseCurseManifest(CURSE);
  check('name gelesen', cm.name === 'Curse-Paket Beta');
  check('version + minecraft getrennt', cm.version === '1.0.0' && cm.minecraft === '1.20.1');
  check('primaerer loader gewinnt (forge)', cm.modloader === 'forge' && cm.loaderRoh === 'forge-44.1.0');
  check('dateien gezahlt', cm.dateien.length === 4);
  const erst = cm.dateien[0];
  check('downloadUrl durchgereicht', erst.downloadUrl === 'https://cdn.test/curse-a.jar');
  check('required default true', erst.erforderlich === true);
  const dritter = cm.dateien[2];
  check('required=false ablesbar', dritter.erforderlich === false);
  const ohneUrlCf = cm.dateien.find((f) => f.projektId === 2);
  check('fehlende downloadUrl -> null', ohneUrlCf && ohneUrlCf.downloadUrl === null);

  console.log('=== modpackAusDatei (Zusammenfassung) ===');
  const zi = modpack.modpackAusDatei(MRPACK);
  check('format', zi.format === 'mrpack');
  check('version IST die packversion (1.2.3)', zi.version === '1.2.3');
  check('minecraft IST die spielversion (1.20.1)', zi.minecraft === '1.20.1');
  check('version != minecraft (nicht verwechseln)', zi.version !== zi.minecraft);
  check('modloader', zi.modloader === 'fabric');
  check('dateien-zaehler', zi.dateien === 3);
  check('overrides-zaehler (4 eintraege, extra.json doppelt fuer client)', zi.overrides === 4);
  const zc = modpack.modpackAusDatei(CURSE);
  check('curseforge format/version/minecraft', zc.format === 'curseforge' && zc.version === '1.0.0' && zc.minecraft === '1.20.1');
  check('curseforge loader inkl. roh-id', zc.modloader === 'forge' && zc.loaderRoh === 'forge-44.1.0');
  const zn = modpack.modpackAusDatei(TEXT_ALS_MRPACK);
  check('kein modpack -> format null + fehler', zn.format === null && typeof zn.fehler === 'string' && zn.fehler.length > 0);

  console.log('=== installiereMrpack (ohne Netz) ===');
  const zielM = path.join(TESTDIR, 'inst-mrpack');
  fs.rmSync(zielM, { recursive: true, force: true });
  const protokoll = [];
  const erg1 = await modpack.installiereMrpack(zielM, MRPACK, attrapenLader(protokoll));
  // 4 Overrides (client-overrides ueberschreibt config/extra.json im selben
  // Lauf) + 2 Downloads = 6; "mods/ohne-url.jar" ohne URL ist ein Fehler.
  check('inst-mrpack: installiert zaehlt overrides + downloads',
    erg1.installiert === 6, 'installiert=' + erg1.installiert + ' fehler=' + erg1.fehler.join('|'));
  check('inst-mrpack: nur die eine ehrliche fehlermeldung (ohne-url.jar)',
    erg1.fehler.length === 1, 'fehler=' + erg1.fehler.join('|'));
  check('inst-mrpack: kein slippy', erg1.abgelehnt === false);
  const dateienM = allePfadeUnter(zielM);
  check('override config/settings.toml geschrieben', dateienM.includes('config/settings.toml'));
  check('override resourcepacks/pack.zip geschrieben', dateienM.includes('resourcepacks/pack.zip'));
  check('download mods/beispielmod.jar geschrieben', dateienM.includes('mods/beispielmod.jar'));
  check('client-overrides siegen ueber overrides',
    fs.readFileSync(path.join(zielM, 'config', 'extra.json'), 'utf-8').includes('client-overrides'));
  const ladeAufrufe = protokoll.map((p) => p.url);
  check('ladeDatei bekam url + sha1 fuer beispielmod',
    ladeAufrufe.includes('https://cdn.test/beispielmod.jar')
    && protokoll.find((p) => p.url.includes('beispielmod')).sha1Soll === JAR_SHA1);
  check('ladeDatei ohne sha1 fuer extra.zip (null durchgereicht)',
    protokoll.find((p) => p.url.includes('extra.zip')).sha1Soll === null);
  check('ohne-url.jar wird ehrlich als fehler gemeldet',
    erg1.fehler.some((f) => f.includes('ohne-url.jar') && f.includes('Download-Adresse')));

  // Zweiter Lauf ohne ueberschreiben: alles schon da -> uebersprungen
  // (4 Overrides + 2 Downloads, der URL-lose Eintrag bleibt Fehler).
  const erg2 = await modpack.installiereMrpack(zielM, MRPACK, attrapenLader([]), {});
  check('zweiter lauf: uebersprungen statt neu geschrieben',
    erg2.installiert === 0 && erg2.uebersprungen === 6,
    'installiert=' + erg2.installiert + ' uebersprungen=' + erg2.uebersprungen);
  check('zweiter lauf: fehler bleibt (ohne-url.jar)', erg2.fehler.length === 1);
  check('ueberschreiben=true schreibt neu',
    (await modpack.installiereMrpack(zielM, MRPACK, attrapenLader([]), { ueberschreiben: true })).installiert === 6);

  // Hoffentlich werfen: kein zip.
  let warf = false;
  try { await modpack.installiereMrpack(path.join(TESTDIR, 'kaputt'), TEXT_ALS_MRPACK, attrapenLader([])); }
  catch { warf = true; }
  check('kein zip -> installiereMrpack wirft (kein stillschweigendes leeres Ergebnis)', warf);

  console.log('=== installiereCurseForge ===');
  const zielC = path.join(TESTDIR, 'inst-curse');
  fs.rmSync(zielC, { recursive: true, force: true });
  const cProto = [];
  const loeser = async (projektId, dateiId) => {
    if (projektId === 2 && dateiId === 20) {
      return { url: 'https://cdn.test/von-api.jar', dateiname: 'von-api.jar', sha1: 'aabbccdd' };
    }
    return { fehler: `Projekt ${projektId}/${dateiId} unbekannt` };
  };
  const ergC = await modpack.installiereCurseForge(zielC, CURSE, loeser, attrapenLader(cProto), { unterordner: 'mods' });
  const dateienC = allePfadeUnter(zielC);
  check('curseforge: download mit url in mods/ (curse-a.jar)', dateienC.includes('mods/curse-a.jar'));
  check('curseforge: resolvierte datei in mods/ (von-api.jar)', dateienC.includes('mods/von-api.jar'));
  check('curseforge: override direkt im instanzordner (config/curse.cfg)', dateienC.includes('config/curse.cfg'));
  check('curseforge: nichts von override unter mods/', !dateienC.includes('mods/curse.cfg'));
  check('curseforge: loeser bekam projekt+datei-id',
    cProto.some((p) => p.url === 'https://cdn.test/von-api.jar' && p.sha1Soll === 'aabbccdd'));
  check('curseforge: required=false -> uebersprungen', ergC.uebersprungen === 1);
  check('curseforge: projekt 4 (Loeser ohne Treffer) -> oeffentlicher curseforge.com-Weg',
    cProto.some((p) => p.url === 'https://www.curseforge.com/api/v1/mods/4/files/40/download'), JSON.stringify(ergC.fehler));
  check('curseforge: gesamtbilanz stimmt', ergC.installiert === 4 && ergC.fehler.length === 0,
    'installiert=' + ergC.installiert + ' fehler=' + ergC.fehler.length);

  // Ohne loeseUrl: nur Eintraege mit eingebetteter downloadUrl funktionieren.
  const zielC2 = path.join(TESTDIR, 'inst-curse-ohne-api');
  fs.rmSync(zielC2, { recursive: true, force: true });
  const ergC2 = await modpack.installiereCurseForge(zielC2, CURSE, null, attrapenLader([]), {});
  check('ohne loeser: curse-a.jar via downloadUrl installiert',
    allePfadeUnter(zielC2).includes('mods/curse-a.jar'));
  check('ohne loeser: eintraege ohne url laden ueber den oeffentlichen Weg statt zu scheitern',
    ergC2.fehler.length === 0 && ergC2.installiert === 4,
    'fehler=' + ergC2.fehler.join('|') + ' installiert=' + ergC2.installiert);
  check('ohne loeser: required=false trotzdem uebersprungen', ergC2.uebersprungen === 1);

  // kaputtes manifest -> wirft (kein lautes "fertig" bei leeren Ergebnissen)
  let warfManifest = false;
  try {
    await modpack.installiereCurseForge(path.join(TESTDIR, 'x'), TEXT_ALS_MRPACK, null, attrapenLader([]));
  } catch { warfManifest = true; }
  check('kein zip -> installiereCurseForge wirft', warfManifest);

  console.log('=== Zip-Slip: ganze Datei wird abgelehnt ===');
  const slipZiel = path.join(TESTDIR, 'slip-ziel');
  const ausserhalb = path.join(TESTDIR, 'slip-aussen');
  fs.mkdirSync(ausserhalb, { recursive: true });
  fs.rmSync(slipZiel, { recursive: true, force: true });
  const ergSlip = await modpack.installiereMrpack(slipZiel, MRPACK_SLIP, attrapenLader([]));
  check('slip: abgelehnt=true', ergSlip.abgelehnt === true);
  check('slip: installiert=0', ergSlip.installiert === 0);
  check('slip: fehler nennt unsichere pfade',
    ergSlip.fehler.some((f) => f.includes('Unzulaessiger Pfad')) && ergSlip.fehler.some((f) => f.includes('Zip-Slip')));
  check('slip: nichts innerhalb des ziels geschrieben (auch gutes nicht)',
    !fs.existsSync(slipZiel) || baum(slipZiel).length === 0,
    'gefunden: ' + JSON.stringify(baum(slipZiel)));
  check('slip: nichts ausserhalb geschrieben (..)',
    !fs.existsSync(path.join(TESTDIR, 'boese.txt')) && !fs.existsSync(path.join(TESTDIR, 'raus.txt')));
  check('slip: keine C:-Datei auf Platte',
    !fs.existsSync(path.join(slipZiel, 'absolut.txt')));

  const slipAbs = await modpack.installiereMrpack(slipZiel, MRPACK_SLIP, attrapenLader([]));
  check('slip: download-pfad mit .. lehnt ebenfalls ab',
    slipAbs.abgelehnt === true && slipAbs.fehler.some((f) => f.includes('../../ausbruch.jar')));

  const ergCurseSlip = await modpack.installiereCurseForge(slipZiel, CURSE_SLIP, null, attrapenLader([]));
  check('curseforge-slip: abgelehnt', ergCurseSlip.abgelehnt === true && ergCurseSlip.installiert === 0);
  check('curseforge-slip: nichts ausserhalb', !fs.existsSync(path.join(TESTDIR, 'raus2.txt')));
  check('curseforge-slip: nichts innerhalb (auch gut.txt nicht)',
    !fs.existsSync(slipZiel) || baum(slipZiel).length === 0,
    JSON.stringify(baum(slipZiel)));

  const ergSteuer = await modpack.installiereMrpack(path.join(TESTDIR, 'steuer-ziel'), MRPACK_STEUERZEICHEN, attrapenLader([]));
  check('steuerzeichen-pfad -> abgelehnt', ergSteuer.abgelehnt === true);

  // Gegenprobe: ein ehrliches Modpack wird NICHT abgelehnt (kein falscher Alarm).
  check('gegenprobe: gutes modpack nie abgelehnt',
    (await modpack.installiereMrpack(path.join(TESTDIR, 'gut2'), MRPACK, attrapenLader([]))).abgelehnt === false);

  console.log('=== IPC: modpackQuellen.* mit gestubbtem Electron ===');
  await ipcTeil();

  console.log('\n' + '='.repeat(60));
  console.log(`${checks} Checks, ${fehl.length} Fehler`);
  if (fehl.length) {
    console.log('❌ Probleme:');
    fehl.forEach((f) => console.log('   - ' + f));
    process.exitCode = 1;
  } else {
    console.log('✅ Modpack-Importmodul und IPC-Kanaele funktionieren.');
  }
})();

// ---------- IPC-Teil ----------
async function ipcTeil() {
  const USER_DATA = path.join(TESTDIR, 'ipc-userdata');
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });

  // Dialog-Attrappe: die Rueckgabe ist steuerbar (erst pruefen -> weil der
  // Speicherpfad des Dialogs der Prozessgrenze folgt).
  let naechsterDialog = { canceled: true, filePaths: [] };
  const registered = {};
  const electronStub = {
    app: { getPath: () => USER_DATA, on() {}, whenReady: async () => {} },
    ipcMain: { handle: (channel, fn) => { registered[channel] = fn; }, on() {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(`X${t}`, 'utf-8'),
      decryptString: (b) => b.toString('utf-8').slice(1)
    },
    dialog: {
      showOpenDialog: async () => naechsterDialog
    },
    BrowserWindow: Object.assign(class {}, {
      fromWebContents: () => null
    }),
    shell: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) }
  };
  const electronEntry = require.resolve('electron');
  require.cache[electronEntry] = {
    id: electronEntry, filename: electronEntry, loaded: true, exports: electronStub
  };

  // Netz-Attrappe: ein Routing-Feld, alles andere wirft (in Tests kein Netz).
  const netz = new Map(); // url -> { json } | { puffer } | Fehler
  let urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, _opts) => {
    urls.push(String(url));
    const eintrag = netz.get(String(url));
    if (!eintrag) throw new Error('kein Netz in diesem Test fuer ' + url);
    if (eintrag.fehler) throw eintrag.fehler;
    return {
      ok: true, status: 200,
      json: async () => eintrag.json,
      arrayBuffer: async () => (eintrag.puffer ? eintrag.puffer.buffer.slice(eintrag.puffer.byteOffset, eintrag.puffer.byteOffset + eintrag.puffer.byteLength) : new ArrayBuffer(0))
    };
  };

  try {
    const { registerIpcHandlers } = require('./src/main/ipc-handlers');
    registerIpcHandlers();

    // Ereignis-Attrappe: echtes Electron uebergibt { sender: webContents };
    // hier reicht ein leeres Objekt (fromWebContents -> null ist erlaubt).
    const evt = { sender: {} };

    for (const kanal of ['modpackQuellen:pruefen', 'modpackQuellen:importieren',
      'modpackQuellen:sucheModrinth', 'modpackQuellen:importiereModrinth',
      'modpackQuellen:sucheCurseForge']) {
      check(`IPC: ${kanal} registriert`, typeof registered[kanal] === 'function');
    }

    console.log('--- CurseForge-Suche ohne API-Schluessel ---');
    const ohneSchluessel = await registered['modpackQuellen:sucheCurseForge'](evt, 'create');
    check('ohne schluessel exakte meldung',
      ohneSchluessel && ohneSchluessel.fehler === 'Für die CurseForge-Suche wird ein API-Schlüssel benötigt.',
      JSON.stringify(ohneSchluessel));

    // Schluessel ueber den normalen settings-Kanal setzen -> landet
    // persistiert in settings.json und wird hier gelesen.
    await registered['settings:set'](evt, { curseforgeApiKey: 'geheim-key' });
    const gespeichert = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf-8'));
    check('curseforgeApiKey ueberlebt in settings.json', gespeichert.curseforgeApiKey === 'geheim-key');

    const cfSuchUrl = 'https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&searchFilter=create&pageSize=10';
    netz.set(cfSuchUrl, { json: { data: [
      { id: 551, name: 'Mango Pack', downloadCount: 4321,
        gameVersionLatestFiles: [{ gameVersion: '1.20.1' }] }
    ] } });
    const mitSchluessel = await registered['modpackQuellen:sucheCurseForge'](evt, 'create');
    check('curseforge-suche mit schluessel liefert reduziertes feld-schema',
      Array.isArray(mitSchluessel) && mitSchluessel.length === 1
      && mitSchluessel[0].id === 551 && mitSchluessel[0].name === 'Mango Pack'
      && mitSchluessel[0].version === '1.20.1' && mitSchluessel[0].downloads === 4321,
      JSON.stringify(mitSchluessel));

    // Nicht registrierte URL -> "kein Netz in diesem Test" -> {fehler}.
    const cfKaputt = await registered['modpackQuellen:sucheCurseForge'](evt, 'kaputt-extern');
    check('curseforge-suche: netzwerkfehler -> {fehler}, kein Wurf',
      cfKaputt && cfKaputt.fehler && typeof cfKaputt.fehler === 'string', JSON.stringify(cfKaputt));

    console.log('--- Modrinth-Suche (gestubbt) ---');
    const suchUrl = 'https://api.modrinth.com/v2/search?query=sodium&limit=10&facets=' +
      encodeURIComponent(JSON.stringify([['project_type:modpack']]));
    netz.set(suchUrl, { json: { hits: [
      { project_id: 'abc123', title: 'Sodium Pack', downloads: 99,
        versions: ['1.19.2', '1.20.1'], latest_version: 'VV1' },
      { project_id: 'def456', title: 'Ohne Versionen', downloads: 1, latest_version: 'VV2' }
    ] } });
    const suchRes = await registered['modpackQuellen:sucheModrinth'](evt, 'sodium');
    check('sucheModrinth: letztes element der versions-liste (neueste spielversion)',
      Array.isArray(suchRes) && suchRes[0].version === '1.20.1', JSON.stringify(suchRes));
    check('sucheModrinth: fallback, wenn versions fehlt',
      Array.isArray(suchRes) && suchRes[1].version === 'VV2', JSON.stringify(suchRes));
    check('sucheModrinth: feld-schema {id,name,version,downloads}',
      Array.isArray(suchRes) && suchRes[0].id === 'abc123' && suchRes[0].name === 'Sodium Pack'
      && suchRes[0].downloads === 99);

    const suchKaputt = await registered['modpackQuellen:sucheModrinth'](evt, 'kaputt-suche');
    check('sucheModrinth: netzwerkfehler -> {fehler}, nie ein Wurf',
      suchKaputt && typeof suchKaputt.fehler === 'string' && !Array.isArray(suchKaputt), JSON.stringify(suchKaputt));

    console.log('--- importiereModrinth (gestubbt) ---');
    // Ein echtes .mrpack bauen (bytes) und sha1 in die Versionsantwort legen.
    const fakeZip = new AdmZip();
    fakeZip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
      formatVersion: 1, game: 'minecraft', versionId: '2.0', name: 'Fake Pack',
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
      files: []
    })));
    fakeZip.addFile('overrides/config/aus-api.json', Buffer.from('{"remote":true}'));
    const mrpackBytes = fakeZip.toBuffer();
    const mrpackSha1 = crypto.createHash('sha1').update(mrpackBytes).digest('hex');
    netz.set('https://api.modrinth.com/v2/project/xyz', { json: { title: 'Fake Pack' } });
    netz.set('https://api.modrinth.com/v2/project/xyz/version', { json: [
      { version_number: '1.0.0', date_published: '2025-01-01T00:00:00Z',
        files: [{ filename: 'alte.mrpack', primary: true, url: 'https://cdn.test/alte.mrpack', hashes: { sha1: 'a' } }] },
      { version_number: '2.0', date_published: '2026-06-01T00:00:00Z',
        files: [{ filename: 'Fake Pack 2.0.mrpack', primary: true, url: 'https://cdn.test/fake.mrpack', hashes: { sha1: mrpackSha1 } }] }
    ] });
    netz.set('https://cdn.test/fake.mrpack', { puffer: mrpackBytes });

    const importModrinth = await registered['modpackQuellen:importiereModrinth'](evt, 'xyz');
    check('importiereModrinth ok:true', importModrinth && importModrinth.ok === true, JSON.stringify(importModrinth));
    check('importiereModrinth nahm die NEUESTE version (2.0)',
      importModrinth.modpack && importModrinth.modpack.version === '2.0', JSON.stringify(importModrinth));
    check('importiereModrinth: instanz liegt als ordner auf der platte',
      fs.existsSync(path.join(USER_DATA, 'instances', 'fake-pack', 'instance.json')));
    check('importiereModrinth: override aus dem .mrpack installiert',
      fs.existsSync(path.join(USER_DATA, 'instances', 'fake-pack', 'config', 'aus-api.json')));
    check('importiereModrinth: tempdatei aufgeraeumt',
      fs.readdirSync(USER_DATA).filter((f) => f.startsWith('import-') && f.endsWith('.mrpack')).length === 0);

    console.log('--- pruefen/importieren (Dateidialog gestubbt) ---');
    naechsterDialog = { canceled: true, filePaths: [] };
    const abgebrochen = await registered['modpackQuellen:pruefen'](evt);
    check('pruefen bei abbruch -> null', abgebrochen === null);

    // ohne vorherige Auswahl wirft importieren (der Renderer darf nie raten).
    let warfOhneWahl = false;
    try { await registered['modpackQuellen:importieren'](evt, 'Irgendwas'); }
    catch { warfOhneWahl = true; }
    check('importieren ohne vorheriges pruefen wirft', warfOhneWahl);

    // Datei-Import mit echtem Fixture: mrpack mit download-url, dessen
    // bytes ueber das gestubbte Netz kommen und per sha1 verifiziert werden.
    naechsterDialog = { canceled: false, filePaths: [MRPACK] };
    const geprueft = await registered['modpackQuellen:pruefen'](evt);
    check('pruefen liefert zusammenfassung', geprueft && geprueft.format === 'mrpack'
      && geprueft.name === 'Test-Paket Alpha');
    netz.set('https://cdn.test/beispielmod.jar', { puffer: JAR_INHALT });
    netz.set('https://cdn.test/extra.zip', { puffer: ZIP_INHALT });
    const importiert = await registered['modpackQuellen:importieren'](evt, 'Mein Import');
    check('importieren ok:true mit instanz', importiert && importiert.ok === true
      && importiert.instanz && importiert.instanz.id, JSON.stringify(importiert));
    check('importieren: selbst gewaehlter name gewinnt',
      importiert.instanz.name === 'Mein Import');
    const instPfad = path.join(USER_DATA, 'instances', importiert.instanz.id);
    check('importieren: mods/beispielmod.jar mit echten bytes (sha1 geprueft)',
      fs.readFileSync(path.join(instPfad, 'mods', 'beispielmod.jar'), 'utf-8') === 'JAR-INHALT-BEISPIEL-MOD-0123456789');
    check('importieren: download ohne sha1 (extra.zip) funktioniert',
      fs.readFileSync(path.join(instPfad, 'resourcepacks', 'extra.zip'), 'utf-8') === 'RESOURCE-PACK-ARCHIV');
    check('importieren: client-overrides im instanzordner',
      fs.readFileSync(path.join(instPfad, 'config', 'extra.json'), 'utf-8').includes('client-overrides'));
    check('importieren: ohne-url.jar wird gemeldet, nicht verschluckt',
      importiert.ergebnis.fehler.some((f) => f.includes('ohne-url.jar')));
    check('importieren: instanz.json mit minecraft-version (1.20.1)',
      JSON.parse(fs.readFileSync(path.join(instPfad, 'instance.json'), 'utf-8')).version === '1.20.1');

    // Der gemerkte Pfad gilt nur einmal: ein zweiter Import ohne pruefen wirft.
    let zweiterImport = null;
    try { zweiterImport = await registered['modpackQuellen:importieren'](evt, 'Nochmal'); }
    catch { zweiterImport = 'geworfen'; }
    check('gemerkte auswahl gilt nur einmal', zweiterImport === 'geworfen',
      JSON.stringify(zweiterImport));

    // quilt-Pack wird ehrlich abgelehnt (Startkette kennt kein quilt).
    const quiltZip = schreiben('quilt.mrpack', (() => {
      const zip = new AdmZip();
      zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
        formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Quilt Pack',
        dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.20' }, files: []
      })));
      return zip.toBuffer();
    })());
    naechsterDialog = { canceled: false, filePaths: [quiltZip] };
    await registered['modpackQuellen:pruefen'](evt);
    const quiltAbgelehnt = await registered['modpackQuellen:importieren'](evt, '');
    check('quilt-pack wird ehrlich abgelehnt',
      quiltAbgelehnt && quiltAbgelehnt.ok === false && /quilt/.test(quiltAbgelehnt.fehler),
      JSON.stringify(quiltAbgelehnt));

    // Kein Modpack in der Datei -> gleiche ehrliche Antwort.
    naechsterDialog = { canceled: false, filePaths: [TEXT_ALS_MRPACK] };
    await registered['modpackQuellen:pruefen'](evt);
    const muellAbgelehnt = await registered['modpackQuellen:importieren'](evt, '');
    check('keine modpack-datei -> ok:false mit fehler',
      muellAbgelehnt && muellAbgelehnt.ok === false && typeof muellAbgelehnt.fehler === 'string',
      JSON.stringify(muellAbgelehnt));

    // Und: die CurseForge-Datei-IMPORT-SEITE funktioniert ohne Schluessel,
    // solange die manifest.json downloadUrl-Eintraege mitbringt. Der
    // Schluessel aus dem Such-Test wird dazu zurueckgesetzt.
    await registered['settings:set'](evt, { curseforgeApiKey: null });
    naechsterDialog = { canceled: false, filePaths: [CURSE] };
    const curseInfo = await registered['modpackQuellen:pruefen'](evt);
    check('pruefen erkennt curseforge-zip ohne schluessel', curseInfo && curseInfo.format === 'curseforge');
    netz.set('https://cdn.test/curse-a.jar', { puffer: Buffer.from('CURSE-A') });
    const curseOhne = await registered['modpackQuellen:importieren'](evt, 'Curse Ohne');
    check('curseforge-dateiimport ohne schluessel: mods/curse-a.jar liegt da',
      curseOhne && curseOhne.ok === true
      && fs.readFileSync(path.join(USER_DATA, 'instances', curseOhne.instanz.id, 'mods', 'curse-a.jar'), 'utf-8') === 'CURSE-A',
      JSON.stringify(curseOhne && { ok: curseOhne.ok, fehler: curseOhne.ergebnis && curseOhne.ergebnis.fehler }));
    check('curseforge ohne schluessel: nicht ladbare Dateien werden ehrlich gemeldet (HTTP-Fehler statt "keine Adresse")',
      curseOhne && curseOhne.ergebnis.fehler.filter((f) => f.includes('curseforge.com/api/v1/mods/')).length === 2,
      JSON.stringify(curseOhne && curseOhne.ergebnis && curseOhne.ergebnis.fehler));
    check('curseforge ohne schluessel: required=false -> uebersprungen',
      curseOhne && curseOhne.ergebnis.uebersprungen === 1,
      JSON.stringify(curseOhne && curseOhne.ergebnis && curseOhne.ergebnis.uebersprungen));

    // Mit Schluessel greift die CurseForge-API-Aufloesung: Eintraege ohne
    // eingebettete downloadUrl werden ueber /v1/mods/{id}/files/{fileId}
    // aufgeloest und mit SHA1 geprueft heruntergeladen.
    await registered['settings:set'](evt, { curseforgeApiKey: 'geheim-key' });
    const vonApiSha = crypto.createHash('sha1').update('CURSE-B').digest('hex');
    netz.set('https://api.curseforge.com/v1/mods/2/files/20', {
      json: { data: { downloadUrl: 'https://cdn.test/von-api.jar', fileName: 'von-api.jar',
        hashes: [{ algo: 1, value: vonApiSha }] } }
    });
    netz.set('https://cdn.test/von-api.jar', { puffer: Buffer.from('CURSE-B') });
    netz.set('https://api.curseforge.com/v1/mods/4/files/40', {
      json: { data: { downloadUrl: 'https://cdn.test/noch-eins.jar', fileName: 'noch-eins.jar', hashes: [] } }
    });
    netz.set('https://cdn.test/noch-eins.jar', { puffer: Buffer.from('NOCH-EINS') });
    naechsterDialog = { canceled: false, filePaths: [CURSE] };
    await registered['modpackQuellen:pruefen'](evt);
    const curseMit = await registered['modpackQuellen:importieren'](evt, 'Curse Mit');
    check('curseforge mit schluessel: uneingebettete datei ueber API aufgeloest + SHA1 geprueft',
      curseMit && curseMit.ok === true
      && fs.readFileSync(path.join(USER_DATA, 'instances', curseMit.instanz.id, 'mods', 'von-api.jar'), 'utf-8') === 'CURSE-B',
      JSON.stringify(curseMit && { ok: curseMit.ok, fehler: curseMit.ergebnis && curseMit.ergebnis.fehler }));
    check('curseforge mit schluessel: zweite API-datei ebenfalls installiert',
      curseMit && fs.readFileSync(path.join(USER_DATA, 'instances', curseMit.instanz.id, 'mods', 'noch-eins.jar'), 'utf-8') === 'NOCH-EINS',
      JSON.stringify(curseMit && { ok: curseMit.ok, fehler: curseMit.ergebnis && curseMit.ergebnis.fehler }));
    check('curseforge mit schluessel: keine offenen fehler',
      curseMit && curseMit.ergebnis.fehler.length === 0,
      JSON.stringify(curseMit && curseMit.ergebnis && curseMit.ergebnis.fehler));

    // CurseForge-Zip mit slippy overrides-Eintrag wird komplett abgelehnt:
    naechsterDialog = { canceled: false, filePaths: [CURSE_SLIP] };
    await registered['modpackQuellen:pruefen'](evt);
    const curseSlipImport = await registered['modpackQuellen:importieren'](evt, 'Slip');
    check('slippery curseforge-zip wird beim import abgelehnt',
      curseSlipImport && curseSlipImport.ok === false
      && Array.isArray(curseSlipImport.fehler) && curseSlipImport.fehler.join(' ').includes('Zip-Slip'),
      JSON.stringify(curseSlipImport));
    check('slippery curseforge-zip hinterlaesst keinen geisterordner',
      !fs.existsSync(path.join(USER_DATA, 'instances', 'slip')));

    // Netz wieder entstubben (sauberer Abschluss).
  } finally {
    global.fetch = originalFetch;
    delete require.cache[electronEntry];
  }
}