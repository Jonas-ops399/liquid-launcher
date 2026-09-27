// src/main/worlds.js
// Auflisten und Verwalten der Spielstände einer Instanz.
//
// Aufbau: <instanz>/saves/<Ordnername>/level.dat
// Der Ordnername ist die "Save-ID" und NICHT der Anzeigename: eine Welt kann im
// Spiel "Neue Welt" heißen und auf der Platte "Neue Welt (3)". Für Quick Play
// wird die Save-ID gebraucht, angezeigt wird der Anzeigename — genau deshalb
// gibt es hier beides zurück.

const fs = require('node:fs');
const path = require('node:path');
const { readNbt } = require('./nbt');

// Spielmodi und Schwierigkeit stehen als Zahlen im level.dat. Die Namen hier
// sind die deutschen Bezeichnungen aus dem Spiel.
const GAME_TYPES = ['Überleben', 'Kreativ', 'Abenteuer', 'Zuschauer'];
const DIFFICULTIES = ['Friedlich', 'Einfach', 'Normal', 'Schwer'];

/**
 * Prüft, dass ein Name ein einzelner Pfadabschnitt ist.
 *
 * Das ist die wichtigste Funktion in dieser Datei. `worlds:delete` löscht per
 * `fs.rm(recursive)`. Ohne diese Prüfung könnte der Renderer den Wert
 * `..\..\..` schicken und damit beliebige Verzeichnisse löschen — inklusive
 * des Benutzerprofils. Renderer-Inhalte gelten als nicht vertrauenswürdig, also
 * wird hier jeder Name geprüft, egal woher er kommt.
 *
 * @throws {Error} wenn der Name als Pfad missbraucht werden könnte
 */
