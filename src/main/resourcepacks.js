// resourcepacks.js
//
// Verwaltet die Ressourcenpakete einer Instanz: Ordner resourcepacks/ lesen,
// ein .zip importieren, ein Paket loeschen und — das ist der eigentliche
// Unterschied zu den Mods — ein Paket im Spiel ein- und ausschalten.
//
// WARUM DAS EIGENE DATEI IST UND NICHT TEIL VON ipc-handlers.js
// Weil es sich ohne Electron pruefen laesst. listPacks(), setPackAktiv() und
// removePack() nehmen einen absoluten Instanzordner und benutzen kein Fenster,
// kein Dialog und kein app.getPath(). test-ressourcenpakete.js ruft sie
// deshalb direkt auf, ohne einen Renderer zu starten.
//
// WIE EIN PAKET IM SPIEL SCHARF GESTELLT WIRD
// Minecraft kennt dafuer kein Kommandozeilenargument. Der Schalter steht in
// <instanz>/options.txt in der Zeile
//
//     resourcePacks:["vanilla","file/Pakname"]
//
// "file/Pakname" ist der Name im resourcepacks/ ohne Endung; bei einem .zip
// also der Dateiname ohne ".zip". Beide Formen benutzen denselben Eintrag.
//
// Der Schreibpfad ist hier derselbe wie beim Spiel selbst: die Datei wird
// gelesen, nur diese eine Zeile wird ersetzt oder ergaenzt, alles andere
// bleibt unangetastet. Ein Rewrite der ganzen Datei wuerde Reihenfolge,
// Kommentare und alle anderen Optionen verlieren.

const fs = require('node:fs');
const path = require('node:path');

// Der Ordner, in dem Minecraft die lokalen Pakete erwartet.
const ORDNER = 'resourcepacks';

// Der Schluessel in options.txt. "vanilla" steht immer mit drin und darf nicht
// entfernt werden: es ist das eingebaute Paket. Ohne diesen Eintrag startet das
// Spiel ohne Standardtexturen.
const SCHLUESSEL = 'resourcePacks';
const VANILLA = 'vanilla';

/**
 * pack_format -> Minecraft-Version, fuer die Anzeige.
 *
 * Nur Anzeige, kein Filter: ein Paket mit unbekanntem Format wird nicht
 * abgewiesen, sondern als "neuer als bekannt" beschriftet.
 *
 * Bewusst unvollstaendig: ab pack_format 24 (1.21.7 und neuer) steht hier
 * nichts mehr. Eine Zahl zu erfinden waere geraten, und eine geratene Zahl in
 * einer Versionsanzeige ist schlimmer als eine fehlende.
 */
const FORMAT_VERSION = {
  1: '1.0–1.1',
  2: '1.2–1.3',
  3: '1.3–1.4',
  4: '1.4–1.6',
  5: '1.6–1.8',
  6: '1.9–1.10.2',
  7: '1.11–1.12.2',
  8: '1.13–1.14',
  9: '1.15–1.16.1',
  10: '1.16.2–1.17.1',
  11: '1.18–1.18.2',
  12: '1.19',
  13: '1.19.1–1.19.3',
  14: '1.19.4',
  15: '1.20–1.20.1',
  16: '1.20.2',
  17: '1.20.3–1.20.4',
  18: '1.20.5–1.20.6',
  19: '1.21–1.21.1',
  20: '1.21.2–1.21.3',
  21: '1.21.4',
  22: '1.21.5',
  23: '1.21.6'
};

const LETZTES_FORMAT = Math.max(...Object.keys(FORMAT_VERSION).map(Number));

// ---------- pack.mcmeta ----------

