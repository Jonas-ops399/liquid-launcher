// test-instances.js
// Testet den Modpack-Speicher (src/main/instances.js) unter reinem Node.
// Kein Electron noetig: das Modul nimmt den userData-Pfad als Argument.
//
// Aufruf:  node test-instances.js
//
// Regel fuer diesen Test: Jede Pruefung prueft eine echte Wirkung auf der
// Platte, nicht nur, dass eine Funktion existiert. Wo "vermutlich" steht,
// steht danach der Grund, warum die Erwartung so lautet und nicht schaerfer.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inst = require('./src/main/instances.js');

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

const WURZEL = fs.mkdtempSync(path.join(os.tmpdir(), 'll-instances-'));
const USERDATA = path.join(WURZEL, 'userData');
// WICHTIG: der instances-Ordner wird hier absichtlich NICHT angelegt. Genau
// dieser Zustand liegt beim allerersten Start vor, und list() darf dabei
// nichts erzeugen. Anlegen() legt ihn mit an (mkdirSync mit recursive).
const INSTANCES = path.join(USERDATA, 'instances');

console.log('Modpack-Speicher');
console.log('Temp-Ordner:', WURZEL);
console.log('');

// ---------------------------------------------------------------- leerer Anfang
console.log('[1] Zustand ohne instances-Ordner');
// Beim allerersten Start gibt es den Ordner noch gar nicht. list() darf dann
// eine leere Liste liefern, aber KEINEN Ordner anlegen - ein blosser Blick in
// die Liste darf auf der Platte nichts erzeugen.
gleich('list() liefert leer', inst.listen(USERDATA).length, 0);
pruefe('list() legt keinen instances-Ordner an', !fs.existsSync(INSTANCES));

// ------------------------------------------------------------------ anlegen
console.log('');
console.log('[2] Anlegen');
const a = inst.anlegen(USERDATA, { name: 'Mein Pack', version: '1.21.4', modloader: 'fabric' });
gleich('ID aus dem Namen', a.id, 'mein-pack');
gleich('Name unveraendert', a.name, 'Mein Pack');
gleich('Version gespeichert', a.version, '1.21.4');
gleich('Modloader gespeichert', a.modloader, 'fabric');
pruefe('instance.json liegt im Ordner', fs.existsSync(path.join(INSTANCES, 'mein-pack', 'instance.json')));
for (const sub of inst.UNTERORDNER) {
  pruefe(`Unterordner ${sub} angelegt`, fs.existsSync(path.join(INSTANCES, 'mein-pack', sub)));
}
gleich('Liste hat einen Eintrag', inst.listen(USERDATA).length, 1);

const b = inst.anlegen(USERDATA, { name: 'Mein Pack', version: '1.20.1', modloader: 'vanilla' });
gleich('gleicher Name -> andere ID', b.id, 'mein-pack-2');
gleich('zwei Eintraege', inst.listen(USERDATA).length, 2);