function assertSafeName(name, label = 'Name') {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} fehlt.`);
  }
  if (name.length > 120) {
    throw new Error(`${label} ist zu lang (max. 120 Zeichen).`);
  }
  // Backslash, Slash und NUL verbieten. Windows hätte zudem reservierte
  // Zeichen, aber die greifen nur bei Erstellung neuer Ordner — beim Löschen
  // sind sie nur ein Angriffspfad, kein Problem.
  if (/[/\\\0]/.test(name)) {
    throw new Error(`${label} darf keine Pfadtrenner enthalten.`);
  }
  // "." und ".." sind die heimtückischen Fälle: sie enthalten keinen Trenner,
  // zeigen aber trotzdem auf ein übergeordnetes Verzeichnis.
  if (name === '.' || name === '..') {
    throw new Error(`${label} darf nicht "." oder ".." sein.`);
  }
  // Nulbyte und Steuerzeichen fallen unter "kein gültiger Ordnername".
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) {
    throw new Error(`${label} enthält Zeichen, die Windows nicht erlaubt.`);
  }
  return name;
}

/**
 * Zusätzliche Absicherung: auch nach dem Zusammenfügen muss das Ergebnis
 * noch im saves-Ordner liegen. assertSafeName allein reicht nicht — falls sich
 * die Prüfung oben je än sollte, bleibt diese zweite Schranke stehen.
 */
function resolveInside(baseDir, name) {
  assertSafeName(name, 'Welt-Ordner');
  const base = path.resolve(baseDir);
  const full = path.resolve(path.join(base, name));
  if (full !== path.join(base, name) || !full.startsWith(base + path.sep)) {
    throw new Error('Welt-Ordner liegt nicht im Instanzordner — abgebrochen.');
  }
  return full;
}

function savesDir(instanceDir) {
  return path.join(instanceDir, 'saves');
}

/**
 * Ordnergröße in Bytes, mit Obergrenze.
 *
 * Große Welten haben zehntausende Dateien (region/, entities/, poi/). Ein
 * vollständiger Durchlauf kann dann Sekunden dauern und die UI blockieren.
 * Deshalb bricht die Zählung ab und meldet zurück, dass sie unvollständig war
 * — eine zu kleine Anzeige ist besser als ein eingefrorenes Fenster.
 */
function folderSize(dir, maxEntries = 20000) {
  let bytes = 0;
  let entries = 0;
  let complete = true;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try {
      items = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // z.B. gesperrte Datei — zählen, was wir haben
    }
    for (const item of items) {
      if (entries >= maxEntries) {
        complete = false;
        break;
      }
      entries++;
      const p = path.join(cur, item.name);
      try {
        if (item.isDirectory()) stack.push(p);
        else if (item.isSymbolicLink()) continue; // Link nicht verfolgen
        else bytes += fs.statSync(p).size;
      } catch { /* Datei weg — ignorieren */ }
    }
    if (!complete) break;
  }
  return { bytes, entries, complete };
}

/**
 * Wandelt die Spielfortschrittszeit in lesbare Angaben.
 * Data.Time ist die Anzahl der Ticks seit Weltenbeginn (20 pro Sekunde).
 */
function worldAgeDays(data) {
  const ticks = Number(data.Time);
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  return Math.floor(ticks / 20 / 60 / 60 / 24);
}

/**
 * Liest die Metadaten eines Weltordners.
 * Wirft NICHT bei kaputten Dateien: ein beschädigtes level.dat darf die
 * ganze Liste nicht umwerfen, der Ordner existiert ja trotzdem und ist für den
 * Benutzer sichtbar.
 */
function readWorldMeta(worldPath) {
  const folderName = path.basename(worldPath);
  const result = {
    id: folderName,               // Save-ID = Ordnername, für Quick Play
    name: folderName,             // Anzeigename, wird unten ggf. überschrieben
    broken: false,
    error: null,
    // Data-URL des Vorschaubilds, null wenn es keins gibt. Bewusst KEIN
    // Dateipfad — siehe readWorldMeta().
    iconDataUrl: null,
    iconBytes: null,
    iconSkipped: null,
    version: null,
    dataVersion: null,
    lastPlayed: null,
    gameType: null,
    gameTypeName: null,
    difficulty: null,
    difficultyName: null,
    hardcore: false,
    cheats: false,
    wasModded: false,
    worldAgeDays: null,
    sizeBytes: null,
    sizeComplete: true,
    folderName                    // für Debug/Aussagekräftigkeit
  };

  const icon = path.join(worldPath, 'icon.png');
  // Das Vorschaubild kommt als Data-URL zurück, nicht als Dateipfad. Grund:
  // ein Pfad wie C:\Users\<Name>\AppData\... landet sonst im Renderer-Prozess
  // und damit in jedem DevTools-Fenster und jeder Fehlermeldung. Ein Data-URL
  // kann der Renderer direkt anzeigen, ohne etwas über die Platte zu wissen.
  //
  // Größenkappe: icon.png ist normalerweise winzig (64x64, ~10 KB). Sollte
  // einmal eine kaputte 50-MB-Datei dahinterliegen, wird sie ignoriert statt
  // den IPC-Kanal zu fluten.
  if (fs.existsSync(icon)) {
    try {
      const stat = fs.statSync(icon);
      if (stat.size <= 1024 * 1024) {
        result.iconDataUrl = 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64');
        result.iconBytes = stat.size;
      } else {
        result.iconSkipped = `icon.png ist ${Math.round(stat.size / 1024)} KB — zu groß für die Vorschau`;
      }
    } catch (err) {
      result.iconSkipped = 'icon.png nicht lesbar: ' + err.message;
    }
  }

  // session.lock legt das Spiel beim Öffnen an und löscht es beim sauberen
  // Beenden. Es ist also ein Hinweis, nicht ein Beweis — Minecraft räumt es bei
  // einem Absturz nicht weg. Wir zeigen es nur an, wenn die Instanz gerade
  // läuft, sonst wäre es eine irreführende Warnung.
  result.sessionLock = fs.existsSync(path.join(worldPath, 'session.lock'));

  const levelDat = path.join(worldPath, 'level.dat');
  if (fs.existsSync(levelDat)) {
    try {
      const root = readNbt(levelDat);
      const d = root.Data || {};

      if (typeof d.LevelName === 'string' && d.LevelName.trim()) {
        result.name = d.LevelName;
      }
      // Version.Name ist die Anzeigeversion ("1.21.4"), Version.Id die interne
      // DataVersion. Früher hieß das Feld GameVersion — mit der Umstellung auf
      // das neue Versionsformat gibt es das nicht mehr.
      const v = d.Version || {};
      if (typeof v.Name === 'string' && v.Name) result.version = v.Name;
      else if (Number.isFinite(v.Id)) result.version = String(v.Id);
      if (Number.isFinite(d.DataVersion)) result.dataVersion = d.DataVersion;

      if (Number.isFinite(d.LastPlayed) && d.LastPlayed > 0) {
        // LastPlayed ist Millisekunden seit 1970. Ein Plausibilitae-Test:
        // Minecraft schreibt das als echten Zeitstempel, ein beschädigter Wert
        // würde sonst "1970" oder ein Datum im Jahr 55000 anzeigen.
        const ms = d.LastPlayed;
        if (ms > 946684800000 && ms < 4102444800000) {
          result.lastPlayed = new Date(ms).toISOString();
        }
      }

      if (Number.isFinite(d.GameType) && d.GameType >= 0 && d.GameType < GAME_TYPES.length) {
        result.gameType = d.GameType;
        result.gameTypeName = GAME_TYPES[d.GameType];
      }
      if (Number.isFinite(d.Difficulty) && d.Difficulty >= 0 && d.Difficulty < DIFFICULTIES.length) {
        result.difficulty = d.Difficulty;
        result.difficultyName = DIFFICULTIES[d.Difficulty];
      }
      result.hardcore = d.hardcore === 1;
      result.cheats = d.allowCommands === 1;
      result.wasModded = d.WasModded === 1;
      result.worldAgeDays = worldAgeDays(d);
    } catch (err) {
      // Kein Abbruch: der Eintrag bleibt sichtbar, damit der Benutzer eine
      // kaputte Welt erkennt und löschen kann.
      result.broken = true;
      result.error = err.message;
    }
  } else {
    result.broken = true;
    result.error = 'level.dat fehlt — vermutlich keine vollständige Welt.';
  }

  const size = folderSize(worldPath);
  result.sizeBytes = size.bytes;
  result.sizeComplete = size.complete;

  return result;
}

/**
 * Alle Welten einer Instanz, neueste zuerst.
 *
 * @param {string} instanceDir  Pfad zum Instanzordner
 * @returns {object[]} Welt-Metadaten
 */
function listWorlds(instanceDir) {
  const dir = savesDir(instanceDir);
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[worlds] saves-Ordner nicht lesbar (${dir}):`, err.message);
    return [];
  }

  const worlds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Punkt-Verzeichnisse sind Minecraft-intern (z.B. .fabric) und keine
    // Welten. Ordner mit "_" sind dagegen KEIN Sonderfall: diese Konvention
    // gibt es nur im Instanzordner (_overrides), nicht unter saves/.
    if (entry.name.startsWith('.')) continue;
    const worldPath = path.join(dir, entry.name);
    try {
      worlds.push(readWorldMeta(worldPath));
    } catch (err) {
      // readWorldMeta ist defensiv geschrieben; falls doch etwas fliegt, darf
      // eine einzelne kaputte Welt die Liste nicht zerlegen.
      console.error(`[worlds] "${entry.name}" nicht lesbar:`, err.message);
      worlds.push({
        id: entry.name,
        name: entry.name,
        broken: true,
        error: err.message,
        iconDataUrl: null,
        folderName: entry.name
      });
    }
  }

  // "Zuletzt gespielt" zuerst — das ist die Reihenfolge, die jemand erwartet,
  // der eine Welt weiterspielen will. Welten ohne Zeitstempel (kaputt oder
  // nie gespielt) landen hinten, alphabetisch sortiert.
  worlds.sort((a, b) => {
    if (a.lastPlayed && b.lastPlayed) return b.lastPlayed.localeCompare(a.lastPlayed);
    if (a.lastPlayed) return -1;
    if (b.lastPlayed) return 1;
    return a.name.localeCompare(b.name, 'de');
  });
  return worlds;
}

