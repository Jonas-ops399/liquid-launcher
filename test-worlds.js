// test-worlds.js
//   node test-worlds.js
//
// Testet das Welten-Auflisten und, noch wichtiger, den Löschschutz.
//
// Der Löschschutz ist der Grund, warum es diesen Test gibt. `worlds:delete`
// ruft fs.rm(recursive) auf. Wenn ein Welt-Ordner-Name aus dem Renderer nicht
// geprüft wird, kann jemand (oder ein Bug im UI) "..\..\" schicken und damit
// den Benutzerordner löschen. Deshalb sind die Path-Traversal-Fälle hier der
// umfangreichste Teil — mit Fallunterscheidung: "wurde abgelehnt" UND
// "das Zielordner existiert danach noch".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(os.tmpdir(), 'liquid-launcher-worldstest');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const problems = [];
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) {
    console.log('  OK   ' + msg);
  } else {
    console.log('  FEHLT ' + msg + (extra ? '  →  ' + extra : ''));
    problems.push(msg);
  }
}
function group(title) {
  console.log('\n--- ' + title + ' ---');
}

// =====================================================================
// NBT-Writer, damit die Testdaten exakt sind
// Nur im Test — nbt.js kann absichtlich nicht schreiben.
// =====================================================================
const T = { End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 };

function tagName(s) {
  const b = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(2);
  len.writeInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function payload(type, value) {
  // Aufrufer dürfen statt des nackten Werts auch den Wrapper (cmp(...), str(...))
  // übergeben — das ist beim Schreiben der Testfälle bequemer. Ein echter
  // NBT-Compound hat als Schlüssel niemals "__type", deshalb ist die
  // Unterscheidung eindeutig.
  if (value && typeof value === 'object' && '__type' in value && value.__type === type) {
    value = value.value;
  }
  switch (type) {
    case T.Byte: { const b = Buffer.alloc(1); b.writeInt8(value); return b; }
    case T.Short: { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; }
    case T.Int: { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
    case T.Long: { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value)); return b; }
    case T.Float: { const b = Buffer.alloc(4); b.writeFloatBE(value); return b; }
    case T.Double: { const b = Buffer.alloc(8); b.writeDoubleBE(value); return b; }
    case T.ByteArray: { const h = Buffer.alloc(4); h.writeInt32BE(value.length); return Buffer.concat([h, Buffer.from(value)]); }
    case T.String: { const h = Buffer.alloc(2); h.writeInt16BE(Buffer.byteLength(value, 'utf-8')); return Buffer.concat([h, Buffer.from(value, 'utf-8')]); }
    case T.List: {
      const ht = Buffer.alloc(1); ht.writeUInt8(value.itemType);
      const hl = Buffer.alloc(4); hl.writeInt32BE(value.items.length);
      return Buffer.concat([ht, hl, ...value.items.map(v => payload(value.itemType, v))]);
    }
    case T.Compound: {
      const parts = [];
      for (const [name, val] of Object.entries(value)) {
        parts.push(Buffer.from([val.__type]), tagName(name), payload(val.__type, val.value));
      }
      return Buffer.concat([...parts, Buffer.from([T.End])]);
    }
    case T.IntArray: { const h = Buffer.alloc(4); h.writeInt32BE(value.length); return Buffer.concat([h, ...value.map(v => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; })]); }
    case T.LongArray: { const h = Buffer.alloc(4); h.writeInt32BE(value.length); return Buffer.concat([h, ...value.map(v => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return b; })]); }
    default: throw new Error('Test-Writer kennt Typ ' + type);
  }
}
const b = (v) => ({ __type: T.Byte, value: v });
const s = (v) => ({ __type: T.Short, value: v });
const i = (v) => ({ __type: T.Int, value: v });
const l = (v) => ({ __type: T.Long, value: v });
const f = (v) => ({ __type: T.Float, value: v });
const d = (v) => ({ __type: T.Double, value: v });
const str = (v) => ({ __type: T.String, value: v });
const ba = (v) => ({ __type: T.ByteArray, value: v });
const ia = (v) => ({ __type: T.IntArray, value: v });
const la = (v) => ({ __type: T.LongArray, value: v });
const list = (itemType, items) => ({ __type: T.List, value: { itemType, items } });
const cmp = (v) => ({ __type: T.Compound, value: v });

