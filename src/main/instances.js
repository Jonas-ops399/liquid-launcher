/**
 * Modpacks (Instanzen) — Anlegen, Auflisten, Umbenennen, Loeschen, Duplizieren.
 *
 * Warum es diese Datei gibt:
 *
 * Bis hierher stand die Liste der Modpacks als fest verdrahtetes Array in
 * ipc-handlers.js. Das sieht nach Daten aus, ist aber eine Konstante im Code:
 * ein neues Modpack konnte nicht entstehen, ein ueberflüssiges nicht
 * verschwinden, und `lastPlayed` war `Date.now() - 2 * 3600e3` — ein Wert, der
 * sich jede Stunde neu berechnet und damit immer "vor 2 Stunden" behauptete,
 * egal ob jemals gespielt wurde.
 *
 * Wo die Angaben liegen:
 *
 * Pro Modpack ein `instance.json` IM Modpackordner, nicht eine gemeinsame
 * Liste in userData. Das entscheidet drei Dinge auf einmal:
 *
 *   1. Ordner loeschen = Modpack loeschen. Es kann kein Eintrag ohne Ordner
 *      und kein Ordner ohne Eintrag entstehen.
 *   2. Wer einen Ordner kopiert, bekommt das Modpack samt Angaben mit - so
 *      wie es bei `servers.json`, `mods-meta.json` und `instance-settings.json`
 *      in diesem Projekt schon ist.
 *   3. Die Liste ergibt sich aus dem, was auf der Platte liegt. Ein Eintrag,
 *      den man von Hand entfernt, ist weg; ein Ordner, den man von Hand
 *      anlegt, taucht auf.
 *
 * Diese Regel ersetzt das Schreiben in `list()` NICHT: aufraeumen ist
 * Handarbeit des Benutzers. `list()` legt nichts an — es liest nur.
 *
 * Bewusst KEIN require('electron') in diesem Modul, damit es unter reinem
 * Node laeuft (test-instances.js). Der userData-Pfad kommt von aussen.
 *
 * Schreibweise der Kommentare: ae/oe/ue — siehe die uebrigen Dateien in
 * src/main.
 */

const fs = require('node:fs');
const path = require('node:path');

// Unterordner, die ein Modpack braucht. `saves/` wird hier angelegt, damit
// der Launcher-Weltbrowser von Anfang an eine leere Liste bekommt und nicht
// mit einem Dateisystemfehler antwortet.
const UNTERORDNER = ['mods', 'saves', 'resourcepacks', 'config', 'logs', 'downloads'];

// Modloader, die der Startcode kennt. Alles andere wird abgelehnt, statt es
// zu speichern und beim Start an einem unbekannten Wert zu scheitern.
const MODLOADER = ['vanilla', 'fabric', 'forge'];

