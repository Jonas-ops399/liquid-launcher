// src/main/widgets.js
//
// Widgets finden, pruefen und laden. Ohne require('electron') - dieselbe
// Regel wie bei app-paths.js, damit der Test unter reinem Node laeuft.
//
// ---------------------------------------------------------------------------
// Was ein Widget ist
// ---------------------------------------------------------------------------
// Ein Widget ist ein Ordner mit zwei Dateien:
//
//   widgets\meine-uhr\
//     widget.json     beschreibt die Kachel (Titel, Breite)
//     widget.html     der Inhalt, frei geschriebenes HTML/CSS/JS
//
// Eingebauten Widgets liegen im Projektordner (widgets\), eigene in
// %APPDATA%\Liquid Launcher\widgets\. Beide werden ueber denselben Mechanismus
// gelesen, es gibt also keinen Sonderweg fuer "die vom Projekt" - sonst waere
// die Sonderbehandlung genau die Stelle, die spaeter auseinanderlaeuft.
//
// ---------------------------------------------------------------------------
// Warum hier Pfad-Sicherheit das Wichtigste ist
// ---------------------------------------------------------------------------
// Die Widget-ID kommt aus dem Renderer, also aus einer Datei auf der Platte
// (settings.json), die jeder bearbeiten kann. Ohne Pruefung koennte ein Eintrag
// wie
//
//     { "id": "../../../../Windows/System32/drivers/etc/hosts" }
//
// dazu fuehren, dass der Hauptprozess eine Datei ausserhalb des Widget-Ordners
// liest und dem Renderer als HTML liefert. Es waere kein direkter Zugriff auf
// das Token (das erreicht ein Widget nicht, siehe README), aber es waere ein
// Lesekanal aus dem Launcher heraus in beliebige Dateien.
//
// Deshalb zweimal abgesichert, nicht einmal:
//   1. Die ID muss als Ganzes passen (istGueltigeId), kein Zusammenbauen von
//      Pfaden aus Einzelteilen.
//   2. Nach dem path.resolve() wird geprueft, ob das Ergebnis INNERHALB des
//      Widget-Ordners liegt. Das faengt auch Symlinks und Windows-Sonderfaelle
//      ab, die die reine Textpruefung in (1) nicht sieht.
//
// (1) allein waere die haeufige Fehlerquelle, (2) allein reicht nicht, weil
// "widget%2e%2e" oder ein Laufwerksbuchstabe durch die Textpruefung rutscht.

const fs = require('node:fs');
const path = require('node:path');

/** Quelle: mitgeliefert vom Projekt. */
const QUELLE_EINGEBAUT = 'eingebaut';
/** Quelle: vom Benutzer selbst angelegt. */
const QUELLE_BENUTZER = 'benutzer';

const MANIFEST = 'widget.json';
const HTML = 'widget.html';

/**
 * Ein Widget-Skript im Renderer darf diese Felder bekommen - mehr nicht.
 * Bewusst als Positivliste, nicht als Negativliste: was nicht hier steht,
 * wird nicht durchgereicht. Eine spaeter ergaenzte Funktion in auth.js ist
 * damit automatisch ausgeschlossen, statt dass man sie hier wieder entfernen
 * muss.
 *
 * KEIN Token, KEINE Account-Daten, KEIN Dateisystem.
 *
 * Bewusst OHNE "theme": die Farben kommen als eigene Nachricht
 * (typ: 'theme') direkt aus den CSS-Variablen des Fensters, weil die sich
 * beim Wechsel des Farbschemas aendern, ohne dass irgendetwas gespeichert
 * wird. Ein Datenfeld waere hier immer null gewesen.
 */
const ERLAUBTE_DATENFELDER = [
  'aktiveInstanz',
  'instanzen',
  'welten',
  'modAnzahl',
  'server',
  'gestartetAm',
  'sprache'
];

/**
 * Nur diese Zeichen in einer ID. Bewusst ohne Slash, Backslash, Doppelpunkt
 * und ohne fuehrenden Punkt - damit kann die ID nie als Pfadbestandteil
 * missbraucht werden.
 */
const ID_MUSTER = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function istGueltigeId(id) {
  return typeof id === 'string' && ID_MUSTER.test(id);
}

/**
 * Liegt `ziel` innerhalb von `wurzel`? Beide muessen absolut aufgeloest sein.
 *
 * `path.relative` gibt zurueck, was ueber die Wurzel hinausgeht: '..\\..' oder
 * bei einem anderen Laufwerk einen absoluten Pfad. Beides wird abgelehnt.
 */
