/**
 * Startoptionen pro Instanz: RAM und Aufloesung.
 *
 * Warum ein eigenes Modul und nicht drei Zeilen in ipc-handlers.js:
 * Beide Werte landen als JVM-Argument in der Befehlszeile (`-Xmx4G`,
 * `--width 1920`). Ein Tippfehler ist dort nicht ein Tippfehler im UI,
 * sondern ein Spiel, das gar nicht erst startet — und die Meldung, die
 * dann kommt, ist die denkbar schlechteste:
 *
 *   "Initial heap size set to a larger value than the maximum heap size"
 *   "Could not reserve enough space for object heap"
 *
 * Beides sagt dem Benutzer nichts ueber die Ursache. Diese Stelle ist also
 * die letzte Gelegenheit, die Zahl zu pruefen, bevor sie schaedlich wird.
 *
 * Bewusste Entscheidung: KEINE freien Argumentlisten (kein "extra JVM args"
 * wie bei den meisten Launchern). Zwei Gruende:
 *
 *  1. Jedes zusaetzliche Argument geht ungeprueft in den argv des Prozesses.
 *     `-javaagent:` und `-Dlog4j.configurationFile=…` laden fremden Code bzw.
 *     hijacken die Log-Konfiguration. Der Nutzer ist hier selbst der Angreifer
 *     — aber bei einer kopierten `instance-settings.json` ist das nicht
 *     offensichtlich, und ein zusaetzlicher Config-Kanal ist eine
 *     Angriffsflaeche ohne Gegenwert.
 *  2. `-Xmx` in einer solchen Liste waere stillschweigend wirkungslos: die
 *     geprueften `-Xms`/`-Xmx` aus process.js stehen weiter hinten in der
 *     Argumentliste und gewinnen. Ein Benutzer, der dort `-Xmx8G` eintraegt,
 *     wuerde sich wundern, warum nichts passiert.
 *
 * RAM und Aufloesung sind dagegen typisiert: der Wert ist eine Zahl, und
 * eine Zahl kann per Konstruktion nichts anderes in die Befehlszeile
 * transportieren als ihre eigene Ziffernfolge.
 */

const os = require('node:os');

const DEFAULTS = Object.freeze({
  ramMinGb: 1,
  ramMaxGb: 2,
  width: 1280,
  height: 720
});

const LIMITS = Object.freeze({
  // Unter 1 GB startet 1.17+ nicht sinnvoll: das Spiel braucht den Heap fuer
  // die Chunk-Generierung, und statt eines sauberen Absturzes gibt es einen
  // OutOfMemoryError mitten im Laden.
  ramMin: 1,
  // 64 GB ist die harte Grenze, und zwar eine praktische: Windows kann
  // nicht beliebig viel reservieren. `-Xmx128G` auf einem 32-GB-Rechner
  // endet in "Could not reserve enough space for object heap" — wieder eine
  // Meldung ohne Ursache. Darueber hinaus ist die Zahl mit Sicherheit ein
  // Tippfehler, kein Wunsch.
  ramMax: 64,
  // 640x480 ist die untere Aufloesung, die das Spiel selbst noch als
  // sinnvoll darstellt; 7680x4320 deckt 8K ab. Alles dazwischen ist
  // erlaubt, auch ungewoehnliche Verhaeltnisse wie 3440x1440 (Ultrawide).
  resMinW: 640,
  resMaxW: 7680,
  resMinH: 480,
  resMaxH: 4320
});

/**
 * Wie viele Gigabyte ein sinnvoller Standard sind.
 *
 * Fest "2G" ist auf einem 32-GB-Rechner genauso falsch wie auf einem
 * 4-GB-Notebook: im ersten Fall verschwendet der Spieler Leistung, im
 * zweiten laeuft das Spiel in den Swap. Deshalb halbiert man den verfuegbaren
 * Speicher und deckelt das Ergebnis — 2 GB Minimum fuer den Spielstart,
 * 4 GB Maximum, weil darueber der Zugewenn fuenf Ram-Luecken laesst.
 */
function recommendedRamGb(physicalGb = physicalRamGb()) {
  if (physicalGb >= 16) return 4;
  if (physicalGb >= 8) return 3;
  return 2;
}

/** Physischer RAM in GB, auf volle GB abgerundet. */
function physicalRamGb() {
  return Math.floor(os.totalmem() / 1024 ** 3);
}