// Zeichen, die Windows nicht in einem Ordnernamen zulaesst, plus Steuerzeichen.
const VERBOTEN = /[<>:"/\\|?*\u0000-\u001f]/g;

// Namen, die Windows auch ohne Sonderzeichen reserviert: CON, PRN, AUX, NUL,
// COM1..COM9, LPT1..LPT9. Ein Ordner "CON" laesst sich nicht anlegen, und
// das ist ein Fehler mitten im Anlegen statt eine klare Meldung.
const RESERVIERT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_NAME = 60;

/**
 * Ordner-ID aus einem Anzeigenamen. Kein Zufall: derselbe Name ergibt
 * dieselbe ID, damit ein doppelter Klick nicht zwei Ordner erzeugt.
 */
function idAusName(name, vergeben) {
  let id = String(name == null ? '' : name)
    .replace(VERBOTEN, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w.\-äöüÄÖÜß]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .toLowerCase();

  if (!id || RESERVIERT.test(id)) id = 'modpack';
  if (id.length > 40) id = id.slice(0, 40).replace(/[.\-]+$/, '');

  // Kollision aufloesen, ohne den Namen mitzaehlen: "mein-pack", "mein-pack-2"
  if (!vergeben || !vergeben.has(id)) return id;
  let n = 2;
  while (vergeben.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

/**
 * Anzeigename pruefen. Wirft mit lesbarer Meldung, weil der Aufrufer im UI
 * direkt anzeigt.
 *
 * Hier wird bewusst NICHT auf die Windows-Sonderzeichen geprueft. Ein
 * Doppelpunkt im Anzeigenamen ist erlaubt und wird in vielen Launchern
 * benutzt; verboten sind diese Zeichen nur im ORDNERNAMEN, und den leitet
 * idAusName() ab. Beides gleich zu behandeln wuerde dem Benutzer Namen
 * verbieten, die er sehen darf - und der Ordnername ist etwas, das er nie
 * selbst eintippt.
 *
 * Abgelehnt werden nur Namen, die sich nicht darstellen lassen: leer, zu lang
 * oder mit Steuerzeichen (die wuerden Zeilen im Log und in der Oberflaeche
 * zerreissen).
 */
function namePruefen(name) {
  const n = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Der Name darf nicht leer sein.');
  if (n.length > MAX_NAME) throw new Error(`Der Name darf hoechstens ${MAX_NAME} Zeichen haben.`);
  if (/[\u0000-\u001f\u007f]/.test(n)) {
    throw new Error('Der Name enthaelt ein Steuerzeichen, das nicht dargestellt werden kann.');
  }
  return n;
}

function modloaderPruefen(loader) {
  const l = String(loader == null ? 'vanilla' : loader).toLowerCase();
  if (!MODLOADER.includes(l)) {
    throw new Error(`Unbekannter Modloader "${loader}". Erlaubt sind: ${MODLOADER.join(', ')}.`);
  }
  return l;
}

/**
 * Fabric-Loader-Version pruefen.
 *
 * Optional: fehlt sie (leer/null) und ist `optional` gesetzt, kommt null
 * zurueck - dann waehlt die Startkette die neueste stabile Version selbst.
 * Erlaubt sind z. B. "0.19.5", "0.16.9", "0.15.0+beta.1". Alles andere wird
 * abgelehnt, statt als Text in die Profil-URL zu wandern.
 */
function loaderVersionPruefen(version, optional = false) {
  const v = String(version == null ? '' : version).trim();
  if (!v) {
    if (optional) return null;
    throw new Error('Bitte eine Fabric-Loader-Version angeben.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(v)) {
    throw new Error(`"${v}" sieht nicht wie eine Fabric-Loader-Version aus (z. B. 0.19.5).`);
  }
  return v;
}

/**
 * Version pruefen. Kein Netzwerkruf hier — das Manifest gehoert dem Downloader.
 * Geprueft wird nur das Format, damit "abc" nicht als Version in die
 * Startkette wandert und dort eine kaputte Befehlszeile erzeugt.
 */
function versionPruefen(version) {
  const v = String(version == null ? '' : version).trim();
  if (!v) throw new Error('Bitte eine Minecraft-Version waehlen.');
  // Erlaubt sind "1.21.4", "1.20.1", "23w31a" (Snapshot) und "1.21.4-pre1".
  if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?(-[A-Za-z0-9]{1,12})?$/.test(v)) {
    throw new Error(`"${v}" sieht nicht wie eine Minecraft-Version aus (z. B. 1.21.4).`);
  }
  return v;
}

/**
 * Pfad der Metadaten. Bewusst `instance.json` und NICHT `instances.json`:
 * siehe Kopfkommentar.
 */
function metaPfad(instanceDir) {
  return path.join(instanceDir, 'instance.json');
}

/**
 * `lastPlayed` ehrlich ermitteln, statt es zu erfinden.
 *
 * Reihenfolge: der neueste `saves/<Welt>/level.dat`, dann der neueste Eintrag
 * in `saves/`, dann die neueste Datei in `logs/`. Allesamt Belege dafuer,
 * dass tatsaechlich gespielt wurde: eine Welt wurde gespeichert, ein Log
 * geschrieben.
 *
 * Der Aenderungszeitpunkt des Modpack-Ordners selbst ist KEIN Beleg und war
 * auch nie einer. Er ist die Zeit des letzten Schreibvorgangs ueberhaupt —
 * und ein Ordner, der gerade erst angelegt wurde, hat damit IMMER "jetzt".
 * Die Folge war, dass ein frisch angelegtes Modpack in der Liste "gerade
 * eben" stand, also so, als waere gerade gespielt worden. Genau die erfundene
 * Zeitangabe, die hier gerade abgebaut wird, nur eine Ebene tiefer.
 *
 * Der Ordner-Zeitstempel bleibt deshalb draussen. Wer nie gespielt hat,
 * bekommt null und sieht "noch nie gespielt". Der Preis: bei einem Altbestand,
 * in dem zwar gespielt wurde, aber weder Welt noch Log erhalten sind, steht
 * ebenfalls "noch nie gespielt". Das ist die richtige Richtung — lieber
 * einmal zu viel "unbekannt" als einmal zu viel "gerade eben".
 */
function lastPlayedAusOrdner(instanceDir) {
  let neuester = 0;
  const merke = (ms) => { if (ms > neuester) neuester = ms; };

  const saves = path.join(instanceDir, 'saves');
  try {
    for (const e of fs.readdirSync(saves, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const lvl = path.join(saves, e.name, 'level.dat');
      try {
        if (fs.existsSync(lvl)) merke(fs.statSync(lvl).mtimeMs);
        else merke(fs.statSync(path.join(saves, e.name)).mtimeMs);
      } catch { /* nicht lesbar: ueberspringen */ }
    }
  } catch { /* kein saves-Ordner */ }

  // Ein Spiel auf einem Server erzeugt keine Welt, aber sehr wohl ein Log.
  // Ohne diesen Zweig waere "nur auf Servern gespielt" nicht von "nie
  // gespielt" zu unterscheiden.
  const logs = path.join(instanceDir, 'logs');
  try {
    for (const e of fs.readdirSync(logs, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { merke(fs.statSync(path.join(logs, e.name)).mtimeMs); } catch { /* ueberspringen */ }
    }
  } catch { /* kein logs-Ordner */ }

  if (!neuester) return null;
  return new Date(neuester).toISOString();
}

/**
 * Modloader und Version aus einer vorhandenen `mods-meta.json` ableiten.
 *
 * Nur wenn ALLE Eintraege denselben Loader und dieselbe Spielversion nennen.
 * Ein gemischter Ordner sagt nichts Zuverlaessiges, und eine falsche Angabe
 * hier erzeugt beim Start eine Befehlszeile, die das Spiel ablehnt.
 */
function ausModsMeta(instanceDir) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(instanceDir, 'mods-meta.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;

  const eintraege = Object.values(meta).filter(
    (m) => m && typeof m === 'object' && typeof m.loader === 'string' && typeof m.gameVersion === 'string'
  );
  if (!eintraege.length) return null;

  const loader = eintraege[0].loader;
  const version = eintraege[0].gameVersion;
  if (!eintraege.every((m) => m.loader === loader && m.gameVersion === version)) return null;

  return MODLOADER.includes(String(loader).toLowerCase())
    ? { modloader: String(loader).toLowerCase(), version }
    : null;
}

/**
 * Einen Ordner zu einem Modpack-Eintrag lesen.
 *
 * Ohne `instance.json` (Altbestand aus der Zeit, als die Liste im Code stand)
 * wird der Ordner trotzdem erkannt — mit dem, was sich aus dem Inhalt
 * belegen laesst. Es wird dabei NICHTS geschrieben: das Lesen soll keinen
 * Ordner anlegen, sonst erzeugt ein blosser Blick in die Liste neue Ordner.
 */
function ausOrdnerLesen(instanceDir) {
  const id = path.basename(instanceDir);

  let raw = null;
  let vorhanden = false;
  try {
    raw = JSON.parse(fs.readFileSync(metaPfad(instanceDir), 'utf-8'));
    vorhanden = true;
  } catch { /* keine oder kaputte Datei: aus dem Inhalt ableiten */ }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const name = String(raw.name || id).trim().slice(0, MAX_NAME) || id;
    const modloader = MODLOADER.includes(String(raw.modloader).toLowerCase())
      ? String(raw.modloader).toLowerCase()
      : 'vanilla';
    const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
    return {
      id,
      name,
      version,
      modloader,
      // Optional: die gewaehlte Fabric-Loader-Version. Fehlt sie, waehlt die
      // Startkette beim naechsten Start die neueste stabile und traegt sie
      // hier ein. Vanilla und Forge brauchen sie nicht.
      loaderVersion: typeof raw.loaderVersion === 'string' && raw.loaderVersion.trim()
        ? raw.loaderVersion.trim()
        : null,
      // Ein gespeichertes lastPlayed wird geglaubt, wenn es plausibel ist —
      // aber ein Ordner mit Welt ist die bessere Quelle, weil jemand den Wert
      // auch von Hand setzen kann.
      lastPlayed: lastPlayedAusOrdner(instanceDir) || (typeof raw.lastPlayed === 'string' ? raw.lastPlayed : null),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : null,
      // Fehlt die Version, ist das Modpack nicht startklar: die Startkette
      // braucht sie fuer Classpath und Assets. Der Ordner bleibt sichtbar und
      // benennbar, aber die Oberflaeche muss zum Nachfragen auffordern.
      unvollstaendig: !version
    };
  }

  // Altbestand: aus dem Inhalt schliessen, was sich belegen laesst.
  const abgeleitet = ausModsMeta(instanceDir);
  return {
    id,
    name: id,
    version: abgeleitet ? abgeleitet.version : null,
    modloader: abgeleitet ? abgeleitet.modloader : 'vanilla',
    loaderVersion: null,
    lastPlayed: lastPlayedAusOrdner(instanceDir),
    createdAt: null,
    iconUrl: null,
    unvollstaendig: true
  };
}

/**
 * Ordner eines Modpacks anlegen.
 */
function ordnerAnlegen(instanceDir) {
  fs.mkdirSync(instanceDir, { recursive: true });
  for (const sub of UNTERORDNER) {
    const p = path.join(instanceDir, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

/**
 * Schreiben ohne halbe Datei.
 *
 * `writeFileSync` direkt auf die Zieldatei hinterlaesst bei einem Abbruch
 * mittendrin (Stromausfall, Fenster wird waehrend des Schreibens gekillt) eine
 * abgeschnittene JSON-Datei. Beim naechsten Start ist die Modpack-Liste dann
 * leer — und weil die Ordner noch da sind, waere nur schwer zu erkennen, dass
 * da etwas war. Deshalb: erst neben die Zieldatei schreiben, dann benennen.
 * `rename` ist auf demselben Laufwerk atomar.
 */
function schreiben(instanceDir, daten) {
  const ziel = metaPfad(instanceDir);
  const tmp = `${ziel}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(daten, null, 2), 'utf-8');
  fs.renameSync(tmp, ziel);
}

/**
 * Alle Modpacks aufzaehlen.
 *
 * Reihenfolge: zuletzt gespielt zuerst, dann nach Name. Genau so, wie der
 * Bildschirm es sortiert, damit die Anzeige nicht springt.
 *
 * Liest ausschliesslich. Legt weder Ordner noch Dateien an.
 */
function listen(userData) {
  const wurzel = path.join(userData, 'instances');
  let namen = [];
  try {
    namen = fs.readdirSync(wurzel, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // Noch kein instances-Ordner: das ist beim allerersten Start der
    // Normalfall und kein Fehler. Der wird beim Anlegen erzeugt.
    return [];
  }

  const liste = namen
    .map((name) => {
      const dir = path.join(wurzel, name);
      try {
        return ausOrdnerLesen(dir);
      } catch {
        // Ein Ordner, der sich nicht lesen laesst, darf die ganze Liste nicht
        // verschlucken. Er wird uebersprungen.
        return null;
      }
    })
    .filter(Boolean);

  liste.sort((a, b) => {
    const ta = a.lastPlayed ? Date.parse(a.lastPlayed) : 0;
    const tb = b.lastPlayed ? Date.parse(b.lastPlayed) : 0;
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name, 'de');
  });
  return liste;
}

function instanceDir(userData, id) {
  return path.join(userData, 'instances', id);
}

function holen(userData, id) {
  if (!id || typeof id !== 'string') throw new Error('Keine Instanz ausgewählt.');
  const dir = instanceDir(userData, id);
  if (!fs.existsSync(dir)) throw new Error(`Modpack „${id}" gibt es nicht.`);
  return dir;
}

/**
 * Neues Modpack anlegen.
 */
function anlegen(userData, angabe) {
  const name = namePruefen(angabe && angabe.name);
  const version = versionPruefen(angabe && angabe.version);
  const modloader = modloaderPruefen(angabe && angabe.modloader);
  // Nur Fabric kennt (bisher) eine waehlbare Loader-Version. Fehlt sie, wird
  // sie beim ersten Start ermittelt und nachgetragen.
  const loaderVersion = modloader === 'fabric'
    ? loaderVersionPruefen(angabe && angabe.loaderVersion, true)
    : null;

  const vergeben = new Set(listen(userData).map((i) => i.id));
  const id = idAusName(name, vergeben);
  const dir = instanceDir(userData, id);

  // Der Ordner wird erst angelegt, wenn die Eingaben geprueft sind. Sonst
  // bleibt bei einem Tippfehler ein leerer Ordner "mein-pack" zurueck, der
  // beim naechsten Anlegen die ID belegt.
  ordnerAnlegen(dir);

  const eintrag = {
    id,
    name,
    version,
    modloader,
    loaderVersion,
    iconUrl: null,
    createdAt: new Date().toISOString()
  };
  schreiben(dir, eintrag);
  return ausOrdnerLesen(dir);
}

/**
 * Umbenennen. Der Ordnername bleibt unangetastet — eine ID, die sich aendert,
 * wuerde den Instanzordner verschieben und damit Welten, Mods und
 * Startoptionen von einem anderen Pfad lesen.
 */
function umbenennen(userData, id, neuerName) {
  const dir = holen(userData, id);
  const name = namePruefen(neuerName);
  const alt = ausOrdnerLesen(dir);
  const neu = { ...alt, name };
  delete neu.unvollstaendig;
  schreiben(dir, neu);
  return ausOrdnerLesen(dir);
}

/**
 * Version/Modloader nachtragen. Getrennt von `umbenennen`, weil es eine andere
 * Frage ist und ein unvollstaendiger Altbestand genau hier aufgefuellt wird.
 */
function technikSetzen(userData, id, angabe) {
  const dir = holen(userData, id);
  const alt = ausOrdnerLesen(dir);
  const version = versionPruefen(angabe && angabe.version);
  const modloader = modloaderPruefen(angabe && angabe.modloader);
  // Version/Modloader neu gesetzt: eine alte Loader-Version passt moeglicher-
  // weise nicht mehr zur gewaehlten Minecraft-Version. Deshalb wird sie hier
  // verworfen und beim naechsten Start passend neu ermittelt.
  const loaderVersion = modloader === 'fabric'
    ? loaderVersionPruefen(angabe && angabe.loaderVersion, true)
    : null;
  const neu = { ...alt, version, modloader, loaderVersion };
  delete neu.unvollstaendig;
  schreiben(dir, neu);
  return ausOrdnerLesen(dir);
}

/**
 * Fabric-Loader-Version merken (nach der ersten Ermittlung).
 *
 * Getrennt von `technikSetzen`, weil hier NUR die Loader-Version gesetzt wird
 * und Version/Modloader unangetastet bleiben. Der Aufrufer (die Startkette)
 * hat die Version gerade von meta.fabricmc.net geholt und will sie fuer den
 * naechsten Start festhalten. Fehler duerfen den Start nicht verhindern.
 */
function loaderVersionSetzen(userData, id, version) {
  const dir = holen(userData, id);
  const alt = ausOrdnerLesen(dir);
  const loaderVersion = loaderVersionPruefen(version, true);
  const neu = { ...alt, loaderVersion };
  delete neu.unvollstaendig;
  schreiben(dir, neu);
  return ausOrdnerLesen(dir);
}

/**
 * Duplizieren: Kopie ohne `saves/` und ohne `logs/`.
 *
 * Beides ist Absicht. Der Grund fuer ein Duplikat ist ein Testlauf mit
 * anderen Mods; eine mitkopierte Welt wuerde mitwaechst und den Speicher
 * verdoppeln, ohne dass jemand sie im neuen Modpack findet. Mods,
 * Mod-Metadaten, Server und Startoptionen wandern mit — das ist der Teil, den
 * man beim Duplizieren behalten will.
 */
function duplizieren(userData, id, neuerName) {
  const quelle = holen(userData, id);
  const alt = ausOrdnerLesen(quelle);
  const name = namePruefen(neuerName || `${alt.name} (Kopie)`);

  const vergeben = new Set(listen(userData).map((i) => i.id));
  const neuId = idAusName(name, vergeben);
  const ziel = instanceDir(userData, neuId);

  const kopieren = ['mods', 'mods-meta.json', 'servers.json', 'instance-settings.json', 'options.txt'];
  ordnerAnlegen(ziel);
  for (const eintrag of kopieren) {
    const von = path.join(quelle, eintrag);
    if (!fs.existsSync(von)) continue;
    try {
      const zielPfad = path.join(ziel, eintrag);
      const stat = fs.statSync(von);
      if (stat.isDirectory()) {
        fs.cpSync(von, zielPfad, { recursive: true });
      } else {
        fs.copyFileSync(von, zielPfad);
      }
    } catch {
      // Eine einzelne nicht kopierbare Datei darf das Duplizieren nicht
      // abbrechen; das neue Modpack ist dann eben beim Punkt unvollstaendig.
    }
  }

  const neu = {
    id: neuId,
    name,
    version: alt.version,
    modloader: alt.modloader,
    loaderVersion: alt.loaderVersion || null,
    iconUrl: alt.iconUrl,
    createdAt: new Date().toISOString()
  };
  schreiben(ziel, neu);
  return ausOrdnerLesen(ziel);
}

/**
 * Modpack loeschen — Ordner inklusive Welt, Mods und Optionen.
 *
 * `erzwingen` ist der einzige Weg an der Pruefung im Hauptprozess vorbei
 * (laufendes Spiel). Ohne diesen Schalter waere es moeglich, den Ordner
 * waehrend eines laufenden Spiels zu loeschen — das Ergebnis waere ein
 * Minecraft, das mitten im Schreiben auf verschwundene Dateien trifft.
 */
function entfernen(userData, id) {
  const dir = holen(userData, id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { id };
}

/**
 * Nach einem Start festhalten, wann zuletzt gespielt wurde.
 *
 * Bewusst nach `list()` aufgerufen und nicht im Rennen mit dem Start: das
 * Schreiben darf den Start nicht verzoegern, und ein verpasstes
 * `lastPlayed` ist ein Schoenheitsfehler, kein Datenverlust.
 */
function gespieltVermerken(userData, id, zeitpunkt) {
  try {
    const dir = holen(userData, id);
    const alt = ausOrdnerLesen(dir);
    const neu = { ...alt, lastPlayed: zeitpunkt || new Date().toISOString() };
    delete neu.unvollstaendig;
    schreiben(dir, neu);
    return true;
  } catch {
    // Wenn es hier scheitert, darf der laufende Spielstart nicht abbrechen.
    return false;
  }
}

module.exports = {
  MODLOADER,
  UNTERORDNER,
  listen,
  anlegen,
  umbenennen,
  technikSetzen,
  loaderVersionSetzen,
  duplizieren,
  entfernen,
  gespieltVermerken,
  instanceDir,
  // Fuer die Tests und die Kontrollproben im Hauptprozess:
  idAusName,
  namePruefen,
  versionPruefen,
  modloaderPruefen,
  loaderVersionPruefen,
  lastPlayedAusOrdner,
  ausModsMeta,
  ausOrdnerLesen
};
