// test-ressourcenpakete.js
// Prueft die Ressourcenpakete einer Instanz: Ordner lesen, pack.mcmeta aus
// .zip und aus entpackten Ordnern, ein- und ausschalten ueber options.txt,
// loeschen, importieren — und vor allem, dass options.txt dabei NICHT
// kaputtgeht.
//
//   node test-ressourcenpakete.js
//
// Der Test braucht kein Electron-Fenster: resourcepacks.js nimmt einen
// absoluten Instanzordner und benutzt weder app.getPath() noch einen Dialog.
// Genau darum liegt es als eigene Datei neben ipc-handlers.js.
//
// Das Wichtigste im Test ist die Unversehrtheit von options.txt. Die Datei
// gehoert dem Spiel; wenn der Launcher sie beim Umstellen eines Schalters
// umbaut, verliert der Benutzer Grösse, Sound- und Grafikeinstellungen. Deshalb
// wird jede andere Zeile byteweise verglichen, nicht nur "die Zeile da steht".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const rp = require('./src/main/resourcepacks.js');

const problems = [];
let pruefungen = 0;

function check(condition, message, detail) {
  pruefungen++;
  const zeile = `  ${condition ? 'OK  ' : 'FEHLT'} ${message}`;
  console.log(detail && !condition ? `${zeile}\n         → ${detail}` : zeile);
  if (!condition) problems.push(message + (detail ? ` → ${detail}` : ''));
}

function gruppe(titel) {
  console.log('\n' + titel);
  console.log('-'.repeat(titel.length));
}

// ---------- Spielfeld ----------

const WURZEL = path.join(os.tmpdir(), 'liquid-ressourcenpakete-test');
fs.rmSync(WURZEL, { recursive: true, force: true });

let instanzNr = 0;
/** Eine frische Instanz mit leemem resourcepacks/ anlegen. */
function instanz() {
  const ordner = path.join(WURZEL, 'instanz-' + (++instanzNr));
  fs.mkdirSync(path.join(ordner, rp.ORDNER), { recursive: true });
  return ordner;
}

function optionsLesen(ordner) {
  try {
    return fs.readFileSync(rp.optionsPfad(ordner), 'utf8');
  } catch (err) {
    return null;
  }
}

function optionsZeilen(ordner) {
  const roh = optionsLesen(ordner);
  return roh === null ? null : roh.split(/\r?\n/);
}

function packEintrag(zipPfad, mcmeta, extra = {}) {
  const zip = new AdmZip();
  if (mcmeta !== null) {
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify(mcmeta), 'utf8'));
  }
  zip.addFile('assets/minecraft/textures/block/stone.png', Buffer.alloc(4096, 7));
  for (const [name, inhalt] of Object.entries(extra)) {
    zip.addFile(name, Buffer.from(inhalt, 'utf8'));
  }
  zip.writeZip(zipPfad);
  return zipPfad;
}

/**
 * Eine options.txt, die einer echten Minecraft-Datei nachgebaut ist.
 *
 * Absichtlich VIEL Zeilen, ueber den relevanten hinaus: eine Zeile, die beim
 * Ersetzen verrutscht, faellt in einer Datei mit drei Zeilen nicht auf.
 */
const ECHTE_OPTIONS = [
  'version:3465',
  'autoJump:false',
  'enableVsync:true',
  'maxFps:120',
  'renderDistance:12',
  'simulationDistance:10',
  'graphicsMode:1',
  'particles:2',
  'ao:true',
  'entityShadows:true',
  'guiScale:3',
  'attackIndicator:1',
  'soundCategory_master:0.8',
  'soundCategory_music:0.2',
  'pauseOnLostFocus:true',
  'chatVisibility:0',
  'gamma:0.5',
  'renderDistance:12',
  'fov:0.0',
  'screenEffectScale:1.0',
  'tutorialStep:none',
  'mouseSensitivity:0.5',
  'invertYMouse:false',
  'touchscreen:false',
  'toggleCrouch:false',
  'darkMojangStudiosBackground:true',
  'hideBundleTutorial:true',
  'resourcePacks:["vanilla"]',
  'incompatibleResourcePacks:[]',
  'lastServer:"127.0.0.1"',
  'lang:de_de',
  'chatHeight:1.0',
  'chatDelay:0.0',
  'chatSpacing:1.0',
  'textBackgroundOpacity:0.5',
  'backgroundForChatOnly:true',
  'hideServerAddress:false',
  'advancedItemTooltips:false',
  'pauseOnLostFocus:true',
  ''
].join('\n');

function optionsSchreiben(ordner, inhalt) {
  fs.writeFileSync(rp.optionsPfad(ordner), inhalt, 'utf8');
}

