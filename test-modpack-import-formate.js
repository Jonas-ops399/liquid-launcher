// Neue Faelle des Modpack-Imports: Wurzelordner im Zip, CurseForge ohne
// overrides, eigener overrides-Name, Prism/MultiMC, Server-Mods, Spiegel-URLs,
// Dateiname aus dem Download. Laeuft unter reinem Node (wie test-modpack-import.js).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const AdmZip = require('adm-zip');
const m = require('./src/main/modpackImport');
let n = 0, bad = 0;
const check = (t, ok, d) => { n++; if (!ok) { bad++; console.log('  FEHLT', t, d || ''); } };
const crypto = require('node:crypto'); const zlib = require('node:zlib'); function crc32(buf) { return zlib.crc32(buf); }
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'll-formate-'));
const zipDatei = (name, eintraege) => { const z = new AdmZip(); for (const [k, v] of eintraege) z.addFile(k, Buffer.from(v)); const p = path.join(DIR, name); z.writeZip(p); return p; };
const lader = (log, scheitere = []) => async (url, sha1, ziel) => {
  log.push(url);
  if (scheitere.includes(url)) throw new Error('HTTP 404');
  fs.writeFileSync(ziel, 'X');
  return { dateiname: url.includes('curseforge.com') ? 'echter-name-1.0.jar' : null };
};
const dateien = (d) => { const o = []; (function w(p, r) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name), rr = r ? r + '/' + e.name : e.name; e.isDirectory() ? w(q, rr) : o.push(rr); } })(d, ''); return o; };

(async () => {
  // Wurzelordner: Zip wurde aus einem Ordner gepackt
  const mrIdx = JSON.stringify({ name: 'Wurzel', versionId: '1', dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    files: [
      { path: 'mods/client.jar', hashes: { sha1: 'a' }, downloads: ['https://a.test/tot.jar', 'https://b.test/client.jar'] },
      { path: 'mods/server.jar', env: { client: 'unsupported', server: 'required' }, downloads: ['https://a.test/server.jar'] }
    ] });
  const nestedMr = zipDatei('nested.mrpack', [['Pack/modrinth.index.json', mrIdx], ['Pack/overrides/config/a.toml', 'a']]);
  check('mrpack im Wurzelordner erkannt', m.erkenneFormat(nestedMr) === 'mrpack');
  const info = m.modpackAusDatei(nestedMr);
  check('mrpack im Wurzelordner: Zusammenfassung', info.format === 'mrpack' && info.minecraft === '1.20.1' && info.modloader === 'fabric' && info.overrides === 1, JSON.stringify(info));
  check('server-only-Mod zaehlt nicht', info.dateien === 1, String(info.dateien));
  const z1 = path.join(DIR, 'i1'); const log1 = [];
  const e1 = await m.installiereMrpack(z1, nestedMr, lader(log1, ['https://a.test/tot.jar']), {});
  check('zweite Adresse wird versucht, wenn die erste scheitert', e1.fehler.length === 0 && log1.length === 2 && dateien(z1).includes('mods/client.jar'), JSON.stringify([e1.fehler, log1]));
  check('server-Mod wird nie geladen', !log1.some((u) => u.includes('server.jar')));
  check('override aus Wurzelordner geschrieben', dateien(z1).includes('config/a.toml'));

  // CurseForge ohne overrides, mit eigenem Override-Namen, im Wurzelordner
  const cf = (extra) => JSON.stringify(Object.assign({ manifestType: 'minecraftModpack', name: 'CF', version: '2', minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] }, files: [{ projectID: 7, fileID: 70, required: true }] }, extra));
  const cfNested = zipDatei('cf-nested.zip', [['CF/manifest.json', cf({ overrides: 'daten' })], ['CF/daten/config/b.cfg', 'b']]);
  check('curseforge im Wurzelordner erkannt', m.erkenneFormat(cfNested) === 'curseforge');
  check('eigener overrides-Name gezaehlt', m.modpackAusDatei(cfNested).overrides === 1);
  const z2 = path.join(DIR, 'i2'); const log2 = [];
  const e2 = await m.installiereCurseForge(z2, cfNested, null, lader(log2), {});
  check('ohne API: oeffentlicher Weg', log2[0] === 'https://www.curseforge.com/api/v1/mods/7/files/70/download', log2[0]);
  check('Datei bekommt den echten Namen', dateien(z2).includes('mods/echter-name-1.0.jar') && !dateien(z2).some((f) => f.startsWith('mods/unbekannt')), dateien(z2).join(','));
  check('eigener overrides-Ordner uebernommen', dateien(z2).includes('config/b.cfg') && e2.fehler.length === 0);
  const cfLeer = zipDatei('cf-leer.zip', [['manifest.json', cf({})]]);
  check('curseforge ganz ohne overrides ist ein Modpack', m.erkenneFormat(cfLeer) === 'curseforge');
  check('fremde manifest.json ist kein Modpack', m.erkenneFormat(zipDatei('fremd.zip', [['manifest.json', '{"name":"irgendwas"}']])) === null);
  check('manifest.json tiefer im Zip (Mod im Pack) zaehlt nicht', m.erkenneFormat(zipDatei('tief.zip', [['a/b/manifest.json', cf({})]])) === null);

  // Prism / MultiMC
  const prism = zipDatei('prism.zip', [
    ['Mein Pack/instance.cfg', 'InstanceType=OneSix\nname=Prism Pack\n'],
    ['Mein Pack/mmc-pack.json', JSON.stringify({ formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.19.2' }, { uid: 'net.fabricmc.fabric-loader', version: '0.14.0' }] })],
    ['Mein Pack/.minecraft/mods/x.jar', 'J'], ['Mein Pack/.minecraft/options.txt', 'o']
  ]);
  check('prism erkannt', m.erkenneFormat(prism) === 'prism');
  const pi = m.modpackAusDatei(prism);
  check('prism: Name, Version, Loader, Dateien', pi.name === 'Prism Pack' && pi.minecraft === '1.19.2' && pi.modloader === 'fabric' && pi.overrides === 2, JSON.stringify(pi));
  const z3 = path.join(DIR, 'i3');
  const e3 = await m.installierePrism(z3, prism, lader([]), {});
  check('prism: Spielordner uebernommen', dateien(z3).includes('mods/x.jar') && dateien(z3).includes('options.txt') && e3.fehler.length === 0, dateien(z3).join(','));
  const boese = path.join(DIR, 'prism-boese.zip'); fs.writeFileSync(boese, rohZipBauen([['instance.cfg', 'name=x'], ['mmc-pack.json', '{"components":[]}'], ['.minecraft/../../raus.txt', 'R']]));
  const z4 = path.join(DIR, 'i4');
  const e4 = await m.installierePrism(z4, boese, lader([]), {});
  check('prism: Zip-Slip wird abgelehnt', e4.abgelehnt === true && !fs.existsSync(path.join(DIR, 'raus.txt')));

  console.log(`\n${n} Checks, ${bad} Fehler`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