function liegtInnerhalb(wurzel, ziel) {
  const rel = path.relative(path.resolve(wurzel), path.resolve(ziel));
  if (rel === '') return false;              // die Wurzel selbst ist kein Widget
  if (path.isAbsolute(rel)) return false;     // anderes Laufwerk
  return !rel.split(path.sep).includes('..');
}

/**
 * Das Manifest pruefen. Gibt immer ein Objekt zurueck, nie eine Exception -
 * ein kaputtes Widget darf den Launcher nicht zum Absturz bringen, es soll
 * schlicht nicht erscheinen.
 */
function pruefeManifest(roh) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    return { ok: false, fehler: 'Manifest ist kein Objekt.' };
  }
  if (!istGueltigeId(roh.id)) {
    return { ok: false, fehler: 'Ungueltige id (erlaubt: Buchstaben, Ziffern, -, _).' };
  }
  if (typeof roh.titel !== 'string' || !roh.titel.trim()) {
    return { ok: false, fehler: 'Feld "titel" fehlt oder ist leer.' };
  }
  // breite: number of grid cells. Default 1, and only 1 or 2 are accepted.
  // Anything else is set to 1 instead of rejected - a widget that
  // specifies "wide" should not disappear completely.
  let breite = Number(roh.breite);
  if (!Number.isInteger(breite) || breite < 1) breite = 1;
  if (breite > 2) breite = 2;

  return {
    ok: true,
    manifest: {
      id: roh.id,
      titel: String(roh.titel).trim().slice(0, 80),
      beschreibung: typeof roh.beschreibung === 'string'
        ? roh.beschreibung.slice(0, 200) : '',
      breite,
      // Der Pfad zur HTML-Datei ist optional. Fehlt er, wird widget.html
      // genommen. So reicht bei den meisten Widgets nur das Manifest.
      //
      // Hier wird er auf den reinen Dateinamen reduziert und nicht erst beim
      // Verwenden. Das ist bewusst an der Grenze und nicht weiter unten:
      // wenn der Wert schon beim Pruefen bereinigt wird, ist er fuer JEDEN
      // kuenftigen Verwendungszweck sicher. Andernfalls haette die naechste
      // Stelle, die manifest.html liest, wieder ungeprueft mit Nutzerdaten
      // zu tun - genau die Art Stelle, die beim Umbauen neu entsteht.
      html: typeof roh.html === 'string' && roh.html.trim()
        ? path.basename(roh.html.trim())
        : HTML
    }
  };
}

/**
 * Liest und prueft widget.json eines Ordners.
 */
function liesManifest(ordner) {
  const pfad = path.join(ordner, MANIFEST);
  let roh;
  try {
    roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, fehler: 'widget.json fehlt.' };
    return { ok: false, fehler: 'widget.json nicht lesbar: ' + (err && err.message) };
  }
  return pruefeManifest(roh);
}

/**
 * Alle Widgets aus mehreren Wurzeln einsammeln.
 *
 * `wurzeln` ist eine Liste von { ordner, quelle }. Reihenfolge = Prioritaet:
 * ein spaeterer Treffer mit derselben ID gewinnt. Damit kann ein Benutzer ein
 * eingebautes Widget einfach mit gleichem Namen im eigenen Ordner ersetzen -
 * ohne Sonderfunktion im Code.
 *
 * Unsichtbar/unsortierbare Ordner werden uebersprungen, statt zu fehlschlagen:
 * ein kaputtes Widget darf den Rest nicht mitreiessen.
 */
function listeWidgets(wurzeln) {
  const gefunden = new Map();
  for (const wurzel of wurzeln) {
    if (!wurzel || typeof wurzel.ordner !== 'string') continue;
    let eintraege;
    try {
      eintraege = fs.readdirSync(wurzel.ordner, { withFileTypes: true });
    } catch {
      continue;   // Wurzel existiert noch nicht: beim ersten Start normal
    }
    for (const eintrag of eintraege) {
      if (!eintrag.isDirectory()) continue;
      if (eintrag.name.startsWith('.')) continue;
      const ordner = path.join(wurzel.ordner, eintrag.name);
      const pruefung = liesManifest(ordner);
      if (!pruefung.ok) continue;
      const m = pruefung.manifest;
      if (!liegtInnerhalb(wurzel.ordner, ordner)) continue; // paranoia
      gefunden.set(m.id, {
        id: m.id,
        titel: m.titel,
        beschreibung: m.beschreibung,
        breite: m.breite,
        quelle: wurzel.quelle || QUELLE_EINGEBAUT,
        ordnerName: eintrag.name
      });
    }
  }
  return [...gefunden.values()].sort((a, b) => a.titel.localeCompare(b.titel, 'de'));
}