/**
 * Liest pack.mcmeta und gibt {gelesen, packFormat, beschreibung, fehler} zurueck.
 *
 * `quelle` ist der Pfad zum .zip oder zum entpackten Ordner. Beides wird
 * behandelt, weil Minecraft beide Formen im resourcepacks/ liegen laesst und
 * der Launcher nicht erzwingen kann, welche davon vorliegt.
 *
 * Es sind drei Befunde, nicht zwei, und jeder braucht einen anderen Text:
 *
 *   gelesen=true                     pack.mcmeta gefunden und gelesen
 *   gelesen=false, fehler=null       es gibt keine pack.mcmeta — Minecraft
 *                                    kann das Paket trotzdem laden (er nutzt
 *                                    dann Standardwerte), aber es fehlt etwas
 *   gelesen=false, fehler="..."      die Datei selbst ist nicht lesbar; das
 *                                    ist ein Fehler und kein Merkmal
 *
 * Geworfen wird bei keinem Fall. Ein defektes Paket soll der Benutzer sehen und
 * loeschen koennen, nicht stattdessen einen Programmabsturz bekommen.
 */
function packMeta(quelle, istOrdner) {
  try {
    let roh = null;
    if (istOrdner) {
      const datei = path.join(quelle, 'pack.mcmeta');
      if (!istDatei(datei)) return { gelesen: false, packFormat: null, beschreibung: null };
      roh = fs.readFileSync(datei);
    } else {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(quelle);
      const eintrag = zip.getEntry('pack.mcmeta');
      if (!eintrag) return { gelesen: false, packFormat: null, beschreibung: null };
      roh = eintrag.getData();
    }
    const pack = JSON.parse(roh.toString('utf8')).pack;
    if (!pack || typeof pack !== 'object') return { gelesen: false, packFormat: null, beschreibung: null };
    const format = Number(pack.pack_format);
    return {
      gelesen: true,
      packFormat: Number.isFinite(format) ? format : null,
      beschreibung: typeof pack.description === 'string' && pack.description.trim()
        ? pack.description.trim()
        : null
    };
  } catch (err) {
    return { gelesen: false, packFormat: null, beschreibung: null, fehler: err.message };
  }
}

/**
 * Ordnet pack_format einen Versions-Text zu.
 *
 * Gibt null zurueck statt 'unbekannt', wenn die Zahl in FORMAT_VERSION steht —
 * der Aufrufer (die Oberflaeche) uebersetzt dann. Kein deutscher Satz von hier
 * nach oben: dieselbe Regel wie bei worlds.js, sonst steht bei englischer
 * Sprache ein deutscher Text neben dem Paket.
 *
 * `neu` ist ein Flag und kein Text: "neuer als bekannt" ist eine Aussage ueber
 * die Zeit, nicht ueber einen Fehler, und gehoert ins Buch der Oberflaeche.
 */
function formatText(packFormat) {
  if (packFormat == null) return { version: null, neu: false };
  const eintrag = FORMAT_VERSION[packFormat];
  if (eintrag) return { version: eintrag, neu: false };
  return { version: null, neu: packFormat > LETZTES_FORMAT };
}

// ---------- Vorschaubild ----------

// Obergrenze fuer das eingebettete Vorschaubild. pack.png ist normalerweise
// 64x64 (wenige KB). Groessere Dateien werden NICHT eingebettet, damit die
// Paketliste nicht megabyteweise Daten durch den IPC-Kanal schaufelt.
const BILD_MAX_BYTES = 256 * 1024;

/**
 * Liest pack.png aus einem Paket und gibt es als Data-URL zurueck.
 *
 * null bedeutet: kein pack.png, zu gross oder nicht lesbar. Ein fehlendes
 * Vorschaubild ist keine Stoerung — die Oberflaeche zeigt dann das
 * Standardsymbol. Deshalb wird hier nichts geworfen.
 *
 * Bei einem .zip wird das Archiv ein zweites Mal geoeffnet (packMeta braucht
 * es schon einmal). Das ist bewusst in Kauf genommen: die Alternative waere,
 * die beiden Auslesevorgaenge zu verschmelzen und dafuer zwei getrennte
 * Zustaendigkeiten (Metadaten und Bild) in eine Funktion zu ziehen.
 */
