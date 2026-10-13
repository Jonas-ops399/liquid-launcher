// test-prozess-stoppen.js
// Prueft: ein Beenden auf eigenen Wunsch ist kein Absturz.
//
// Warum es dafuer einen eigenen Test braucht und nicht eine Zeile in
// test-full-launch.js: Der Fehler zeigt sich erst, wenn ein Prozess mit
// UNKLAREM Exit-Code endet, nachdem jemand "Beenden" geklickt hat. Ein echter
// Minecraft-Rundlauf liefert fast nie genau diese Kombination — er ist
// langsam, zieht 500 MB und endet ausgerechnet selten so. Genau darum steht
// hier ein winziges Java-Programm statt des Spiels: es beendet sich auf
// Kommando mit einem Code, den man selbst bestimmt.
//
// Das ist kein Test ueber eine nachgebaute Logik. process.js laeuft hier
// unveraendert: spawnt wird wirklich, der close-Handler wirklich, und
// stopProcess wirklich. Nur das Spiel ist ein Ersatz.
//
// Aufruf: node test-prozess-stoppen.js
//
// Regel fuer diesen Test: Es wird kein Erwartungswert gelockert, damit etwas
// gruen wird. Jede Pruefung beschreibt, was der Nutzer sehen soll.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { launchProcess, stopProcess } = require('./src/main/process');

const TMP = path.join(os.tmpdir(), 'll-prozess-stop-test');
let pruefungen = 0;
const probleme = [];

function ok(bedingung, text, zusatz) {
  pruefungen++;
  const zeile = '  ' + (bedingung ? 'OK   ' : 'FEHLT') + ' ' + text;
  console.log(zeile + (zusatz ? '   -> ' + zusatz : ''));
  if (!bedingung) probleme.push(text);
}

function gleich(text, ist, soll) {
  ok(JSON.stringify(ist) === JSON.stringify(soll), text,
     'ist ' + JSON.stringify(ist) + ', erwartet ' + JSON.stringify(soll));
}

/** Woertlich: das Merkmal muss GESETZT sein, BEVOR irgendetwas an den
 *  Prozess geschickt wird. Sonst kann das close-Ereignis eintreffen, bevor
 *  die Absicht notiert ist — und genau dann meldet der naechste Fehler
 *  wieder einen Absturz. */