/**
 * Den Ordner zu einer ID finden, inklusive der Pruefung, dass der Pfad
 * tatsaechlich im passenden Wurzelordner liegt.
 *
 * ACHTUNG, Reihenfolge = Prioritaet, letzter Treffer gewinnt. Das ist genau
 * die Regel von listeWidgets(), und beide MUESSEN uebereinstimmen. In der
 * ersten Fassung stand hier `return` beim ersten Treffer, in listeWidgets()
 * dagegen das spaetere Ueberschreiben - mit der Folge, dass die Liste
 * "Uhr (meine)" anzeigte, die gerenderte Kachel aber weiterhin die
 * eingebaute Uhr zeigte. Beide Funktionen jetzt gleich: alles durchlaufen,
 * das Ergebnis am laufenden ueberschreiben.
 */
function findeWidgetOrdner(wurzeln, id) {
  if (!istGueltigeId(id)) return null;
  let treffer = null;
  for (const wurzel of wurzeln) {
    if (!wurzel || typeof wurzel.ordner !== 'string') continue;
    const ordner = path.join(wurzel.ordner, id);
    // Die zweite Absicherung, siehe Kommentar oben. Ohne sie koennte ein
    // Wurzelordner-Eintrag den Rest aushebeln.
    if (!liegtInnerhalb(wurzel.ordner, ordner)) continue;
    const pruefung = liesManifest(ordner);
    if (!pruefung.ok) continue;
    // Das Manifest muss auch die gesuchte ID fuehren - sonst waere es ein
    // Ordner, der sich als etwas anderes ausgibt.
    if (pruefung.manifest.id !== id) continue;
    treffer = {
      ordner,
      quelle: wurzel.quelle || QUELLE_EINGEBAUT,
      manifest: pruefung.manifest
    };
  }
  return treffer;
}

/**
 * Das HTML eines Widgets laden.
 * Liefert { ok:true, html, manifest, quelle } oder { ok:false, fehler }.
 */
function liesWidgetHtml(wurzeln, id) {
  const treffer = findeWidgetOrdner(wurzeln, id);
  if (!treffer) return { ok: false, fehler: 'Widget nicht gefunden: ' + id };

  // Der Dateiname aus dem Manifest ist ebenfalls Angabe des Benutzers.
  // Nur reiner Dateiname, kein Pfd.
  const datei = path.basename(treffer.manifest.html || HTML);
  const pfad = path.join(treffer.ordner, datei);
  if (!liegtInnerhalb(treffer.ordner, pfad)) {
    return { ok: false, fehler: 'HTML-Datei liegt ausserhalb des Widget-Ordners.' };
  }
  let inhalt;
  try {
    inhalt = fs.readFileSync(pfad, 'utf-8');
  } catch (err) {
    return { ok: false, fehler: datei + ' nicht lesbar: ' + (err && err.message) };
  }
  return {
    ok: true,
    html: inhalt,
    manifest: treffer.manifest,
    quelle: treffer.quelle
  };
}

/**
 * Die Daten, die ein Widget bekommen darf, auf die Positivliste kuerzen.
 *
 * Wird im Hauptprozess vor jedem Senden aufgerufen. Ohne das wuerde ein
 * zukuenftiges neues Feld in den Daten automatisch an jedes Widget gehen -
 * die Positivliste verhindert das by construction.
 */
function filtereDatenFuerWidget(daten) {
  const raus = {};
  if (!daten || typeof daten !== 'object') return raus;
  for (const feld of ERLAUBTE_DATENFELDER) {
    if (daten[feld] !== undefined) raus[feld] = daten[feld];
  }
  return raus;
}

module.exports = {
  QUELLE_EINGEBAUT,
  QUELLE_BENUTZER,
  ERLAUBTE_DATENFELDER,
  ID_MUSTER,
  istGueltigeId,
  liegtInnerhalb,
  pruefeManifest,
  liesManifest,
  listeWidgets,
  findeWidgetOrdner,
  liesWidgetHtml,
  filtereDatenFuerWidget
};