function packBild(quelle, istOrdner) {
  try {
    let roh = null;
    if (istOrdner) {
      const datei = path.join(quelle, 'pack.png');
      if (!istDatei(datei) || dateiGroesse(datei) > BILD_MAX_BYTES) return null;
      roh = fs.readFileSync(datei);
    } else {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(quelle);
      const eintrag = zip.getEntry('pack.png');
      if (!eintrag) return null;
      roh = eintrag.getData();
      if (!roh || roh.length > BILD_MAX_BYTES) return null;
    }
    if (!roh || !roh.length) return null;
    return 'data:image/png;base64,' + roh.toString('base64');
  } catch (err) {
    return null;
  }
}

// ---------- Ordner ----------

function packsOrdner(instanzOrdner) {
  return path.join(instanzOrdner, ORDNER);
}

function dateiGroesse(pfad) {
  try {
    return fs.statSync(pfad).size || 0;
  } catch (err) {
    return 0;
  }
}

// existsSync() allein reicht nicht: es beantwortet nur "irgendetwas steht da".
// Beim Loeschen wird aber genau das gebraucht — ein Ordner mit .zip im Namen
// darf nicht als Paketdatei behandelt werden. Die beiden Helfer sind deshalb
// getrennt, und beide fangen einen Fehler des Dateisystems ab: eine Datei, die
// zwischen readdir und stat verschwindet, darf kein Absturz sein.
function istDatei(pfad) {
  try {
    return fs.statSync(pfad).isFile();
  } catch (err) {
    return false;
  }
}