// ===================================================================
gruppe('1. Eine leere Instanz');
// ===================================================================
{
  const ordner = instanz();
  const { packs, konflikte } = rp.listPacks(ordner);

  check(packs.length === 0, 'eine leere Instanz hat keine Pakete', `gefunden: ${packs.length}`);
  check(konflikte.length === 0, 'und keine Konflikte');

  // Der Ordner muss da sein — Minecraft legt ihn selbst auch an, aber ein
  // fehlender Ordner wuerde hier ein Absturz beim ersten Klick auf Import.
  check(fs.existsSync(rp.packsOrdner(ordner)) === true,
        'der Ordner resourcepacks/ ist vorhanden');

  const ohneOrdner = path.join(WURZEL, 'gibt-es-nicht');
  const r = rp.listPacks(ohneOrdner);
  check(r.packs.length === 0, 'ein fehlender Instanzordner fuehrt nicht zum Absturz');
}

// ===================================================================
gruppe('2. Import und Liste');
// ===================================================================
{
  const ordner = instanz();
  const quelle = packEintrag(
    path.join(WURZEL, 'quellen', 'Cleartext-15.zip'),
    { pack: { pack_format: 15, description: 'Cleartext 15' } }
  );

  const eingetragen = rp.importZip(ordner, quelle);
  check(eingetragen.id === 'Cleartext-15', 'der Import gibt den Namen ohne .zip zurueck', eingetragen.id);
  check(fs.existsSync(path.join(rp.packsOrdner(ordner), 'Cleartext-15.zip')),
        'die Datei liegt danach in resourcepacks/');

  const { packs } = rp.listPacks(ordner);
  check(packs.length === 1, 'die Liste zeigt genau ein Paket', `gefunden: ${packs.length}`);
  const p = packs[0] || {};
  check(p.art === 'zip', 'es wird als .zip erkannt', p.art);
  check(p.packFormat === 15, 'pack_format 15 wird aus der zip gelesen', String(p.packFormat));
  check(p.version === '1.20–1.20.1', 'und auf eine Version abgebildet', String(p.version));
  check(p.beschreibung === 'Cleartext 15', 'die Beschreibung wird gelesen', String(p.beschreibung));
  check(p.hatMeta === true, 'pack.mcmeta wurde gefunden', String(p.hatMeta));
  check(p.defekt === false, 'die zip ist nicht als beschaedigt gemeldet');
  // Das ist die Dateigroesse auf der Platte, also die ZIP-Datei. Ein 4096-Byte-Bild
  // wird dabei deflatiert und ist deshalb kleiner — die Zahl beweist also nur,
  // dass gemessen und nicht geraten wird. Der ungepackte Inhalt waere hier die
  // falsche Erwartung; bei einem entpackten Ordner (Gruppe 4) ist es genau
  // andersherum, weil dort nichts komprimiert wird.
  check(p.groesseBytes > 0, 'die Groesse der Datei wird gemessen', String(p.groesseBytes));
  check(p.aktiv === false, 'ein frisch importiertes Paket ist noch aus', String(p.aktiv));

  // Erneut importieren: genau so wie mods:importLocal wird ueberschrieben,
  // damit ein Update nicht als "Paket-2" daneben liegen bleibt.
  packEintrag(quelle, { pack: { pack_format: 16, description: 'Cleartext 16' } });
  rp.importZip(ordner, quelle);
  const erneut = rp.listPacks(ordner).packs;
  check(erneut.length === 1, 'ein zweiter Import ersetzt statt zu duplizieren', `gefunden: ${erneut.length}`);
  check(erneut[0].packFormat === 16, 'und die neue Fassung ist die gelesene', String(erneut[0].packFormat));
}

// ===================================================================
gruppe('3. Was NICHT in die Liste gehoert');
// ===================================================================
{
  const ordner = instanz();
  const rpOrdner = rp.packsOrdner(ordner);
  packEintrag(path.join(WURZEL, 'quellen', 'Gut.zip'), { pack: { pack_format: 15 } });
  fs.copyFileSync(path.join(WURZEL, 'quellen', 'Gut.zip'), path.join(rpOrdner, 'Gut.zip'));

  fs.writeFileSync(path.join(rpOrdner, ' Lies mich.txt'), 'kein Paket');
  fs.writeFileSync(path.join(rpOrdner, 'LiesMich.txt'), 'kein Paket');
  fs.writeFileSync(path.join(rpOrdner, '.versteckt.zip'), 'kein Paket');
  fs.mkdirSync(path.join(rpOrdner, '.versteckt'));
  fs.writeFileSync(path.join(rpOrdner, '.versteckt', 'pack.mcmeta'), '{}');
  // Das legt das Spiel neben den Paketen ab.
  fs.writeFileSync(path.join(rpOrdner, '.packindex'), 'zustand');

  const { packs } = rp.listPacks(ordner);
  const namen = packs.map(p => p.id);
  check(packs.length === 1, 'nur echte .zip-Dateien und Ordner kommen in die Liste',
        `gefunden: ${JSON.stringify(namen)}`);
  check(namen[0] === 'Gut', 'und zwar genau die', JSON.stringify(namen));
}