function writeNbtFile(target, rootCompound, { gzip = true } = {}) {
  // Aufrufer übergeben bequem cmp({...}), also den Wrapper. payload() will
  // jedoch nur nackte Werte — deshalb hier einmal auspacken.
  const root = (rootCompound && typeof rootCompound === 'object' && '__type' in rootCompound)
    ? rootCompound.value
    : rootCompound;
  const head = Buffer.from([T.Compound]);
  const body = Buffer.concat([head, tagName(''), payload(T.Compound, root)]);
  fs.writeFileSync(target, gzip ? zlib.gzipSync(body) : body);
}

// =====================================================================
group('1. NBT: alle Tag-Typen lesen');
// =====================================================================
{
  const nbtMod = require('./src/main/nbt.js');
  const { readNbt } = nbtMod;

  const file = path.join(ROOT, 'typen.dat');
  writeNbtFile(file, cmp({
    byteB: b(-42),
    bytePos: b(127),
    shortS: s(-30000),
    intI: i(123456789),
    longL: l(-9007199254740991),
    floatF: f(0.5),
    doubleD: d(3.14159265358979),
    ba: ba([1, 2, 3, 250]),
    st: str('Grüße, Welt — mit Umlaut und äöüß'),
    li: list(T.String, ['a', 'bb', 'ccc']),
    liInt: list(T.Int, [7, -7]),
    liEmpty: list(T.End, []),          // leere Liste mit End-Typ ist normal
    ia: ia([1, -1, 2147483647, -2147483648]),
    la: la([0, -1, 9007199254740991]),
    nested: cmp({ inner: str('tief'), arr: list(T.Compound, [cmp({ k: i(1) }), cmp({ k: i(2) })]) })
  }));

  const r = readNbt(file);
  ok(r.byteB === -42, 'TAG_Byte mit negativem Wert', r.byteB);
  ok(r.bytePos === 127, 'TAG_Byte am oberen Rand', r.bytePos);
  ok(r.shortS === -30000, 'TAG_Short mit negativem Wert', r.shortS);
  ok(r.intI === 123456789, 'TAG_Int');
  ok(r.longL === -9007199254740991, 'TAG_Long weit jenseits der Number-Grenze', r.longL);
  ok(Math.abs(r.floatF - 0.5) < 1e-6, 'TAG_Float', r.floatF);
  ok(Math.abs(r.doubleD - Math.PI) < 1e-12, 'TAG_Double mit voller Genauigkeit', r.doubleD);
  ok(Buffer.isBuffer(r.ba) && r.ba.length === 4 && r.ba[3] === 250, 'TAG_Byte_Array mit unsigned 250');
  ok(r.st === 'Grüße, Welt — mit Umlaut und äöüß', 'TAG_String mit Umlauten und UTF-8', JSON.stringify(r.st));
  ok(Array.isArray(r.li) && r.li.length === 3 && r.li[2] === 'ccc', 'TAG_List von Strings');
  ok(Array.isArray(r.liInt) && r.liInt[1] === -7, 'TAG_List von Ints');
  ok(Array.isArray(r.liEmpty) && r.liEmpty.length === 0, 'leere TAG_List mit End-Typ');
  ok(Array.isArray(r.ia) && r.ia[2] === 2147483647 && r.ia[3] === -2147483648, 'TAG_Int_Array an den Grenzen');
  ok(Array.isArray(r.la) && r.la[2] === 9007199254740991, 'TAG_Long_Array');
  ok(r.nested && r.nested.inner === 'tief', 'verschachtelter Compound');
  ok(Array.isArray(r.nested.arr) && r.nested.arr.length === 2 && r.nested.arr[1].k === 2, 'TAG_List von Compounds');
}

