// test-schnellzugriff-fenster.js
//   node_modules\electron\dist\electron.exe test-schnellzugriff-fenster.js
//
// Prueft den Schnellzugriff auf der Startseite im ECHTEN Electron-Fenster,
// mit echtem preload und echter index.html. Nicht simuliert.
//
// Warum ein Fenster-Test und nicht nur die statischen Pruefungen aus
// test-ideen-fixes.js: dort ist nur nachlesbar, dass die Kacheln im HTML
// stehen. Ob ein Klick auf "Welten" die Ansicht wirklich umschaltet, ob
// "Design aendern" das Panel oeffnet und ob der Screenshot-Knopf den Kanal
// aufruft und die Statuszeile fuellt, zeigt erst das Fenster.
//
// Der Screenshot-Kanal wird hier durch eine Attrappe ersetzt: der echte
// Handler zeichnet das Fenster (capturePage). Ein unsichtbares Test-Fenster
// liefert dabei kein verlaessliches Bild, und ob ein PNG auf der Platte
// landet, ist eine Aussage des Hauptprozesses, keine der Oberflaeche.
// Geprueft wird hier die Kette Renderer -> preload -> Kanal -> Statuszeile.

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJ = __dirname;
const DATEN = path.join(os.tmpdir(), 'll-schnellzugriff-test');

const Z = [];
const probleme = [];
let pruefungen = 0;

function ok(bedingung, text, zusatz) {
  pruefungen++;
  Z.push((bedingung ? '  OK    ' : '  FEHLT ') + text +
    (bedingung || !zusatz ? '' : '   -> ' + zusatz));
  if (!bedingung) probleme.push(text);
}
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); }