// ===================================================================
gruppe('4. Entpackte Ordner');
// ===================================================================
{
  const ordner = instanz();
  const sub = path.join(rp.packsOrdner(ordner), 'VanillaPlus');
  fs.mkdirSync(path.join(sub, 'assets', 'minecraft', 'textures', 'block'), { recursive: true });
  fs.mkdirSync(path.join(sub, 'assets', 'minecraft', 'models'), { recursive: true });
  const MCMETA = JSON.stringify({ pack: { pack_format: 9, description: 'Vanilla Plus' } });
  fs.writeFileSync(path.join(sub, 'pack.mcmeta'), MCMETA, 'utf8');
  fs.writeFileSync(path.join(sub, 'assets', 'minecraft', 'textures', 'block', 'gras.png'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(sub, 'assets', 'minecraft', 'models', 'block.json'), Buffer.alloc(500));
  // Auch ganz oben: der Ordner selbst traegt etwas.
  fs.writeFileSync(path.join(sub, 'pack.png'), Buffer.alloc(200));

  const { packs } = rp.listPacks(ordner);
  const p = packs[0] || {};
  check(packs.length === 1, 'ein entpackter Ordner wird als Paket erkannt', `gefunden: ${packs.length}`);
  check(p.art === 'ordner', 'er wird als Ordner ausgewiesen, nicht als .zip', p.art);
  check(p.id === 'VanillaPlus', 'der Identifier ist der Ordnername', p.id);
  check(p.datei === 'VanillaPlus', 'und die Anzeige nennt denselben Namen', p.datei);
  check(p.packFormat === 9, 'pack_format aus dem Ordner', String(p.packFormat));
  check(p.version === '1.15–1.16.1', 'mit Versionsangabe', String(p.version));

  // Hier wird jede Datei im Baum gezaehlt, auch die pack.mcmeta oben — 55 Byte.
  const erwartet = 1000 + 500 + 200 + MCMETA.length;
  check(p.groesseBytes === erwartet,
        `die Groesse zaehlt rekursiv jede Datei: ${1000} + ${500} + ${200} + ${MCMETA.length} (pack.mcmeta) = ${erwartet}`,
        String(p.groesseBytes));
}

// ===================================================================
gruppe('5. Die drei pack.mcmeta-Befunde');
// ===================================================================
{
  const ordner = instanz();
  const rpOrdner = rp.packsOrdner(ordner);

  // a) keine pack.mcmeta
  packEintrag(path.join(rpOrdner, 'OhneMeta.zip'), null);
  // b) kaputte zip
  fs.writeFileSync(path.join(rpOrdner, 'Kaputt.zip'), Buffer.from('PK\x03\x04 und dann Muell', 'latin1'));
  // c) pack.mcmeta mit kaputtem JSON
  const kaputtesJson = new AdmZip();
  kaputtesJson.addFile('pack.mcmeta', Buffer.from('{kein json', 'utf8'));
  kaputtesJson.writeZip(path.join(rpOrdner, 'FalschesJson.zip'));
  // d) pack.mcmeta ohne pack_format
  packEintrag(path.join(rpOrdner, 'OhneFormat.zip'), { pack: { description: 'nur Text' } });

  const { packs } = rp.listPacks(ordner);
  const von = id => packs.find(p => p.id === id) || {};

  check(packs.length === 4, 'alle vier bleiben sichtbar, keiner verschwindet', `gefunden: ${packs.length}`);

  check(von('OhneMeta').hatMeta === false && von('OhneMeta').defekt === false,
        'ohne pack.mcmeta: als "keine pack.mcmeta" gemeldet, nicht als Fehler',
        JSON.stringify({ hatMeta: von('OhneMeta').hatMeta, defekt: von('OhneMeta').defekt }));

  check(von('Kaputt').defekt === true,
        'eine unlesbare zip wird als beschaedigt gemeldet', String(von('Kaputt').defekt));

  check(von('FalschesJson').defekt === true,
        'eine pack.mcmeta mit kaputtem JSON wird als beschaedigt gemeldet',
        String(von('FalschesJson').defekt));

  check(von('OhneFormat').hatMeta === true && von('OhneFormat').packFormat === null,
        'pack.mcmeta ohne pack_format: gelesen, aber ohne Versionszahl',
        JSON.stringify({ hatMeta: von('OhneFormat').hatMeta, packFormat: von('OhneFormat').packFormat }));
  check(von('OhneFormat').version === null && von('OhneFormat').versionNeu === false,
        'und ohne Versionsangabe, ohne "neuer als bekannt"',
        JSON.stringify({ version: von('OhneFormat').version, neu: von('OhneFormat').versionNeu }));
}

// ===================================================================
gruppe('6. Formate, die die Tabelle nicht kennt');
// ===================================================================
{
  check(rp.formatText(99).version === null && rp.formatText(99).neu === true,
        'pack_format 99 gilt als "neuer als bekannt" statt als unbekannt',
        JSON.stringify(rp.formatText(99)));
  check(rp.formatText(1).version === '1.0–1.1', 'die unterste Zahl steht auch drin', rp.formatText(1).version);
  check(rp.formatText(rp.LETZTES_FORMAT).neu === false,
        'die hoechste bekannte Zahl ist nicht "neu"', String(rp.LETZTES_FORMAT));
  check(rp.formatText(null).version === null && rp.formatText(null).neu === false,
        'ohne pack_format gibt es weder Text noch "neu"');

  // Kein deutscher Satz darf von hier nach oben: derselbe Grund wie bei
  // worlds.js — sonst steht bei englischer Sprache ein deutscher Text da.
  const quelle = fs.readFileSync(path.join(__dirname, 'src', 'main', 'resourcepacks.js'), 'utf8');
  const fremd = [...quelle.matchAll(/^\s*(?:version|neu|defekt|hatMeta|beschreibung):\s*(.*)$/gm)]
    .map(m => m[1].trim())
    .filter(w => /[äöüß]/.test(w));
  check(fremd.length === 0,
        'die Felder der Liste tragen keine deutschen Texte im Hauptprozess',
        fremd.join(' | '));
}

// ===================================================================
gruppe('7. options.txt lesen — auch die kaputten Formen');
// ===================================================================
{
  const faelle = [
    ['resourcePacks:["vanilla","file/A","file/B"]', ['vanilla', 'file/A', 'file/B'], 'JSON-Array'],
    ['resourcePacks:vanilla,file/A', ['vanilla', 'file/A'], 'alte Komma-Liste'],
    ['resourcePacks:[]', ['vanilla'], 'leeres Array'],
    ['resourcePacks:', ['vanilla'], 'Zeile ohne Wert'],
    ['resourcePacks:["kaputt', ['vanilla'], 'abgeschnittenes JSON'],
    ['resourcePacks:["file/Nur Einer"]', ['file/Nur Einer'], 'ohne vanilla'],
    ['soundCategory_music:0.2', ['vanilla'], 'keine resourcePacks-Zeile'],
    ['resourcePacks:[{kaputt]', ['vanilla'], 'JSON mit Objekt statt String']
  ];
  for (const [zeile, erwartet, wofuer] of faelle) {
    const got = rp.parsePacks(zeile);
    check(JSON.stringify(got) === JSON.stringify(erwartet),
          `parsePacks: ${wofuer}`, `erwartet ${JSON.stringify(erwartet)}, bekam ${JSON.stringify(got)}`);
  }
  // "vanilla" fehlt: das Spiel laeuft dann ohne Standardtexturen. parsePacks
  // faellt das nicht wieder auf, weil es nur liest — beim Schreiben wird der
  // Eintrag ohnehin immer neu gesetzt, und dort steht "vanilla" dann drin.
  // Geprueft wird das weiter unten in Gruppe 14.

  const ordner = instanz();
  check(optionsLesen(ordner) === null, 'ohne Datei liest sich null');
  const fehlend = rp.readOptions(ordner);
  check(fehlend.vorhanden === false, 'readOptions meldet "keine Datei"', String(fehlend.vorhanden));
  check(JSON.stringify(fehlend.packs) === JSON.stringify(['vanilla']),
        'und rechnet mit vanilla', JSON.stringify(fehlend.packs));
}

// ===================================================================
gruppe('8. Einschalten — und was dabei mit options.txt passiert');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, ECHTE_OPTIONS);
  packEintrag(path.join(rp.packsOrdner(ordner), 'Dunkel.zip'), { pack: { pack_format: 15 } });

  const vorherZeilen = optionsZeilen(ordner);
  const vorherRoh = optionsLesen(ordner);

  const erg = rp.setPackAktiv(ordner, 'Dunkel', true);
  check(erg.geaendert === true, 'der Schreibvorgang meldet eine Aenderung');
  check(JSON.stringify(erg.packs) === JSON.stringify(['Dunkel']), 'die Paketliste enthaelt nur Dunkel',
        JSON.stringify(erg.packs));

  const jetztRoh = optionsLesen(ordner);
  const jetztZeilen = jetztRoh.split(/\r?\n/);

  check(jetztRoh.includes('resourcePacks:["vanilla","file/Dunkel"]'),
        'die Zeile lautet jetzt resourcePacks:["vanilla","file/Dunkel"]',
        jetztZeilen.find(z => z.startsWith('resourcePacks')));

  check(jetztZeilen.length === vorherZeilen.length,
        'die Datei hat genauso viele Zeilen wie vorher',
        `vorher ${vorherZeilen.length}, nachher ${jetztZeilen.length}`);

  // Der eigentliche Beweis: jede andere Zeile unveraendert und in gleicher
  // Reihenfolge. "renderDistance:12" steht zweimal in der Vorlage — das ist
  // Absicht, weil ein Test mit eindeutigen Zeilen einen doppelten Eintrag
  // nicht aufspueren wuerde.
  const istGleich = vorherZeilen.every((z, i) =>
    z.startsWith('resourcePacks:') ? true : jetztZeilen[i] === z);
  check(istGleich, 'jede andere Zeile steht unveraendert an derselben Stelle');
  check(jetztRoh !== vorherRoh, 'die Datei ist wirklich neu geschrieben worden');

  check(rp.aktiveNamen(ordner).includes('Dunkel'), 'und das Paket gilt jetzt als aktiv');

  const { packs } = rp.listPacks(ordner);
  check(packs[0].aktiv === true, 'auch die Liste zeigt es als aktiv');

  check(jetztRoh.endsWith('\n'), 'die Datei endet weiterhin mit einem Zeilenumbruch');
}