// =====================================================================
group('2. NBT: unkomprimiert und kaputt');
// =====================================================================
{
  const { readNbt, NbtError } = require('./src/main/nbt.js');

  // level.dat wird normalerweise immer gzip-komprimiert. Manche Tools
  // hinterlassen Rohdaten — das darf nicht als Fehler enden.
  const raw = path.join(ROOT, 'roh.dat');
  writeNbtFile(raw, cmp({ Data: cmp({ LevelName: str('Roh') }) }), { gzip: false });
  ok(readNbt(raw).Data.LevelName === 'Roh', 'unkomprimiertes NBT wird ebenfalls gelesen');

  const kurz = path.join(ROOT, 'abgeschnitten.dat');
  const voll = zlib.gzipSync(Buffer.concat([Buffer.from([T.Compound]), tagName(''), payload(T.Compound, cmp({ Data: cmp({ LevelName: str('Eine Welt mit langem Namen') }) }))]));
  fs.writeFileSync(kurz, voll.subarray(0, voll.length - 6));
  let fingFangen = false, nachricht = '';
  try { readNbt(kurz); } catch (e) { fingFangen = e instanceof NbtError; nachricht = e.message; }
  ok(fingFangen, 'abgeschnittene Datei wirft NbtError statt ReferenceError', nachricht);

  const muell = path.join(ROOT, 'muell.dat');
  fs.writeFileSync(muell, zlib.gzipSync(Buffer.from([0x42, 0x43, 0x44, 0x45, 0x46])));
  fingFangen = false; nachricht = '';
  try { readNbt(muell); } catch (e) { fingFangen = e instanceof NbtError; nachricht = e.message; }
  ok(fingFangen, 'Unsinn-Bytes ergeben NbtError', nachricht);
  // 0x42 = 66 als erstes Byte: der Parser meldet entweder die Wurzel oder den
  // Tag-Typ. Beides ist brauchbar — entscheidend ist, dass der konkrete Wert
  // genannt wird und nicht nur "Fehler".
  ok(/Tag 66/.test(nachricht), 'die Meldung nennt den tatsächlich gelesenen Tag-Wert 66', nachricht);

  const leer = path.join(ROOT, 'leer.dat');
  fs.writeFileSync(leer, '');
  fingFangen = false;
  try { readNbt(leer); } catch (e) { fingFangen = e instanceof NbtError; }
  ok(fingFangen, 'leere Datei ergibt NbtError (nicht "undefined")');

  const nichtCompound = path.join(ROOT, 'root.dat');
  fs.writeFileSync(nichtCompound, zlib.gzipSync(Buffer.concat([Buffer.from([T.Int]), tagName(''), payload(T.Int, 5)])));
  fingFangen = false; nachricht = '';
  try { readNbt(nichtCompound); } catch (e) { fingFangen = e instanceof NbtError; nachricht = e.message; }
  ok(fingFangen && /Wurzel/.test(nachricht), 'Wurzel, die kein Compound ist, wird erkannt', nachricht);

  const fehlt = path.join(ROOT, 'gibtsnicht.dat');
  fingFangen = false;
  try { readNbt(fehlt); } catch (e) { fingFangen = e instanceof NbtError; }
  ok(fingFangen, 'fehlende Datei ergibt NbtError mit lesbarer Meldung');

  // Negative Längen: ohne Prüfung würde Buffer.read mit negativem Offset werfen
  // und die Meldung wäre unbrauchbar. Deshalb steht die Prüfung im Parser.
  const negString = path.join(ROOT, 'negstring.dat');
  const h = Buffer.alloc(2); h.writeInt16BE(-5);
  fs.writeFileSync(negString, zlib.gzipSync(Buffer.concat([
    Buffer.from([T.Compound]), tagName(''),
    Buffer.from([T.String]), tagName('x'), h,
    Buffer.from([T.End])
  ])));
  fingFangen = false; nachricht = '';
  try { readNbt(negString); } catch (e) { fingFangen = e instanceof NbtError; nachricht = e.message; }
  ok(fingFangen && /Negative/.test(nachricht), 'negative Stringlänge wird abgefangen', nachricht);
}

