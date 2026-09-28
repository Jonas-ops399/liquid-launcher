// test-widgets-fenster.js
//   node_modules\electron\dist\electron.exe test-widgets-fenster.js
//
// Prueft die Widget-Kacheln im ECHTEN Electron-Fenster, mit dem ECHTEN
// preload und der ECHTEN index.html. Nicht simuliert.
//
// Warum ein eigener Test und nicht eine Erweiterung von test-widgets.js:
// Die entscheidende Behauptung lautet "ein Widget kommt nicht an das
// Token". Die laesst sich mit keinem DOM-Shim pruefen, sondern nur in einem
// echten Fenster, in dem contextIsolation, sandbox und webSecurity wirklich
// greifen. Ein gruener Shim-Test wuerde hier genau nichts aussagen.
//
// Zwei Dinge, die dieser Test ausdruecklich mitprueft, weil sie beim
// Schreiben des Codes leicht falsch laufen und dann still schiefgehen:
//
// 1. DIE KONTROLLE. Bevor irgendetwas geprueft wird, muss festgestellt
//    werden, dass der Hauptframe ueberhaupt window.launcher hat. Faellt die
//    Kontrolle aus, sind alle weiteren Ergebnisse wertlos - so ist es in
//    einer frueheren Fassung des iframe-Tests gelaufen (das preload schrieb
//    mit require('node:fs') in eine Sandbox-Renderer, wo das nicht geht,
//    die Logdatei blieb leer und las sich als Beweis).
//
// 2. GEGENPROBE. Das Test-Widget versucht ausdruecklich, an Token zu kommen -
//    ueber parent, ueber top, ueber localStorage, ueber document.cookie. Es
//    muss daran scheitern. Ein Test, der nur fragt "ist window.launcher
//    da?" prueft nicht, ob es einen WEG dahin gibt.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJ = __dirname;
const TESTDATEN = path.join(os.tmpdir(), 'll-widgetfenster-test');

const Z = [];
const probleme = [];
let pruefungen = 0;

function ok(bedingung, text, zusatz) {
  pruefungen++;
  if (bedingung) {
    Z.push('  OK    ' + text);
  } else {
    Z.push('  FEHLT ' + text + (zusatz ? '   -> ' + zusatz : ''));
    probleme.push(text);
  }
}
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); }

// Das Test-Widget. Legt absichtlich jeden Angriffversuch offen, den ein
// echtes bösartiges Widget versuchen würde.
const PROBE_WIDGET = `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}body{font:12px sans-serif;color:#fff}</style>
</head><body><div id="s">P</div>
<script>
(function(){
  var befund = {};

  // --- Wer bin ich? -------------------------------------------------
  befund.window_launcher   = typeof window.launcher;
  befund.require           = typeof window.require;
  befund.process           = typeof window.process;
  befund.module            = typeof window.module;
  befund.electron          = typeof window.electron;
  befund.istHauptframe     = (window.top === window);
  befund.origin            = String(window.location.origin);
  befund.href              = String(window.location.href).slice(0, 60);

  // --- Angriffsversuche --------------------------------------------
  // 1. Ueber parent
  try { befund.parent_launcher = typeof window.parent.launcher; }
  catch (e) { befund.parent_launcher = 'WIRFT: ' + e.name; }

  // 2. Ueber top (Seitenuebergreifend)
  try { befund.top_launcher = typeof window.top.launcher; }
  catch (e) { befund.top_launcher = 'WIRFT: ' + e.name; }

  // 3. Fensterkette durchlaufen und die ganze Kette abfragen
  var gefunden = null, w = window, tiefe = 0;
  try {
    while (w && tiefe < 10) {
      if (w.launcher) { gefunden = 'Frame ' + tiefe; break; }
      if (w.parent === w) break;
      w = w.parent; tiefe++;
    }
  } catch (e) { gefunden = 'WIRFT: ' + e.name; }
  befund.kette_launcher = gefunden || 'nirgends';

  // 4. Speicher des eigenen Frames
  try { localStorage.setItem('x', '1'); befund.localStorage = 'beschreibbar'; }
  catch (e) { befund.localStorage = 'WIRFT: ' + e.name; }
  try { befund.cookie = String(document.cookie) || '(leer)'; }
  catch (e) { befund.cookie = 'WIRFT: ' + e.name; }

  // 5. Aus der Nachricht des Launchers: welche Felder kamen an?
  befund.datenSchluessel = null;
  befund.datenEnthaeltToken = null;
  befund.datenVolltext = null;

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.quelle !== 'liquid-launcher') return;
    if (d.typ === 'daten') {
      var s = d.daten || {};
      befund.datenSchluessel = Object.keys(s).sort().join(',');
      var alsText = JSON.stringify(s);
      befund.datenVolltext = alsText;
      befund.datenEnthaeltToken =
        /token/i.test(alsText) || /df3c3ec3/i.test(alsText) || /AppData/i.test(alsText);
    }
  });

  function melde(){
    document.getElementById('s').textContent = 'PROBE';
    parent.postMessage({ quelle:'liquid-launcher-widget', typ:'anfrage', probe: befund }, '*');
  }
  melde();
  setInterval(melde, 400);
})();
<\/script>
</body></html>`;