/**
 * Eine Zahl akzeptieren, die aus einem Textfeld kommt.
 *
 * `Number()` ist dafuer die falsche Funktion. Sie liefert fuer `''`, `' '`
 * und `null` jeweils 0 — drei Eingaben, die wie eine Eingabe aussehen und
 * trotzdem eine Zahl ergeben. Und sie akzeptiert Schreibweisen, die in
 * diesem Feld nichts zu suchen haben:
 *
 *   Number('0x10')      === 16     // Hexadezimal als "16 GB" gelesen
 *   Number('Infinity')  === Infinity
 *   Number('1e3')       === 1000
 *
 * `0x10` ist der Fall, der wehtut: der Benutzer hat sich verrechnet, die
 * Zahl ist falsch, und statt einer Meldung bekommt er 16 GB. Deshalb wird
 * gegen eine Dezimalzahl geprueft statt umgewandelt.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    // '4 GB' ist eine sehr natuerliche Eingabe. Die Einheit wegmessen ist
    // grosszuegiger als sie abzulehnen — getippt wird sie trotzdem.
    const trimmed = value.trim().replace(/\s*(gb|gib|g)$/i, '');
    if (trimmed === '') return NaN;
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  return NaN;
}

/**
 * RAM in halben Gigabyte-Schritten.
 *
 * `value * 2` muss eine ganze Zahl sein. Damit fallen sowohl 2.7 GB (das
 * JVM akzeptiert es, aber kein Mensch meint es) als auch 0.25 GB (nuetzlich
 * nur fuer die Fehlersuche) durchs Raster. Nachkommastellen sind bei einer
 * Schieberegler-Eingabe ohnehin nicht erreichbar.
 */
function isValidRam(value) {
  return Number.isFinite(value) && value >= LIMITS.ramMin && value <= LIMITS.ramMax
    && Number.isInteger(value * 2);
}

function isValidResolution(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= LIMITS.resMinW && width <= LIMITS.resMaxW
    && height >= LIMITS.resMinH && height <= LIMITS.resMaxH;
}

/**
 * Gespeicherte Einstellungen lesen und auf einen benutzbaren Zustand bringen.
 *
 * Liest die Datei nicht selbst — der Pfad kommt von aussen, damit das Modul
 * keinen Electron-Import braucht und im Test mit einem Temp-Ordner laeuft.
 * Ein Fehler fuehrt NICHT zum Abbruch: eine kaputte Einstellungsdatei darf
 * einen Start nicht verhindern, sie faellt auf die Standardwerte zurueck.
 * Genau wie bei einer kaputten level.dat: sichtbar kaputt, aber benutzbar.
 */
function loadSettings(instanceDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance-settings.json'), 'utf-8'));
  } catch {
    return { ...DEFAULTS, _problem: 'unlesbar' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULTS, _problem: 'unlesbar' };
  }
  // Was nicht durch die Pruefung kommt, wird verworfen — nicht gerettet.
  // Ein `max` von 9999 aus einer manipulierten Datei darf den Start nicht
  // mit `-Xmx9999G` verschenken.
  const ergebnis = { ...DEFAULTS };
  const min = toNumber(raw.ramMinGb);
  const max = toNumber(raw.ramMaxGb);
  const breite = toNumber(raw.width);
  const hoehe = toNumber(raw.height);
  if (isValidRam(min)) ergebnis.ramMinGb = min;
  if (isValidRam(max)) ergebnis.ramMaxGb = max;
  if (Number.isInteger(breite) && breite >= LIMITS.resMinW && breite <= LIMITS.resMaxW) ergebnis.width = breite;
  if (Number.isInteger(hoehe) && hoehe >= LIMITS.resMinH && hoehe <= LIMITS.resMaxH) ergebnis.height = hoehe;
  // min <= max gilt auch fuer das, was gerade aus der Datei kam.
  if (ergebnis.ramMinGb > ergebnis.ramMaxGb) ergebnis.ramMinGb = ergebnis.ramMaxGb;
  return ergebnis;
}