const c = inst.anlegen(USERDATA, { name: 'Kursiv: Ärger/egal?', version: '1.21.4', modloader: 'vanilla' });
pruefe('verbotene Zeichen landen nicht im Ordnernamen', !/[<>:"/\\|?*]/.test(c.id), `ID war "${c.id}"`);
pruefe('ID ist verwendbarer Ordnername', fs.existsSync(path.join(INSTANCES, c.id)));

// ---------------------------------------------------------------- Eingaben
console.log('');
console.log('[3] Eingabepruefung');
wirft('leerer Name wird abgelehnt', () => inst.anlegen(USERDATA, { name: '   ', version: '1.21.4' }));
wirft('fehlende Version wird abgelehnt', () => inst.anlegen(USERDATA, { name: 'X', version: '' }));
wirft('Unsinns-Version wird abgelehnt', () => inst.anlegen(USERDATA, { name: 'Y', version: 'abc' }));
wirft('unbekannter Modloader wird abgelehnt', () => inst.anlegen(USERDATA, { name: 'Z', version: '1.21.4', modloader: 'quilt' }));
const langErr = wirft('zu langer Name wird abgelehnt', () => inst.anlegen(USERDATA, { name: 'x'.repeat(200), version: '1.21.4' }));
pruefe('Laengenmeldung nennt das Limit', langErr && /60/.test(langErr.message), langErr && langErr.message);
wirft('Steuerzeichen im Namen werden abgelehnt', () => inst.anlegen(USERDATA, { name: 'a\u0007b', version: '1.21.4' }));
gleich('abgelehnte Eingaben haben nichts angelegt', inst.listen(USERDATA).length, 3);

// Sonderzeichen im ANZEIGENamen sind erlaubt - verboten sind sie nur im
// Ordnernamen, und den leitet idAusName() ab. "CON" ist als Anzeigename
// normal, als Ordnername kann Windows es nicht anlegen.
const con = inst.anlegen(USERDATA, { name: 'CON', version: '1.21.4' });
gleich('reservierter Name bleibt als Anzeigename', con.name, 'CON');
gleich('...wird aber kein Ordnername', con.id, 'modpack');
const mitSonderzeichen = inst.anlegen(USERDATA, { name: 'Abenteuer: Pixel & Pixel', version: '1.21.4' });
gleich('Sonderzeichen bleiben im Anzeigenamen', mitSonderzeichen.name, 'Abenteuer: Pixel & Pixel');
pruefe('Sonderzeichen verschwinden aus dem Ordnernamen',
  !/[<>:"/\\|?*&]/.test(mitSonderzeichen.id), `ID war "${mitSonderzeichen.id}"`);

// ------------------------------------------------------------------ lesen
console.log('');
console.log('[4] Lesen und Sortieren');
const alle = inst.listen(USERDATA);
pruefe('kein Pfad im Renderer-Ergebnis', alle.every((i) => i.ordner === undefined),
  'ordner waere ein %APPDATA%-Pfad im UI');

inst.gespieltVermerken(USERDATA, 'mein-pack-2', '2026-09-01T10:00:00.000Z');
inst.gespieltVermerken(USERDATA, 'mein-pack', '2026-09-20T10:00:00.000Z');
const sortiert = inst.listen(USERDATA);
gleich('zuletzt gespielt kommt zuerst', sortiert[0].id, 'mein-pack');

// lastPlayed muss aus einem BELEG kommen, nicht aus dem Anlegen. Ein frisch
// angelegtes Modpack hat einen Aenderungszeitpunkt von jetzt — und stand
// damit in der Liste als "gerade eben gespielt", ohne dass je gespielt
// wurde. Dieselbe erfundene Zeit, die vorher fest im Code stand, nur eine
// Ebene tieber.
const nieGespielt = inst.anlegen(USERDATA, { name: 'Frisch', version: '1.21.4', modloader: 'fabric' });
gleich('ein frisch angelegtes Modpack hat kein lastPlayed', nieGespielt.lastPlayed, null);
const logOrdner = path.join(INSTANCES, 'frisch', 'logs');
fs.mkdirSync(logOrdner, { recursive: true });
fs.writeFileSync(path.join(logOrdner, 'latest.log'), 'x');
pruefe('nach einem Log ist lastPlayed belegt (nur auf Servern gespielt)',
  !!inst.listen(USERDATA).find((i) => i.id === 'frisch').lastPlayed);
fs.rmSync(logOrdner, { recursive: true, force: true });
gleich('ohne jeden Beleg wieder "nie gespielt"',
  inst.listen(USERDATA).find((i) => i.id === 'frisch').lastPlayed, null);

// ------------------------------------------------------------- umbenennen
console.log('');
console.log('[5] Umbenennen und Technik nachtragen');
const umbenannt = inst.umbenennen(USERDATA, 'mein-pack', 'Mein Pack 2');
gleich('neuer Name', umbenannt.name, 'Mein Pack 2');
gleich('Ordner bleibt unangetastet', umbenannt.id, 'mein-pack');
pruefe('Weltbezug haengt am Ordner, nicht am Namen',
  fs.existsSync(path.join(INSTANCES, 'mein-pack', 'saves')));
const technik = inst.technikSetzen(USERDATA, 'mein-pack-2', { version: '1.20.1', modloader: 'forge' });
gleich('Modloader nachgetragen', technik.modloader, 'forge');
wirhtKeinFehler('Name bleibt beim Technik-Setzen erhalten', technik.name, 'Mein Pack');

// ------------------------------------------------------------------ kopieren
console.log('');
console.log('[6] Duplizieren');
// Dem Original erst eine Welt und einen Mod geben, damit sich zeigen laesst,
// was kopiert wird und was nicht.
fs.writeFileSync(path.join(INSTANCES, 'mein-pack', 'mods', 'beispiel.jar'), 'x');
fs.writeFileSync(path.join(INSTANCES, 'mein-pack', 'mods-meta.json'), '{}');
fs.mkdirSync(path.join(INSTANCES, 'mein-pack', 'saves', 'Alte Welt'), { recursive: true });
fs.writeFileSync(path.join(INSTANCES, 'mein-pack', 'saves', 'Alte Welt', 'level.dat'), 'x');

const kopie = inst.duplizieren(USERDATA, 'mein-pack', 'Mein Pack Kopie');
gleich('Kopie hat eigene ID', kopie.id, 'mein-pack-kopie');
gleich('Kopie hat eigene ID bei Namenskollision', inst.duplizieren(USERDATA, 'mein-pack', 'Mein Pack Kopie').id, 'mein-pack-kopie-2');
pruefe('Mod wandert mit', fs.existsSync(path.join(INSTANCES, 'mein-pack-kopie', 'mods', 'beispiel.jar')));
pruefe('Mod-Metadaten wandern mit', fs.existsSync(path.join(INSTANCES, 'mein-pack-kopie', 'mods-meta.json')));
// Saves bewusst NICHT kopiert: eine mitkopierte Welt wuerde mitwachsen, ohne
// dass sie jemand im neuen Modpack findet. Genau das wird hier festgehalten.
pruefe('Welt wird NICHT kopiert', !fs.existsSync(path.join(INSTANCES, 'mein-pack-kopie', 'saves', 'Alte Welt')));
pruefe('Originalwelt unberuehrt', fs.existsSync(path.join(INSTANCES, 'mein-pack', 'saves', 'Alte Welt', 'level.dat')));
pruefe('leerer saves-Ordner existiert in der Kopie', fs.existsSync(path.join(INSTANCES, 'mein-pack-kopie', 'saves')));
gleich('Kopie erbt Version', kopie.version, '1.21.4');

// ------------------------------------------------------------------ loeschen
console.log('');
console.log('[7] Loeschen');
const vorher = inst.listen(USERDATA).length;
inst.entfernen(USERDATA, 'mein-pack-kopie-2');
gleich('ein Eintrag weniger', inst.listen(USERDATA).length, vorher - 1);
pruefe('Ordner ist wirklich weg', !fs.existsSync(path.join(INSTANCES, 'mein-pack-kopie-2')));
// Loeschen zweimal: der zweite Versuch muss mit lesbarer Meldung scheitern
// statt den Prozess zu beenden.
const nochmal = wirft('zweites Loeschen meldet "gibt es nicht"',
  () => inst.entfernen(USERDATA, 'mein-pack-kopie-2'));
pruefe('Meldung nennt den Namen', nochmal && /gibt es nicht/.test(nochmal.message), nochmal && nochmal.message);
wirft('leere ID wird abgelehnt', () => inst.entfernen(USERDATA, ''));

// ------------------------------------------------------- Altbestand uebernommen
console.log('');
console.log('[8] Altbestand: Ordner ohne instance.json');
// Genau die Lage nach dem Umstieg: talberg liegt auf der Platte, mit Welt und
// mods-meta.json, aber ohne instance.json. list() muss ihn finden, ohne
// irgendetwas zu schreiben.
const altDir = path.join(INSTANCES, 'talberg');
fs.mkdirSync(path.join(altDir, 'saves', 'New World'), { recursive: true });
const lvl = path.join(altDir, 'saves', 'New World', 'level.dat');
fs.writeFileSync(lvl, 'x');
fs.writeFileSync(path.join(altDir, 'mods-meta.json'), JSON.stringify({
  iris: { id: 'iris', name: 'Iris', source: 'modrinth', filename: 'iris.jar', loader: 'fabric', gameVersion: '1.21.4' },
  sodium: { id: 'sodium', name: 'Sodium', source: 'modrinth', filename: 'sodium.jar', loader: 'fabric', gameVersion: '1.21.4' }
}));
fs.writeFileSync(path.join(altDir, 'servers.json'), '[]');
fs.writeFileSync(path.join(altDir, 'options.txt'), 'fov:0.0\n');

const vorScan = fs.readdirSync(INSTANCES).sort().join(',');
const mitAlt = inst.listen(USERDATA);
const talberg = mitAlt.find((i) => i.id === 'talberg');
pruefe('Altbestand taucht in der Liste auf', !!talberg, 'Liste: ' + mitAlt.map((i) => i.id).join(', '));
gleich('Modloader aus mods-meta.json abgeleitet', talberg && talberg.modloader, 'fabric');
gleich('Version aus mods-meta.json abgeleitet', talberg && talberg.version, '1.21.4');
pruefe('als unvollstaendig markiert', talberg && talberg.unvollstaendig === true);
pruefe('lastPlayed aus der Welt ermittelt', talberg && !!talberg.lastPlayed, String(talberg && talberg.lastPlayed));
pruefe('list() hat beim Scannen NICHTS geschrieben',
  fs.readdirSync(INSTANCES).sort().join(',') === vorScan, 'Ordner vorher: ' + vorScan);
pruefe('keine instance.json im Altbestand erzeugt', !fs.existsSync(path.join(altDir, 'instance.json')));

// Gemischter mods-meta.json sagt nichts Zuverlaessiges -> keine Ableitung.
const gemischt = path.join(INSTANCES, 'gemischt');
fs.mkdirSync(gemischt, { recursive: true });
fs.writeFileSync(path.join(gemischt, 'mods-meta.json'), JSON.stringify({
  a: { loader: 'fabric', gameVersion: '1.21.4' },
  b: { loader: 'forge', gameVersion: '1.20.1' }
}));
const gemischtEintrag = inst.listen(USERDATA).find((i) => i.id === 'gemischt');
gleich('gemischte Angaben ergeben keine Ableitung', gemischtEintrag && gemischtEintrag.version, null);
gleich('...und werden nicht geraten', gemischtEintrag && gemischtEintrag.modloader, 'vanilla');

// ------------------------------------------------------------------ kaputt
console.log('');
console.log('[9] Kaputte Dateien');
// instance.json mit Muell: der Ordner muss trotzdem auftauchen, nicht verschwinden.
const kaputt = path.join(INSTANCES, 'kaputt');
fs.mkdirSync(kaputt, { recursive: true });
fs.writeFileSync(path.join(kaputt, 'instance.json'), '{ kein json');
const kaputtEintrag = inst.listen(USERDATA).find((i) => i.id === 'kaputt');
pruefe('Ordner mit kaputter instance.json bleibt sichtbar', !!kaputtEintrag);
pruefe('...und gilt als unvollstaendig', kaputtEintrag && kaputtEintrag.unvollstaendig === true);

// instance.json, die ein Array ist, ist genauso Mist.
const alsArray = path.join(INSTANCES, 'alsarray');
fs.mkdirSync(alsArray, { recursive: true });
fs.writeFileSync(path.join(alsArray, 'instance.json'), '[]');
const arrEintrag = inst.listen(USERDATA).find((i) => i.id === 'alsarray');
pruefe('Array statt Objekt wird nicht geglaubt', arrEintrag && arrEintrag.unvollstaendig === true);

// ------------------------------------------------------------------ schreiben
console.log('');
console.log('[10] Schreiben ohne halbe Datei');
const ziel = path.join(INSTANCES, 'mein-pack', 'instance.json');
const vorherBytes = fs.readFileSync(ziel);
inst.umbenennen(USERDATA, 'mein-pack', 'Mein Pack 3');
const nachherBytes = fs.readFileSync(ziel);
pruefe('Datei wurde wirklich neu geschrieben', !vorherBytes.equals(nachherBytes));
pruefe('keine .tmp-Reste liegen daneben',
  !fs.existsSync(`${ziel}.tmp`), 'Leftover: ' + fs.readdirSync(INSTANCES).filter((f) => f.endsWith('.tmp')).join(','));
const gelesen = JSON.parse(fs.readFileSync(ziel, 'utf-8'));
gleich('geschriebenes JSON ist lesbar', gelesen.name, 'Mein Pack 3');

// ------------------------------------------------------- Fabric-Loader-Version
console.log('');
console.log('[11] Fabric-Loader-Version merken');

// Ohne Angabe ist erlaubt - die Startkette ermittelt sie beim ersten Start.
const fabPack = inst.anlegen(USERDATA, { name: 'Fabric Pack', version: '1.21.11', modloader: 'fabric' });
gleich('neue Fabric-Instanz ohne Loader-Version', fabPack.loaderVersion, null);
pruefe('instance.json wurde angelegt', fs.existsSync(path.join(INSTANCES, fabPack.id, 'instance.json')));

// Nachtragen - genau das macht die Startkette nach dem Ermitteln.
const gesetzt = inst.loaderVersionSetzen(USERDATA, fabPack.id, '0.19.5');
gleich('Loader-Version nachgetragen', gesetzt.loaderVersion, '0.19.5');
gleich('auch in list() sichtbar',
  inst.listen(USERDATA).find((i) => i.id === fabPack.id).loaderVersion, '0.19.5');
const roh = JSON.parse(fs.readFileSync(path.join(INSTANCES, fabPack.id, 'instance.json'), 'utf-8'));
gleich('und wirklich in der Datei', roh.loaderVersion, '0.19.5');

// Beim Anlegen direkt mitgeben.
const direkt = inst.anlegen(USERDATA, {
  name: 'Fabric Direkt', version: '1.20.1', modloader: 'fabric', loaderVersion: '0.15.0'
});
gleich('beim Anlegen mitgegebene Version', direkt.loaderVersion, '0.15.0');

// Unsinnige Version wird abgelehnt - und nichts angelegt.
const vorherAnzahl = inst.listen(USERDATA).length;
const fehler = wirft('unsinnige Loader-Version abgelehnt', () =>
  inst.anlegen(USERDATA, {
    name: 'Boese', version: '1.20.1', modloader: 'fabric', loaderVersion: '../etc/passwd'
  }));
pruefe('Fehlermeldung nennt das Problem', fehler && /Fabric-Loader-Version/.test(fehler.message));
gleich('abgelehnt: kein Eintrag entstanden', inst.listen(USERDATA).length, vorherAnzahl);

// Vanilla kennt keine Loader-Version - auch wenn eine mitkommt.
const vanillaPack = inst.anlegen(USERDATA, {
  name: 'Vanilla Pack', version: '1.20.1', modloader: 'vanilla', loaderVersion: '0.19.5'
});
gleich('Vanilla ignoriert die Loader-Version', vanillaPack.loaderVersion, null);

// Version/Modloader neu gesetzt -> alte Loader-Version passt evtl. nicht mehr.
const nachTechnik = inst.technikSetzen(USERDATA, fabPack.id, { version: '1.21.4', modloader: 'fabric' });
gleich('MC-Versionswechsel verwirft die Loader-Version', nachTechnik.loaderVersion, null);

// Duplizieren nimmt die Loader-Version mit.
inst.loaderVersionSetzen(USERDATA, fabPack.id, '0.18.0');
const fabKopie = inst.duplizieren(USERDATA, fabPack.id, 'Fabric Kopie');
gleich('Duplikat erbt die Loader-Version', fabKopie.loaderVersion, '0.18.0');

// Die Prueffunktion selbst.
gleich('gueltig: 0.19.5', inst.loaderVersionPruefen('0.19.5'), '0.19.5');
gleich('gueltig: 0.20.0-beta.1', inst.loaderVersionPruefen('0.20.0-beta.1'), '0.20.0-beta.1');
gleich('leer + optional ergibt null', inst.loaderVersionPruefen('', true), null);
wirft('leer ohne optional wirft', () => inst.loaderVersionPruefen(''));
wirft('Pfad-Zeichen abgelehnt', () => inst.loaderVersionPruefen('../../x'));

// ------------------------------------------------------------------ aufräumen
fs.rmSync(WURZEL, { recursive: true, force: true });

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

// Hilfsfunktion fuer den Textvergleich, der nicht exakt gleich sein muss.
function wirhtKeinFehler(bezeichnung, ist, soll) {
  gleich(bezeichnung, ist, soll);
}