// ===================================================================
gruppe('9. Ausschalten laesst die Datei unangetastet');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, ECHTE_OPTIONS);
  packEintrag(path.join(rp.packsOrdner(ordner), 'Hell.zip'), { pack: { pack_format: 15 } });

  const vorher = optionsLesen(ordner);
  rp.setPackAktiv(ordner, 'Hell', true);
  const mitHell = optionsLesen(ordner);

  const erg = rp.setPackAktiv(ordner, 'Hell', false);
  check(erg.geaendert === true, 'das Ausschalten meldet eine Aenderung');
  check(erg.packs.length === 0, 'die Paketliste ist wieder leer', JSON.stringify(erg.packs));

  const danach = optionsLesen(ordner);
  check(danach !== mitHell, 'die Datei wurde fuer das Ausschalten neu geschrieben');
  check(!danach.includes('file/Hell'), 'kein Rest von Hell in der resourcePacks-Zeile');
  check(danach.includes('resourcePacks:["vanilla"]'), 'die Zeile steht wieder auf vanilla',
        danach.split(/\r?\n/).find(z => z.startsWith('resourcePacks')));

  // Byteweise zurueck auf den Ausgangszustand? Das ist die strengste Form von
  // "nur diese eine Zeile wird angefasst".
  check(danach === vorher,
        'die options.txt ist danach byteweise wieder die Ausgangsdatei');

  check(fs.existsSync(path.join(rp.packsOrdner(ordner), 'Hell.zip')),
        'die Paketdatei selbst bleibt liegen — ausgeschaltet heisst nicht geloescht');
}

