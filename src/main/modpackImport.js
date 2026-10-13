// src/main/modpackImport.js
//
// Bestehende Modpacks importieren: .mrpack (Modrinth) und .zip aus
// CurseForge (manifest.json). Das Modul ist bewusst frei von electron,
// damit es unter reinem Node geprueft werden kann (test-modpack-import.js) —
// dieselbe Regel wie bei resourcepacks.js und worlds.js.
//
// Was das Modul kann:
//   - erkenneFormat(): welches Modpack-Format steckt in dem Zip?
//   - leseMrpack() / leseCurseManifest(): Metadaten + Dateiliste auslesen
//   - installiereMrpack() / installiereCurseForge(): entpacken und Dateien
//     laden. Die Download-Funktion wird injiziert, damit das Modul ohne Netz
//     pruefbar bleibt; der echte Aufrufer steckt die HTTP-Logik hinein.
//   - modpackAusDatei(): Zusammenfassung fuer die Oberflaeche
//
// Sicherheit (Zip-Slip-Schutz), die oberste Regel dieses Moduls:
//   JEDER entpackte oder geschriebene Pfad muss innerhalb des Zielordners
//   liegen. Eintraege mit "..", absoluten Pfaden, Laufwerksbuchstaben oder
//   leeren Segmenten werden ABGELEHNT — und zwar bevor irgendetwas
//   geschrieben wird. Es darf nie etwas ausserhalb des Zielordners landen.
//   Der Test baut dazu bewusst ein Zip mit rohen Eintragsnamen, wie es ein
//   boeswilliges Zip von aussen enthaelt (adm-zip saeubert beim SCHREIBEN
//   selbst; ein Angreifer schreibt aber roh, und genau dafuer ist der
//   Schutz da — Messung siehe test-modpack-import.js).
//
// Schreibweise der Kommentare: ae/oe/ue, siehe instances.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const INDEX_MRPACK = 'modrinth.index.json';
const MANIFEST_CURSE = 'manifest.json';
// Ordner, die ein Modpack im Zip mitbringt und die 1:1 in die Instanz
// geschrieben werden. Reihenfolge ist Absicht: bei gleichem Namen gewinnt
// der spaetere Eintrag, bei Modrinth also client-overrides ueber overrides.
const OVERRIDES_MRPACK = ['overrides', 'client-overrides'];
const OVERRIDES_CURSE = ['overrides'];
// Prism Launcher / MultiMC: Marker-Dateien und der Ordner mit dem Spielstand.
const MMC_PACK = 'mmc-pack.json';
const MMC_CFG = 'instance.cfg';
const MMC_ORDNER = ['.minecraft', 'minecraft'];

// Modloader-Namen, die der Launcher beim Start kennt (instances.js). Alles
// andere kann ein Modpack verlangen (quilt, neoforge), aber gestartet werden
// kann es damit hier nicht — das ist eine ehrliche Grenze, keine Erfindung.
const STARTER_LOADER = ['vanilla', 'fabric', 'forge'];

// ---------- Formaterkennung ----------

/**
 * Welches Modpack-Format steckt in dem Zip?
 *
 *   'mrpack'     wenn modrinth.index.json enthalten ist
 *   'curseforge' wenn manifest.json UND ein overrides/-Eintrag enthalten sind
 *   null         sonst (auch wenn die Datei gar kein Zip ist)
 *
 * Die Erkennung wirft nie: eine unlesbare Datei ist kein Programmabsturz.
 */