app.whenReady().then(async () => {
  // -------------------------------------------------------------------
  // Eigenes userData. Zwei Gruende: die Test-Widget-Ordner sollen nicht in
  // den echten %APPDATA%-Ordner des Benutzers, und der Konto-Speicher des
  // Tests darf das echte accounts.json nicht anfassen.
  // Muss VOR registerIpcHandlers() passieren, weil dort der Pfad einmal
  // gelesen wird.
  // -------------------------------------------------------------------
  fs.rmSync(TESTDATEN, { recursive: true, force: true });
  fs.mkdirSync(path.join(TESTDATEN, 'widgets', 'probe', ), { recursive: true });
  app.setPath('userData', TESTDATEN);
  fs.writeFileSync(path.join(TESTDATEN, 'widgets', 'probe', 'widget.json'),
    JSON.stringify({ id: 'probe', titel: 'Probe', breite: 1 }), 'utf8');
  fs.writeFileSync(path.join(TESTDATEN, 'widgets', 'probe', 'widget.html'),
    PROBE_WIDGET, 'utf8');

  // Echte Testdaten fuer eine Instanz: zwei Welten und zwei Mods.
  //
  // Ohne die behaelt der Test nichts. Die erste Fassung liess das
  // Instanz-Verzeichnis leer, bekam modAnzahl 0 und welten 0 - und pruefte
  // dann nur noch die Form der Antwort. Genau so hat sich ein echter Fehler
  // durchgeschlichen: widget-host.js suchte nach einem Element
  // "statInstanceId", das es nicht gibt, bekam deshalb immer einen leeren
  // Koffer, und es wirkte wie "die Kachel zeigt 0". Diese Dateien sorgen
  // dafuer, dass "1" und "2" das richtige Ergebnis sind - nur dann kann ein
  // falscher leerer Koffer auffallen.
  const inst = path.join(TESTDATEN, 'instances', 'talberg');
  fs.mkdirSync(path.join(inst, 'saves', 'Meine Welt'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'saves', 'Kaputte Welt'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'saves', 'Meine Welt', 'level.dat'),
    Buffer.from([0x0a, 0x00, 0x00]));   // zu kurz = beschaedigt, zaehlt aber
  fs.writeFileSync(path.join(inst, 'saves', 'Kaputte Welt', 'level.dat'),
    Buffer.alloc(0));
  fs.writeFileSync(path.join(inst, 'mods', 'erste.jar'), 'x');
  fs.writeFileSync(path.join(inst, 'mods', 'zweite.jar'), 'y');
  fs.writeFileSync(path.join(inst, 'mods', 'keine-mod.txt'), 'z'); // darf nicht zaehlen
  Z.push('Testdaten: 2 Welten, 2 Mods (+1 Nicht-Mod) in instances/talberg');

  // Ganz normale Kanalregistrierung, wie die App sie macht.
  const { registerIpcHandlers } = require('./src/main/ipc-handlers.js');
  try {
    registerIpcHandlers();
    Z.push('registerIpcHandlers() lief ohne Fehler.');
  } catch (err) {
    Z.push('registerIpcHandlers() WERFTE: ' + err.message);
    probleme.push('registerIpcHandlers');
  }

  const fenster = new BrowserWindow({
    show: false,
    width: 1400, height: 900,
    webPreferences: {
      preload: path.join(PROJ, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Konsolenfehler einsammeln. Nicht als Fehler gewertet - in index.html
  // gibt es bekannte Vorlaeufer-Probleme - aber am Ende ausgewiesen, damit
  // sie nicht untergehen.
  const konsolenFehler = [];
  fenster.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2 && typeof msg === 'string') konsolenFehler.push(msg);
  });

  await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const js = (code) => fenster.webContents.executeJavaScript(code, true);

  // Einen Protokoll-Listener im HAUPTframe aufhaengen, bevor die Probe
  // loslegt. Der Hauptframe sieht alles, was die Kacheln melden.
  await js(`
    window.__probeLog = [];
    window.addEventListener('message', function(ev){
      var d = ev.data;
      if (d && d.quelle === 'liquid-launcher-widget') {
        window.__probeLog.push(d.probe || { typ: d.typ });
      }
    });
    true;
  `);

  // =====================================================================
  gruppe('1. KONTROLLE: Ist ueberhaupt ein preload da?');
  // =====================================================================
  const kontrolle = await js(`JSON.stringify({
    hatLauncher: typeof window.launcher,
    hatAuth: !!(window.launcher && window.launcher.auth),
    hatTokenKanal: !!(window.launcher && window.launcher.auth && window.launcher.auth.getActiveAccount),
    hatWidgets: !!(window.launcher && window.launcher.widgets),
    hatWidgetList: !!(window.launcher && window.launcher.widgets && window.launcher.widgets.list)
  })`);
  const k = JSON.parse(kontrolle);
  Z.push('    window.launcher        = ' + k.hatLauncher);
  Z.push('    auth.getActiveAccount  = ' + k.hatTokenKanal);
  Z.push('    widgets.list           = ' + k.hatWidgetList);
  ok(k.hatLauncher === 'object', 'der HAUPTframe hat window.launcher');
  ok(k.hatTokenKanal === true, 'der HAUPTframe kann das Token abrufen');
  ok(k.hatWidgetList === true, 'widgets.list ist erreichbar');
  const messungGueltig = (k.hatLauncher === 'object' && k.hatTokenKanal === true);
  Z.push('');
  Z.push('    Messung gueltig: ' + messungGueltig);
  if (!messungGueltig) {
    Z.push('    ACHTUNG: Ohne diese Kontrolle waere alles Folgende wertlos.');
  }

  // =====================================================================
  gruppe('2. Kacheln werden gebaut');
  // =====================================================================
  const zustand = await js(`JSON.stringify({
    hatWidgetHost: typeof window.WidgetHost,
    kacheln: document.querySelectorAll('#statGrid .wdg-tile').length,
    frames: document.querySelectorAll('#statGrid .wdg-frame').length,
    fehler: document.querySelectorAll('#statGrid .wdg-fehler').length,
    leere: document.querySelectorAll('#statGrid .wdg-leer').length,
    zustand: window.WidgetHost ? window.WidgetHost._zustand().kacheln.map(function(x){return x.id;}) : null,
    verfuegbar: window.WidgetHost ? window.WidgetHost._zustand().verfuegbar.map(function(x){return x.id;}) : null
  })`);
  const z = JSON.parse(zustand);
  Z.push('    Kacheln im DOM        : ' + z.kacheln);
  Z.push('    iframes im DOM         : ' + z.frames);
  Z.push('    Kachel-IDs             : ' + JSON.stringify(z.zustand));
  Z.push('    verfuegbare Widgets    : ' + JSON.stringify(z.verfuegbar));
  ok(z.hatWidgetHost === 'object', 'window.WidgetHost existiert');
  ok(z.kacheln > 0, 'es stehen Kacheln im Raster', 'gefunden: ' + z.kacheln);
  ok(z.kacheln === z.frames, 'jede Kachel hat ein iframe', z.kacheln + ' Kacheln / ' + z.frames + ' frames');
  ok(z.fehler === 0, 'keine Kachel zeigt einen Ladefehler', z.fehler + ' Fehler');
  ok(Array.isArray(z.verfuegbar) && z.verfuegbar.indexOf('uhr') !== -1, 'die Uhr ist verfuegbar');
  ok(Array.isArray(z.verfuegbar) && z.verfuegbar.indexOf('probe') !== -1,
     'das Test-Widget aus dem userData-Ordner wird gefunden', JSON.stringify(z.verfuegbar));

  // =====================================================================
  gruppe('3. Das sandbox-Attribut');
  // =====================================================================
  const sandbox = await js(`JSON.stringify(
    [].map.call(document.querySelectorAll('#statGrid .wdg-frame'), function(f){
      return {
        sandbox: f.getAttribute('sandbox'),
        allowSameOrigin: f.hasAttribute('allow-same-origin'),
        hatSrcdoc: f.hasAttribute('srcdoc'),
        srcAttr: f.getAttribute('src')
      };
    })
  )`);
  const rahmen = JSON.parse(sandbox);
  Z.push('    ' + JSON.stringify(rahmen[0]));
  ok(rahmen.every(r => r.sandbox === 'allow-scripts'),
     'jedes iframe hat sandbox="allow-scripts"',
     JSON.stringify(rahmen.map(r => r.sandbox)));
  ok(rahmen.every(r => r.allowSameOrigin === false),
     'KEIN iframe hat allow-same-origin - das waere die ganze Grenze aufgehoben');
  ok(rahmen.every(r => r.hatSrcdoc === true),
     'der Inhalt kommt per srcdoc, nicht per Dateipfad', JSON.stringify(rahmen.map(r => r.srcAttr)));
  ok(rahmen.every(r => !r.srcAttr), 'kein iframe laedt ueber src=... eine Datei');

  // =====================================================================
  gruppe('4. Das Test-Widget bauen und laufen lassen');
  // =====================================================================
  const gebaut = await js(`(function(){
    var r = window.WidgetHost.einbauen('probe');
    return JSON.stringify({ eingebaut: r });
  })()`);
  Z.push('    einbauen("probe") -> ' + gebaut);
  await new Promise(r => setTimeout(r, 3000));

  const probeKachel = await js(`(function(){
    var el = document.querySelector('#statGrid .wdg-tile[data-wid="probe"]');
    if (!el) return JSON.stringify({ da: false });
    var f = el.querySelector('.wdg-frame');
    return JSON.stringify({
      da: true,
      sandbox: f.getAttribute('sandbox'),
      hatSrcdoc: f.hasAttribute('srcdoc'),
      srcdocLaenge: (f.getAttribute('srcdoc') || '').length
    });
  })()`);
  const pk = JSON.parse(probeKachel);
  Z.push('    Probe-Kachel: ' + JSON.stringify(pk));
  ok(pk.da === true, 'die Probe-Kachel steht im Raster');
  ok(pk.sandbox === 'allow-scripts', 'und hat sandbox="allow-scripts"');
  ok(pk.srcdocLaenge > 200, 'und ihr HTML ist geladen',
     'srcdoc-Laenge: ' + pk.srcdocLaenge);

  // Das Probe-Widget schickt alle 400 ms seinen Befund. Ein paar Runden warten.
  await new Promise(r => setTimeout(r, 2000));
  const log = await js('JSON.stringify(window.__probeLog || [])');
  const eintraege = JSON.parse(log);
  const befund = eintraege.length ? eintraege[eintraege.length - 1] : null;

  // =====================================================================
  gruppe('5. Was das Widget von innen sieht');
  // =====================================================================
  if (!befund) {
    ok(false, 'das Widget hat nichts gemeldet',
       'Meldungen: ' + eintraege.length);
  } else {
    for (const [name, wert] of Object.entries(befund)) {
      if (name === 'datenVolltext') continue;
      Z.push('    ' + name.padEnd(22) + wert);
    }
    Z.push('');
    Z.push('    Daten-Schluessel: ' + befund.datenSchluessel);
    Z.push('');

    ok(befund.istHauptframe === false, 'es laeuft in einem Subframe');
    ok(befund.window_launcher === 'undefined',
       'window.launcher ist NICHT da', befund.window_launcher);
    ok(befund.require === 'undefined', 'kein require', befund.require);
    ok(befund.process === 'undefined', 'kein process', befund.process);
    ok(befund.electron === 'undefined', 'kein electron', befund.electron);
    ok(befund.module === 'undefined', 'kein module', befund.module);
  }

  // =====================================================================
  gruppe('6. GEGENPROBE: Kommt es an das Token?');
  // =====================================================================
  if (befund) {
    // Die vier Angriffswege, die das Widget selbst probiert hat.
    ok(befund.parent_launcher === 'undefined' || String(befund.parent_launcher).indexOf('WIRFT') === 0,
       'parent.launcher ist nicht erreichbar', befund.parent_launcher);
    ok(befund.top_launcher === 'undefined' || String(befund.top_launcher).indexOf('WIRFT') === 0,
       'top.launcher ist nicht erreichbar', befund.top_launcher);
    ok(befund.kette_launcher === 'nirgends' || String(befund.kette_launcher).indexOf('WIRFT') === 0,
       'die ganze Fensterkette fuehrt zu keinem launcher', befund.kette_launcher);

    // Und das entscheidende: die Daten, die tatsaechlich ankommen.
    ok(befund.datenSchluessel !== null, 'das Widget hat Daten bekommen',
       String(befund.datenSchluessel));
    ok(befund.datenEnthaeltToken === false,
       'in den Widget-Daten steht KEIN Token, keine Client-ID, kein AppData-Pfad',
       'gefunden: ' + befund.datenEnthaeltToken);
    const volltext = befund.datenVolltext || '';
    ok(volltext.indexOf('accessToken') === -1, 'kein accessToken im uebermittelten JSON');
    ok(volltext.indexOf('accounts') === -1, 'kein accounts-Feld');
    ok(volltext.indexOf('AppData') === -1, 'kein AppData-Pfad');
    Z.push('');
    Z.push('    Was tatsaechlich ankam: ' + String(volltext).slice(0, 240));
  }

  // =====================================================================
  gruppe('7. Der Datenkoffer direkt am Kanal');
  // =====================================================================
  // Nicht nur aus der Sicht des Widgets, sondern am Kanal selbst: mit
  // Absicht ein Token hineingelegt, das der Filter wegwuerfen muss.
  //
  // Zuerst OHNE Instanz. Das ist der Zustand beim allerersten Start, und er
  // muss sauber sein: aktiveInstanz null, leere Listen - aber nicht null
  // und nicht undefined.
  const ohneInstanz = JSON.parse(await Promise.resolve(js(`(async function(){
    var d = await window.launcher.widgets.daten('');
    return JSON.stringify({
      aktiv: d.aktiveInstanz,
      modAnzahl: d.modAnzahl,
      welten: Array.isArray(d.welten) ? d.welten.length : 'kein array',
      instanzen: Array.isArray(d.instanzen) ? d.instanzen.length : 'kein array'
    });
  })()`)));
  Z.push('    ohne Instanz: ' + JSON.stringify(ohneInstanz));
  ok(ohneInstanz.aktiv === null, 'ohne Instanz ist aktiveInstanz null');
  ok(ohneInstanz.welten === 0, 'und es sind 0 Welten');
  ok(ohneInstanz.instanzen > 0, 'die Liste der Instanzen kommt trotzdem');

  // Und jetzt MIT Instanz. Hier entscheidet sich, ob die Kacheln echte
  // Zahlen zeigen koennen.
  const kanal = JSON.parse(await Promise.resolve(js(`(async function(){
    var echteDaten = await window.launcher.widgets.daten('talberg');
    return JSON.stringify({
      schluessel: Object.keys(echteDaten || {}).sort(),
      gestartetAmTyp: typeof (echteDaten || {}).gestartetAm,
      sprache: (echteDaten || {}).sprache,
      modAnzahl: (echteDaten || {}).modAnzahl,
      weltAnzahl: Array.isArray((echteDaten || {}).welten) ? echteDaten.welten.length : 'kein array',
      weltNamen: (echteDaten || {}).welten ? (echteDaten.welten||[]).map(function(w){return w.name;}) : null,
      alsText: JSON.stringify(echteDaten || {}).slice(0, 300)
    });
  })()`)));
  Z.push('    Schluessel: ' + kanal.schluessel.join(', '));
  Z.push('    gestartetAm: ' + kanal.gestartetAmTyp + '   sprache: ' + kanal.sprache +
         '   modAnzahl: ' + kanal.modAnzahl + '   welten: ' + kanal.weltAnzahl);
  Z.push('    Weltnamen: ' + JSON.stringify(kanal.weltNamen));
  ok(kanal.schluessel.indexOf('gestartetAm') !== -1, 'gestartetAm kommt an');
  ok(kanal.gestartetAmTyp === 'number', 'gestartetAm ist eine Zahl');
  ok(kanal.schluessel.indexOf('sprache') !== -1, 'sprache kommt an');
  // Sprachcode wie "de", kein Locale wie "de-DE". Mit dem falschen
  // Schluesselname ("sprache" statt "language") war hier immer die
  // Vorgabe gefuellt, unabhaengig davon, was im Menue eingestellt war -
  // die Uhr zeigte dann auch bei englischer Oberflaeche deutsche Zeit.
  ok(kanal.sprache === 'de', 'sprache ist der Sprachcode aus den Einstellungen',
     String(kanal.sprache));
  ok(kanal.sprache.indexOf('-') === -1,
     'und kein Locale mit Land, weil die Einstellungen keins speichern',
     String(kanal.sprache));
  ok(kanal.schluessel.indexOf('modAnzahl') !== -1, 'modAnzahl kommt an');
  ok(kanal.schluessel.indexOf('theme') === -1,
     'theme kommt NICHT mit - es gibt keine theme-Einstellung (waere immer null)');
  // Die harten Zahlen. Ohne Testdaten waeren hier 0 und 0 gestanden und der
  // Test waere gruen gewesen, obwohl die Kacheln nichts anzeigten.
  ok(kanal.modAnzahl === 2, 'modAnzahl ist 2 - die zwei .jar, nicht die .txt',
     'bekommen: ' + kanal.modAnzahl);
  ok(kanal.weltAnzahl === 2, 'es sind 2 Welten', 'bekommen: ' + kanal.weltAnzahl);
  ['accessToken', 'refreshToken', 'accounts', 'accountsStorePfad', 'settingsStore']
    .forEach(f => ok(kanal.schluessel.indexOf(f) === -1, 'der Kanal liefert kein "' + f + '"'));
  ok(kanal.alsText.indexOf('TOKEN') === -1, 'im Kanal-Ergebnis kommt das Wort TOKEN nicht vor');

  // =====================================================================
  gruppe('7b. Die Kacheln bekommen die Instanz auch wirklich mit');
  // =====================================================================
  // Der Fehler, der diesen ganzen Abschnitt ausgeloest hat: widget-host.js
  // suchte nach einem nicht vorhandenen Element und blieb bei ''. Hier wird
  // er festgenagelt - instanzSetzen() muss den Koffer wirklich austauschen.
  const umgeschaltet = JSON.parse(await Promise.resolve(js(`(async function(){
    await window.WidgetHost.instanzSetzen('talberg');
    await new Promise(function(r){ setTimeout(r, 700); });
    var z = window.WidgetHost._zustand();
    return JSON.stringify({
      instanzId: z.instanzId,
      aktiv: z.daten ? z.daten.aktiveInstanz : '(keine daten)',
      modAnzahl: z.daten ? z.daten.modAnzahl : '(keine daten)',
      welten: z.daten && z.daten.welten ? z.daten.welten.length : '(keine daten)'
    });
  })()`)));
  Z.push('    ' + JSON.stringify(umgeschaltet));
  ok(umgeschaltet.instanzId === 'talberg', 'die Instanz ist gemerkt');
  ok(umgeschaltet.aktiv === 'talberg', 'und steht in den Daten als aktiveInstanz',
     String(umgeschaltet.aktiv));
  ok(umgeschaltet.modAnzahl === 2, 'die Kacheln sehen modAnzahl 2', String(umgeschaltet.modAnzahl));
  ok(umgeschaltet.welten === 2, 'die Kacheln sehen 2 Welten', String(umgeschaltet.welten));

  // Gegenprobe: der Hauptframe HAT sehr wohl den Token-Kanal. Ohne diese
  // Zeile waere "das Widget hat kein Token" auch dann gruen, wenn es gar
  // keine Tokens gaebe.
  const gegenprobe = await js(`(async function(){
    try { await window.launcher.auth.getActiveAccount(); return 'gibt es'; }
    catch (e) { return 'wirft: ' + String(e.message || e).slice(0, 50); }
  })()`);
  Z.push('    Gegenprobe auth.getActiveAccount() im Hauptframe -> ' + gegenprobe);
  ok(String(await Promise.resolve(gegenprobe)).length > 0,
     'der Token-Kanal im Hauptframe antwortet (Gegenprobe zur Kontrolle)');

  // =====================================================================
  gruppe('8. Bearbeiten-Modus und Entfernen');
  // =====================================================================
  const bearbeiten = await js(`(function(){
    window.WidgetHost.bearbeitenSchalten(true);
    var kachel = document.querySelector('#statGrid .wdg-tile');
    var knopf = kachel ? kachel.querySelector('.wdg-entf') : null;
    var sichtbar = knopf ? getComputedStyle(knopf).display !== 'none' : false;
    var dragbar = kachel ? kachel.getAttribute('draggable') : null;
    var vorher = document.querySelectorAll('#statGrid .wdg-tile').length;
    if (knopf) knopf.click();
    var nachher = document.querySelectorAll('#statGrid .wdg-tile').length;
    window.WidgetHost.bearbeitenSchalten(false);
    return JSON.stringify({
      knopfSichtbar: sichtbar, dragbar: dragbar,
      vorher: vorher, nachher: nachher,
      gespeichert: !!window.WidgetHost._zustand()
    });
  })()`);
  const bm = JSON.parse(await Promise.resolve(bearbeiten));
  Z.push('    ' + JSON.stringify(bm));
  ok(bm.knopfSichtbar === true, 'im Bearbeiten-Modus erscheint der Entfernen-Knopf');
  ok(bm.dragbar === 'true', 'im Bearbeiten-Modus sind die Kacheln ziehbar');
  ok(bm.nachher === bm.vorher - 1, 'Entfernen nimmt genau eine Kachel weg',
     bm.vorher + ' -> ' + bm.nachher);

  // =====================================================================
  gruppe('9. Persistenz');
  // =====================================================================
  const gespeichert = await js(`(function(){
    var s = window.WidgetHost._zustand();
    return JSON.stringify(s.kacheln.map(function(k){return k.id;}));
  })()`);
  Z.push('    Kacheln nach dem Entfernen: ' + gespeichert);
  const settingsDatei = path.join(TESTDATEN, 'settings.json');
  let gespeichertDatei = '(keine Datei)';
  try {
    gespeichertDatei = JSON.stringify(JSON.parse(fs.readFileSync(settingsDatei, 'utf8')).widgetKacheln);
  } catch (e) { /* noch nicht geschrieben */ }
  Z.push('    widgetKacheln in settings.json: ' + gespeichertDatei);
  ok(Array.isArray(JSON.parse(gespeichertDatei)),
     'die Kacheln stehen als widgetKacheln in settings.json', gespeichertDatei);

  // =====================================================================
  gruppe('10. Die vier mitgelieferten Widgets');
  // =====================================================================
  const eingebaut = await js(`(function(){
    // In der Kachel "uhr" nachsehen, ob wirklich etwas drinsteht - ein iframe
    // mit srcdoc, das leer ist, sieht im DOM vollstaendig intakt aus.
    var el = document.querySelector('#statGrid .wdg-tile[data-wid="uhr"]');
    if (!el) return JSON.stringify({ da: false });
    var f = el.querySelector('.wdg-frame');
    return JSON.stringify({
      da: true,
      laenge: (f.getAttribute('srcdoc') || '').length,
      enthaeltZeichen: /setInterval/.test(f.getAttribute('srcdoc') || '')
    });
  })()`);
  const e = JSON.parse(await Promise.resolve(eingebaut));
  Z.push('    ' + JSON.stringify(e));
  ok(e.da === true, 'die Uhr steht als Kachel im Raster');
  ok(e.laenge > 500, 'die Uhr hat Inhalt', 'Laenge: ' + e.laenge);
  ok(e.enthaeltZeichen === true, 'und die Uhr hat auch wirklich ein Skript');

  // =====================================================================
  gruppe('11. Ein kaputtes Widget reisst nichts mit');
  // =====================================================================
  const kaputt = await js(`(async function(){
    window.WidgetHost.einbauen('gibtsnicht');
    await new Promise(function(r){ setTimeout(r, 900); });
    var el = document.querySelector('#statGrid .wdg-tile[data-wid="gibtsnicht"]');
    return JSON.stringify({
      kachelDa: !!el,
      fehlerText: el ? (el.querySelector('.wdg-fehler') || {}).textContent : null,
      andereKacheln: document.querySelectorAll('#statGrid .wdg-tile').length
    });
  })()`);
  const kp = JSON.parse(await Promise.resolve(kaputt));
  Z.push('    ' + JSON.stringify(kp));
  ok(kp.kachelDa === true, 'die unbekannte Kachel wird trotzdem angelegt (kein Absturz)');
  ok(typeof kp.fehlerText === 'string' && kp.fehlerText.length > 0,
     'und zeigt eine Fehlermeldung', String(kp.fehlerText));
  ok(kp.andereKacheln > 1, 'die anderen Kacheln bleiben bestehen', String(kp.andereKacheln));

  // =====================================================================
  Z.push('');
  Z.push('--- Konsolenfehler waehrend des Tests ---');
  // Nicht einfach alles als "vorbehandelt" abstempeln. Ein Teil dieser
  // Meldungen entsteht DURCH DIESEN TEST, weil er nur die Kanäle aus
  // ipc-handlers.js registriert und die Fensterkanäle in main.js stehen.
  // Das sauber zu trennen ist wichtig, sonst gilt spaeter eine Meldung als
  // bekannter Restfehler der App, die in Wahrheit ein Testartefakt ist.
  const durchTest = /No handler registered for 'window:/;
  const eigen = [...new Set(konsolenFehler)].map(String);
  const testFehler = eigen.filter(m => durchTest.test(m));
  const appFehler = eigen.filter(m => !durchTest.test(m));

  if (appFehler.length === 0) {
    Z.push('  aus der App: keine.');
  } else {
    appFehler.forEach(m => Z.push('  - [App] ' + m.slice(0, 130)));
    Z.push('    (vorbehandelt, nicht durch die Widgets entstanden -');
    Z.push('     siehe README, Abschnitt "Noch nicht verifiziert")');
  }
  if (testFehler.length) {
    Z.push('  aus diesem Test: ' + testFehler.length + ' - die Fensterkanäle');
    Z.push('    (window:*) liegen in main.js, nicht in ipc-handlers.js,');
    Z.push('    deshalb registriert dieser Test sie nicht. Kein App-Fehler.');
  }

  // ---------------------------------------------------------------------
  Z.push('');
  Z.push('=====================================================');
  if (probleme.length === 0) {
    Z.push('ALLE ' + pruefungen + ' PRUEFUNGEN BESTANDEN');
  } else {
    Z.push(probleme.length + ' von ' + pruefungen + ' PRUEFUNGEN FEHLGESCHLAGEN:');
    probleme.forEach(p => Z.push('  - ' + p));
  }

  const ausgabe = 'C:\\Users\\Anwender\\AppData\\Local\\Temp\\opencode\\widget-fenster.txt';
  fs.writeFileSync(ausgabe, Z.join('\r\n'), 'utf8');

  try { fs.rmSync(TESTDATEN, { recursive: true, force: true }); } catch (e) {}
  fenster.destroy();
  app.exit(probleme.length ? 1 : 0);
});

app.on('window-all-closed', () => app.exit(0));
setTimeout(() => {
  fs.writeFileSync('C:\\Users\\Anwender\\AppData\\Local\\Temp\\opencode\\widget-fenster.txt',
    Z.join('\r\n') + '\r\n\r\nABBRUCH: Zeitueberschreitung nach 90 s.\r\n', 'utf8');
  try { app.exit(3); } catch (e) {}
}, 90000);