function quelle() {
  const p = path.join(__dirname, 'src', 'main', 'process.js');
  const zeilen = fs.readFileSync(p, 'utf-8').split('\n');
  const merker = zeilen.findIndex((z) => /stopRequested\s*=\s*true/.test(z));
  if (merker < 0) return { ok: false, grund: 'es gibt keine Stelle, die stopRequested setzt' };
  const koerper = zeilen.slice(merker, merker + 12).join('\n');
  const naechsteAktion = ['kill(', 'taskkill', 'SIGTERM', 'SIGKILL']
    .map((m) => koerper.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return {
    ok: naechsteAktion === undefined,
    grund: naechsteAktion === undefined
      ? 'bis zum Ende des Ausschnitts wird nichts an den Prozess geschickt'
      : 'das Signal kommt ' + naechsteAktion + ' Zeichen weiter unten, das Merkmal aber vorher'
  };
}

console.log('');
console.log('== Prozess beenden: Absicht == Absturz ==');
console.log('Tmp: ' + TMP);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// Das winzige Programm. "block" haelt die Schleife am Leben, damit es
// beim Beenden etwas zu beenden gibt; alles andere ist der Exit-Code.
fs.writeFileSync(path.join(TMP, 'Probe.java'), [
  'public class Probe {',
  '  public static void main(String[] a) throws Exception {',
  '    System.out.println("probe laeuft");',
  '    if (a.length > 0 && a[0].equals("block")) { Thread.sleep(600000); }',
  '    System.exit(a.length > 0 ? Integer.parseInt(a[0]) : 0);',
  '  }',
  '}',
  ''
].join('\n'), 'utf-8');

const JAVA = javaPfad();
if (!JAVA) {
  // Kein Java: das waere kein Grund, gruen zu melden. Der Test sagt dann
  // klar, dass er nicht gelaufen ist — sonst gaebe ein leeres "0 Fehler"
  // den Eindruck, der Weg sei geprueft.
  console.log('');
  console.log('FEHLER: Kein Java gefunden. Dieser Test laeuft nicht.');
  console.log('        Er braucht ein Java, das eine einzelne .java-Datei starten kann (Java 11+).');
  console.log('        Gefunden: ' + (process.env.JAVA_HOME || '(JAVA_HOME nicht gesetzt)'));
  console.log('        Vorhandene Java-Dateien: ' + (fs.readdirSync(path.join(__dirname)).join(', ')));
  console.log('');
  console.log('bestanden: 0   gescheitert: 1');
  process.exit(1);
}
console.log('Java: ' + JAVA);

const STARTE = {
  javaPath: JAVA,
  mainClass: 'Probe.java',
  cwd: TMP,
  ramMin: '64M',
  ramMax: '256M'
};

/**
 * Startet die Probe und wartet auf ihr Ende.
 * @param {string[]} gameArgs - Argument an das Programm
 * @param {number} [stopNachMs] - wenn gesetzt, wird nach so vielen
 *   Millisekunden gestoppt
 * @param {number} [timeoutMs] - Notausstieg fuer stopProcess
 * @returns {Promise<Object>} was der Emitter gemeldet hat, plus wie lange
 *   das Beenden gebraucht hat und ob es die Notloesung nehmen musste
 */
function lauf(marke, gameArgs, stopNachMs, timeoutMs) {
  return new Promise((resolve) => {
    const e = launchProcess({ ...STARTE, gameArgs });
    const gesehen = [];
    let ergebnis = null;
    let stoppErgebnis = null;
    let stoppDauer = null;

    const merke = (art, daten) => {
      gesehen.push(art);
      // Es zaehlt der ERSTE Abschluss: nach einem Stopp kann noch ein
      // weiteres 'closed' kommen, und das wuerde die Auswertung verschieben.
      if (!ergebnis) ergebnis = { art, daten, gesehen };
    };
    e.on('closed', (d) => merke('closed', d));
    e.on('crashed', (d) => merke('crashed', d));
    e.on('error', (err) => merke('error', { message: String(err && err.message || err) }));

    const stoppen = stopNachMs === undefined ? null : setTimeout(async () => {
      const von = Date.now();
      // stopProcess loest mit true auf, wenn der erste Versuch gereicht hat,
      // und mit false, wenn erst der Timeout die Notloesung ziehen musste.
      // Diese Angabe ist das, was man hier eigentlich wissen will.
      stoppErgebnis = await stopProcess(e.instanceId, timeoutMs === undefined ? 8000 : timeoutMs);
      stoppDauer = Date.now() - von;
    }, stopNachMs);

    // Notausstieg: ohne ihn haengt der Test still, wenn der Prozess
    // ausgehaengt ist, und das sieht dann wie ein Erfolg aus.
    const wache = setTimeout(() => {
      if (!ergebnis) {
        ergebnis = { art: 'TIMEOUT', daten: null, gesehen };
        resolve({ ...ergebnis, marke });
      }
    }, 45000);

    const fertig = () => {
      clearTimeout(wache);
      if (stoppen) clearTimeout(stoppen);
      setTimeout(() => resolve({ ...ergebnis, marke, gesehen, stoppErgebnis, stoppDauer }), 250);
    };
    if (ergebnis) fertig();
    else {
      const beobachter = setInterval(() => {
        if (ergebnis) { clearInterval(beobachter); fertig(); }
      }, 40);
    }
  });
}

(async () => {
  // ------------------------------------------------------------ 1. Steuerung
  console.log('');
  console.log('[1] Die Unterscheidung tut, was sie soll');
  const nullExit = await lauf('null', ['0']);
  gleich('beendet sich selbst mit 0 -> "beendet"', nullExit.art, 'closed');
  ok(nullExit.art === 'closed' && nullExit.gesehen.includes('closed'),
     'und kein "abgestuerzt" daneben', 'gesehen: ' + JSON.stringify(nullExit.gesehen));

  const zweiExit = await lauf('zwei', ['7']);
  gleich('bricht mit Code 7 ab -> "abgestuerzt"', zweiExit.art, 'crashed');
  ok(zweiExit.gesehen.length === 1,
     'und genau eine Meldung, nicht zwei — sonst schreibt die Oberflaeche zweimal in dasselbe Protokoll',
     'gesehen: ' + JSON.stringify(zweiExit.gesehen));
  ok(Array.isArray(zweiExit.daten && zweiExit.daten.lastLogLines) && zweiExit.daten.lastLogLines.length > 0,
     'und der Absturz bringt die letzten Log-Zeilen mit, die man zum Nachsehen braucht',
     JSON.stringify(zweiExit.daten && zweiExit.daten.lastLogLines));

  // -------------------------------------------------- 2. Der eigentliche Bug
  console.log('');
  console.log('[2] Der eigentliche Fehler: Beenden auf eigenen Wunsch');
  const gestoppt = await lauf('stop', ['block'], 1500);
  ok(gestoppt.art !== 'TIMEOUT', 'das Programm lief und wurde beendet', gestoppt.art);
  ok(gestoppt.art !== 'TIMEOUT' && gestoppt.art !== 'error',
     'der Prozess liess sich ueberhaupt stoppen', gestoppt.art);
  gleich('und das meldet KEINEN Absturz', gestoppt.art, 'closed');
  ok(gestoppt.art === 'closed' && gestoppt.daten && gestoppt.daten.gewollt === true,
     'sondern sagt ausdruecklich, dass es Absicht war',
     'gewollt: ' + JSON.stringify(gestoppt.daten && gestoppt.daten.gewollt));
  ok(gestoppt.gesehen.length === 1,
     'und auch hier genau eine Meldung', 'gesehen: ' + JSON.stringify(gestoppt.gesehen));

  // Der Exit-Code eines abgebrochenen Spiels: nicht 0, meistens 1 oder
  // 0xC000013A. Genau dieser Wert war vorher der ganze Grund fuer die
  // Fehlmeldung, deshalb wird er hier ausdruecklich geprueft.
  ok(gestoppt.daten && gestoppt.daten.exitCode !== 0,
     'der Exit-Code war tatsaechlich ungleich 0 — also genau der Fall, der vorher als Absturz durchging',
     'Exit-Code: ' + JSON.stringify(gestoppt.daten && gestoppt.daten.exitCode));

  // ------------------------------------------ 3. Wie lange das Beenden dauert
  console.log('');
  console.log('[3] Das Beenden braucht keinen Timeout');
  // stopProcess loest mit true auf, wenn der erste Versuch gegriffen hat, und
  // mit false, wenn erst nach dem Timeout die Notloesung (taskkill /F auf den
  // ganzen Baum) gezogen werden musste.
  //
  // Vorher war das auf Windows immer false: der erste Versuch steckte im
  // `else`-Zweig und lief nie. Das hiess, jeder Klick auf "Beenden" wartete
  // den vollen Timeout ab. Die 8000 ms sind der Timeout, den dieser Lauf
  // mitgibt — vorher waeren sie deshalb immer abgelaufen.
  gleich('der erste Versuch hat gereicht, die Notloesung war nicht noetig',
     gestoppt.stoppErgebnis, true);
  ok(typeof gestoppt.stoppDauer === 'number' && gestoppt.stoppDauer < 3000,
     'und es ging zuegig — nicht erst nach dem Timeout',
     'gedauert: ' + gestoppt.stoppDauer + ' ms (Timeout war 8000 ms)');

  // ------------------------------------------ 3. Die Reihenfolge im Quelltext
  console.log('');
  console.log('[4] Das Merkmal wird VOR dem Signal gesetzt');
  const q = quelle();
  ok(q.ok, 'die Absicht steht vor dem ersten Signal an den Prozess', q.grund);
  ok(quelle().ok, 'und dieselbe Aussage beim zweiten Nachsehen — keine Zufallsabweichung beim Lesen');

  // ------------------------------------------------------ 4. Was der Nutzer liest
  console.log('');
  console.log('[5] Was in der Oberflaeche ankommt');
  const ipc = fs.readFileSync(path.join(__dirname, 'src', 'main', 'ipc-handlers.js'), 'utf-8');
  const closedZeile = ipc.split('\n').find((z) => /emitter\.on\('closed'/.test(z));
  ok(!!closedZeile, 'es gibt eine Behandlung fuer "beendet"');
  const lauftext = ipc.split('\n').slice(
    ipc.split('\n').findIndex((z) => /emitter\.on\('closed'/.test(z)),
    ipc.split('\n').findIndex((z) => /emitter\.on\('crashed'/.test(z))
  ).join('\n');
  ok(/gewollt/.test(lauftext), 'und sie unterscheidet danach, ob es Absicht war');
  ok(!/Exit-Code \$\{exitCode\}[^}]*\}\.\`;\s*$/.test(lauftext) || /gewollt/.test(lauftext),
     'der Exit-Code steht nicht mehr ohne Unterschied in beiden Faellen');
  ok(!/crashed/.test(lauftext.replace(/emitter\.on\('crashed'.*/, '')),
     'und ein gewolltes Beenden schreibt nirgends "abgestuerzt"',
     lauftext.split('\n').filter((z) => /crashed/.test(z)).join(' | ') || 'keine Zeile');

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('');
  console.log('============================================================');
  console.log(probleme.length
    ? probleme.length + ' von ' + pruefungen + ' PRUEFUNGEN FEHLGESCHLAGEN:'
    : 'ALLE ' + pruefungen + ' PRUEFUNGEN BESTANDEN');
  if (probleme.length) probleme.forEach((p) => console.log('  - ' + p));
  console.log('============================================================');
  process.exit(probleme.length ? 1 : 0);
})();

/** Sucht ein Java, das eine einzelne .java-Datei starten kann (Java 11+). */
function javaPfad() {
  const kandidaten = [];
  if (process.env.JAVA_HOME) kandidaten.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  // test-java-runtime.js sucht dasselbe; hier die ueblichen Orte.
  for (const basis of ['C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java',
                       'C:/Program Files/Microsoft', 'C:/Program Files/Zulu',
                       'C:/Program Files/BellSoft', 'C:/Program Files/Amazon Corretto']) {
    let eintraege = [];
    try { eintraege = fs.readdirSync(basis); } catch { continue; }
    for (const e of eintraege) kandidaten.push(path.join(basis, e, 'bin', 'java.exe'));
  }
  for (const k of kandidaten) {
    try { fs.accessSync(k); return k; } catch { /* weiter */ }
  }
  return null;
}