function erkenneFormat(zipPfad) {
  let zip;
  try {
    zip = new AdmZip(zipPfad);
  } catch (err) {
    return null;
  }
  try {
    if (findeBasis(zip, INDEX_MRPACK) !== null) return 'mrpack';
    const basisCurse = findeBasis(zip, MANIFEST_CURSE);
    if (basisCurse !== null && istCurseManifest(zip, basisCurse)) return 'curseforge';
    if (findeBasis(zip, MMC_PACK) !== null || findeBasis(zip, MMC_CFG) !== null) return 'prism';
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * Ordner, in dem eine Marker-Datei (z. B. manifest.json) im Zip liegt.
 * '' = ganz oben, 'Name/' = in genau einem Wurzelordner (so entsteht ein Zip,
 * wenn jemand einen Ordner packt statt seines Inhalts), null = nicht da.
 * Tiefer geschachtelt wird bewusst nicht gesucht: sonst wuerde die
 * manifest.json einer Mod im Pack als Modpack-Manifest gelten.
 */
function findeBasis(zip, name) {
  const namen = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName);
  if (namen.includes(name)) return '';
  const treffer = namen.find((n) => n.endsWith('/' + name) && n.split('/').length === 2);
  return treffer ? treffer.slice(0, treffer.length - name.length) : null;
}

/**
 * Ist diese manifest.json das Manifest eines CurseForge-Modpacks?
 * Vorher entschied der overrides-Ordner. Der fehlt aber bei Packs ohne
 * eigene Configs, und genau die wurden als "kein Modpack" abgelehnt.
 * Jetzt entscheidet der Inhalt der Datei.
 */
function istCurseManifest(zip, basis) {
  try {
    const m = JSON.parse(zip.getEntry(basis + MANIFEST_CURSE).getData().toString('utf8'));
    if (!m || typeof m !== 'object') return false;
    if (m.manifestType === 'minecraftModpack') return true;
    return Boolean(m.minecraft && typeof m.minecraft === 'object' && Array.isArray(m.files));
  } catch (err) {
    return false;
  }
}

/** Override-Ordner im Zip (mit Wurzelordner-Praefix) fuer ein Format. */
function overridePraefixe(zipPfad, format) {
  const zip = zipOeffnen(zipPfad);
  if (format === 'mrpack') {
    const b = findeBasis(zip, INDEX_MRPACK) || '';
    return OVERRIDES_MRPACK.map((o) => b + o);
  }
  if (format === 'curseforge') {
    const b = findeBasis(zip, MANIFEST_CURSE) || '';
    let ordner = 'overrides';
    try {
      const m = JSON.parse(zip.getEntry(b + MANIFEST_CURSE).getData().toString('utf8'));
      if (m && typeof m.overrides === 'string') {
        const sauber = m.overrides.replace(/^\/+|\/+$/g, '');
        if (sauber && !sauber.split('/').includes('..')) ordner = sauber;
      }
    } catch (err) { /* Standardname */ }
    return [b + ordner];
  }
  if (format === 'prism') {
    const b = (findeBasis(zip, MMC_PACK) ?? findeBasis(zip, MMC_CFG)) || '';
    return MMC_ORDNER.map((o) => b + o);
  }
  return [];
}

/** Zip oeffnen; wirft mit lesbarer Meldung, wenn es keines ist. */
function zipOeffnen(zipPfad) {
  try {
    return new AdmZip(zipPfad);
  } catch (err) {
    throw new Error('Die Datei ist kein lesbares Zip-Archiv: ' + (err && err.message));
  }
}

function eintragJson(zip, name) {
  const eintrag = zip.getEntry(name);
  if (!eintrag) throw new Error(`Das Archiv enthaelt keine Datei "${name}".`);
  let roh;
  try {
    roh = eintrag.getData().toString('utf8');
  } catch (err) {
    throw new Error(`"${name}" ist im Archiv nicht lesbar: ${err && err.message}`);
  }
  try {
    return JSON.parse(roh);
  } catch (err) {
    throw new Error(`"${name}" ist kein gueltiges JSON: ${err && err.message}`);
  }
}

// ---------- Modloader-Normalisierung ----------

/**
 * Modloader aus den Dependencies eines Modrinth-Packs.
 *
 * Ein Modrinth-Pack nennt den Loader ueber einen Dependency-Namen
 * (fabric-loader, quilt-loader, forge, neoforge), nicht ueber eine
 * Kategorie. Normalisiert wird auf die Kuerzel, die die Oberflaeche kennt.
 * Ist keiner gesetzt, ist das Pack Vanilla.
 */
function normalisiereLoader(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') return 'vanilla';
  const reihenfolge = [
    ['neoforge', 'neoforge'],
    ['quilt-loader', 'quilt'],
    ['fabric-loader', 'fabric'],
    ['forge', 'forge']
  ];
  for (const [schluessel, loader] of reihenfolge) {
    if (dependencies[schluessel]) return loader;
  }
  return 'vanilla';
}

/**
 * Modloader aus einer CurseForge-modLoaders-Id.
 *
 * Die Id hat die Form "fabric-0.15.0", "forge-44.1.0" usw. — der Teil vor
 * dem ersten Bindestrich ist der Loader. "minecraft-..." ist Vanilla. Ein
 * unbekannter Praefix wird NICHT erfunden, sondern landet als
 * loaderRoh im Ergebnis, damit die Oberflaeche ehrlich melden kann.
 */
function loaderAusCurseId(id) {
  const roh = String(id == null ? '' : id);
  const praefix = roh.split('-')[0].toLowerCase();
  if (praefix === 'minecraft' || !praefix) return { modloader: 'vanilla', loaderRoh: roh };
  if (STARTER_LOADER.includes(praefix)) return { modloader: praefix, loaderRoh: roh };
  return { modloader: praefix, loaderRoh: roh };
}

// ---------- Pfad-Sicherheit ----------

/**
 * Prueft, ob ein Pfad aus dem Zip sicher in den Zielordner geschrieben
 * werden darf. Gibt den endgueltigen Zielpfad zurueck oder null.
 *
 * ABGELEHNT werden:
 *   - ".."-Segmente (Zip-Slip)
 *   - absolute Pfade (fuehren mit / oder \ an)
 *   - Laufwerksbuchstaben (C:... — unter Windows auch als Segment, denn
 *     "C:foo" schreibt ohne Separierung aufs Laufwerk)
 *   - leere Segmente (Doppel-Slashes, "a//b", fuehrende Slashes)
 *   - "."-Segmente und Steuerzeichen
 *
 * Zusaetzlich misst der letzte Schritt die Aufloesung: path.resolve() muss
 * strikt innerhalb der Basis liegen. Damit ist der Schutz nicht von einer
 * einzigen Pruefstelle abhaengig.
 */
function sichererZielPfad(basis, relativ) {
  if (typeof relativ !== 'string' || !relativ.length) return null;
  if (relativ.includes('\0')) return null;
  if (/^[\\/]/.test(relativ)) return null;              // absolut
  if (/\\\\/.test(relativ)) return null;                // UNC
  const segmente = relativ.split(/[\\/]/);
  for (const teil of segmente) {
    if (teil === '') return null;                       // leere Eintraege
    if (teil === '.' || teil === '..') return null;
    if (teil.includes(':')) return null;                // Laufwerksbuchstabe / ADS
    if (/[\u0000-\u001f]/.test(teil)) return null;      // Steuerzeichen
  }
  const ziel = path.join(basis, ...segmente);
  const norm = path.resolve(basis);
  if (ziel !== norm && !ziel.startsWith(norm + path.sep)) return null;
  return ziel;
}

// ---------- lesen ----------

/**
 * Liest modrinth.index.json.
 *
 * Rueckgabe: { name, versionId, modloader, minecraft, dependencies,
 *              dateien: [{ pfad, sha1, url }] }
 *
 * Die dateien-Liste ist eine Angabe des Packs, was es zum Laufen braucht —
 * die Dateien selbst liegen NICHT im Zip, sondern werden ueber die URLs
 * geladen. Overrides dagegen stecken im Zip.
 */
function leseMrpack(zipPfad) {
  const zip = zipOeffnen(zipPfad);
  const index = eintragJson(zip, (findeBasis(zip, INDEX_MRPACK) || '') + INDEX_MRPACK);
  if (!index || typeof index !== 'object') {
    throw new Error('modrinth.index.json enthaelt kein Objekt.');
  }
  const dependencies = index.dependencies && typeof index.dependencies === 'object'
    ? index.dependencies
    : {};
  const minecraft = typeof dependencies.minecraft === 'string' && dependencies.minecraft
    ? dependencies.minecraft
    : null;
  const dateien = Array.isArray(index.files)
    ? index.files
        .filter((f) => f && typeof f === 'object')
        // Reine Server-Mods (env.client = unsupported) gehoeren nicht in einen
        // Client und koennen ihn beim Start zum Absturz bringen.
        .filter((f) => !(f.env && f.env.client === 'unsupported'))
        .map((f) => ({
          urls: Array.isArray(f.downloads) ? f.downloads.filter((u) => typeof u === 'string' && u) : [],
          pfad: typeof f.path === 'string' ? f.path : '',
          sha1: f.hashes && typeof f.hashes.sha1 === 'string' ? f.hashes.sha1 : null,
          url: Array.isArray(f.downloads) && typeof f.downloads[0] === 'string'
            ? f.downloads[0]
            : null
        }))
        .filter((f) => f.pfad.length > 0)
    : [];
  return {
    name: typeof index.name === 'string' && index.name.trim() ? index.name.trim() : null,
    versionId: typeof index.versionId === 'string' && index.versionId ? index.versionId : null,
    modloader: normalisiereLoader(dependencies),
    minecraft,
    dependencies,
    dateien
  };
}

/**
 * Liest manifest.json eines CurseForge-Packs.
 *
 * Rueckgabe: { name, version, minecraft, modloader, loaderRoh,
 *              dateien: [{ projektId, dateiId, erforderlich, downloadUrl }] }
 */
function leseCurseManifest(zipPfad) {
  const zip = zipOeffnen(zipPfad);
  const manifest = eintragJson(zip, (findeBasis(zip, MANIFEST_CURSE) || '') + MANIFEST_CURSE);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json enthaelt kein Objekt.');
  }
  const mc = manifest.minecraft && typeof manifest.minecraft === 'object' ? manifest.minecraft : {};
  let modloader = 'vanilla';
  let loaderRoh = '';
  if (Array.isArray(mc.modLoaders)) {
    const primaer = mc.modLoaders.find((m) => m && m.primary) || mc.modLoaders[0];
    if (primaer && typeof primaer.id === 'string') {
      const gelesen = loaderAusCurseId(primaer.id);
      modloader = gelesen.modloader;
      loaderRoh = gelesen.loaderRoh;
    }
  }
  const dateien = Array.isArray(manifest.files)
    ? manifest.files
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
          projektId: typeof f.projectID === 'number' ? f.projectID : null,
          dateiId: typeof f.fileID === 'number' ? f.fileID : null,
          erforderlich: f.required !== false,
          downloadUrl: typeof f.downloadUrl === 'string' && f.downloadUrl ? f.downloadUrl : null
        }))
    : [];
  return {
    name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : null,
    version: typeof manifest.version === 'string' && manifest.version ? manifest.version : null,
    minecraft: typeof mc.version === 'string' && mc.version ? mc.version : null,
    modloader,
    loaderRoh,
    dateien
  };
}