/**
 * Löscht eine Welt samt Ordner.
 *
 * Sicherheitsreihenfolge absichtlich so:
 *   1. Namen prüfen (assertSafeName) — blockiert Pfad-Ausbrüche
 *   2. prüfen, dass es überhaupt eine Welt ist
 *   3. erst dann löschen
 * Würde man erst löschen und danach prüfen, wäre der Schaden schon passiert.
 *
 * @returns {{ok: true, id: string}}
 */
function deleteWorld(instanceDir, worldId) {
  const dir = savesDir(instanceDir);
  const worldPath = resolveInside(dir, worldId);

  let stat;
  try {
    stat = fs.lstatSync(worldPath);
  } catch {
    throw new Error(`Welt "${worldId}" existiert nicht.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`"${worldId}" ist kein Ordner — gelöscht wird nur unter saves/`);
  }
  // level.dat ist das Mindeste, was eine Welt ausmacht. Ohne die Datei ist es
  // entweder ein Überbleibsel oder ein Tippfehler — beides soll man nicht
  // mit einem Klick auf "Löschen" wegwerfen können.
  if (!fs.existsSync(path.join(worldPath, 'level.dat'))) {
    throw new Error(
      `In "${worldId}" liegt keine level.dat — das ist vermutlich keine Welt.\n` +
      'Ordner manuell löschen, falls er wirklich weg soll.'
    );
  }

  fs.rmSync(worldPath, { recursive: true, force: false });
  return { ok: true, id: worldId };
}

module.exports = {
  listWorlds,
  readWorldMeta,
  deleteWorld,
  savesDir,
  assertSafeName,
  resolveInside,
  GAME_TYPES,
  DIFFICULTIES
};
