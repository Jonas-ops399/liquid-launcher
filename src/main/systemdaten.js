// src/main/systemdaten.js
//
// Messbare System- und Dateiwerte fuer die Overview-Widgets (Phase D4).
//
// OHNE require('electron') - dieselbe Regel wie bei app-paths.js und
// widgets.js, damit der Test unter reinem Node laeuft. Der Hauptprozess
// uebergibt die Pfade, die er sonst aus app haette.
//
// ---------------------------------------------------------------------------
// Was hierherein gehoert - und was nicht
// ---------------------------------------------------------------------------
// Jedes Feld ist eine GEMESSENE Groesse: os.cpus() zaehlt Takte, os.freemem()
// zaehlt Bytes, statfsSync zaehlt Bloecke, readdirSync zaehlt Dateien. Es
// wird nichts geschaetzt, nichts aus Konfigurationen abgeleitet und nichts
// erfunden. CPU-Temperatur fehlt deshalb bewusst: unter Windows braechaete
// sie einen Zusatztreiber, und "irgendein Wert" waere eine Luege in einer
// Kachel, die vorgibt, gemessen zu haben.
//
// Keine Pfade, keine Benutzernamen, keine Tokens in den Rueckgaben - die
// Felder gehen durch die Positivliste in widgets.js an sandboxed Widgets.
// Ein Pfad in einem Widget-Feld waere ein Lesekanal, den es nicht geben muss.
//
// ---------------------------------------------------------------------------
// Warum die CPU-Auslastung zweimal gemessen wird
// ---------------------------------------------------------------------------
// os.cpus() liefert KUMULATIVE Zeiten seit dem Boot. Aus einem einzelnen
// Messpunkt folgt keine Auslastung - nur aus der Differenz zweier. Deshalb
// haelt dieses Modul den letzten Messpunkt und liefert beim ersten Aufruf
// null: lieber "noch keine Angabe" als eine Zahl, die aus nichts folgt.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Letzter CPU-Messpunkt: { zeit, idle, gesamt } ueber alle Kerne summiert. */
let cpuProbe = null;

/** Nur fuer den Test: den Messpunkt zuruecksetzen. */
function zuruecksetzen() {
  cpuProbe = null;
}