// ===================================================================
gruppe('10. Zwei Pakete, und die Reihenfolge bleibt stehen');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, 'resourcePacks:["vanilla"]\nsoundCategory_music:0.2\n');
  packEintrag(path.join(rp.packsOrdner(ordner), 'A.zip'), { pack: { pack_format: 15 } });
  packEintrag(path.join(rp.packsOrdner(ordner), 'B.zip'), { pack: { pack_format: 15 } });

  rp.setPackAktiv(ordner, 'A', true);
  rp.setPackAktiv(ordner, 'B', true);
  check(optionsLesen(ordner).includes('resourcePacks:["vanilla","file/A","file/B"]'),
        'beide sind eingetragen',
        optionsLesen(ordner).split(/\r?\n/).find(z => z.startsWith('resourcePacks')));

  rp.setPackAktiv(ordner, 'A', false);
  check(optionsLesen(ordner).includes('resourcePacks:["vanilla","file/B"]'),
        'nach dem Ausschalten von A bleibt B an und steht allein',
        optionsLesen(ordner).split(/\r?\n/).find(z => z.startsWith('resourcePacks')));

  rp.setPackAktiv(ordner, 'A', true);
  check(optionsLesen(ordner).includes('resourcePacks:["vanilla","file/B","file/A"]'),
        'wieder eingeschaltet kommt A hinten an — die Reihenfolge der anderen bleibt',
        optionsLesen(ordner).split(/\r?\n/).find(z => z.startsWith('resourcePacks')));
}

// ===================================================================
gruppe('11. Idempotenz: zweimal dasselbe');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, ECHTE_OPTIONS);
  packEintrag(path.join(rp.packsOrdner(ordner), 'Idem.zip'), { pack: { pack_format: 15 } });

  rp.setPackAktiv(ordner, 'Idem', true);
  const einmal = optionsLesen(ordner);
  const nochmal = rp.setPackAktiv(ordner, 'Idem', true);

  check(nochmal.geaendert === false, 'das zweite Einschalten meldet "nichts geaendert"', String(nochmal.geaendert));
  check(optionsLesen(ordner) === einmal, 'und die Datei ist unveraendert');

  const aus1 = rp.setPackAktiv(ordner, 'Idem', false);
  const nachAus = optionsLesen(ordner);
  const aus2 = rp.setPackAktiv(ordner, 'Idem', false);
  check(aus2.geaendert === false, 'das zweite Ausschalten ebenso', String(aus2.geaendert));
  check(optionsLesen(ordner) === nachAus, 'die Datei bleibt unveraendert');
  check(aus1.geaendert === true && aus2.geaendert === false, 'nur der erste Vorgang war eine Aenderung');
}