// ---------- Zip-Eintraege lesen ----------

/**
 * Nicht-Ordner-Eintraege unter einem Praefix, mit dem Pfad relativ dazu.
 *
 * WICHTIG: die Reihenfolge ist nach PRAEFIX sortiert, nicht nach der
 * Reihenfolge der Eintraege im Zip. Ein Zip-Archiv darf seine Eintraege in
 * beliebiger Reihenfolge fuehren (gemessen: adm-zip.toBuffer() schreibt sie
 * sogar rueckwaerts), und die Installationslogik verlaesst sich darauf, dass
 * Modrinth-client-overrides NACH overrides verarbeitet werden — sonst gewinnt
 * mal der falsche Ordner. Beim Lesen eines echten .mrpack von Modrinth ist
 * das der Unterschied zwischen der gemeldeten und der tatsaechlich
 * benutzten Konfiguration.
 */
function eintraegeUnter(zip, praefixe) {
  const gefunden = [];
  const eintraege = zip.getEntries();
  for (const praefix of praefixe) {
    for (const eintrag of eintraege) {
      if (eintrag.isDirectory) continue;
      const name = eintrag.entryName;
      if (name === praefix) continue;                 // der Ordner selbst
      if (name.startsWith(praefix + '/')) {
        // Der Rest nach dem Praefix ist der eigentliche Dateipfad. Ein
        // Pfad wie "overrides/../x" faellt in der sicheren Pruefung durch.
        gefunden.push({ eintrag, relativ: name.slice(praefix.length + 1) });
      }
    }
  }
  return gefunden;
}