function cpuRoh() {
  const kerne = os.cpus();
  let idle = 0;
  let gesamt = 0;
  for (const k of kerne) {
    const t = k.times;
    if (!t) continue;
    idle += t.idle;
    gesamt += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { zeit: Date.now(), idle: idle, gesamt: gesamt };
}

/**
 * Die Auslastung zwischen zwei Messpunkten in Prozent (0-100, ganzzahlig).
 * Liefert null, wenn sich nichts messen laesst: keine beiden Punkte, keine
 * vergangene Zeit, kein zaehlbare Delta. null ist die richtige Antwort -
 * 0 % waere eine Behauptung.
 */
function berechneAuslastung(alt, neu) {
  if (!alt || !neu) return null;
  const dGesamt = neu.gesamt - alt.gesamt;
  const dIdle = neu.idle - alt.idle;
  if (!(dGesamt > 0)) return null;
  const anteil = (1 - dIdle / dGesamt) * 100;
  if (!Number.isFinite(anteil) || anteil < 0) return null;
  return Math.min(100, Math.round(anteil));
}

/**
 * Die Auslastung seit dem letzten Aufruf. Beim ersten Aufruf wird nur der
 * Messpunkt angelegt und null zurueckgegeben - ab dem zweiten steht eine
 * echte Differenz dahinter.
 */
function cpuAuslastung() {
  const neu = cpuRoh();
  const anteil = berechneAuslastung(cpuProbe, neu);
  cpuProbe = neu;
  return anteil;
}

/** Systemwerte, die sich waehrend des Laufens aendern. */
function systemFelder() {
  const frei = os.freemem();
  const gesamt = os.totalmem();
  const kerne = os.cpus();
  return {
    plattform: process.platform,        // 'win32', 'darwin', 'linux'
    release: os.release(),              // z.B. '10.0.26200'
    arch: os.arch(),                    // 'x64', 'arm64'
    kerne: kerne.length,
    // Der von der Hardware gemeldete Takt in MHz - kein Turbo, kein
    // "bis zu". Genau das, was os.cpus()[0].speed ausgibt.
    cpuTaktMhz: kerne.length && kerne[0].speed ? Math.round(kerne[0].speed) : null,
    ramGesamt: gesamt,
    ramFrei: frei,
    ramBelegt: Math.max(0, gesamt - frei),
    systemUptimeSek: Math.floor(os.uptime()),
    zeitstempel: Date.now()
  };
}

/**
 * Groesse und freier Platz des Datentraegers, auf dem `wurzel` liegt - also
 * des Laufwerks, auf dem die Spielstaende liegen. Ueber statfs: dasselbe,
 * was der Explorer als "frei" anzeigt. Bei einem Fehler null, kein Schaetzwert.
 */
function laufwerkFeld(wurzel) {
  if (typeof wurzel !== 'string' || !wurzel) return null;
  try {
    const s = fs.statfsSync(wurzel);
    const gesamt = s.bsize * s.blocks;
    const frei = s.bsize * s.bavail;
    if (!Number.isFinite(gesamt) || !Number.isFinite(frei) || gesamt <= 0) return null;
    return { gesamt: gesamt, frei: Math.max(0, Math.min(frei, gesamt)) };
  } catch {
    return null;
  }
}

/**
 * Die Netzwerk-Schnittstellen: Name, ob intern, IPv4-Adresse.
 * Nur IPv4 - IPv6-Adressen sind fuer eine Kachel zu lang und bringen keine
 * Aussage, die eine Zeile "WLAN, 192.168.178.5" nicht besser sagt.
 */
function netzwerkFelder() {
  const raus = [];
  let roh;
  try {
    roh = os.networkInterfaces();
  } catch {
    return raus;
  }
  for (const name of Object.keys(roh || {})) {
    const eintraege = roh[name];
    if (!Array.isArray(eintraege)) continue;
    for (const e of eintraege) {
      const istV4 = e.family === 'IPv4' || e.family === 4;
      if (!istV4) continue;
      raus.push({ name: String(name), intern: !!e.internal, adresse: String(e.address) });
    }
  }
  return raus;
}

/**
 * Ordnergroesse in Bytes, rekursiv gezaehlt.
 *
 * Gezaehlt werden nur echte Dateien. Symlinks und Sonderdateien bleiben
 * draussen: ein Link, der auf sich selbst zeigt, wuerde die Schleife sonst
 * nie beenden, und ein Link nach aussen wuerde Bytes zaehlen, die gar nicht
 * in diesem Ordner liegen.
 *
 * Bei fehlendem Pfad null. Tiefe ist begrenzt, weil ein kaputter oder sehr
 * tiefer Baum die Kachel nicht aufhaengen darf.
 */
function ordnerGroesse(pfad) {
  if (typeof pfad !== 'string' || !pfad) return null;
  let stat;
  try {
    stat = fs.statSync(pfad);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : null;

  let summe = 0;
  function lauf(dir, tiefe) {
    if (tiefe > 14) return;
    let eintraege;
    try {
      eintraege = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // unlesbarer Unterordner: den Rest zaehlen wir trotzdem
    }
    for (const e of eintraege) {
      if (e.isDirectory()) {
        lauf(path.join(dir, e.name), tiefe + 1);
      } else if (e.isFile()) {
        try { summe += fs.statSync(path.join(dir, e.name)).size; } catch { /* weggefallen */ }
      }
    }
  }
  lauf(pfad, 0);
  return summe;
}

/**
 * Wie viele Eintraege ein Ordner hat (Dateien und Unterordner).
 * Fehlt der Ordner: null - "gibt es nicht" ist etwas anderes als "ist leer".
 */
function anzahlEintraege(pfad) {
  if (typeof pfad !== 'string' || !pfad) return null;
  try {
    return fs.readdirSync(pfad).length;
  } catch {
    return null;
  }
}

/**
 * Der leichte Teil des Datenkoffers: alles, was sich oft aendert und billig
 * zu messen ist. Wird vom Renderer im Takt abgefragt (widgets:systemdaten),
 * deshalb ohne Dateisystem-Wanderungen - ordnerGroesse() steht bewusst NICHT
 * hier, sondern nur im vollen Koffer von widgets:daten.
 */
function leicht(wurzel) {
  return {
    system: systemFelder(),
    cpuLast: cpuAuslastung(),
    laufwerk: laufwerkFeld(wurzel)
  };
}

module.exports = {
  zuruecksetzen,
  berechneAuslastung,
  cpuAuslastung,
  systemFelder,
  laufwerkFeld,
  netzwerkFelder,
  ordnerGroesse,
  anzahlEintraege,
  leicht
};