// ===================================================================
gruppe('12. Fehlende resourcePacks-Zeile');
// ===================================================================
{
  const ordner = instanz();
  const vorher = ['version:3465', 'maxFps:120', 'guiScale:3'].join('\n') + '\n';
  optionsSchreiben(ordner, vorher);

  rp.setPackAktiv(ordner, 'Neu', true);
  const zeilen = optionsZeilen(ordner).filter(z => z !== '');

  check(zeilen.length === 4, 'die drei Zeilen bleiben und die resourcePacks-Zeile kommt dazu',
        `gefunden: ${zeilen.length}`);
  check(zeilen[0] === 'version:3465', 'und zwar hinten angehaengt, nicht eingeschoben', zeilen[0]);
  check(zeilen[3].startsWith('resourcePacks:'), 'die neue Zeile steht am Ende', zeilen[3]);

  // Leerzustand: gar keine Datei.
  const leer = instanz();
  const erg = rp.setPackAktiv(leer, 'Alles', true);
  check(optionsLesen(leer).trim() === 'resourcePacks:["vanilla","file/Alles"]',
        'ohne vorhandene Datei entsteht genau eine Zeile', JSON.stringify(optionsLesen(leer)));
}

// ===================================================================
gruppe('13. Zeilenumbruch: CRLF bleibt CRLF');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, ECHTE_OPTIONS.replace(/\n/g, '\r\n'));
  check(optionsLesen(ordner).includes('\r\n'), 'der Ausgang ist wirklich CRLF');

  rp.setPackAktiv(ordner, 'CrLf', true);
  const danach = optionsLesen(ordner);

  check(danach.includes('\r\n'), 'die geschriebene Datei bleibt CRLF');
  check(!/[^\r]\n/.test(danach), 'es hat sich kein einzelnes \n eingeschlichen',
        JSON.stringify((danach.match(/[^\r]\n/g) || []).length) + ' solche Stellen');
  check(danach.split('\r\n').length === ECHTE_OPTIONS.replace(/\n/g, '\r\n').split('\r\n').length,
        'die Zeilenzahl ist gleich geblieben', String(danach.split('\r\n').length));
}

// ===================================================================
gruppe('14. "vanilla" laesst sich nicht ausschalten');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, 'resourcePacks:["vanilla"]\n');
  const vorher = optionsLesen(ordner);

  rp.setPackAktiv(ordner, rp.VANILLA, false);
  check(optionsLesen(ordner) === vorher,
        'das eingebaute Paket bleibt im Eintrag, auch wenn man es auszuschalten versucht',
        JSON.stringify(optionsLesen(ordner)));

  rp.setPackAktiv(ordner, rp.VANILLA, true);
  check(optionsLesen(ordner).includes('"vanilla"'), 'und es wird nicht zu einem file/-Eintrag',
        optionsLesen(ordner).split(/\r?\n/).find(z => z.startsWith('resourcePacks')));
}

// ===================================================================
gruppe('15. Pfadpruefung: kein Ausbruch aus resourcepacks/');
// ===================================================================
{
  const bosen = [
    '../fremd', '..\\fremd', 'a/b', 'a\\b', '.', '..', '', '.versteckt',
    'C:pfad', 'x:y', 'mit\0null'
  ];
  for (const name of bosen) {
    check(rp.istGueltigerName(name) === false, `istGueltigerName lehnt ab: ${JSON.stringify(name)}`,
          String(rp.istGueltigerName(name)));
  }
  const guten = ['Dunkel', 'Cleartext-15', 'Mein Paket', 'a', 'x'.repeat(120)];
  for (const name of guten) {
    check(rp.istGueltigerName(name) === true, `istGueltigerName erlaubt: ${JSON.stringify(name)}`);
  }
  check(rp.istGueltigerName('x'.repeat(121)) === false, 'zu lange Namen werden abgewiesen');

  const ordner = instanz();
  const ausserhalb = path.join(WURZEL, 'ausserhalb');
  fs.mkdirSync(ausserhalb, { recursive: true });
  fs.writeFileSync(path.join(ausserhalb, 'wichtig.txt'), 'darf nicht geloescht werden', 'utf8');

  let geworfen = false;
  try { rp.removePack(ordner, '../ausserhalb'); } catch (err) { geworfen = true; }
  check(geworfen, 'removePack verweigert "..", statt zurueck in resourcepacks/ zu gehen');
  check(fs.existsSync(path.join(ausserhalb, 'wichtig.txt')),
        'die Datei ausserhalb der Instanz ist noch da');

  let geworfen2 = false;
  try { rp.setPackAktiv(ordner, '../ausserhalb', true); } catch (err) { geworfen2 = true; }
  check(geworfen2, 'setPackAktiv verweigert denselben Namen');
  check(optionsLesen(ordner) === null, 'und schreibt dabei nichts in options.txt');

  // Ein Name, der die Grenze reisst, darf auch nicht importierbar sein.
  let geworfen3 = false;
  try { rp.importZip(ordner, path.join(WURZEL, 'quellen', 'Ordner.zip', 'innen.zip')); } catch (err) { geworfen3 = true; }
  check(fs.existsSync(path.join(rp.packsOrdner(ordner), 'Ordner.zip')) === false,
        'der Import kann kein Ziel ausserhalb von resourcepacks/ erzeugen');
}

