// test-widget-systemdaten.js
//   node test-widget-systemdaten.js
//
// Testet src/main/systemdaten.js - die Messgrundlage der D4-Widgets.
//
// Warum eigener Test und nicht in test-widgets.js: hier geht es nicht um
// Pfade und Positivlisten, sondern um die Zahlen selbst. Eine Kachel, die
// "37 %" zeigt, muss 37 gemessen haben - deshalb prueft dieser Test vor
// allem eines: dass aus nichts nichts wird.
//
// Der Test laeuft unter REINEM Node. Dass systemdaten.js dabei ueberhaupt
// geladen werden kann, ist schon der erste Pruefpunkt: das Modul darf kein
// require('electron') haben, sonst faellt hier alles raus.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('./src/main/systemdaten.js');

const problems = [];
let checks = 0;
const Z = [];

function ok(cond, msg, extra) {
  checks++;
  if (cond) Z.push('  OK   ' + msg);
  else {
    Z.push('  FEHLT ' + msg + (extra ? '  ->  ' + extra : ''));
    problems.push(msg);
  }
}
function group(t) { Z.push('\n--- ' + t + ' ---'); }

/** Synchrones Warten - die CPU-Zeiten zaehlen im Hintergrund weiter. */
function warte(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Temporaerer Testordner mit bekanntem Inhalt. */
const WURZEL = path.join(os.tmpdir(), 'liquid-launcher-systemdaten');
fs.rmSync(WURZEL, { recursive: true, force: true });
fs.mkdirSync(path.join(WURZEL, 'tief', 'noch-tiefer'), { recursive: true });
fs.writeFileSync(path.join(WURZEL, 'a.bin'), Buffer.alloc(1000));
fs.writeFileSync(path.join(WURZEL, 'b.bin'), Buffer.alloc(2500));
fs.writeFileSync(path.join(WURZEL, 'tief', 'c.bin'), Buffer.alloc(500));
fs.writeFileSync(path.join(WURZEL, 'tief', 'noch-tiefer', 'd.bin'), Buffer.alloc(100));

// =====================================================================
group('1. Das Modul laeuft ohne electron');
// =====================================================================
{
  const quelle = fs.readFileSync(path.join(__dirname, 'src', 'main', 'systemdaten.js'), 'utf8');
  // Nur ausserhalb von Kommentaren zaehlen: der Kommentar im Kopf erlaeuft
  // die Wortfolge absichtlich, um zu erklaeren, was NICHT da ist.
  const ohneKommentar = quelle.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/require\(['"]electron['"]\)/.test(ohneKommentar),
     'kein require("electron") ausserhalb der Kommentare');
  ok(typeof S.ordnerGroesse === 'function', 'ordnerGroesse ist exportiert');
  ok(typeof S.berechneAuslastung === 'function', 'berechneAuslastung ist exportiert');
  ok(typeof S.zuruecksetzen === 'function', 'zuruecksetzen ist exportiert');
  // Gegenprobe: was alles NICHT exportiert wird - diese Funktionen haengen
  // am Hauptprozess und duerfen hier nicht auftauchen.
  for (const fremd of ['app', 'BrowserWindow', 'ipcMain']) {
    ok(S[fremd] === undefined, 'kein Electron-Baustein als Export: ' + fremd);
  }
}

// =====================================================================
group('2. CPU-Auslastung: aus zwei Messpunkten, sonst gar nichts');
// =====================================================================
{
  // Die Auslastung ist eine Differenz. Ein einzelner Messpunkt sagt nichts.
  ok(S.berechneAuslastung(null, { idle: 10, gesamt: 100 }) === null,
     'ohne alten Messpunkt: null (keine erfundene Zahl)');
  ok(S.berechneAuslastung({ idle: 10, gesamt: 100 }, null) === null,
     'ohne neuen Messpunkt: null');
  ok(S.berechneAuslastung({ idle: 10, gesamt: 100 }, { idle: 10, gesamt: 100 }) === null,
     'ohne verstrichene Zeit (Delta 0): null - nicht 0 %');

  // 100 von 200 Einheiten bedient -> 50 % Auslastung.
  const lastig = S.berechneAuslastung({ idle: 0, gesamt: 0 }, { idle: 100, gesamt: 200 });
  ok(lastig === 50, 'halbe Zeit nicht bedient ergibt 50 %', String(lastig));

  // Alles bedient -> 0 % ist hier ECHT messbar (Delta > 0, anteil 0).
  const ruhig = S.berechneAuslastung({ idle: 0, gesamt: 0 }, { idle: 500, gesamt: 500 });
  ok(ruhig === 0, 'volle Idle-Zeit ergibt 0 %', String(ruhig));

  // Mehr Idle als Gesamtzeit kann nicht sein - ohnehin unmoeglich, aber die
  // Rechnung darf in dem Fall nicht ein negatives Prozent liefern.
  kaputt: {
    const k = S.berechneAuslastung({ idle: 0, gesamt: 100 }, { idle: 500, gesamt: 150 });
    ok(k === null || (k >= 0 && k <= 100), 'verdrehte Zeiten ergeben keinen Wert ausserhalb 0-100',
       String(k));
  }
  // Rueckwaerts in der Zeit (z.B. nach Zurueckstellen der Uhr): kein Wert.
  ok(S.berechneAuslastung({ idle: 500, gesamt: 1000 }, { idle: 100, gesamt: 200 }) === null,
     'ein Rueckgang der kumulierten Zeiten ergibt null');

  // Der erste echte Aufruf liefert null - er legt nur den Messpunkt an.
  S.zuruecksetzen();
  const erst = S.cpuAuslastung();
  ok(erst === null, 'der erste Aufruf liefert null (Messpunkt wird nur angelegt)', String(erst));

  // Ab dem zweiten Aufruf muss eine echte Zahl stehen. Wird zu schnell
  // gemessen, ist das Delta 0 und null die ehrliche Antwort - deshalb mit
  // Warten mehrere Versuche, bis eine Zeit vergangen ist.
  let zahl = null;
  for (let versuch = 0; versuch < 20 && zahl === null; versuch++) {
    warte(50);
    zahl = S.cpuAuslastung();
  }
  ok(typeof zahl === 'number', 'spaetestens nach ein paar Versuchen kommt eine Zahl', String(zahl));
  if (typeof zahl === 'number') {
    ok(Number.isInteger(zahl), 'die Auslastung ist ganzzahlig', String(zahl));
    ok(zahl >= 0 && zahl <= 100, 'die Auslastung liegt zwischen 0 und 100', String(zahl));
  }
}

// =====================================================================
group('3. Systemwerte: gemessen, nicht geschaetzt');
// =====================================================================
{
  const s = S.systemFelder();
  ok(s.plattform === process.platform, 'die Plattform ist die echte', String(s.plattform));
  ok(typeof s.release === 'string' && s.release.length > 0, 'die OS-Version steht drin', String(s.release));
  ok(typeof s.arch === 'string' && s.arch.length > 0, 'die Architektur steht drin', String(s.arch));
  ok(Number.isInteger(s.kerne) && s.kerne >= 1, 'mindestens ein Kern', String(s.kerne));
  ok(s.cpuTaktMhz === null || (Number.isFinite(s.cpuTaktMhz) && s.cpuTaktMhz > 0),
     'der Takt ist null oder eine positive Zahl', String(s.cpuTaktMhz));
  ok(Number.isFinite(s.ramGesamt) && s.ramGesamt > 0, 'der RAM ist eine positive Zahl', String(s.ramGesamt));
  ok(s.ramFrei >= 0 && s.ramFrei <= s.ramGesamt, 'freier RAM liegt zwischen 0 und Gesamt');
  ok(s.ramBelegt === Math.max(0, s.ramGesamt - s.ramFrei), 'belegt ist Gesamt minus frei');
  ok(s.ramFrei <= s.ramGesamt, 'der freie Wert uebersteigt nie den Gesamtwert');
  ok(Number.isFinite(s.systemUptimeSek) && s.systemUptimeSek >= 0,
     'die System-Laufzeit ist in Sekunden und nicht negativ', String(s.systemUptimeSek));
  ok(Math.abs(Date.now() - s.zeitstempel) < 5000, 'der Messzeitpunkt ist gerade erst');

  // Zwei Aufrufe in kurzer Folge: die Uptime darf springen, aber die
  // groben Werte (Kerne, Gesamt-RAM) muessen gleich bleiben.
  const s2 = S.systemFelder();
  ok(s2.kerne === s.kerne, 'die Kernzahl bleibt dieselbe');
  ok(s2.ramGesamt === s.ramGesamt, 'der Gesamt-RAM bleibt derselbe');
  ok(s2.systemUptimeSek >= s.systemUptimeSek, 'die Laufzeit waechst nie zurueck');

  // Kein Pfad, kein Benutzername - die Werte gehen an sandboxed Widgets.
  const text = JSON.stringify(s);
  ok(!/[A-Za-z]:\\/.test(text), 'kein Windows-Pfad in den Systemwerten', text);
  ok(!/AppData|\\Users\\/.test(text), 'kein Benutzerpfad in den Systemwerten', text);
}

// =====================================================================
group('4. Laufwerk: was der Explorer auch als frei anzeigt');
// =====================================================================
{
  const l = S.laufwerkFeld(WURZEL);
  ok(l !== null, 'fuer einen vorhandenen Ordner kommt ein Wert');
  if (l) {
    ok(Number.isFinite(l.gesamt) && l.gesamt > 0, 'die Groesse ist positiv', String(l.gesamt));
    ok(Number.isFinite(l.frei) && l.frei >= 0, 'der freie Platz ist nicht negativ', String(l.frei));
    ok(l.frei <= l.gesamt, 'frei kann nicht groesser sein als gesamt');
    ok(Number.isInteger(l.gesamt) && Number.isInteger(l.frei), 'ganzzahlige Bytes');
  }
  ok(S.laufwerkFeld('C:\\\\GibtsNicht\\\\Ordner') === null, 'ein fehlender Pfad ergibt null');
  ok(S.laufwerkFeld('') === null, 'ein leerer Pfad ergibt null');
  ok(S.laufwerkFeld(null) === null, 'null ergibt null');
  ok(S.laufwerkFeld(undefined) === null, 'undefined ergibt null');
  ok(S.laufwerkFeld(42) === null, 'eine Zahl ergibt null');
  // Gegenprobe: das Feld selbst enthaelt nur Bytes, keinen Laufwerksbuchstaben.
  if (l) {
    ok(!/[A-Za-z]:/.test(JSON.stringify(l)), 'im Feld steht kein Laufwerksbuchstaben',
       JSON.stringify(l));
  }
}

// =====================================================================
group('5. Netzwerk: nur IPv4, ohne Rumpeln');
// =====================================================================
{
  const n = S.netzwerkFelder();
  ok(Array.isArray(n), 'es kommt eine Liste');
  ok(n.length >= 1, 'mindestens eine Schnittstelle', String(n.length));
  let fehler = 0;
  for (const e of n) {
    if (typeof e.name !== 'string' || !e.name) fehler++;
    if (typeof e.intern !== 'boolean') fehler++;
    if (typeof e.adresse !== 'string') fehler++;
    // IPv4 hat drei Punkte, IPv6 hat Doppelpunkte - letztere bleiben raus.
    if (e.adresse.includes(':')) fehler++;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(e.adresse)) fehler++;
    if (e.adresse.split('.').some((t) => Number(t) > 255)) fehler++;
  }
  ok(fehler === 0, 'jede Schnittstelle hat Namen, Wahrheitswert und gueltige IPv4', fehler + ' Fehler');
  ok(n.some((e) => e.intern === true), 'die Loopback-Schnittstelle ist als intern markiert');
  const text = JSON.stringify(n);
  ok(!/\\/.test(text), 'kein Pfad darin', text);
}

// =====================================================================
group('6. Ordnergroesse: gezaehlt, nicht geschaetzt');
// =====================================================================
{
  ok(S.ordnerGroesse(WURZEL) === 1000 + 2500 + 500 + 100,
     'die Groesse ist die Summe aller vier Dateien (4100)', String(S.ordnerGroesse(WURZEL)));
  ok(S.ordnerGroesse(path.join(WURZEL, 'tief')) === 600,
     'ein Unterordner fuer sich', String(S.ordnerGroesse(path.join(WURZEL, 'tief'))));
  ok(S.ordnerGroesse(path.join(WURZEL, 'a.bin')) === 1000,
     'eine einzelne Datei liefert ihre Groesse');
  ok(S.ordnerGroesse(path.join(WURZEL, 'gibtsnicht')) === null,
     'ein fehlender Pfad ergibt null - nicht 0');
  ok(S.ordnerGroesse('') === null, 'ein leerer Pfad ergibt null');
  ok(S.ordnerGroesse(null) === null, 'null ergibt null');
  ok(S.ordnerGroesse(1234) === null, 'eine Zahl ergibt null');
  ok(S.ordnerGroesse(WURZEL + '-fehlt-sicher') === null, 'ein nicht existierender Pfad ergibt null');
}

// =====================================================================
group('7. Eintraege zaehlen');
// =====================================================================
{
  ok(S.anzahlEintraege(WURZEL) === 3, 'im Testordner liegen drei Eintraege', String(S.anzahlEintraege(WURZEL)));
  const leer = path.join(WURZEL, 'leer');
  fs.mkdirSync(leer, { recursive: true });
  ok(S.anzahlEintraege(leer) === 0, 'ein leerer Ordner hat 0 Eintraege');
  ok(S.anzahlEintraege(path.join(WURZEL, 'gibtsnicht')) === null,
     'ein fehlender Ordner ergibt null - nicht 0');
  ok(S.anzahlEintraege('') === null, 'ein leerer Pfad ergibt null');
  ok(S.anzahlEintraege(undefined) === null, 'undefined ergibt null');
}

// =====================================================================
group('8. Der leichte Koffer bleibt leicht');
// =====================================================================
{
  S.zuruecksetzen();
  const s1 = S.leicht(WURZEL);
  const schluessel = Object.keys(s1).sort();
  ok(JSON.stringify(schluessel) === JSON.stringify(['cpuLast', 'laufwerk', 'system']),
     'genau diese drei Felder: system, cpuLast, laufwerk', JSON.stringify(schluessel));
  // Der Test dafuer, dass hier NICHT gemessen wird, was teuer ist: die
  // Ordnergroesse steht nicht drin. Sie gehoert in den vollen Koffer von
  // widgets:daten, weil sie jeden Baum wandert.
  ok(s1.instanzGroesse === undefined, 'keine Ordnergroesse im leichten Koffer');
  ok(s1.modsGroesse === undefined, 'keine mods-Groesse im leichten Koffer');
  ok(s1.ressourcenpaketeAnzahl === undefined, 'keine Paket-Anzahl im leichten Koffer');
  ok(s1.welten === undefined, 'keine Welten-Liste im leichten Koffer');

  const vorher = Date.now();
  const s2 = S.leicht(WURZEL);
  const dauer = Date.now() - vorher;
  ok(dauer < 1000, 'der leichte Koffer ist in unter einer Sekunde da (' + dauer + ' ms)');

  ok(s2.system.kerne === s1.system.kerne, 'die Systemwerte sind dieselben');
  ok(s2.laufwerk === null || (s2.laufwerk.frei <= s2.laufwerk.gesamt), 'das Laufwerk bleibt stimmig');
  const text = JSON.stringify(s2);
  ok(!/AppData|[A-Za-z]:\\/.test(text), 'kein Pfad im leichten Koffer', text);
}

// =====================================================================
group('9. Der Draht zum Fenster: Kanal, Preload, Takt');
// =====================================================================
{
  // Die Messung allein nuetzt nichts - der Renderer muss den Wert auch
  // abfragen. Diese Stellen stehen in drei Dateien und passen nur
  // zusammen, wenn alle drei da sind.
  const ipc = fs.readFileSync(path.join(__dirname, 'src', 'main', 'ipc-handlers.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'src', 'main', 'preload.js'), 'utf8');
  const host = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'widget-host.js'), 'utf8');

  ok(/ipcMain\.handle\('widgets:systemdaten'/.test(ipc),
     'der Hauptprozess registriert widgets:systemdaten');
  ok(/systemdaten: invoke\('widgets:systemdaten'\)/.test(preload),
     'preload gibt den Kanal frei');
  ok(/systemdaten\.leicht\(userData\(\)\)/.test(ipc),
     'der Kanal liefert den leichten Koffer');
  ok(/filtereDatenFuerWidget\(leicht\)/.test(ipc),
     'und schickt ihn durch dieselbe Positivliste');
  ok(/ruf\('systemdaten'\)/.test(host),
     'der Renderer fragt den Kanal ab');
  ok(/FRISCH_MS = 4000/.test(host), 'der Takt betraegt 4 Sekunden');
  ok(/document\.hidden/.test(host), 'ein verstecktes Fenster wird nicht gemessen');
  ok(/frischTakt !== null/.test(host),
     'es wird nur ein Takt angelegt (kein doppelter Timer)');
  // Der volle Koffer bringt den leichten Teil mit, sonst blinken die
  // Kacheln beim ersten Zeichnen, bis der erste Takt kommt.
  ok(/\.\.\.systemdaten\.leicht\(userData\(\)\)/.test(ipc),
     'widgets:daten enthaelt den leichten Teil ebenfalls');
}

// ---------------------------------------------------------------------
Z.push('');
Z.push('=====================================================');
fs.rmSync(WURZEL, { recursive: true, force: true });
if (problems.length === 0) {
  Z.push('ALLE ' + checks + ' PRUEFUNGEN BESTANDEN');
} else {
  Z.push(problems.length + ' von ' + checks + ' PRUEFUNGEN FEHLGESCHLAGEN:');
  problems.forEach((p) => Z.push('  - ' + p));
  process.exitCode = 1;
}
console.log(Z.join('\n'));