function saveSettings(instanceDir, settings) {
  const fs = require('node:fs');
  const path = require('node:path');
  const datei = path.join(instanceDir, 'instance-settings.json');
  // Ohne die Zusatzfelder: _problem gehoert zu einer Leseoperation.
  const { ramMinGb, ramMaxGb, width, height } = settings;
  const tmp = `${datei}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ramMinGb, ramMaxGb, width, height }, null, 2));
  // Erst daneben schreiben, dann umbenennen. Ein Absturz mitten im Schreiben
  // hinterlaesst sonst eine halbe Datei, die beim naechsten Start als
  // "unlesbar" auffaellt und die Einstellungen des Benutzers vernichtet.
  fs.renameSync(tmp, datei);
}

/**
 * Eingaben pruefen. Wirft bei einem echten Fehler, gibt Warnungen als
 * Ergebnis zurueck.
 *
 * Warum geworfen und nicht korrigiert: wenn der Benutzer 32 GB eintippt und
 * der Rechner 8 GB hat, ist das kein Tippfehler, sondern eine Absicht. Ein
 * stilles Zuruecksetzen auf 4 GB wuerde ihn beim naechsten Start mit einem
 * anderen Wert wundern lassen als dem, den er eingegeben hat.
 */
function validateSettings(partial = {}, physical = physicalRamGb()) {
  const kandidat = { ...DEFAULTS, ...(partial && typeof partial === 'object' ? partial : {}) };
  const fehler = [];

  const min = toNumber(kandidat.ramMinGb);
  const max = toNumber(kandidat.ramMaxGb);
  const breite = toNumber(kandidat.width);
  const hoehe = toNumber(kandidat.height);

  if (!Number.isFinite(min)) fehler.push('Mindest-RAM ist keine Zahl.');
  else if (!isValidRam(min)) {
    fehler.push(min < LIMITS.ramMin
      ? `Mindest-RAM muss mindestens ${LIMITS.ramMin} GB sein.`
      : `Mindest-RAM muss zwischen ${LIMITS.ramMin} und ${LIMITS.ramMax} GB liegen, in halben GB-Schritten.`);
  }

  if (!Number.isFinite(max)) fehler.push('Maximaler RAM ist keine Zahl.');
  else if (!isValidRam(max)) {
    fehler.push(max < LIMITS.ramMin
      ? `Maximaler RAM muss mindestens ${LIMITS.ramMin} GB sein.`
      : `Maximaler RAM muss zwischen ${LIMITS.ramMin} und ${LIMITS.ramMax} GB liegen, in halben GB-Schritten.`);
  }

  // Das ist der eine Fehler, der das Spiel gar nicht erst starten laesst.
  if (isValidRam(min) && isValidRam(max) && min > max) {
    fehler.push(`Mindest-RAM (${fmt(min)}) darf nicht groesser sein als der maximale RAM (${fmt(max)}).`);
  }

  if (!Number.isInteger(breite) || breite < LIMITS.resMinW || breite > LIMITS.resMaxW) {
    fehler.push(`Breite muss eine ganze Zahl zwischen ${LIMITS.resMinW} und ${LIMITS.resMaxW} sein.`);
  }
  if (!Number.isInteger(hoehe) || hoehe < LIMITS.resMinH || hoehe > LIMITS.resMaxH) {
    fehler.push(`Hoehe muss eine ganze Zahl zwischen ${LIMITS.resMinH} und ${LIMITS.resMaxH} sein.`);
  }

  if (fehler.length) {
    const err = new Error(fehler.join(' '));
    err.felder = fehler;
    throw err;
  }

  return {
    settings: { ramMinGb: min, ramMaxGb: max, width: breite, height: hoehe },
    // Warnungen blockieren nichts. Ein `-Xmx8G` auf einem 16-GB-Rechner ist
    // eine legitime Entscheidung (Modpack, lange Wege), nur eine, von der man
    // besser vorher weiss.
    warnungen: warnungen({ ramMinGb: min, ramMaxGb: max }, physical)
  };
}

function warnungen(settings, physical = physicalRamGb()) {
  const liste = [];
  if (settings.ramMaxGb > physical) {
    liste.push(`${fmt(settings.ramMaxGb)} liegen mehr als im Rechner stecken (${physical} GB). Minecraft startet, laeuft aber in den Swap.`);
  } else if (settings.ramMaxGb >= physical) {
    liste.push(`${fmt(settings.ramMaxGb)} sind so viel wie der Rechner hat. Windows braucht davon etwas fuer sich.`);
  }
  // -Xms wird beim Start sofort reserviert, -Xmx nur bei Bedarf. Ein hohes
  // -Xms ist daher echter Speicherverbrauch von Anfang an und kein blosser
  // Deckel. Die Grenze liegt bei der Haelfte des physikalischen Speichers.
  if (settings.ramMinGb * 2 > physical) {
    liste.push(`${fmt(settings.ramMinGb)} werden sofort beim Start belegt. ${fmt(settings.ramMaxGb)} reichen in der Regel aus.`);
  }
  return liste;
}

/** RAM als Anzeige: 1.5 statt 1,5 — die Zahlenfelder sind number. */
function fmt(gb) {
  return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * Was resolveLaunchOptions() braucht. Bewusst zwei getrennte Objekte, weil
 * dort zwei verschiedene Parameter stehen — der RAM als JVM-Argument, die
 * Aufloesung als Game-Argument.
 */
function toLaunchInputs(settings) {
  return {
    resolution: { width: settings.width, height: settings.height },
    // 'G' ohne Zahl dahinter waere 'G' allein. Die Zahl ist hier durch die
    // Validierung garantiert ganzzahlig bzw. halbzahlig, das 'G' haengt
    // direkt dran: aus 1.5 entsteht '-Xmx1.5G', aus 4 entsteht '-Xmx4G'.
    memory: { min: `${settings.ramMinGb}G`, max: `${settings.ramMaxGb}G` }
  };
}

/** Alles, was das UI fuer die Anzeige braucht. */
function describe() {
  const physical = physicalRamGb();
  return {
    settings: { ...DEFAULTS, ramMaxGb: recommendedRamGb(physical) },
    limits: { ...LIMITS },
    physicalRamGb: physical,
    recommendedRamGb: recommendedRamGb(physical)
  };
}

module.exports = {
  DEFAULTS,
  LIMITS,
  loadSettings,
  saveSettings,
  validateSettings,
  toLaunchInputs,
  physicalRamGb,
  recommendedRamGb,
  isValidRam,
  isValidResolution,
  toNumber,
  warnungen,
  describe
};