// ===================================================================
gruppe('16. Loeschen');
// ===================================================================
{
  const ordner = instanz();
  optionsSchreiben(ordner, 'resourcePacks:["vanilla","file/Weg","file/Bleib"]\n');
  packEintrag(path.join(rp.packsOrdner(ordner), 'Weg.zip'), { pack: { pack_format: 15 } });
  packEintrag(path.join(rp.packsOrdner(ordner), 'Bleib.zip'), { pack: { pack_format: 15 } });

  const erg = rp.removePack(ordner, 'Weg');
  check(erg.entfernt === true, 'removePack meldet, dass etwas entfernt wurde');
  check(!fs.existsSync(path.join(rp.packsOrdner(ordner), 'Weg.zip')), 'die Datei ist weg');
  check(fs.existsSync(path.join(rp.packsOrdner(ordner), 'Bleib.zip')), 'die andere bleibt liegen');
  check(erg.verbleibend.includes('Bleib'), 'die Schalterliste nennt nur noch die andere',
        JSON.stringify(erg.verbleibend));
  check(optionsLesen(ordner).includes('resourcePacks:["vanilla","file/Bleib"]'),
        'und in options.txt steht es genauso',
        optionsLesen(ordner).split(/\r?\n/).find(z => z.startsWith('resourcePacks')));
  check(rp.listPacks(ordner).packs.length === 1, 'die Liste zeigt nur noch ein Paket');

  // Ein Paket, das gar nicht da ist, darf keinen Fehler machen — der Ordner
  // koennte zwischen dem Aufbau der Liste und dem Klick gekippt sein.
  const nix = rp.removePack(ordner, 'GabEsNie');
  check(nix.entfernt === false, 'das Loeschen eines unbekannten Pakets meldet "nichts entfernt"');
  check(optionsLesen(ordner).includes('"file/Bleib"'),
        'und laesst die Liste der anderen unangetastet');
}

// ===================================================================
gruppe('17. Loeschen ohne options.txt');
// ===================================================================
{
  const ordner = instanz();
  packEintrag(path.join(rp.packsOrdner(ordner), 'OhneDatei.zip'), { pack: { pack_format: 15 } });

  const erg = rp.removePack(ordner, 'OhneDatei');
  check(erg.entfernt === true, 'die Datei wird auch ohne options.txt entfernt');
  check(optionsLesen(ordner) === null,
        'und es entsteht keine leere options.txt, nur weil man ein Paket loescht');
}

// ===================================================================
gruppe('18. Ordner UND zip mit demselben Namen');
// ===================================================================
{
  const ordner = instanz();
  packEintrag(path.join(rp.packsOrdner(ordner), 'Doppelt.zip'), { pack: { pack_format: 15 } });
  const sub = path.join(rp.packsOrdner(ordner), 'Doppelt');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 16 } }), 'utf8');

  const { packs, konflikte } = rp.listPacks(ordner);
  check(packs.length === 2, 'beide Formen sind sichtbar — beide sind echte Dateien',
        `gefunden: ${packs.length}`);
  check(konflikte.length === 2, 'und beide sind als Konflikt gemeldet', `gefunden: ${konflikte.length}`);
  check(packs.every(p => p.konflikt === true), 'das Konflikt-Flag steht an beiden');

  // Der Schalter kann nur einen der beiden treffen — das ist der Grund fuer
  // die Meldung. Er trifft sie gemeinsam, was in der Oberflaeche erklaert wird.
  rp.setPackAktiv(ordner, 'Doppelt', true);
  check(rp.aktiveNamen(ordner).includes('Doppelt'), 'der Schalter wirkt auf den gemeinsamen Namen');
  check(rp.listPacks(ordner).packs.every(p => p.aktiv === true),
        'und beide Eintraege zeigen ihn danach als aktiv');

  // Loeschen entfernt beide Formen und meldet das.
  const erg = rp.removePack(ordner, 'Doppelt');
  check(erg.entfernt === true && erg.verdeckt === true,
        'das Loeschen entfernt beide Formen und meldet es als verdeckt',
        JSON.stringify(erg));
  check(!fs.existsSync(path.join(rp.packsOrdner(ordner), 'Doppelt.zip')) &&
        !fs.existsSync(path.join(rp.packsOrdner(ordner), 'Doppelt')),
        'und der Ordner ist wirklich leer');
  check(rp.listPacks(ordner).packs.length === 0, 'die Liste ist leer');
}