app.whenReady().then(async () => {
  fs.rmSync(DATEN, { recursive: true, force: true });
  fs.mkdirSync(DATEN, { recursive: true });
  app.setPath('userData', DATEN);

  const { registerIpcHandlers } = require('./src/main/ipc-handlers.js');
  registerIpcHandlers();

  // Den echten Screenshot-Kanal durch eine Attrappe ersetzen: wir wollen die
  // Oberflaeche pruefen, nicht die Bildaufnahme (die steht in ipc-handlers).
  let stubAntwort = { ok: true, datei: 'test-shot.png' };
  try { ipcMain.removeHandler('screenshot:capture'); } catch {}
  ipcMain.handle('screenshot:capture', async () => stubAntwort);

  const fenster = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(PROJ, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true
    }
  });
  const js = (code) => fenster.webContents.executeJavaScript(code, true);
  fenster.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) Z.push('  (Fenster meldet: ' + message + ')');
  });

  await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2200));

  // -------------------------------------------------------------------
  gruppe('0. Kontrolle: das echte Fenster laeuft');
  // -------------------------------------------------------------------
  const kontrolle = JSON.parse(await js(`JSON.stringify({
    hatLauncher: typeof window.launcher === 'object' && window.launcher !== null,
    hatShots: !!(window.launcher && window.launcher.screenshots),
    kacheln: document.querySelectorAll('.shortcut-kachel').length,
    status: !!document.getElementById('shortcutStatus')
  })`));
  ok(kontrolle.hatLauncher, 'window.launcher ist vorhanden');
  ok(kontrolle.hatShots, 'window.launcher.screenshots ist vorhanden (der neue Kanal)');
  ok(kontrolle.status, 'die Statuszeile im Schnellzugriff existiert');
  ok(kontrolle.kacheln === 8, 'acht Kacheln (sechs Ansichten + zwei Aktionen)',
     String(kontrolle.kacheln));
  if (!kontrolle.hatLauncher || !kontrolle.hatShots) {
    Z.push('');
    Z.push('!! Kontrolle fehlgeschlagen - die weiteren Ergebnisse waeren wertlos.');
    console.log(Z.join('\n'));
    app.quit();
    return;
  }

  // -------------------------------------------------------------------
  gruppe('1. Jede Ansicht ist ueber eine Kachel erreichbar');
  // -------------------------------------------------------------------
  {
    const views = JSON.parse(await js(`JSON.stringify(
      [].map.call(document.querySelectorAll('.shortcut-kachel[data-view]'),
        function(b){ return b.dataset.view; }))`));
    for (const v of ['worlds', 'mods', 'resourcepacks', 'servers', 'account', 'settings']) {
      ok(views.indexOf(v) !== -1, 'die Kachel fuer "' + v + '" ist da');
    }
  }

  // -------------------------------------------------------------------
  gruppe('1b. Ein Klick auf "Welten" schaltet die Ansicht um');
  // -------------------------------------------------------------------
  {
    await js(`document.querySelector('.shortcut-kachel[data-view="worlds"]').click(); true;`);
    await new Promise(r => setTimeout(r, 300));
    const m = JSON.parse(await js(`JSON.stringify({
      view: document.getElementById('shellEl').getAttribute('data-view'),
      klasse: (document.querySelector('.nav-item[data-view="worlds"]') || {}).className || ''
    })`));
    ok(m.view === 'worlds', 'die Ansicht steht auf "worlds"', m.view);
    ok(/\bactive\b/.test(m.klasse), 'der Seitenleisten-Knopf "Welten" leuchtet', m.klasse);
  }

  // -------------------------------------------------------------------
  gruppe('2. Design aendern oeffnet das Panel');
  // -------------------------------------------------------------------
  {
    const vorher = await js(`document.getElementById('themePanel').hidden`);
    ok(vorher === true, 'das Design-Panel ist zu Beginn geschlossen', String(vorher));
    await js(`document.querySelector('.shortcut-kachel[data-action="theme"]').click(); true;`);
    await new Promise(r => setTimeout(r, 400));
    const nachher = await js(`document.getElementById('themePanel').hidden`);
    ok(nachher === false, 'nach dem Klick ist das Design-Panel offen', String(nachher));
    // Aufraeumen, damit der Screenshot-Abschnitt nicht durch ein offenes
    // Panel gestoert wird.
    await js(`document.getElementById('themeTrigger').click(); true;`);
    await new Promise(r => setTimeout(r, 250));
  }

  // -------------------------------------------------------------------
  gruppe('3. Screenshot: Kanal wird gerufen, Status zeigt die Datei');
  // -------------------------------------------------------------------
  {
    // Zurueck auf die Startseite, sonst liegt das Ansichts-Overlay davor.
    await js(`document.querySelector('.nav-item[data-view="play"]').click(); true;`);
    await new Promise(r => setTimeout(r, 300));

    stubAntwort = { ok: true, datei: 'test-shot.png' };
    await js(`document.querySelector('.shortcut-kachel[data-action="screenshot"]').click(); true;`);
    await new Promise(r => setTimeout(r, 500));
    const erfolg = JSON.parse(await js(`JSON.stringify({
      text: document.getElementById('shortcutStatus').textContent,
      fehler: document.getElementById('shortcutStatus').classList.contains('err')
    })`));
    ok(/test-shot\.png/.test(erfolg.text), 'der Dateiname steht in der Statuszeile', erfolg.text);
    ok(erfolg.fehler === false, 'kein Fehlerzustand bei Erfolg');

    // Fehlerpfad: der Kanal antwortet mit { ok:false } - die Zeile muss das
    // zeigen statt still zu bleiben.
    stubAntwort = { ok: false, fehler: 'Kaputt' };
    await js(`document.querySelector('.shortcut-kachel[data-action="screenshot"]').click(); true;`);
    await new Promise(r => setTimeout(r, 400));
    const text = await js(`document.getElementById('shortcutStatus').textContent`);
    const err = await js(`document.getElementById('shortcutStatus').classList.contains('err')`);
    ok(/Kaputt/.test(text), 'die Fehlermeldung des Kanals wird angezeigt', text);
    ok(err === true, 'die Statuszeile traegt den Fehlerzustand');
  }

  // -------------------------------------------------------------------
  console.log('\n' + Z.join('\n'));
  console.log('\n=====================================================');
  let ergebnisText;
  if (probleme.length === 0) {
    ergebnisText = 'ALLE ' + pruefungen + ' PRUEFUNGEN BESTANDEN';
  } else {
    ergebnisText = probleme.length + ' von ' + pruefungen + ' PRUEFUNGEN FEHLGESCHLAGEN:\n' +
      probleme.map(p => '  - ' + p).join('\n');
    process.exitCode = 1;
  }
  console.log(ergebnisText);
  // Ergebnis zusaetzlich in eine Datei schreiben: der Exit-Code eines GUI-
  // Prozesses ist in PowerShell nicht verlaesslich abgreifbar (dieselbe
  // Begruendung wie bei test-widgets-fenster.js). Die Datei ist die Quelle
  // der Wahrheit.
  try {
    fs.writeFileSync('C:\\Users\\Anwender\\AppData\\Local\\Temp\\opencode\\schnellzugriff-fenster.txt',
      ergebnisText + '\r\n\r\n' + Z.join('\r\n'), 'utf8');
  } catch { /* nur ein Zusatz */ }
  app.quit();
}).catch(err => {
  console.log(Z.join('\n'));
  console.error('\nFEHLER IM TESTABLAUF:', err && err.stack || err);
  process.exitCode = 1;
  app.quit();
});