/**
 * Alle Pfade eines Imports vorab pruefen, BEVOR irgendetwas geschrieben
 * wird. Ein einziger unsicherer Pfad lehnt die ganze Datei ab: sonst
 * entstuende ein halb importiertes Modpack, bei dem der Angreifer zumindest
 * erraten kann, welche Dateien es ins Ziel geschafft haben.
 *
 * `pfade` ist die Liste, `wohin` der Zielordner. Rueckgabe: array mit
 * Meldungen (leer = alles sicher).
 */
function unsicherePfade(pfade, wohin) {
  const meldungen = [];
  for (const p of pfade) {
    if (!sichererZielPfad(wohin, p.relativ)) {
      meldungen.push(`Unzulaessiger Pfad im Zip: "${p.relativ}"`);
    }
  }
  return meldungen;
}

// ---------- Installation (gemeinsames Geruest) ----------

/**
 * Gemeinsames Ergebnis aller Installationen: WAS gelang und WAS NICHT.
 *
 *   installiert   Dateien geschrieben bzw. geladen
 *   uebersprungen Dateien, die schon da waren (und nicht ueberschrieben
 *                 werden sollten)
 *   fehler        menschenlesbare Meldungen zu allem, was nicht ging —
 *                 nichts wird still verschluckt
 *   abgelehnt     true, wenn die Datei wegen unsicherer Pfade GAR NICHT
 *                 installiert wurde (Zip-Slip-Schutz)
 */