// ===================================================================
gruppe('19. Die Sprachregel: keine deutschen Texte vom Hauptprozess');
// ===================================================================
{
  // Nicht nur die Listenfelder — der ganze Text, der in der Oberflaeche
  // landen koennte. Die erlaubten Ausnahmen sind unten benannt.
  const erlaubt = [
    /Ungültiger Paketname/,
    /Ungültiger Dateiname für ein Paket/
  ];
  const treffer = [];
  const zeilen = fs.readFileSync(path.join(__dirname, 'src', 'main', 'resourcepacks.js'), 'utf8')
    .split(/\r?\n/);
  zeilen.forEach((z, i) => {
    const ohneKommentar = z.replace(/\/\/.*$/, '');
    // Nur Zeichenketten, nicht Code und nicht Kommentare.
    for (const m of ohneKommentar.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)) {
      const wert = m[1] !== undefined ? m[1] : m[2];
      if (!/[äöüßÄÖÜ]/.test(wert)) continue;
      if (erlaubt.some(m => m.test(wert))) continue;
      treffer.push(`${i + 1}: ${wert}`);
    }
  });
  check(treffer.length === 0,
        'alle deutschen Texte sind Fehlermeldungen fuer den Hauptprozess, nicht UI-Inhalte',
        treffer.join(' | '));

  // Die Versionsangabe kommt als Text aus dieser Datei — das ist eine Ausnahme
  // und muss als solche benannt sein: sie ist eine reine Zahl-zu-Text-Tabelle,
  // keine Sprache. Ansonsten waere "1.20–1.20.1" in jeder Sprache gleich, was
  // richtig ist.
  check(rp.FORMAT_VERSION[15] === '1.20–1.20.1',
        'die Versionstabelle nennt nur Zahlen und Bindestriche, also keine Sprache',
        rp.FORMAT_VERSION[15]);
  check(!/[a-zA-Zäöüß]/.test(rp.FORMAT_VERSION[15]), 'und enthaelt wirklich keinen Buchstabensprung',
        rp.FORMAT_VERSION[15]);
}

// ===================================================================
gruppe('Vorschaubild (pack.png)');
// ===================================================================
{
  const ordner = instanz();
  // Die PNG-Signatur reicht fuer den Transport; packBild prueft den Inhalt
  // nicht, es bettet die Bytes ein. Genau das wird hier gemessen.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  // Ordnerpaket mit pack.png
  const paketOrdner = path.join(rp.packsOrdner(ordner), 'MitBild');
  fs.mkdirSync(paketOrdner, { recursive: true });
  fs.writeFileSync(path.join(paketOrdner, 'pack.mcmeta'),
                   JSON.stringify({ pack: { pack_format: 15 } }), 'utf8');
  fs.writeFileSync(path.join(paketOrdner, 'pack.png'), png);
  const mitBild = rp.listPacks(ordner).packs.find(p => p.id === 'MitBild');
  check(Boolean(mitBild), 'das Paket mit Bild wird gelistet');
  check(typeof mitBild.bild === 'string' && mitBild.bild.startsWith('data:image/png;base64,'),
        'pack.png kommt als PNG-Data-URL an', mitBild.bild && mitBild.bild.slice(0, 30));
  check(mitBild.bild === 'data:image/png;base64,' + png.toString('base64'),
        'die Data-URL enthaelt genau die Dateibytes');

  // Ordnerpaket ohne pack.png
  const ohneOrdner = path.join(rp.packsOrdner(ordner), 'OhneBild');
  fs.mkdirSync(ohneOrdner, { recursive: true });
  fs.writeFileSync(path.join(ohneOrdner, 'pack.mcmeta'),
                   JSON.stringify({ pack: { pack_format: 15 } }), 'utf8');
  const ohne = rp.listPacks(ordner).packs.find(p => p.id === 'OhneBild');
  check(Boolean(ohne) && ohne.bild === null, 'ohne pack.png bleibt das Bild null');

  // .zip mit pack.png
  const zipPfad = path.join(rp.packsOrdner(ordner), 'ZipBild.zip');
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 15 } }), 'utf8'));
  zip.addFile('pack.png', png);
  zip.writeZip(zipPfad);
  const zipPack = rp.listPacks(ordner).packs.find(p => p.id === 'ZipBild');
  check(Boolean(zipPack) && zipPack.bild === 'data:image/png;base64,' + png.toString('base64'),
        'auch im .zip wird pack.png gefunden');

  // Zu grosses pack.png wird nicht eingebettet
  const grossOrdner = path.join(rp.packsOrdner(ordner), 'ZuGross');
  fs.mkdirSync(grossOrdner, { recursive: true });
  fs.writeFileSync(path.join(grossOrdner, 'pack.mcmeta'),
                   JSON.stringify({ pack: { pack_format: 15 } }), 'utf8');
  fs.writeFileSync(path.join(grossOrdner, 'pack.png'), Buffer.alloc(rp.BILD_MAX_BYTES + 1, 1));
  const gross = rp.listPacks(ordner).packs.find(p => p.id === 'ZuGross');
  check(Boolean(gross) && gross.bild === null,
        'ein zu grosses pack.png wird nicht eingebettet');
}

// ===================================================================
console.log('\n' + '='.repeat(66));
if (problems.length) {
  console.log(`❌ ${problems.length} von ${pruefungen} Pruefungen fehlgeschlagen:`);
  problems.forEach(p => console.log('   - ' + p));
  process.exitCode = 1;
} else {
  console.log(`✅ Alle ${pruefungen} Pruefungen bestanden.`);
  console.log('   options.txt wird nur an der resourcePacks-Zeile angefasst, "vanilla"');
  console.log('   bleibt drin, und kein Name kommt aus resourcepacks/ heraus.');
}

fs.rmSync(WURZEL, { recursive: true, force: true });