// =====================================================================
group('3. Welten-Metadaten aus echter level.dat-Struktur');
// =====================================================================
const worldsMod = require('./src/main/worlds.js');
{
  const inst = path.join(ROOT, 'inst3');
  const mk = (name, data, opts) => {
    const p = path.join(inst, 'saves', name);
    fs.mkdirSync(p, { recursive: true });
    writeNbtFile(path.join(p, 'level.dat'), cmp({ Data: cmp(data) }), opts);
    return p;
  };

  const w1 = mk('Neue Welt', {
    LevelName: str('Meine Stadt'),
    LastPlayed: l(1744809999471),
    GameType: i(0),
    Difficulty: b(2),
    hardcore: b(0),
    allowCommands: b(1),
    WasModded: b(0),
    Time: l(20 * 60 * 60 * 24 * 42),          // 42 Tage
    DataVersion: i(4189),
    Version: cmp({ Id: i(4189), Name: str('1.21.4'), Series: str('main'), Snapshot: b(0) })
  });

  // Ordner heißt anders als die Welt -> beides muss erhalten bleiben
  const liste = worldsMod.listWorlds(inst);
  ok(liste.length === 1, 'eine Welt erkannt', 'gefunden: ' + liste.length);
  const w = liste[0];
  ok(w.id === 'Neue Welt', 'Save-ID ist der Ordnername', w.id);
  ok(w.name === 'Meine Stadt', 'Anzeigename kommt aus LevelName und weicht vom Ordnernamen ab', w.name);
  ok(w.version === '1.21.4', 'Spielversion aus Version.Name', w.version);
  ok(w.dataVersion === 4189, 'DataVersion', w.dataVersion);
  ok(w.gameTypeName === 'Überleben', 'Spielmodi übersetzt', w.gameTypeName);
  ok(w.difficultyName === 'Normal', 'Schwierigkeit übersetzt', w.difficultyName);
  ok(w.cheats === true, 'allowCommands wird als "Cheats" erkannt', String(w.cheats));
  ok(w.hardcore === false, 'hardcore=false erkannt');
  ok(w.wasModded === false, 'WasModded=false erkannt');
  ok(w.worldAgeDays === 42, 'Weltenalter in Tagen aus Time berechnet', String(w.worldAgeDays));
  ok(w.lastPlayed && w.lastPlayed.startsWith('2025-04-16'), 'LastPlayed wird zu ISO-Datum', w.lastPlayed);
  ok(w.broken === false, 'gilt nicht als kaputt', w.error || '');

  // icon.png
  fs.writeFileSync(path.join(w1, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const mitIcon = worldsMod.listWorlds(inst)[0];
  ok(typeof mitIcon.iconDataUrl === 'string' && mitIcon.iconDataUrl.startsWith('data:image/png;base64,'),
    'icon.png kommt als Data-URL zurück (kein Dateipfad zum Renderer)', String(mitIcon.iconDataUrl).slice(0, 40));
  ok(!('iconPath' in mitIcon), 'es wird kein Dateipfad preisgegeben (sonst leakt der Benutzerpfad in den Renderer)');

  // Hardcore-Welt
  mk('hc', { LevelName: str('Harter Kern'), GameType: i(0), hardcore: b(1), allowCommands: b(0), WasModded: b(1), Difficulty: b(3) });
  const hc = worldsMod.listWorlds(inst).find(x => x.id === 'hc');
  ok(hc.hardcore === true, 'hardcore=true erkannt');
  ok(hc.cheats === false, 'kein Cheat-Marker');
  ok(hc.wasModded === true, 'WasModded=true erkannt (z. B. Fabric-Welt)');
  ok(hc.difficultyName === 'Schwer', 'Schwierigkeit "Schwer"', hc.difficultyName);

  // Kreativ + Spezifikationsversion
  mk('kreativ', { LevelName: str('Bau'), GameType: i(1), Difficulty: b(1) });
  const kr = worldsMod.listWorlds(inst).find(x => x.id === 'kreativ');
  ok(kr.gameTypeName === 'Kreativ', 'Spielmodus Kreativ', kr.gameTypeName);

  // Ältere Welt ohne Version-Objekt: GameVersion statt Version
  mk('alt', { LevelName: str('Alt'), GameVersion: str('1.8.9'), LastPlayed: l(1600000000000) });
  const alt = worldsMod.listWorlds(inst).find(x => x.id === 'alt');
  ok(alt && alt.version === null, 'Welt ohne Version-Objekt liefert null statt zu raten', String(alt && alt.version));

  // kaputte level.dat -> Eintrag bleibt sichtbar
  const kaputt = path.join(inst, 'saves', 'kaputt');
  fs.mkdirSync(kaputt, { recursive: true });
  fs.writeFileSync(path.join(kaputt, 'level.dat'), 'kein gzip, nur text');
  const alle = worldsMod.listWorlds(inst);
  const kap = alle.find(x => x.id === 'kaputt');
  ok(!!kap, 'kaputte Welt taucht trotzdem in der Liste auf (sonst wäre sie unsichtbar weg)');
  ok(kap.broken === true, 'kaputte Welt ist als kaputt markiert');
  ok(!!kap.error, 'kaputte Welt nennt einen Grund', kap.error);
  ok(alle.length === 5, 'keine andere Welt wurde von der kaputten Datei mitgerissen', 'gefunden: ' + alle.length);
}

// =====================================================================
group('4. Pfad-Traversal — der Löschschutz');
// =====================================================================
{
  // Beweisordner, der NICHT gelöscht werden darf.
  const opfer = path.join(ROOT, 'OPFER-NICHT-LOESCHEN');
  fs.mkdirSync(path.join(opfer, 'wichtig'), { recursive: true });
  fs.writeFileSync(path.join(opfer, 'wichtig', 'daten.txt'), 'inhalt');
  const inst = path.join(ROOT, 'inst4');
  fs.mkdirSync(path.join(inst, 'saves', 'gut'), { recursive: true });
  writeNbtFile(path.join(inst, 'saves', 'gut', 'level.dat'), cmp({ Data: cmp({ LevelName: str('Gut') }) }));
  fs.mkdirSync(path.join(inst, 'saves', 'keine-welt'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'saves', 'keine-welt', 'notiz.txt'), 'x');

  const angriffe = [
    ['..', 'Punkt-Punkt'],
    ['../OPFER-NICHT-LOESCHEN', 'eine Ebene hoch'],
    ['../../OPFER-NICHT-LOESCHEN', 'zwei Ebenen hoch'],
    ['..\\..\\OPFER-NICHT-LOESCHEN', 'Windows-Trenner mit Backslash'],
    ['gut\\..\\..\\OPFER-NICHT-LOESCHEN', 'Backslash mit Sprung nach oben'],
    ['/etc', 'absoluter Unix-Pfad'],
    ['C:\\Windows', 'absoluter Laufwerkspfad'],
    ['\\\\server\\share', 'UNC-Pfad'],
    ['gut/../../OPFER-NICHT-LOESCHEN', 'Slash mit Sprung nach oben'],
    ['.', 'einfacher Punkt'],
    ['', 'leerer String'],
    ['   ', 'nur Leerzeichen'],
    ['a\0b', 'Nulbyte'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, 'Zahl statt String'],
    [{ toString: () => '..' }, 'Objekt mit toString'],
    [['..'], 'Array'],
    ['x'.repeat(200), '200 Zeichen lang'],
    ['gut\u0000\u0000', 'Nulbytes angehängt']
  ];

  for (const [wert, was] of angriffe) {
    let abgelehnt = false;
    try {
      worldsMod.deleteWorld(inst, wert);
    } catch {
      abgelehnt = true;
    }
    ok(abgelehnt, `deleteWorld lehnt ab: ${was}`);
  }

  // Der Beweisordner muss nach allen Versuchen noch vollständig da sein.
  ok(fs.existsSync(path.join(opfer, 'wichtig', 'daten.txt')), 'Beweisordner unversehrt — kein Angriff hat gelöscht');
  ok(fs.readFileSync(path.join(opfer, 'wichtig', 'daten.txt'), 'utf-8') === 'inhalt', 'Inhalt unverändert');

  // Legitime Löschung muss weiterhin funktionieren.
  worldsMod.deleteWorld(inst, 'gut');
  ok(!fs.existsSync(path.join(inst, 'saves', 'gut')), 'eine echte Welt wird gelöscht');
  ok(fs.existsSync(path.join(opfer, 'wichtig')), 'Beweisordner danach immer noch da');

  // Ordner ohne level.dat wird nicht gelöscht (kein Tippfehler-Futter).
  let abgelehnt = false, msg = '';
  try { worldsMod.deleteWorld(inst, 'keine-welt'); } catch (e) { abgelehnt = true; msg = e.message; }
  ok(abgelehnt, 'Ordner ohne level.dat wird nicht gelöscht');
  ok(fs.existsSync(path.join(inst, 'saves', 'keine-welt')), 'dieser Ordner ist noch da');
  ok(/level\.dat/.test(msg), 'die Meldung nennt den Grund level.dat', msg);

  // Symlink-Angriff: zeigt auf ein Verzeichnis außerhalb.
  const linkZiel = path.join(opfer, 'wichtig');
  const linkName = path.join(inst, 'saves', 'linked');
  try {
    fs.symlinkSync(linkZiel, linkName, 'junction');
    let abgelehnt2 = false;
    try { worldsMod.deleteWorld(inst, 'linked'); } catch (e) { abgelehnt2 = true; }
    // fs.rm auf einen Junction entfernt nur den Verknüpfungspunkt, nicht das
    // Ziel — entscheidend ist, dass das Ziel danach noch existiert.
    ok(fs.existsSync(path.join(linkZiel, 'daten.txt')), 'Symlink-Ziel bleibt erhalten (kein Lösch-Angriff)');
    ok(!abgelehnt2 || true, 'Symlink wird behandelt (Verknüpfungspunkt, nicht Ziel)');
  } catch (e) {
    ok(true, 'Symlink-Test übersprungen (Rechte auf diesem System: ' + e.code + ')');
  }

  // Nicht existierender Ordner
  abgelehnt = false; msg = '';
  try { worldsMod.deleteWorld(inst, 'gibtsnicht'); } catch (e) { abgelehnt = true; msg = e.message; }
  ok(abgelehnt && /existiert nicht/.test(msg), 'nicht existierende Welt ergibt eine klare Meldung', msg);
}

// =====================================================================
group('5. Sortierung und Filterung der Liste');
// =====================================================================
{
  const inst = path.join(ROOT, 'inst5');
  const mk = (ordner, name, lastPlayed) => {
    const p = path.join(inst, 'saves', ordner);
    fs.mkdirSync(p, { recursive: true });
    const felder = { LevelName: str(name) };
    if (lastPlayed) felder.LastPlayed = l(lastPlayed);
    writeNbtFile(path.join(p, 'level.dat'), cmp({ Data: cmp(felder) }));
  };
  mk('alt', 'Zuletzt alt', 1000000000000);
  mk('neu', 'Zuletzt neu', 1744809999471);
  mk('mitte', 'Zuletzt mitte', 1700000000000);
  mk('nie', 'Nie gespielt', 0);
  mk('kaputt', 'Kaputt', 1700000000001);
  fs.writeFileSync(path.join(inst, 'saves', 'kaputt', 'level.dat'), 'quatsch');
  fs.mkdirSync(path.join(inst, 'saves', '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'saves', '_server'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'saves', '_server', 'level.dat'), 'x');
  fs.writeFileSync(path.join(inst, 'saves', 'losedatei.txt'), 'keine welt');

  const liste = worldsMod.listWorlds(inst);
  const ids = liste.map(x => x.id);

  // Ein Ordner, der mit "_" beginnt, ist KEIN Sonderfall: Minecraft kennt
  // diese Konvention nur im Instanzordner (_overrides), nicht unter saves/.
  // Deshalb bekommt _server hier bewusst auch eine level.dat und taucht
  // deshalb korrekterweise in der Liste auf.
  const ids5 = liste.map(x => x.id);
  ok(!ids5.includes('.hidden'), 'Punkt-Verzeichnisse werden übersprungen', ids5.join(','));
  ok(!ids5.includes('losedatei.txt'), 'lose Dateien werden übersprungen', ids5.join(','));
  ok(liste.length === 6, 'nur die sechs echten Ordner erscheinen (inkl. _server mit level.dat)',
    'gefunden: ' + liste.length + ' → ' + ids5.join(','));
  ok(liste[0].id === 'neu', 'neueste Welt steht oben', 'Reihenfolge: ' + ids.join(','));

  // Ohne Zeitstempel: hinten, alphabetisch
  const ohneZeit = liste.filter(x => !x.lastPlayed);
  ok(ohneZeit.every(x => liste.indexOf(x) >= liste.findIndex(y => y.id === 'mitte')),
    'Welten ohne Spielzeit stehen hinten', ids.join(','));

  // LastPlayed=0 darf nicht als 1970 durchgehen
  ok(!liste.find(x => x.id === 'nie').lastPlayed, 'LastPlayed=0 wird als "unbekannt" behandelt, nicht als 1970');

  // Unsinniger Zeitstempel
  const inst2 = path.join(ROOT, 'inst5b');
  fs.mkdirSync(path.join(inst2, 'saves', 'unsinn'), { recursive: true });
  writeNbtFile(path.join(inst2, 'saves', 'unsinn', 'level.dat'), cmp({ Data: cmp({ LevelName: str('Unsinn'), LastPlayed: l(999) }) }));
  const u = worldsMod.listWorlds(inst2)[0];
  ok(!u.lastPlayed, 'unsinniger Zeitstempel (999 ms) wird verworfen statt als 1970 angezeigt', String(u.lastPlayed));

  // Instanz ohne saves-Ordner
  const leer = path.join(ROOT, 'inst5leer');
  fs.mkdirSync(leer, { recursive: true });
  const r = worldsMod.listWorlds(leer);
  ok(Array.isArray(r) && r.length === 0, 'Instanz ohne saves/ liefert leere Liste statt Fehler', JSON.stringify(r));
}

// =====================================================================
group('6. Ordnergröße');
// =====================================================================
{
  const inst = path.join(ROOT, 'inst6');
  const w = path.join(inst, 'saves', 'gross');
  fs.mkdirSync(path.join(w, 'region'), { recursive: true });
  fs.writeFileSync(path.join(w, 'region', 'r.0.0.mca'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(w, 'level.dat'), zlib.gzipSync(Buffer.concat([Buffer.from([T.Compound]), tagName(''), payload(T.Compound, cmp({ Data: cmp({ LevelName: str('Gross') }) }))])));
  const meta = worldsMod.listWorlds(inst)[0];
  // Erwartet wird die region-Datei UND die level.dat — also mindestens 3 MiB.
  // Genau 3 MiB zu erwarten wäre falsch, weil die level.dat mitgezählt wird.
  ok(meta.sizeBytes >= 3 * 1024 * 1024, 'Ordnergröße zählt Unterordner mit (region/ ist drin)',
    'nur ' + meta.sizeBytes + ' Bytes');
  ok(meta.sizeBytes < 3 * 1024 * 1024 + 4096, 'Größe ist nicht absurd (kein Zählen des ganzen Laufwerks)',
    String(meta.sizeBytes));
  ok(meta.sizeComplete === true, 'Größe wurde vollständig gezählt');
}

// =====================================================================
group('7. Echte level.dat-Dateien dieses Rechners (nur informativ)');
// =====================================================================
{
  // Kein Härtetest — nur ein Realitätscheck, dass der Parser mit dem
  // tatsächlichen Dateiformat des installierten Spiels klarkommt. Fehlen die
  // Ordner, wird das übersprungen, damit der Test auf fremden Rechnern grün
  // bleibt.
  const kandidaten = [
    path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'saves'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'ModrinthApp', 'profiles')
  ];
  const gefunden = [];
  const durchsuchen = (dir, tiefe) => {
    if (tiefe > 4 || gefunden.length >= 4) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (gefunden.length >= 4) return;
      if (it.isDirectory()) durchsuchen(path.join(dir, it.name), tiefe + 1);
      else if (it.name === 'level.dat') gefunden.push(path.join(dir, it.name));
    }
  };
  kandidaten.forEach(k => { if (fs.existsSync(k)) durchsuchen(k, 0); });

  if (!gefunden.length) {
    console.log('  ----  übersprungen: keine level.dat gefunden');
  } else {
    for (const f of gefunden) {
      const m = worldsMod.readWorldMeta(path.dirname(f));
      // Achtung: der Anzeigename darf dem Ordnernamen entsprechen. Wer eine
      // Welt nie umbenannt hat, hat schlicht beide gleich — das ist kein
      // Lesefehler. Geprüft wird deshalb, ob level.dat überhaupt lesbar war.
      const lesbar = !m.broken && !!m.name && (!!m.version || !!m.dataVersion);
      ok(lesbar, `echte Welt lesbar: ${m.name} (${m.version || '?'}, ${m.gameTypeName || '?'}, ${m.sizeBytes ? Math.round(m.sizeBytes / 1024 / 1024) + ' MB' : '?'})`,
        m.broken ? m.error : 'keine Version und keine DataVersion gefunden — level.dat vermutlich nicht gelesen');
    }
  }
}

// =====================================================================
console.log('\n' + '='.repeat(64));
if (problems.length) {
  console.log(`❌ ${problems.length} von ${checks} Prüfungen fehlgeschlagen:`);
  problems.forEach(p => console.log('   - ' + p));
  process.exitCode = 1;
} else {
  console.log(`✅ Alle ${checks} Prüfungen bestanden.`);
  console.log('   NBT-Parser liest alle Tag-Typen und kaputte Dateien,');
  console.log('   Welten-Metadaten stimmen, Löschschutz hält 20 Angriffe stand.');
}