function startErgebnis() {
  return { installiert: 0, uebersprungen: 0, fehler: [], abgelehnt: false };
}

/**
 * Overrides aus dem Zip in den Zielordner schreiben.
 *
 * `ueberschreiben` gilt nur fuer Dateien, die VOR diesem Lauf auf der Platte
 * lagen. Was derselbe Lauf schon geschrieben hat (ueberlappende Para…uxe
 * zwischen zwei Override-Ordnern), wird immer ersetzt, damit die
 * spaetere Quelle gewinnt (Modrinth: client-overrides > overrides).
 */
function overridesSchreiben(ziel, zip, praefixe, ueberschreiben, ergebnis) {
  const geschrieben = new Set();
  for (const { eintrag, relativ } of eintraegeUnter(zip, praefixe)) {
    const zielPfad = sichererZielPfad(ziel, relativ);
    if (!zielPfad) continue; // wurde vorab geprueft; doppelte Absicherung
    if (!ueberschreiben && fs.existsSync(zielPfad) && !geschrieben.has(zielPfad)) {
      ergebnis.uebersprungen++;
      continue;
    }
    let daten;
    try {
      daten = eintrag.getData();
    } catch (err) {
      ergebnis.fehler.push(`Override "${relativ}" nicht lesbar: ${err && err.message}`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
      fs.writeFileSync(zielPfad, daten);
      geschrieben.add(zielPfad);
      ergebnis.installiert++;
    } catch (err) {
      ergebnis.fehler.push(`Override "${relativ}" nicht schreibbar: ${err && err.message}`);
    }
  }
}

/**
 * Eine Datei ueber die injizierte Download-Funktion nachladen.
 *
 * Die Funktion `ladeDatei(url, sha1Soll, zielPfad)` laedt und verifiziert
 * (SHA1) und SCHREIBT die Datei nach zielPfad; das Verzeichnis davor legt
 * dieses Modul an, damit der Injectable sich darauf verlassen kann.
 */
async function dateiLaden(ziel, relativ, url, sha1, ladeDatei, ueberschreiben, ergebnis, extra) {
  const zielPfad = sichererZielPfad(ziel, relativ);
  if (!zielPfad) {
    ergebnis.fehler.push(`Unzulaessiger Zielpfad fuer "${relativ}"`);
    return;
  }
  if (!ueberschreiben && fs.existsSync(zielPfad)) {
    ergebnis.uebersprungen++;
    return;
  }
  // Mehrere Adressen (Modrinth nennt Spiegel) der Reihe nach versuchen,
  // statt beim ersten Fehler aufzugeben.
  const kandidaten = extra && Array.isArray(extra.urls) && extra.urls.length
    ? extra.urls
    : (url ? [url] : []);
  if (!kandidaten.length) {
    ergebnis.fehler.push(`Keine Download-Adresse fuer "${relativ}"`);
    return;
  }
  let letzterFehler = null;
  for (const adresse of kandidaten) {
    try {
      fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
      const antwort = await ladeDatei(adresse, sha1 || null, zielPfad);
      ergebnis.installiert++;
      // Name unbekannt (CurseForge ohne API): der Download nennt ihn.
      if (extra && extra.umbenennen && antwort && typeof antwort.dateiname === 'string') {
        const name = path.basename(antwort.dateiname);
        if (name && /\.jar$/i.test(name)) {
          const neu = sichererZielPfad(ziel, path.join(path.dirname(relativ), name));
          if (neu && neu !== zielPfad) {
            try { fs.renameSync(zielPfad, neu); } catch (err) { /* alter Name bleibt, Datei ist da */ }
          }
        }
      }
      return;
    } catch (err) {
      letzterFehler = err;
    }
  }
  ergebnis.fehler.push(`"${relativ}": ${letzterFehler && letzterFehler.message ? letzterFehler.message : String(letzterFehler)}`);
}

/**
 * Gemeinsamer Einstieg: Vorab-Pfadpruefung, dann Overrides, dann Downloads.
 */
async function installieren(ziel, zipPfad, praefixe, downloads, ladeDatei, optionen) {
  const zip = zipOeffnen(zipPfad);
  const ueberschreiben = Boolean(optionen && optionen.ueberschreiben);
  const ergebnis = startErgebnis();

  const zuPruefen = eintraegeUnter(zip, praefixe)
    .map(({ relativ }) => ({ relativ }))
    .concat(downloads.map((d) => ({ relativ: d.pfad })));

  const abgelehnt = unsicherePfade(zuPruefen, ziel);
  if (abgelehnt.length) {
    ergebnis.abgelehnt = true;
    ergebnis.fehler.push(
      'Diese Modpack-Datei wurde wegen unsicherer Pfade NICHT installiert (Zip-Slip-Schutz).'
    );
    ergebnis.fehler.push(...abgelehnt);
    return ergebnis;
  }

  overridesSchreiben(ziel, zip, praefixe, ueberschreiben, ergebnis);
  for (const d of downloads) {
    await dateiLaden(ziel, d.pfad, d.url, d.sha1, ladeDatei, ueberschreiben, ergebnis, d);
  }
  return ergebnis;
}

// ---------- Installation: Modrinth-Modpack ----------

/**
 * Ein .mrpack in einen Instanzordner installieren.
 *
 *   zielDir   absoluter Instanzordner (muss schon existieren oder angelegt
 *             werden koennen — der Aufrufer hat ihn mit instances.anlegen
 *             erzeugt)
 *   zipPfad   Pfad zur .mrpack-Datei
 *   ladeDatei injizierte Download-Funktion (url, sha1Soll, zielPfad)
 *   optionen  { ueberschreiben: bool } — schon vorhandene Dateien ersetzen?
 *
 * Rueckgabe: { installiert, uebersprungen, fehler, abgelehnt }
 */
async function installiereMrpack(zielDir, zipPfad, ladeDatei, optionen) {
  const pack = leseMrpack(zipPfad);
  const downloads = pack.dateien.map((f) => ({ pfad: f.pfad, url: f.url, urls: f.urls, sha1: f.sha1 }));
  return installieren(zielDir, zipPfad, overridePraefixe(zipPfad, 'mrpack'), downloads, ladeDatei, optionen);
}

/**
 * Generischer Recycler fuer CurseForge: hoelt den Dateinamen aus einer URL.
 */
function dateinameAusUrl(url) {
  try {
    const ohneQuery = String(url).split('?')[0];
    return decodeURIComponent(ohneQuery.slice(ohneQuery.lastIndexOf('/') + 1)) || null;
  } catch (err) {
    return null;
  }
}

/**
 * Ein CurseForge-Zip in einen Instanzordner installieren.
 *
 *   zielDir   absoluter Instanzordner
 *   zipPfad   Pfad zum .zip mit manifest.json
 *   loeseUrl  (projektId, dateiId) => { url, dateiname, sha1 } — aufloesen
 *             der CurseForge-Datei ueber die API; null, wenn kein
 *             API-Schluessel vorhanden ist. Dann funktioniert der Import
 *             nur fuer Eintraege mit eingebetteter downloadUrl, alles
 *             andere wird ehrlich als Fehler gemeldet.
 *   ladeDatei injizierte Download-Funktion (url, sha1Soll, zielPfad)
 *   optionen  { ueberschreiben, unterordner } — unterordner (Standard
 *             'mods') ist der Zielordner fuer die geladenen Dateien; die
 *             Overrides gehen immer direkt in den Instanzordner.
 *
 * Rueckgabe: { installiert, uebersprungen, fehler, abgelehnt }
 */
async function installiereCurseForge(zielDir, zipPfad, loeseUrl, ladeDatei, optionen) {
  const manifest = leseCurseManifest(zipPfad);
  const unterordner = optionen && typeof optionen.unterordner === 'string' && optionen.unterordner
    ? optionen.unterordner
    : 'mods';

  const downloads = [];
  const offen = [];
  for (const f of manifest.dateien) {
    if (f.erforderlich === false) {
      // Nicht erforderliche Dateien werden nicht installiert; sie sind
      // Zusatz, den der Nutzer selbst entscheiden soll. Gezaehlt werden
      // sie trotzdem, damit nichts still verschwindet.
      offen.push(f);
      continue;
    }
    let url = f.downloadUrl;
    let dateiname = url ? dateinameAusUrl(url) : null;
    let sha1 = null;
    // 1) Mit API-Schluessel ueber die offizielle API aufloesen.
    if (!url && typeof loeseUrl === 'function') {
      try {
        const info = await loeseUrl(f.projektId, f.dateiId);
        if (info && typeof info.url === 'string' && info.url) {
          url = info.url;
          dateiname = (info.dateiname && String(info.dateiname)) || dateinameAusUrl(url);
          sha1 = info.sha1 || null;
        }
      } catch (err) { /* weiter mit dem oeffentlichen Weg unten */ }
    }
    // 2) Ohne Schluessel (oder wenn die API die Datei verweigert): der
    //    oeffentliche Download-Weg von curseforge.com. CurseForge-Manifeste
    //    tragen fast nie eine downloadUrl - ohne diesen Weg scheiterte
    //    JEDE Mod eines solchen Packs.
    if (!url) {
      if (f.projektId == null || f.dateiId == null) {
        downloads.push({
          pfad: path.join(unterordner, `unbekannt-${f.projektId}-${f.dateiId}.jar`),
          url: null, sha1: null,
          fehlerVormerken: 'Eintrag ohne Projekt- oder Datei-ID im Manifest.'
        });
        continue;
      }
      url = `https://www.curseforge.com/api/v1/mods/${f.projektId}/files/${f.dateiId}/download`;
    }
    downloads.push({
      pfad: path.join(unterordner, dateiname || `unbekannt-${f.projektId}-${f.dateiId}.jar`),
      url,
      sha1,
      umbenennen: !dateiname
    });
  }

  // Den "ueberlaufenen" Anteil von downloads im Ergebnis abbilden, damit
  // die fuer die Vorab-Pfadpruefung genutzte Liste nicht ploetzlich
  // andere Pfade enthaelt als die, die geschrieben werden.
  const ergebnis = startErgebnis();
  const zip = zipOeffnen(zipPfad);
  const praefixeCurse = overridePraefixe(zipPfad, 'curseforge');
  const zuPruefen = eintraegeUnter(zip, praefixeCurse)
    .map(({ relativ }) => ({ relativ }))
    .concat(downloads.map((d) => ({ relativ: d.pfad })));

  const abgelehnt = unsicherePfade(zuPruefen, zielDir);
  if (abgelehnt.length) {
    ergebnis.abgelehnt = true;
    ergebnis.fehler.push(
      'Diese Modpack-Datei wurde wegen unsicherer Pfade NICHT installiert (Zip-Slip-Schutz).'
    );
    ergebnis.fehler.push(...abgelehnt);
    return ergebnis;
  }

  overridesSchreiben(zielDir, zip, praefixeCurse, Boolean(optionen && optionen.ueberschreiben), ergebnis);
  for (const d of downloads) {
    if (d.fehlerVormerken) {
      ergebnis.fehler.push(d.fehlerVormerken + ' (kein Download versucht)');
      continue;
    }
    await dateiLaden(zielDir, d.pfad, d.url, d.sha1, ladeDatei, Boolean(optionen && optionen.ueberschreiben), ergebnis, d);
  }
  for (const f of offen) {
    ergebnis.uebersprungen++;
  }
  return ergebnis;
}


// ---------- Prism Launcher / MultiMC ----------

/** Liest mmc-pack.json und instance.cfg eines Prism-/MultiMC-Exports. */
function lesePrism(zipPfad) {
  const zip = zipOeffnen(zipPfad);
  const basisPack = findeBasis(zip, MMC_PACK);
  const basisCfg = findeBasis(zip, MMC_CFG);
  let minecraft = null;
  let modloader = 'vanilla';
  let loaderRoh = '';
  if (basisPack !== null) {
    const pack = eintragJson(zip, basisPack + MMC_PACK);
    const bauteile = pack && Array.isArray(pack.components) ? pack.components : [];
    const loaderUid = {
      'net.fabricmc.fabric-loader': 'fabric',
      'net.minecraftforge': 'forge',
      'net.neoforged': 'neoforge',
      'org.quiltmc.quilt-loader': 'quilt'
    };
    for (const c of bauteile) {
      if (!c || typeof c.uid !== 'string') continue;
      if (c.uid === 'net.minecraft' && typeof c.version === 'string') minecraft = c.version;
      if (loaderUid[c.uid]) { modloader = loaderUid[c.uid]; loaderRoh = loaderUid[c.uid]; }
    }
  }
  let name = null;
  if (basisCfg !== null) {
    try {
      const cfg = zip.getEntry(basisCfg + MMC_CFG).getData().toString('utf8');
      const m = /^name=(.*)$/m.exec(cfg);
      if (m && m[1].trim()) name = m[1].trim();
    } catch (err) { /* Name bleibt leer */ }
  }
  return { name, minecraft, modloader, loaderRoh, dateien: [] };
}

/** Prism-/MultiMC-Export installieren: der Spielordner wird 1:1 uebernommen. */
async function installierePrism(zielDir, zipPfad, ladeDatei, optionen) {
  return installieren(zielDir, zipPfad, overridePraefixe(zipPfad, 'prism'), [], ladeDatei, optionen);
}

// ---------- Zusammenfassung fuer die Oberflaeche ----------

/**
 * Zusammenfassung eines Modpacks fuer die UI.
 *
 * Rueckgabe: { format, name, version, minecraft, modloader, dateien,
 *              overrides } — `version` ist die PAKETversion (Modrinth:
 *              versionId, CurseForge: manifest.version), `minecraft` die
 *              SPIELversion, die die Instanz zum Starten braucht. Beides
 *              getrennt, denn eins davon zu verwechseln wuerde die
 *              Startkette kaputt machen.
 *
 * Ist die Datei kein Modpack, kommt { format: null, fehler: '...' } statt
 * einer Ausnahme zurueck — die UI soll eine Meldung anzeigen koennen.
 */
function modpackAusDatei(zipPfad) {
  const format = erkenneFormat(zipPfad);
  if (!format) {
    return {
      format: null,
      fehler: 'Kein Modpack erkannt (erwartet: .mrpack von Modrinth, CurseForge-Zip oder Prism-/MultiMC-Export).'
    };
  }
  try {
    if (format === 'mrpack') {
      const pack = leseMrpack(zipPfad);
      return {
        format,
        name: pack.name || 'Unbenanntes Modpack',
        version: pack.versionId,
        minecraft: pack.minecraft,
        modloader: pack.modloader,
        dateien: pack.dateien.length,
        overrides: anzahlOverrides(zipPfad, overridePraefixe(zipPfad, 'mrpack'))
      };
    }
    if (format === 'prism') {
      const p = lesePrism(zipPfad);
      return {
        format,
        name: p.name || 'Unbenanntes Modpack',
        version: null,
        minecraft: p.minecraft,
        modloader: p.modloader,
        loaderRoh: p.loaderRoh || null,
        dateien: 0,
        overrides: anzahlOverrides(zipPfad, overridePraefixe(zipPfad, 'prism'))
      };
    }
    const pack = leseCurseManifest(zipPfad);
    return {
      format,
      name: pack.name || 'Unbenanntes Modpack',
      version: pack.version,
      minecraft: pack.minecraft,
      modloader: pack.modloader,
      // loaderRoh wird mitgeliefert, damit die UI einen unbekannten Loader
      // ehrlich nennen kann statt zu raten.
      loaderRoh: pack.loaderRoh || null,
      dateien: pack.dateien.length,
      overrides: anzahlOverrides(zipPfad, overridePraefixe(zipPfad, 'curseforge'))
    };
  } catch (err) {
    return { format: null, fehler: (err && err.message) || String(err) };
  }
}

/** Anzahl der Nicht-Ordner-Eintraege unter den Override-Praefixen. */
function anzahlOverrides(zipPfad, praefixe) {
  try {
    return eintraegeUnter(zipOeffnen(zipPfad), praefixe).length;
  } catch (err) {
    return 0;
  }
}

module.exports = {
  INDEX_MRPACK,
  MANIFEST_CURSE,
  OVERRIDES_MRPACK,
  OVERRIDES_CURSE,
  STARTER_LOADER,
  erkenneFormat,
  findeBasis,
  lesePrism,
  installierePrism,
  normalisiereLoader,
  loaderAusCurseId,
  sichererZielPfad,
  leseMrpack,
  leseCurseManifest,
  installiereMrpack,
  installiereCurseForge,
  modpackAusDatei,
  dateinameAusUrl
};