function istOrdner_(pfad) {
  try {
    return fs.statSync(pfad).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Groesse eines entpackten Paketordners in Bytes.
 *
 * Ohne Symbolverfolgung: jeder Eintrag wird einzeln auf isDirectory/isFile
 * geprueft, ein Link wird also uebersprungen statt verfolgt. Die Tiefenschranke
 * faengt zyklische Baeume ab.
 */
function ordnerGroesse(wurzel, tiefe = 0) {
  if (tiefe > 12) return 0;
  let summe = 0;
  let eintraege = [];
  try {
    eintraege = fs.readdirSync(wurzel, { withFileTypes: true });
  } catch (err) {
    return 0;
  }
  for (const eintrag of eintraege) {
    const voll = path.join(wurzel, eintrag.name);
    if (eintrag.isDirectory()) summe += ordnerGroesse(voll, tiefe + 1);
    else if (eintrag.isFile()) summe += dateiGroesse(voll);
  }
  return summe;
}

/**
 * Alle Pakete einer Instanz, alphabetisch nach Ordnername.
 *
 * Der Ordnername ist der Identifier, den options.txt kennt. Er muss ein
 * einzelner Pfadabschnitt sein, sonst waere ueber den Renderer ein fremder
 * Pfad lesbar und loeschbar. Die Pruefung steht hier und nicht erst beim
 * Loeschen, weil der Name auch in der Anzeige landet.
 *
 * Zurueckgegeben wird ein Objekt, kein reines Array: die Sortierung braucht
 * Platz fuer die Namenskonflikte (siehe unten), und ein stillschweigend
 * verschwundenes Paket waere schlimmer als eine Meldung.
 */
function listPacks(instanzOrdner) {
  const leer = { packs: [], konflikte: [] };
  const ordner = packsOrdner(instanzOrdner);
  if (!fs.existsSync(ordner)) return leer;

  let eintraege = [];
  try {
    eintraege = fs.readdirSync(ordner, { withFileTypes: true });
  } catch (err) {
    return leer;
  }

  const aktiv = aktiveNamen(instanzOrdner);
  const packs = [];
  const konflikte = [];

  for (const eintrag of eintraege) {
    if (eintrag.name.startsWith('.')) continue;      // Punktordner, .DS_Store, ...
    const istOrdner = eintrag.isDirectory();
    const istZip = !istOrdner && /\.zip$/i.test(eintrag.name);
    if (!istOrdner && !istZip) continue;             // alles andere gehoert nicht dazu

    const basis = istOrdner ? eintrag.name : eintrag.name.replace(/\.zip$/i, '');
    if (!istGueltigerName(basis)) continue;

    // "Foo.zip" und "Foo/" ergeben fuer Minecraft denselben Identifier "Foo" —
    // es laedt eines von beiden und das andere nie, und welches es ist, steht
    // in keiner Datei. Deshalb wird hier keiner von beiden ausgewaehlt und
    // keiner ausgeblendet: beide sind echte Dateien, die der Benutzer abgelegt
    // hat. Die Doppelung wird gleich unten markiert.
    const voll = path.join(ordner, eintrag.name);
    const meta = packMeta(voll, istOrdner);
    const format = formatText(meta.packFormat);
    packs.push({
      id: basis,
      name: basis,
      art: istOrdner ? 'ordner' : 'zip',
      datei: eintrag.name,
      groesseBytes: istOrdner ? ordnerGroesse(voll) : dateiGroesse(voll),
      packFormat: meta.packFormat,
      version: format.version,
      // true heisst "pack_format ist groesser als jede Zahl, die wir kennen".
      versionNeu: format.neu,
      beschreibung: meta.beschreibung,
      // pack.png als Data-URL, sonst null. Die Oberflaeche zeigt es statt
      // des Standard-Symbols an.
      bild: packBild(voll, istOrdner),
      // Ein defektes .zip wird als solches gemeldet statt aus der Liste
      // entfernt — sonst fragt sich der Benutzer, wo sein Paket geblieben ist.
      defekt: Boolean(meta.fehler),
      // false heisst: es ist keine pack.mcmeta lesbar. Anders als defekt ist
      // das kein Fehler, sondern eine Luecke, die es in der Anzeige zu nennen
      // gilt (die Oberflaeche uebersetzt den Text).
      hatMeta: meta.gelesen,
      aktiv: aktiv.includes(basis),
      // Wird gleich unten gesetzt, sobald klar ist, dass es den Namen doppelt gibt.
      konflikt: false
    });
  }

  // Wer den doppelten Namen hat, bekommt gemeldet, dass der Schalter nicht
  // auswaehlt, sondern beide Formen gemeinsam trifft. Ohne diese Markierung
  // wuerde der Benutzer das eine einschalten und sich wundern, warum das andere
  // im Spiel trotzdem wirkt — je nachdem, welches Minecraft geladen hat.
  const mehrfach = new Map();
  for (const pack of packs) mehrfach.set(pack.id, (mehrfach.get(pack.id) || 0) + 1);
  for (const pack of packs) {
    if (mehrfach.get(pack.id) > 1) {
      pack.konflikt = true;
      konflikte.push({ id: pack.id, datei: pack.datei, art: pack.art });
    }
  }

  packs.sort((a, b) => a.id.localeCompare(b.id, 'de'));
  konflikte.sort((a, b) => a.datei.localeCompare(b.datei, 'de'));
  return { packs, konflikte };
}

// ---------- options.txt ----------

function optionsPfad(instanzOrdner) {
  return path.join(instanzOrdner, 'options.txt');
}

/**
 * Holt die Packnamen aus options.txt.
 *
 * Toleranz ist hier wichtig, weil Minecraft die Datei selbst schreibt und die
 * Form sich je nach Version unterscheidet. Angefunden wird:
 *   - resourcePacks:["vanilla","file/X"]     (1.13 und neuer, JSON-Array)
 *   - resourcePacks:vanilla,file/X            (aeltere Form, Komma-Liste)
 * Ist die Zeile unlesbar, wird ["vanilla"] geliefert statt geworfen: eine
 * kaputte options.txt darf das Programm nicht anhalten.
 */
function parsePacks(roh) {
  const zeile = roh.split(/\r?\n/).find(z => z.trim().startsWith(SCHLUESSEL + ':'));
  if (!zeile) return [VANILLA];
  const wert = zeile.slice(zeile.indexOf(':') + 1).trim();
  if (!wert) return [VANILLA];

  if (wert.startsWith('[')) {
    // Beginnt der Wert mit einer Klammer, ist JSON gemeint. Schlaegt das
    // Scheitern fehl, ist die Zeile kaputt — und dann wird sie NICHT mehr als
    // Komma-Liste gelesen. Das war ein Fehler: aus resourcePacks:["kaputt
    // (abgeschnitten) wurde so der Paketname "kaputt", und jedes Paket, das
    // gerade so heisst, gaelte als eingeschaltet.
    try {
      const arr = JSON.parse(wert);
      if (Array.isArray(arr)) {
        const namen = arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
        if (namen.length) return namen;
      }
    } catch (err) { /* kaputt: siehe oben */ }
    return [VANILLA];
  }

  const namen = wert.split(',')
    .map(x => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return namen.length ? namen : [VANILLA];
}

/**
 * Liest options.txt.
 *
 * Fehlt die Datei, ist `vorhanden` false und `packs` ist ["vanilla"] — denn
 * ohne die Zeile laeuft das Spiel zwar, aber ohne die Standardtexturen. Ob das
 * gemeldet wird, entscheidet der Aufrufer.
 */
function readOptions(instanzOrdner) {
  const datei = optionsPfad(instanzOrdner);
  let roh = '';
  try {
    roh = fs.readFileSync(datei, 'utf8');
  } catch (err) {
    return { vorhanden: false, packs: [VANILLA], zeilen: null, crlf: false };
  }
  const zeilen = roh.split(/\r?\n/);
  // Genau EIN leeres Element hinten abschneiden: es ist die Spur des
  // abschliessenden Zeilenumbruchs, nicht eine Leerzeile der Datei. Ohne das
  // wuerde jeder Schreibvorgang eine Leerzeile anhaengen — gemessen war das so:
  // nach vier Umschaltvorgaengen hatte die 39-zeilige Vorlage 43 Zeilen, und
  // die Datei war nicht mehr byteweise auf den Ausgangszustand zurueckzubringen.
  // Echte Leerzeilen in der Mitte bleiben unberuehrt, denn die liegen nicht am
  // Ende.
  if (zeilen.length && zeilen[zeilen.length - 1] === '') zeilen.pop();

  return {
    vorhanden: true,
    packs: parsePacks(roh),
    zeilen,
    // Gemessen statt geraten: Minecraft schreibt \n, eine von Hand bearbeitete
    // Datei kann \r\n haben, und die Datei soll danach nicht halb umgestellt
    // dastehen.
    crlf: roh.includes('\r\n')
  };
}

/**
 * Die Ordnernamen, die options.txt gerade als eingeschaltet nennt — ohne
 * "file/". Das ist die Antwort auf "ist dieses Paket aktiv".
 */
function aktiveNamen(instanzOrdner) {
  return readOptions(instanzOrdner).packs
    .filter(n => n !== VANILLA)
    .map(n => n.replace(/^file\//, ''))
    .filter(n => n && istGueltigerName(n));
}

// ---------- Schreiben ----------

/**
 * Baut den options.txt-Eintrag aus einer Liste von Ordnernamen.
 */
function eintragBauen(namen) {
  const liste = [VANILLA, ...namen.filter(n => n !== VANILLA).map(n => 'file/' + n)];
  return SCHLUESSEL + ':' + JSON.stringify(liste);
}

/**
 * Ersetzt genau die resourcePacks-Zeile — oder ergaenzt sie am Ende.
 *
 * Nur diese eine Zeile wird angefasst. Reihenfolge, Kommentare und alle
 * anderen Optionen bleiben, wie sie waren.
 */
function optionsSchreiben(instanzOrdner, zeilen, eintrag, crlf) {
  const vorlage = Array.isArray(zeilen) ? zeilen : [];
  const umbruch = crlf ? '\r\n' : '\n';
  const stelle = vorlage.findIndex(z => z.trim().startsWith(SCHLUESSEL + ':'));

  let neu;
  if (stelle >= 0) {
    neu = vorlage.slice();
    neu[stelle] = eintrag;
  } else {
    // Fehlt die Zeile, wird sie angehaengt statt eingeschoben: wer die Datei
    // von Hand pflegt, freut sich ueber ein Ende statt ueber einen Block mitten
    // drin. Minecraft liest sie zeilenweise und ist auf die Reihenfolge nicht
    // angewiesen.
    neu = [...vorlage.filter(z => z.trim() !== ''), eintrag];
  }

  // Der abschliessende Zeilenumbruch bleibt erhalten. Ohne ihn nimmt das Spiel
  // die letzte Zeile nicht mit. readOptions() hat die Spur des vorhandenen
  // Umbruchs schon abgeschnitten, deshalb wird er hier genau einmal gesetzt.
  const text = neu.join(umbruch) + umbruch;
  fs.writeFileSync(optionsPfad(instanzOrdner), text, 'utf8');
  return text;
}

/**
 * Schaltet ein Paket ein oder aus und schreibt options.txt.
 *
 * Die Reihenfolge der schon eingeschalteten Pakete bleibt erhalten; ein neu
 * eingeschaltetes kommt hinten an. Das ist sichtbar, wenn man die Datei oeffnet,
 * und es ist harmlos — Minecraft probiert alle Eintraege durch.
 *
 * Ob die Pakete wirklich existieren, wird nicht geprueft. Eine options.txt, die
 * auf ein geloeschtes Paket zeigt, ist harmlos: Minecraft ueberspringt den
 * Eintrag still. Dagegen ist jeder Name ein einzelner Pfadabschnitt — dort
 * waere ein fremder Pfad erreichbar.
 *
 * Gibt zurueck, ob sich die Datei wirklich geaendert hat, damit der Aufrufer
 * nicht grundlos speichert und dem Benutzer kein "gespeichert" vortaeuscht.
 */
function setPackAktiv(instanzOrdner, id, an) {
  if (!istGueltigerName(id)) throw new Error('Ungültiger Paketname.');
  const { packs, zeilen, crlf } = readOptions(instanzOrdner);

  const ohne = packs
    .filter(n => n !== VANILLA)
    .map(n => n.replace(/^file\//, ''))
    .filter(n => n && istGueltigerName(n) && n !== id);

  const neu = an ? [...ohne, id] : ohne;
  const eintrag = eintragBauen(neu);
  const vorher = optionsText(instanzOrdner);
  const jetzt = optionsSchreiben(instanzOrdner, zeilen, eintrag, crlf);

  return { geaendert: jetzt !== vorher, packs: neu, eintrag };
}

/** Der aktuelle Text von options.txt, oder null, wenn es keine Datei gibt. */
function optionsText(instanzOrdner) {
  try {
    return fs.readFileSync(optionsPfad(instanzOrdner), 'utf8');
  } catch (err) {
    return null;
  }
}

// ---------- Loeschen ----------

/**
 * Loescht ein Paket und nimmt es aus resourcePacks heraus.
 *
 * Die Reihenfolge ist Absicht: erst aus der Schalterliste, dann die Datei.
 * Wuerde es umgekehrt machen und der Schreibvorgang scheitern, zeigte
 * options.txt auf eine Datei, die nicht mehr da ist.
 *
 * Beide Formen werden angefasst, aber nur die, die es gibt. `verdeckt` ist true,
 * wenn es beide gab und Minecraft ohnehin nur eine geladen haette — dann wurde
 * beim Loeschen eine echte Datei entfernt, auch wenn der Schalter schon auf
 * den anderen Namen zeigte.
 */
function removePack(instanzOrdner, id) {
  if (!istGueltigerName(id)) throw new Error('Ungültiger Paketname.');
  const ordner = packsOrdner(instanzOrdner);

  const zip = path.join(ordner, id + '.zip');
  const sub = path.join(ordner, id);
  const zipDa = istDatei(zip);
  const ordnerDa = istOrdner_(sub);

  if (zipDa) fs.rmSync(zip, { force: true });
  if (ordnerDa) fs.rmSync(sub, { recursive: true, force: true });

  const { packs, zeilen, crlf } = readOptions(instanzOrdner);
  const ohne = packs
    .filter(n => n !== VANILLA)
    .map(n => n.replace(/^file\//, ''))
    .filter(n => n !== id);

  // Auch wenn keine Datei da war: ein toter Eintrag wird bereinigt, sonst
  // zeigt options.txt auf etwas, das es nicht mehr gibt.
  //
  // Verglichen wird gegen die Liste OHNE "vanilla" — sonst waere jeder Vergleich
  // schon deshalb ungleich, und die Datei wuerde bei jedem Loeschen
  // neu geschrieben, auch ohne Aenderung.
  const vorher = packs.filter(n => n !== VANILLA).map(n => n.replace(/^file\//, '')).filter(Boolean);
  const geaendert = vorher.length !== ohne.length || vorher.some((n, i) => n !== ohne[i]);
  if (zeilen && geaendert) {
    optionsSchreiben(instanzOrdner, zeilen, eintragBauen(ohne), crlf);
  }

  return {
    entfernt: zipDa || ordnerDa,
    // true heisst: es gab beide Formen, und Minecraft laedt ohnehin nur eine.
    verdeckt: zipDa && ordnerDa,
    verbleibend: ohne
  };
}

// ---------- Import ----------

/**
 * Kopiert eine .zip-Datei nach resourcepacks/.
 *
 * Ein vorhandenes Paket mit demselben Namen wird ersetzt, ohne Rueckfrage —
 * genau so wie mods:importLocal es macht. Das ist hier auch richtig: der
 * haeufigste Grund fuer einen zweiten Import ist ein Update desselben Pakets,
 * und da soll die alte Datei verschwinden, nicht als "-2" danebenliegen.
 */
function importZip(instanzOrdner, quelle) {
  const ordner = packsOrdner(instanzOrdner);
  fs.mkdirSync(ordner, { recursive: true });

  const basis = path.basename(quelle).replace(/\.zip$/i, '');
  if (!istGueltigerName(basis)) throw new Error('Ungültiger Dateiname für ein Paket.');

  const ziel = path.join(ordner, basis + '.zip');
  fs.copyFileSync(quelle, ziel);
  return { id: basis, datei: basis + '.zip' };
}

// ---------- Pfad-Pruefung ----------

/**
 * Ein Paketname muss ein einzelner Pfadabschnitt sein.
 *
 * Dieselbe Regel wie bei den Weltordnern (worlds.js): der Name kommt aus dem
 * Renderer, und ".." wuerde aus resourcepacks/ herausfuehren. removePack() und
 * setPackAktiv() benutzen diesen Namen fuer Pfade, die Pruefung ist dort also
 * Pflicht und nicht Kosmetik.
 */
function istGueltigerName(name) {
  if (typeof name !== 'string' || !name || name.length > 120) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/]/.test(name)) return false;        // auch Backslash: Windows teilt darauf
  if (name.includes('\0')) return false;
  if (name.startsWith('.')) return false;      // Punktdateien
  if (name.includes(':')) return false;       // unter Windows Alternate Data Stream
  return true;
}

module.exports = {
  ORDNER,
  VANILLA,
  SCHLUESSEL,
  FORMAT_VERSION,
  LETZTES_FORMAT,
  packsOrdner,
  optionsPfad,
  listPacks,
  aktiveNamen,
  readOptions,
  parsePacks,
  setPackAktiv,
  removePack,
  importZip,
  packMeta,
  packBild,
  BILD_MAX_BYTES,
  formatText,
  istGueltigerName
};