// test-einstellungen-fenster.js
//   node_modules\electron\dist\electron.exe test-einstellungen-fenster.js
//
// Prueft die neuen Einstellungen im ECHTEN Electron-Fenster: mit dem echten
// preload, der echten index.html, den echten IPC-Kanaelen und einem
// eigenen userData-Ordner. Nicht simuliert.
//
// Warum Fenster und nicht reiner Text-Test: die Einstellungen hatten einen
// Fehler, den kein node --check und kein Regex je gefunden haette. Der
// Inhalt war 1356px hoch in einem 789px hohen Panel, und weil weder das
// Panel noch body scrollten, war alles darunter unerreichbar - darunter
// das Feld fuer die Microsoft-Client-ID. Im Quelltext sah jede Zeile
// voellig richtig aus. Erst ein Fenster hat gemessen, dass
// panel.scrollTop = 9999 weiterhin 0 ergibt.
//
// test-einstellungen.js prueft den Text, dieses hier prueft die Wirkung.
//
// Drei Dinge werden hier bewusst mit einer KONTROLLE gepaart, weil eine
// Messung ohne Kontrolle nichts beweist:
//   - Schrift: nicht nur "die Variable wurde gesetzt", sondern die
//     berechnete Schriftart eines echten Elements aendert sich mit
//   - Textgroesse: nicht nur "--fs steht auf 1.25", sondern eine echte
//     Schriftgroesse waechst um 25 % - waehrend ein Abstand daneben
//     gleich bleibt
//   - eigene Schriftdatei: nicht nur "die Bytes kamen zurueck", sondern
//     eine echte Schrift laesst sich laden und eine mit Zufallsbytes nicht

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJ = __dirname;
const DATEN = path.join(os.tmpdir(), 'll-einstellungen-test');
const EINSTELLUNGEN = path.join(DATEN, 'settings.json');
const SCHRIFTORDNER = path.join(DATEN, 'schrift');

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

function settingsSchreiben(objekt) {
  fs.mkdirSync(DATEN, { recursive: true });
  fs.writeFileSync(EINSTELLUNGEN, JSON.stringify(objekt, null, 2), 'utf8');
}

// Alle Kanaele aus ipc-handlers.js abmelden, damit registerIpcHandlers()
// ein zweites Mal laufen kann. removeHandler() wirft bei einem Kanal, der
// gar nicht da ist - deshalb durchgehen und den Fehler schlucken.
function alleKanaeleAbmelden(kanale) {
  for (const k of kanale) {
    try { ipcMain.removeHandler(k); } catch { /* kein handler, nur listener */ }
    try { ipcMain.removeAllListeners(k); } catch { /* egal */ }
  }
}

// Eine echte Schrift aus dem System, klein und garantiert vorhanden.
// Sie dient als Beweis, dass der Weg "Datei -> Data-URI -> @font-face"
// wirklich eine Schrift ergibt und nicht nur irgendeine Bytes.
const ECHTE_SCHRIFT = ['C:\\Windows\\Fonts\\marlett.ttf', 'C:\\Windows\\Fonts\\arial.ttf',
  'C:\\Windows\\Fonts\\segoeui.ttf']
  .find(p => { try { return fs.statSync(p).size > 0; } catch { return false; } });

app.whenReady().then(async () => {
  fs.rmSync(DATEN, { recursive: true, force: true });
  fs.mkdirSync(SCHRIFTORDNER, { recursive: true });
  app.setPath('userData', DATEN);

  const { registerIpcHandlers } = require('./src/main/ipc-handlers.js');
  registerIpcHandlers();
  Z.push('registerIpcHandlers() lief ohne Fehler.');

  let fenster = null;
  const js = (code) => fenster.webContents.executeJavaScript(code, true);

  // Fehler aus dem Renderer nach stdout durchreichen. Ohne das sagt
  // Electron bei einem Fehler nur "Script failed to execute, this normally
  // means an error was thrown" - und man weiss nicht, was im Fenster
  // eigentlich fehlt. Genau darum ist in einem frueheren Test ein
  // fehlendes DOM-Element als "0 Treffer" durchgegangen statt als Fehler.
  function fensterAnlegen() {
    const w = new BrowserWindow({
      show: false, width: 1400, height: 900,
      webPreferences: {
        preload: path.join(PROJ, 'src', 'main', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
        sandbox: true, webSecurity: true
      }
    });
    w.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) Z.push('  (Fenster meldet: ' + message + '  [' + source + ':' + line + '])');
    });
    return w;
  }

  // Die Kanaele aus der Quelle lesen statt sie hart zu tippen. Wer hier
  // nur die Settings-Kanaele abmeldet und registerIpcHandlers() zweimal
  // aufruft, laeuft in "Attempted to register a second handler for
  // 'instances:list'" - genau das ist der erste Versuch gewesen.
  const QUELLE_IPC = fs.readFileSync(path.join(PROJ, 'src', 'main', 'ipc-handlers.js'), 'utf8');
  const KANAELE = [...new Set(
    [...QUELLE_IPC.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)].map(m => m[1]))];
  Z.push('Kanaele aus ipc-handlers.js: ' + KANAELE.length +
    '  (darunter settings:get ' + KANAELE.includes('settings:get') +
    ' und schriften:lesen ' + KANAELE.includes('schriften:lesen') + ')');

  // Ein Fenster, kein Neues pro Abschnitt: Chromium verweigert sonst
  // gelegentlich das Laden ("ERR_FAILED (-2)"), wenn das vorherige gerade
  // abgeraeumt wird.
  //
  // Der wichtigere Grund ist ein anderer. "Neustart" heisst hier nicht
  // "Seite neu laden": settings.json wird bei registerIpcHandlers() genau
  // einmal von der Platte gelesen. Ein blasses reload wuerde den alten,
  // im Speicher liegenden Stand liefern - und alle Tests zur Persistenz
  // waeren gruen, ohne dass irgendetwas gespeichert worden waere. Deshalb
  // werden die Kanaele abgemeldet und neu registriert.
  async function oeffnen(settings) {
    settingsSchreiben(settings || {});
    alleKanaeleAbmelden(KANAELE);
    registerIpcHandlers();
    if (!fenster) fenster = fensterAnlegen();
    await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
    // 2200ms wie in den anderen Fenstertests: gibt dem Start-Block Zeit,
    // settings zu lesen, die Schrift zu laden und das Raster zu setzen.
    await new Promise(r => setTimeout(r, 2200));
  }

  // -------------------------------------------------------------------
  // 0. KONTROLLE
  // -------------------------------------------------------------------
  gruppe('0. Kontrolle: laeuft ueberhaupt das echte Fenster?');
  await oeffnen({});
  const kontrolle = JSON.parse(await js(`JSON.stringify({
    hatLauncher: typeof window.launcher === 'object' && window.launcher !== null,
    hatSettings: !!(window.launcher && window.launcher.settings),
    hatFonts: !!(window.launcher && window.launcher.fonts),
    karten: document.querySelectorAll('#settingsRaster .settings-karte').length,
    hatLaunchoptsNav: !!document.querySelector('.nav-item[data-view="launchopts"]'),
    hatOptsFelder: !!document.getElementById('optsRamMin')
  })`));
  ok(kontrolle.hatLauncher, 'window.launcher ist vorhanden');
  ok(kontrolle.hatSettings, 'window.launcher.settings ist vorhanden');
  ok(kontrolle.hatFonts, 'window.launcher.fonts ist vorhanden (der neue Kanal)');
  // Nach dem Umbau (Phase C): die Startoptionen sind keine eigene Ansicht
  // mehr, sondern die vierte Karte in den Einstellungen.
  ok(kontrolle.karten === 4, 'Genau vier Einstellungskarten (inkl. Startoptionen)',
     String(kontrolle.karten));
  ok(!kontrolle.hatLaunchoptsNav, 'Der Startoptionen-Menuepunkt ist aus der Seitenleiste raus');
  ok(kontrolle.hatOptsFelder, 'Die RAM-Felder stehen jetzt in den Einstellungen');
  if (!kontrolle.hatLauncher || kontrolle.karten !== 4) {
    Z.push('');
    Z.push('!! Die Kontrolle ist fehlgeschlagen. Alle weiteren Ergebnisse waeren');
    Z.push('   wertlos - es laeuft dann nicht die echte Oberflaeche.');
    console.log(Z.join('\n'));
    app.quit();
    return;
  }

  // Zweite Kontrolle, und sie ist die wichtigere: bringt das erneute
  // Registrieren der Kanaele ueberhaupt die neue Datei auf die Schirm?
  // Ohne sie koennte der ganze Test mit einem uralten, im Speicher
  // liegenden Stand laufen und dabei gruen werden - gerade die Abschnitte
  // 5, 6, 9 und 10 pruefen sonst nichts.
  {
    settingsSchreiben({ schrift: 'consolas', schriftGroesse: 90 });
    alleKanaeleAbmelden(KANAELE);
    registerIpcHandlers();
    const gelesen = await js(`window.launcher.settings.get().then(function(s){
      return JSON.stringify({ schrift: s.schrift, groesse: s.schriftGroesse }); })`);
    const p = JSON.parse(gelesen);
    ok(p.schrift === 'consolas' && p.groesse === 90,
       'KONTROLLE: nach dem Neuladen kommt die NEUE Datei zurueck, nicht ein alter Stand',
       gelesen);
  }
  await oeffnen({});

  // -------------------------------------------------------------------
  // 1. Die Karten sind erreichbar (der gefundene Fehler)
  // -------------------------------------------------------------------
  gruppe('1. Alles in den Einstellungen ist erreichbar');
  await js('document.querySelector(\'.nav-item[data-view="settings"]\').click(); true;');
  await new Promise(r => setTimeout(r, 400));
  {
    const m = JSON.parse(await js(`JSON.stringify((function(){
      var sc = document.querySelector('#viewSettings .settings-scroll');
      var oben = sc.scrollTop;
      sc.scrollTop = 99999;
      var unten = sc.scrollTop;
      var hoechst = unten;
      sc.scrollTop = oben;
      return {
        scrollHoehe: sc.scrollHeight,
        sichtbareHoehe: sc.clientHeight,
        maxScroll: hoechst,
        overflowY: getComputedStyle(sc).overflowY
      };
    })())`));
    ok(m.overflowY === 'auto', 'Der Einstellungsbereich kann ueberhaupt scrollen',
       'overflow-y ist ' + m.overflowY);
    ok(m.maxScroll > 0, 'Es gibt ueberhaupt etwas zu scrollen',
       'maxScroll = ' + m.maxScroll);
    ok(m.scrollHoehe > m.sichtbareHoehe, 'Der Inhalt ist hoeher als der Bereich',
       m.scrollHoehe + ' > ' + m.sichtbareHoehe);

    // Der eigentliche Nachweis: laesst sich jede Karte vollstaendig anzeigen?
    // Nicht nur "oben sichtbar" - eine Karte, die hoeher ist als der
    // Bereich, muss auch mit ihrem ENDE erreichbar sein.
    const karten = JSON.parse(await js(`JSON.stringify((function(){
      var sc = document.querySelector('#viewSettings .settings-scroll');
      var out = [];
      [].forEach.call(document.querySelectorAll('#settingsRaster .settings-karte'), function(k){
        var titel = (k.querySelector('.settings-karte-titel') || {}).textContent || '?';
        // Fuer jede Karte beide Enden pruefen: Anfang sichtbar? Ende sichtbar?
        sc.scrollTop = 0;
        var b = k.getBoundingClientRect(), c = sc.getBoundingClientRect();
        var anfangSichtbar = (b.top - c.top) >= -1;
        sc.scrollTop = 99999;
        b = k.getBoundingClientRect();
        var endeSichtbar = (b.bottom - c.top) <= sc.clientHeight + 1;
        out.push({ titel: titel, hoehe: Math.round(k.getBoundingClientRect().height),
                   anfang: anfangSichtbar, ende: endeSichtbar });
      });
      sc.scrollTop = 0;
      return out;
    })())`));
    for (const k of karten) {
      ok(k.anfang, '"' + k.titel + '": Anfang erreichbar', 'Hoehe ' + k.hoehe);
      ok(k.ende, '"' + k.titel + '": Ende erreichbar',
         'Hoehe ' + k.hoehe + ', Bereich ' + m.sichtbareHoehe);
    }
    // Die Microsoft-Login-Karte wurde bewusst aus den Einstellungen entfernt:
    // das Client-ID-Feld darf im DOM nicht mehr auftauchen. Dass die Karten
    // trotzdem vollstaendig erreichbar bleiben, deckt die Schleife oben ab.
    const clientId = JSON.parse(await js(`JSON.stringify((function(){
      return { da: !!document.getElementById('clientIdInput') };
    })())`));
    ok(!clientId.da, 'Das Microsoft-Client-ID-Feld ist aus den Einstellungen entfernt');
  }

  // -------------------------------------------------------------------
  // 2. Das Karten-Raster
  // -------------------------------------------------------------------
  gruppe('2. Die Karten stehen untereinander in EINER Spalte');
  {
    const g = JSON.parse(await js(`JSON.stringify((function(){
      var r = document.getElementById('settingsRaster');
      var karten = [].map.call(r.querySelectorAll('.settings-karte'), function(k){
        var q = k.getBoundingClientRect();
        return { titel: (k.querySelector('.settings-karte-titel') || {}).textContent,
                 oben: Math.round(q.top), breite: Math.round(q.width),
                 breit: k.classList.contains('breit') };
      });
      return { display: getComputedStyle(r).display,
               spalten: getComputedStyle(r).gridTemplateColumns,
               karten: karten };
    })())`));
    ok(g.display === 'grid', 'Das Raster ist wirklich ein Raster', 'display: ' + g.display);
    const spaltenZahl = g.spalten.split(' ').filter(x => x && x !== 'none').length;
    ok(spaltenZahl === 1, 'Genau EINE Spalte - die Karten stehen untereinander', g.spalten);
    const normal = g.karten.filter(k => !k.breit);
    const breit = g.karten.filter(k => k.breit);
    ok(normal.every(k => k.breite > 900), 'Auch die normalen Karten laufen ueber die volle Breite',
       JSON.stringify(normal.map(k => k.breite)));
    ok(breit.length === 0, 'Keine Karte traegt noch die Klasse breit (Microsoft-Karte ist raus)',
       JSON.stringify(breit.map(k => k.titel)));
    // Keine zwei Karten auf gleicher Hoehe: alles untereinander.
    const paare = new Set(normal.map(k => k.oben));
    ok(paare.size === normal.length, 'Keine zwei Karten teilen sich eine Reihe',
       'Reihen bei y = ' + [...paare].join(', '));
  }

  // -------------------------------------------------------------------
  // 3. Schrift waehlen
  // -------------------------------------------------------------------
  gruppe('3. Schriftauswahl');
  {
    const v = JSON.parse(await js(`JSON.stringify((function(){
      var sel = document.getElementById('schriftSelect');
      var ziel = document.getElementById('heroCard');
      var h1 = document.querySelector('#heroCard h1');
      function messe() { return { fam: getComputedStyle(ziel).fontFamily,
                                  h1: getComputedStyle(h1).fontSize }; }
      var vorher = messe();
      var werte = [].map.call(sel.options, function(o){ return o.value; });
      var treffer = [];
      for (const w of werte) {
        sel.value = w;
        sel.dispatchEvent(new Event('change'));
        var n = messe();
        treffer.push({ wert: w, fam: n.fam, h1: n.h1, neu: n.fam !== vorher.fam });
      }
      return { werte: werte, vorher: vorher, treffer: treffer };
    })())`));
    ok(v.werte.length === 9, 'Neun Eintraege: eigene Datei + acht Systemschriften',
       v.werte.join(', '));
    ok(v.werte[0] === 'eigene', 'Die eigene Datei steht oben');
    // Die eigentliche Behauptung: die Schrift des Fensters aendert sich.
    const geaendert = v.treffer.filter(t => t.wert !== 'eigene' && t.neu);
    ok(geaendert.length >= 4, 'Mindestens vier Systemschriften aendern die Oberflaeche sichtbar',
       v.treffer.map(t => t.wert + (t.neu ? '+' : '=')).join(' '));
    ok(v.treffer.every(t => t.h1 === v.vorher.h1),
       'Beim Wechsel der Schrift aendert sich die Schriftgroesse NICHT (Kontrolle)');

    // Ein unbekannter Wert darf nichts setzen.
    const unbekannt = JSON.parse(await js(`JSON.stringify((function(){
      var sel = document.getElementById('schriftSelect');
      sel.value = 'georgia'; sel.dispatchEvent(new Event('change'));
      return getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
    })())`));
    ok(/Georgia/.test(unbekannt), 'Nach der Auswahl steht die richtige Familie in --font-ui',
       unbekannt);
  }

  // -------------------------------------------------------------------
  // 4. Textgroesse
  // -------------------------------------------------------------------
  gruppe('4. Textgroesse');
  {
    const m = JSON.parse(await js(`JSON.stringify((function(){
      function setzen(v){
        var r = document.getElementById('schriftGroesse');
        r.value = String(v);
        r.dispatchEvent(new Event('input'));
      }
      var h1 = document.querySelector('#heroCard h1');
      var karte = document.getElementById('settingsRaster');
      var zeile = document.querySelector('.shortcut-titel');
      function messe(){
        return { h1: parseFloat(getComputedStyle(h1).fontSize),
                 zeile: parseFloat(getComputedStyle(zeile).fontSize),
                 kartePadding: getComputedStyle(karte).paddingTop,
                 kachelPadding: getComputedStyle(document.querySelector('.shortcut-kachel')).paddingTop };
      }
      setzen(100); var a = messe();
      setzen(125); var b = messe();
      setzen(85);  var c = messe();
      setzen(100);
      return { a: a, b: b, c: c, wert: document.getElementById('schriftGroesseWert').textContent };
    })())`));
    const f = (a, b) => a / b;
    ok(Math.abs(f(m.b.h1, m.a.h1) - 1.25) < 0.02,
       'Bei 125 % wird die grosse Ueberschrift um 25 % groesser',
       m.a.h1 + ' px -> ' + m.b.h1 + ' px  (Faktor ' + f(m.b.h1, m.a.h1).toFixed(3) + ')');
    ok(Math.abs(f(m.b.zeile, m.a.zeile) - 1.25) < 0.03,
       'Auch ein kleiner Text waechst um 25 %',
       m.a.zeile + ' px -> ' + m.b.zeile + ' px');
    ok(Math.abs(f(m.c.h1, m.a.h1) - 0.85) < 0.02,
       'Bei 85 % wird sie um 15 % kleiner',
       m.a.h1 + ' px -> ' + m.c.h1 + ' px');
    // Die Kontrolle: Rahmen und Abstaende duerfen NICHT mitwachsen. Sonst
    // waere es kein Textgroessenregler, sondern eine Seitenlupe.
    ok(m.a.kartePadding === m.b.kartePadding,
       'KONTROLLE: der Karten-Innenabstand waechst nicht mit',
       m.a.kartePadding + ' vs ' + m.b.kartePadding);
    ok(m.a.kachelPadding === m.b.kachelPadding,
       'KONTROLLE: der Kachel-Innenabstand waechst nicht mit',
       m.a.kachelPadding + ' vs ' + m.b.kachelPadding);
  }

  // -------------------------------------------------------------------
  // 5. Eigene Schriftdatei: eine echte laesst sich laden
  // -------------------------------------------------------------------
  gruppe('5. Eigene Schriftdatei');
  if (!ECHTE_SCHRIFT) {
    ok(false, 'Auf diesem Rechner liegt keine .ttf zum Testen bereit');
  } else {
    Z.push('  (Testschrift: ' + path.basename(ECHTE_SCHRIFT) + ')');
    fs.copyFileSync(ECHTE_SCHRIFT, path.join(SCHRIFTORDNER, 'eigene.ttf'));
    await oeffnen({ schrift: 'eigene', eigeneSchrift: 'eigene.ttf' });

    const r = JSON.parse(await js(`(async function(){
      var daten = await window.launcher.fonts.read();
      var regel = document.getElementById('llEigeneSchrift');
      var geladen = [];
      try {
        var f = await Promise.race([
          document.fonts.load('12px LiquidEigeneSchrift'),
          new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('Zeitueberschreitung')); }, 4000); })
        ]);
        geladen = f.length;
      } catch (e) { geladen = -1; }
      return JSON.stringify({
        name: daten && daten.name,
        mime: daten && daten.mime,
        laenge: daten && daten.dataUri ? daten.dataUri.length : 0,
        praefix: daten && daten.dataUri ? daten.dataUri.slice(0, 21) : '',
        hatRegel: !!regel,
        regel: regel ? regel.textContent.slice(0, 100) : '',
        eigeneGewaehlt: document.getElementById('schriftSelect').value,
        stapel: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
        infos: document.getElementById('eigeneSchriftInfo').textContent,
        geladen: geladen,
        knopfSichtbar: !document.getElementById('eigeneSchriftWegBtn').hidden
      });
    })()`));

    ok(r.name === 'eigene.ttf', 'Der Dateiname kommt zurueck', String(r.name));
    ok(r.mime === 'font/ttf', 'Der MIME-Typ passt zur Endung', String(r.mime));
    ok(r.praefix === 'data:font/ttf;base64,', 'Die Bytes kommen als Data-URI', r.praefix);
    ok(r.laenge > 10000, 'Die Data-URI enthaelt wirklich die ganze Datei',
       r.laenge + ' Zeichen');
    ok(r.hatRegel, 'Die @font-face-Regel wurde erzeugt');
    ok(/LiquidEigeneSchrift/.test(r.regel) && /data:font\/ttf/.test(r.regel),
       'Die Regel nennt den festen Namen und die Data-URI', r.regel);
    ok(!/eigene\.ttf/.test(r.regel), 'Der Dateiname steht NICHT in der CSS-Regel',
       r.regel);
    ok(r.geladen > 0, 'Der Browser hat die Schrift wirklich geladen',
       'document.fonts.load() ergab ' + r.geladen + ' FontFaces');
    ok(r.eigeneGewaehlt === 'eigene', '"Eigene Datei" bleibt gewaehlt, weil eine Datei da ist',
       String(r.eigeneGewaehlt));
    ok(/LiquidEigeneSchrift/.test(r.stapel),
       'Die eigene Schrift steht im Stapel an erster Stelle', r.stapel);
    ok(/Geladen/.test(r.infos), 'Die Statuszeile sagt, welche Datei geladen ist', r.infos);
    ok(r.knopfSichtbar, 'Der Entfernen-Knopf ist sichtbar, wenn eine Datei da ist');

    // Gegenprobe: dieselbe Endung, aber Zufallsbytes. Der Browser muss die
    // ablehnen - dann ist "die Datei wurde angenommen" wirklich nicht
    // dasselbe wie "es ist eine Schrift".
    fs.writeFileSync(path.join(SCHRIFTORDNER, 'eigene.ttf'),
      Buffer.from('das ist keine schrift, nur text.'.repeat(400)));
    await oeffnen({ schrift: 'eigene', eigeneSchrift: 'eigene.ttf' });
    const g = JSON.parse(await js(`(async function(){
      var daten = await window.launcher.fonts.read();
      var geladen = 0;
      try {
        var f = await Promise.race([
          document.fonts.load('12px LiquidEigeneSchrift'),
          new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('Zeit')); }, 4000); })
        ]);
        geladen = f.length;
      } catch (e) { geladen = -1; }
      return JSON.stringify({ gelesen: !!daten, geladen: geladen,
        gewaehlt: document.getElementById('schriftSelect').value,
        stapel: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() });
    })()`));
    ok(g.gelesen, 'Die Bytes werden auch bei Muell uebergeben (nur die Endung wird geprueft)');
    ok(g.geladen === 0 || g.geladen === -1,
       'GEGENPROBE: der Browser laesst Muell als Schrift durchfallen', 'FontFaces: ' + g.geladen);
    ok(g.gewaehlt === 'standard',
       '"Eigene Datei" faellt zurueck, weil keine brauchbare Schrift da ist', g.gewaehlt);
    ok(!/LiquidEigeneSchrift/.test(g.stapel), 'Der Stapel nennt die unbrauchbare Schrift nicht mehr',
       g.stapel);
  }

  // -------------------------------------------------------------------
  // 6. Pfadabwehr: settings.json kann keinen Pfad einschleusen
  // -------------------------------------------------------------------
  gruppe('6. Ein manipuliertes settings.json kommt nicht durch');
  for (const [name, wert] of [
    ['Verzeichnis-Sprung', '../../Programme/evil.ttf'],
    ['absoluter Pfad', 'C:\\Windows\\System32\\drivers\\etc\\hosts.ttf'],
    ['falsche Endung', 'eigene.exe'],
    ['Unbekannte Endung', 'eigene.png'],
    ['leerer Name', ''],
  ]) {
    await oeffnen({ schrift: 'eigene', eigeneSchrift: wert });
    const r = await js(`window.launcher.fonts.read().then(function(d){ return d === null; })`);
    ok(r === true, 'Zurueckgewiesen: ' + name, 'Wert: ' + JSON.stringify(wert) + ', read() -> ' + r);
  }
  {
    // Und die Kontrolle: derselbe Aufruf MIT gueltigem Namen liefert Bytes.
    // Sonst koennte der Test auch dann gruen sein, wenn read() immer null
    // zurueckgibt.
    await oeffnen({ schrift: 'eigene', eigeneSchrift: 'eigene.ttf' });
    const r = await js(`window.launcher.fonts.read().then(function(d){ return d ? d.name : null; })`);
    ok(r === 'eigene.ttf', 'KONTROLLE: mit gueltigem Namen kommen die Bytes zurueck', String(r));
  }

  // -------------------------------------------------------------------
  // 7. "Weniger Bewegung"
  // -------------------------------------------------------------------
  gruppe('7. Der Schalter fuer weniger Bewegung');
  {
    await oeffnen({});
    const m = JSON.parse(await js(`JSON.stringify((function(){
      var schalter = document.getElementById('bewegungSchalter');
      function zustand(){
        return { klasse: document.documentElement.classList.contains('ll-wenig-bewegung'),
                 aria: schalter.getAttribute('aria-checked') };
      }
      // Messobjekt: Hero und Profilkarte bewegen sich seit 06.10. nicht
      // mehr - der Test haengt sich deshalb eine eigene stat-tile-Kachel
      // an, die weiterhin mitlaeuft, und misst an ihr die beiden Stufen.
      function ziel(){
        var el = document.getElementById('testBewegung');
        if(!el){
          el = document.createElement('div');
          el.id = 'testBewegung';
          el.className = 'stat-tile';
          el.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:80px;';
          document.body.appendChild(el);
        }
        return el;
      }
      // Echter Mausweg: mouseover, dann mousemove mit Koordinaten.
      function ueberfahren(){
        var el = ziel();
        var r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width - 4, clientY: r.top + 3 }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width - 4, clientY: r.top + 3 }));
        return el.style.transform || '';
      }
      function zurueck(){
        var el = ziel();
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
        return el.style.transform === '' ? 'geleert' : el.style.transform;
      }
      var aus = zustand();
      var bewegtAus = ueberfahren();
      zurueck();
      schalter.click();
      var an = zustand();
      var bewegtAn = ueberfahren();
      zurueck();
      schalter.click();
      var wiederAus = zustand();
      var bewegtWieder = ueberfahren();
      zurueck();
      return { aus: aus, an: an, wiederAus: wiederAus,
               bewegtAus: bewegtAus, bewegtAn: bewegtAn, bewegtWieder: bewegtWieder };
    })())`));
    ok(m.aus.klasse === false, 'Ausgeliefert ist die Bewegung an');
    ok(m.aus.aria === 'false', 'Der Schalter steht aus');
    ok(/translate/.test(m.bewegtAus), 'Die Karte bewegt sich beim Ueberfahren',
       JSON.stringify(m.bewegtAus));
    ok(m.an.klasse === true, 'Nach dem Klick steht die Klasse an', JSON.stringify(m.an));
    ok(m.an.aria === 'true', 'Der Schalter meldet "an"');
    ok(m.bewegtAn === '', 'Bei eingeschaltetem Schalter bewegt sich NICHTS',
       JSON.stringify(m.bewegtAn));
    ok(m.wiederAus.klasse === false, 'Nach dem zweiten Klick ist sie wieder aus');
    ok(/translate/.test(m.bewegtWieder), 'Und die Bewegung kommt wieder zurueck',
       JSON.stringify(m.bewegtWieder));
  }
  {
    // Persistenz. Wichtig: gelesen wird direkt nach EINEM Klick auf AN.
    // Am Ende von Abschnitt 7 wurde der Schalter ein zweites Mal geklickt,
    // er steht also wieder auf AUS, und die Datei sagt folgerichtig false.
    // Genau so hat die erste Fassung dieses Tests "wird gespeichert"
    // fehlschlagen lassen, ohne dass etwas im Programm kaputt war.
    await js(`document.getElementById('bewegungSchalter').click(); true;`);
    const g = await js(`window.launcher.settings.get().then(function(s){ return s.wenigerBewegung; })`);
    ok(g === true, 'Ein Klick auf AN steht danach in der Datei', 'settings.json sagt: ' + g);
    await oeffnen({ wenigerBewegung: true });
    const h = JSON.parse(await js(`JSON.stringify({
      klasse: document.documentElement.classList.contains('ll-wenig-bewegung'),
      aria: document.getElementById('bewegungSchalter').getAttribute('aria-checked')
    })`));
    ok(h.klasse && h.aria === 'true', 'Beim naechsten Start ist er wieder an', JSON.stringify(h));
    // Und der Weg zurueck: AUS wird ebenso gespeichert wie AN.
    await js(`document.getElementById('bewegungSchalter').click(); true;`);
    const z = await js(`window.launcher.settings.get().then(function(s){ return s.wenigerBewegung; })`);
    ok(z === false, 'Und ein Klick auf AUS ebenso', 'settings.json sagt: ' + z);
  }

  // -------------------------------------------------------------------
  // 8. Suche
  // -------------------------------------------------------------------
  gruppe('8. Die Suche in den Einstellungen');
  {
    await oeffnen({});
    await js('document.querySelector(\'.nav-item[data-view="settings"]\').click(); true;');
    await new Promise(r => setTimeout(r, 300));
    const m = JSON.parse(await js(`JSON.stringify((function(){
      var f = document.getElementById('settingsSuche');
      function suchen(w){
        f.value = w; f.dispatchEvent(new Event('input'));
        return {
          w: w,
          sichtbar: [].filter.call(document.querySelectorAll('#settingsRaster .settings-karte'),
            function(k){ return !k.classList.contains('unsichtbar'); })
            .map(function(k){ return (k.querySelector('.settings-karte-titel')||{}).textContent; }),
          leer: document.getElementById('settingsLeer').classList.contains('an'),
          unsichtbarWirklich: (function(){
            var k = document.querySelector('#settingsRaster .settings-karte.unsichtbar');
            return k ? getComputedStyle(k).display : 'nichts ausgeblendet';
          })()
        };
      }
      return [suchen(''), suchen('schrift'), suchen('anordnung'),
              suchen('widget'), suchen('gibtesnicht'), suchen('ANORDNUNG'),
              suchen('aufloesung')];
    })())`));
    ok(m[0].sichtbar.length === 4, 'Leeres Feld: alle vier Karten da (Startoptionen sind in den Einstellungen)',
       JSON.stringify(m[0].sichtbar));
    ok(m[1].sichtbar.length === 1 && /Darstellung/.test(m[1].sichtbar[0]),
       '"schrift" findet genau die Darstellungskarte', JSON.stringify(m[1].sichtbar));
    ok(m[2].sichtbar.length === 1 && /Karten-Layout/.test(m[2].sichtbar[0]),
       '"anordnung" findet genau die Layout-Karte', JSON.stringify(m[2].sichtbar));
    ok(m[3].sichtbar.length === 1 && /Widgets/.test(m[3].sichtbar[0]),
       '"widget" findet genau die Widget-Karte', JSON.stringify(m[3].sichtbar));
    // Frueher stand hier "ram" - seit Phase D4 heisst eine Kachel in der
    // Widget-Liste "RAM fürs Spiel", und "ram" trifft damit auch die
    // Widget-Karte. Gesucht wird deshalb nach "aufloesung", einem Begriff,
    // der nur in der data-suche der Startoptionen-Karte steht.
    ok(m[6].sichtbar.length === 1 && /Startoptionen/.test(m[6].sichtbar[0]),
       '"aufloesung" findet genau die Startoptionen-Karte', JSON.stringify(m[6].sichtbar));
    ok(m[4].sichtbar.length === 0, 'Ein Unsinnswort findet nichts', JSON.stringify(m[4].sichtbar));
    ok(m[4].leer === true, 'Und sagt das auch');
    ok(m[4].unsichtbarWirklich === 'none', 'Ausgeblendete Karten sind wirklich display:none',
       m[4].unsichtbarWirklich);
    // Grossbuchstaben: die Suche wandelt both sides in Kleinbuchstaben um.
    // Geprueft wird mit einem Begriff, der wirklich in einer Karte steht -
    // "SUCHE" waere hier sinnlos, weil das Suchfeld selbst ausserhalb der
    // Karten liegt und der Begriff daher nirgends auftaucht.
    ok(m[5].sichtbar.length === 1 && /Karten-Layout/.test(m[5].sichtbar[0]),
       'Grossbuchstaben stoeren nicht', JSON.stringify(m[5].sichtbar));    // Querprobe: der englische Begriff findet die Karte auch, wenn die
    // Oberflaeche auf Deutsch steht.
    const q = JSON.parse(await js(`JSON.stringify((function(){
      var f = document.getElementById('settingsSuche');
      f.value = 'widget'; f.dispatchEvent(new Event('input'));
      var a = [].filter.call(document.querySelectorAll('#settingsRaster .settings-karte'),
        function(k){ return !k.classList.contains('unsichtbar'); }).length;
      f.value = 'apparence'; f.dispatchEvent(new Event('input'));
      var b = [].filter.call(document.querySelectorAll('#settingsRaster .settings-karte'),
        function(k){ return !k.classList.contains('unsichtbar'); }).length;
      f.value = ''; f.dispatchEvent(new Event('input'));
      return { widget: a, fr: b };
    })())`));
    ok(q.widget === 1, 'Der englische Begriff findet die Karte auf einer deutschen Oberflaeche',
       String(q.widget) + ' Karten');
    ok(q.fr === 1, 'Und der franzoesische Titel derselben Karte auch',
       String(q.fr) + ' Karten');
  }

  // -------------------------------------------------------------------
  // 9. Das gespeicherte Karten-Layout wird migriert
  // -------------------------------------------------------------------
  gruppe('9. Ein altes Layout mit "news" wird uebernommen');
  {
    // Ein Layout, wie es vor dem Umbau auf der Platte lag: dieselben Karten
    // wie heute, nur heisst der Schnellzugriff noch "news".
    //
    // Wichtig sind hier colSpan/rowSpan. Die erste Fassung dieses Tests
    // schrieb w/h, und weil das Raster heute colSpan/rowSpan heisst, war fuer
    // layoutUebernehmen() nichts zu uebernehmen - die Karte blieb auf der
    // Standardposition und der Test meldete einen Fehler, der eigentlich
    // im Test lag. Genau deshalb steht hier die Kontrolle: dieselbe Position
    // einmal mit "news" und einmal mit "shortcut" gespeichert. Wenn beide
    // Laeufe dasselbe ergeben, ist die Migration nachgewiesen; wenn beide
    // Laeufe die Standardposition ergaeben, waere der Test gruen, ohne dass
    // etwas geprueft waere.
    const ALT = {
      hero:    { col: 2, row: 1, colSpan: 3, rowSpan: 4 },
      profile: { col: 5, row: 1, colSpan: 2, rowSpan: 1 },
      stat:    { col: 5, row: 2, colSpan: 2, rowSpan: 2 },
      news:    { col: 1, row: 2, colSpan: 1, rowSpan: 1 }
    };
    const NEU = { hero: ALT.hero, profile: ALT.profile, stat: ALT.stat,
                  shortcut: ALT.news };

    async function messen(layout){
      await oeffnen({ blockLayout: layout });
      return JSON.parse(await js(`JSON.stringify((function(){
        var k = document.getElementById('shortcutCard');
        return {
          da: !!k,
          block: k ? k.getAttribute('data-block') : null,
          col: k ? getComputedStyle(k).gridColumn : null,
          row: k ? getComputedStyle(k).gridRow : null
        };
      })())`));
    }

    const alt = await messen(ALT);
    const neu = await messen(NEU);

    ok(alt.da, 'Die Schnellzugriff-Karte ist da');
    ok(alt.block === 'shortcut', 'Sie traegt data-block="shortcut"', String(alt.block));
    // Die Karte steht auf Kartenkoordinate Spalte 1 - berechnet wird daraus
    // Spalte 2, weil links die schmale Seitenleisten-Spur davorsteht.
    ok(alt.col === '2 / span 1' && alt.row === '2 / span 1',
       'Ein altes "news" setzt die Karte auf die alte Stelle (hinter der Spur)',
       JSON.stringify({ col: alt.col, row: alt.row }));
    ok(alt.col === neu.col && alt.row === neu.row,
       'Und genau dieselbe Stelle wie das Layout, das schon "shortcut" hiess',
       JSON.stringify({ alt: [alt.col, alt.row], neu: [neu.col, neu.row] }));
    // Gegenprobe: das muss auch wirklich eine andere Stelle sein als sonst.
    ok(!(alt.col === '6 / span 2' && alt.row === '4 / span 1'),
       'Und nicht stillschweigend auf der Standardposition',
       JSON.stringify({ col: alt.col, row: alt.row }));
  }

  // -------------------------------------------------------------------
  // 10. Persistenz: was gespeichert wird, kommt wieder
  // -------------------------------------------------------------------
  gruppe('10. Einstellungen ueberleben einen Neustart');
  {
    await oeffnen({});
    await js(`(function(){
      var sel = document.getElementById('schriftSelect');
      sel.value = 'georgia'; sel.dispatchEvent(new Event('change'));
      var r = document.getElementById('schriftGroesse');
      r.value = '110'; r.dispatchEvent(new Event('input'));
      r.dispatchEvent(new Event('change'));
      document.getElementById('bewegungSchalter').click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 600));

    // Auf der Platte nachsehen, nicht nur im Fenster: genau das ist der
    // Unterschied zwischen "gesetzt" und "gespeichert".
    const platte = JSON.parse(fs.readFileSync(EINSTELLUNGEN, 'utf8'));
    ok(platte.schrift === 'georgia', 'settings.json enthaelt die Schrift',
       JSON.stringify(platte.schrift));
    ok(platte.schriftGroesse === 110, 'settings.json enthaelt die Textgroesse',
       JSON.stringify(platte.schriftGroesse));
    ok(platte.wenigerBewegung === true, 'settings.json enthaelt den Schalter',
       JSON.stringify(platte.wenigerBewegung));
    // Und keine Bytes in der Konfigurationsdatei - die gehoeren in den
    // eigenen Ordner, sonst waere die Datei unlesbar gross.
    ok(!JSON.stringify(platte).includes('data:font'),
       'Keine Schrift-Bytes in settings.json');
    ok(!('eigeneSchrift' in platte),
       'Kein Schrift-Dateiname eingetragen, wenn keine Datei gewaehlt wurde',
       JSON.stringify(platte.eigeneSchrift));

    // Jetzt NEU laden, mit genau dieser Datei. Das ist der Neustart.
    await oeffnen(platte);
    const m = JSON.parse(await js(`JSON.stringify({
      schrift: document.getElementById('schriftSelect').value,
      groesse: document.getElementById('schriftGroesse').value,
      anzeige: document.getElementById('schriftGroesseWert').textContent,
      schalter: document.getElementById('bewegungSchalter').getAttribute('aria-checked'),
      klasse: document.documentElement.classList.contains('ll-wenig-bewegung'),
      stapel: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
      h1: getComputedStyle(document.querySelector('#heroCard h1')).fontSize
    })`));
    ok(m.schrift === 'georgia', 'Nach dem Neustart ist die Schrift wieder gewaehlt', m.schrift);
    ok(m.groesse === '110', 'Nach dem Neustart steht der Regler wieder auf 110', m.groesse);
    ok(m.anzeige === '110 %', 'Die Anzeige stimmt mit dem Regler ueberein', m.anzeige);
    ok(/Georgia/.test(m.stapel), 'Und sie ist auch wirklich angewendet', m.stapel);
    ok(m.schalter === 'true' && m.klasse === true, 'Der Schalter ist wieder an',
       JSON.stringify({ aria: m.schalter, klasse: m.klasse }));
    // Kontrollrechnung: 110 % muessen sich von 100 % unterscheiden. Ohne
    // diese Zeile wuerde auch "--fs steht auf 1" als Erfolg durchgehen.
    ok(parseFloat(m.h1) > 30, 'Die Ueberschrift ist groesser als ihre Basisgroesse', m.h1);

    // Und die Umgekehrte Richtung: ein WERT, der gar nicht existiert,
    // darf den Start nicht vergiften.
    await oeffnen({ schrift: 'gibtesnicht', schriftGroesse: 9999, wenigerBewegung: 'ja' });
    const n = JSON.parse(await js(`JSON.stringify({
      schrift: document.getElementById('schriftSelect').value,
      groesse: document.getElementById('schriftGroesse').value,
      anzeige: document.getElementById('schriftGroesseWert').textContent,
      schalter: document.getElementById('bewegungSchalter').getAttribute('aria-checked')
    })`));
    ok(n.schrift !== 'gibtesnicht', 'Ein unbekannter Schriftname wird verworfen', n.schrift);
    ok(n.groesse !== '9999', 'Eine Groesse ausserhalb 85-125 wird verworfen', n.groesse);
    ok(n.anzeige === '100 %', 'Der Regler faellt auf 100 % zurueck', n.anzeige);
    ok(n.schalter === 'false', 'Ein Text statt true beim Schalter wird verworfen', n.schalter);
  }

  // -------------------------------------------------------------------
  // 10b. Das Karten-Layout ueberlebt einen Neustart
  // -------------------------------------------------------------------
  gruppe('10b. Das Karten-Layout ueberlebt einen Neustart');
  {
    // Regressionstest. syncLayout() hat frueher selbst gespeichert und lief
    // beim Start einmal, BEVOR das gespeicherte Layout gelesen war. Damit
    // schrieb jeder Start das Standardlayout in die Datei und die eigene
    // Anordnung der Karten war nach dem ersten Start futsch. Gefunden wurde
    // das, als die Migration von "news" nach "shortcut" im Fenster-Test
    // nicht griff und die Datei hinterher nur noch das Standardlayout
    // enthielt.
    const eigen = {
      hero:     { col: 2, row: 1, colSpan: 3, rowSpan: 4 },
      profile:  { col: 5, row: 1, colSpan: 2, rowSpan: 1 },
      stat:     { col: 5, row: 2, colSpan: 2, rowSpan: 2 },
      shortcut: { col: 1, row: 2, colSpan: 1, rowSpan: 1 }
    };
    await oeffnen({ blockLayout: eigen });
    const vorStart = fs.readFileSync(EINSTELLUNGEN, 'utf8');

    const m = JSON.parse(await js(`JSON.stringify((function(){
      var k = document.getElementById('shortcutCard');
      return { col: getComputedStyle(k).gridColumn, row: getComputedStyle(k).gridRow };
    })())`));
    ok(m.col === '2 / span 1' && m.row === '2 / span 1',
       'Das eigene Layout ist beim Start angewendet (Spalte 1 hinter der Spur)',
       JSON.stringify(m));

    // Startet man das Programm ein zweites Mal, darf die Datei dabei nicht
    // ungefragt umgeschrieben werden. Genau das war der Fehler.
    await oeffnen(JSON.parse(vorStart));
    const nachStart = fs.readFileSync(EINSTELLUNGEN, 'utf8');
    ok(JSON.stringify(JSON.parse(nachStart).blockLayout) === JSON.stringify(eigen),
       'Ein Start schreibt das Layout nicht ungefragt ueber',
       JSON.stringify(JSON.parse(nachStart).blockLayout));

    const n = JSON.parse(await js(`JSON.stringify((function(){
      var k = document.getElementById('shortcutCard');
      return { col: getComputedStyle(k).gridColumn, row: getComputedStyle(k).gridRow };
    })())`));
    ok(n.col === m.col && n.row === m.row,
       'Und beim zweiten Start steht es noch genauso',
       JSON.stringify({ vorher: [m.col, m.row], nachher: [n.col, n.row] }));
  }

  // -------------------------------------------------------------------
  // 10c. Die Seitenleiste hat eine eigene schmale Spur an allen vier Raendern
  // -------------------------------------------------------------------
  gruppe('10c. Die Seitenleiste wandert an alle vier Raender, Karten unangetastet');
  {
    // Die Leiste ist kein Rasterblock mehr, sondern eine eigene schmale Spur
    // (links/rechts als Spalte, oben/unten als Zeile). Kern der Pruefung:
    // sie kann die Seite wechseln, ohne dass eine Karte angefasst wird - die
    // gespeicherten Koordinaten bleiben, nur die berechneten Gitterlinien
    // dahinter verschieben sich (gridVersatz()).
    const BLOECKE = {
      hero:     { col: 1, row: 1, colSpan: 4, rowSpan: 4 },
      profile:  { col: 5, row: 1, colSpan: 2, rowSpan: 1 },
      stat:     { col: 5, row: 2, colSpan: 2, rowSpan: 2 },
      shortcut: { col: 5, row: 4, colSpan: 2, rowSpan: 1 }
    };

    async function messen(){
      return JSON.parse(await js(`JSON.stringify((function(){
        var out = {};
        ['sidebar','hero','profile','stat','shortcut'].forEach(function(id){
          var el = id === 'sidebar' ? document.getElementById('sidebarEl')
                   : document.getElementById(id + 'Card');
          if(!el) return;
          out[id] = {
            col: getComputedStyle(el).gridColumn,
            row: getComputedStyle(el).gridRow,
            breite: Math.round(el.getBoundingClientRect().width)
          };
        });
        var sh = document.getElementById('shellEl');
        var cs = getComputedStyle(sh);
        out.shell = {
          edge: sh.dataset.sbEdge,
          spalten: cs.gridTemplateColumns.trim().split(' ').map(function(v){ return parseFloat(v); }),
          zeilen: cs.gridTemplateRows.trim().split(' ').map(function(v){ return parseFloat(v); })
        };
        return out;
      })())`));
    }

    async function oeffnenMit(edge){
      await oeffnen({ blockLayout: { version: 2, sidebar: { edge: edge }, ...BLOECKE } });
      // Die Karten bekommen ihre Platzierung per grid-column/row; die kurze
      // Uebergang-Animation faengt sonst Zwischenwerte ein. Kurz warten.
      await new Promise(r => setTimeout(r, 450));
      return messen();
    }

    const links = await oeffnenMit('left');
    ok(links.shell.edge === 'left', 'links: Kante gesetzt', links.shell.edge);
    ok(links.sidebar.col === '1 / span 1', 'links: Sidebar in Spur 1', links.sidebar.col);
    ok(links.hero.col === '2 / span 4' && links.hero.row === '1 / span 4',
       'links: Kartenraster beginnt hinter der Spur bei Spalte 2',
       links.hero.col + ' / ' + links.hero.row);
    ok(links.shell.spalten[0] > 50 && links.shell.spalten[0] < 90,
       'links: Die Spur ist schmal (~72px, nicht eine Rasterspalte)',
       String(links.shell.spalten[0]));
    ok(links.sidebar.breite <= 85,
       'links: Die Leiste ist selbst nur so breit wie ihre Spur',
       String(links.sidebar.breite));
    ok(links.shell.zeilen[0] > 110,
       'links: Die erste Zeile ist eine echte Karten-Zeile',
       String(links.shell.zeilen[0]));

    const rechts = await oeffnenMit('right');
    ok(rechts.shell.edge === 'right', 'rechts: Kante gesetzt', rechts.shell.edge);
    ok(rechts.sidebar.col === '7 / span 1', 'rechts: Sidebar in der letzten Spur', rechts.sidebar.col);
    ok(rechts.hero.col === '1 / span 4' && rechts.hero.row === '1 / span 4',
       'rechts: Kartenraster beginnt bei Spalte 1 (Spur steht rechts)',
       rechts.hero.col + ' / ' + rechts.hero.row);
    ok(rechts.shell.spalten[0] > 110,
       'rechts: Die erste Spalte ist eine echte Karten-Spalte, nicht die Spur',
       String(rechts.shell.spalten[0]));
    ok(rechts.shell.spalten[rechts.shell.spalten.length - 1] < 90,
       'rechts: Die schmale Spur ist die letzte Spalte',
       String(rechts.shell.spalten[rechts.shell.spalten.length - 1]));

    const oben = await oeffnenMit('top');
    ok(oben.shell.edge === 'top', 'oben: Kante gesetzt', oben.shell.edge);
    ok(oben.sidebar.row === '1 / span 1', 'oben: Sidebar in der ersten Zeile', oben.sidebar.row);
    ok(oben.hero.col === '1 / span 4' && oben.hero.row === '2 / span 4',
       'oben: Kartenraster beginnt unter der Spur bei Zeile 2',
       oben.hero.col + ' / ' + oben.hero.row);
    ok(oben.shell.zeilen[0] < 90 && oben.shell.zeilen[oben.shell.zeilen.length - 1] > 110,
       'oben: Die schmale Spur ist die erste Zeile, die Karten darunter',
       String(oben.shell.zeilen[0]) + ' / ' + String(oben.shell.zeilen[oben.shell.zeilen.length - 1]));

    const unten = await oeffnenMit('bottom');
    ok(unten.shell.edge === 'bottom', 'unten: Kante gesetzt', unten.shell.edge);
    ok(unten.sidebar.row === '5 / span 1', 'unten: Sidebar in der letzten Zeile', unten.sidebar.row);
    ok(unten.hero.col === '1 / span 4' && unten.hero.row === '1 / span 4',
       'unten: Kartenraster beginnt bei Zeile 1 (Spur steht unten)',
       unten.hero.col + ' / ' + unten.hero.row);
    ok(unten.shell.zeilen[0] > 110 && unten.shell.zeilen[unten.shell.zeilen.length - 1] < 90,
       'unten: Die schmale Spur ist die letzte Zeile, die Karten darueber',
       String(unten.shell.zeilen[0]) + ' / ' + String(unten.shell.zeilen[unten.shell.zeilen.length - 1]));
  }

  // -------------------------------------------------------------------
  // 10d. Nachbarn weichen von selbst aus; der Andock-Knopf setzt die Kante
  // -------------------------------------------------------------------
  gruppe('10d. Nachbarn weichen von selbst aus, Andock-Knopf setzt die Kante');
  {
    // Invariante: aus den berechneten Gitterlinien lassen sich die Rechtecke
    // bauen; ueberlappen darf sich nichts, und alle vier Karten muessen da
    // sein. Die 0.35s-Transition der Karten erledigt sich durch Warten.
    async function pruefeKeinUeberlapp(name){
      await new Promise(r => setTimeout(r, 450));
      const m = JSON.parse(await js(`JSON.stringify((function(){
        function linien(s){ var teile = s.split(' '); return { start: +teile[0], span: +teile[3] }; }
        var out = { karten: [] };
        ['hero','profile','stat','shortcut'].forEach(function(id){
          var el = document.getElementById(id + 'Card');
          var cs = getComputedStyle(el);
          out.karten.push({ id: id, col: linien(cs.gridColumn), row: linien(cs.gridRow) });
        });
        out.sb = getComputedStyle(document.getElementById('sidebarEl')).gridColumn;
        return out;
      })())`));
      let kollision = null;
      for(let i = 0; i < m.karten.length && !kollision; i++){
        for(let j = i + 1; j < m.karten.length && !kollision; j++){
          const a = m.karten[i], b = m.karten[j];
          const x = a.col.start < b.col.start + b.col.span && a.col.start + a.col.span > b.col.start;
          const y = a.row.start < b.row.start + b.row.span && a.row.start + a.row.span > b.row.start;
          if(x && y) kollision = a.id + ' <-> ' + b.id;
        }
      }
      ok(!kollision, name + ': keine zwei Karten ueberlappen', String(kollision));
      ok(m.karten.length === 4, name + ': alle vier Karten sind da', String(m.karten.length));
      return m;
    }

    // Hero nur 3 Spalten breit - so bleibt beim Verbreitern Platz und die
    // drei rechten Karten muessen gemeinsam zur Seite ruecken.
    await oeffnen({ blockLayout: { version: 2, sidebar: { edge: 'left' },
      hero:     { col: 1, row: 1, colSpan: 3, rowSpan: 4 },
      profile:  { col: 4, row: 1, colSpan: 2, rowSpan: 1 },
      stat:     { col: 4, row: 2, colSpan: 2, rowSpan: 2 },
      shortcut: { col: 4, row: 4, colSpan: 2, rowSpan: 1 } } });

    // --- Resize: den Hero nach Osten verbreitern. Er waechst in die Spalte,
    // in der Konto/Stats/Zugriff stehen - die weichen von selbst aus.
    await js(`JSON.stringify((function(){
      document.querySelector('.nav-item[data-view="settings"]').click();
      document.getElementById('openLayoutEditorBtn').click();
      var shell = document.getElementById('beShell');
      var hero = document.querySelector('.be-leaf[data-block="hero"]');
      var kante = hero.querySelector('.be-e');
      var cs = getComputedStyle(shell);
      var spalten = cs.gridTemplateColumns.trim().split(' ').map(function(v){ return parseFloat(v); });
      var cellW = spalten.slice(1).reduce(function(a,b){ return a+b; }, 0) / 6;
      var r = hero.getBoundingClientRect();
      var start = { x: r.right, y: r.top + r.height / 2 };
      // 1.4 Zellen nach rechts - die Rundung ergibt sicher +1 Zelle.
      var end = { x: start.x + cellW * 1.4, y: start.y };
      kante.dispatchEvent(new MouseEvent('mousedown', { clientX: start.x, clientY: start.y, bubbles: true, cancelable: true }));
      shell.dispatchEvent(new MouseEvent('mousemove', { clientX: end.x, clientY: end.y, bubbles: true, cancelable: true }));
      shell.dispatchEvent(new MouseEvent('mouseup', { clientX: end.x, clientY: end.y, bubbles: true, cancelable: true }));
      document.getElementById('closeLayoutEditorBtn').click();
      return true;
    })())`);
    await new Promise(r => setTimeout(r, 500));
    const resize = JSON.parse(await js(`JSON.stringify({
      heroCol: getComputedStyle(document.getElementById('heroCard')).gridColumn })`));
    ok(resize.heroCol === '2 / span 4',
       'Der Hero ist nach dem Verbreitern 4 Spalten breit', resize.heroCol);
    await pruefeKeinUeberlapp('Nach dem Verbreitern');

    // --- Drag: den Hero ganz nach rechts ziehen, in die Zone der drei Karten.
    const drag = JSON.parse(await js(`JSON.stringify((function(){
      document.querySelector('.nav-item[data-view="settings"]').click();
      document.getElementById('openLayoutEditorBtn').click();
      var shell = document.getElementById('beShell');
      var griff = document.querySelector('.be-leaf[data-block="hero"] .be-move');
      var cs = getComputedStyle(shell);
      var spalten = cs.gridTemplateColumns.trim().split(' ').map(function(v){ return parseFloat(v); });
      var zeilen = cs.gridTemplateRows.trim().split(' ').map(function(v){ return parseFloat(v); });
      var cellW = spalten.slice(1).reduce(function(a,b){ return a+b; }, 0) / 6;
      var cellH = zeilen.reduce(function(a,b){ return a+b; }, 0) / 4;
      var gapX = parseFloat(cs.columnGap) || 0;
      var gapY = parseFloat(cs.rowGap) || 0;
      var rr = shell.getBoundingClientRect();
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padT = parseFloat(cs.paddingTop) || 0;
      var spurW = spalten[0];
      // Mittelpunkt von Zelle (3, 1) im Kartenraster.
      var x = rr.left + padL + spurW + gapX + (3 - 1) * (cellW + gapX) + cellW / 2;
      var y = rr.top + padT + gapY + (1 - 1) * (cellH + gapY) + cellH / 2;
      var m = griff.getBoundingClientRect();
      griff.dispatchEvent(new MouseEvent('mousedown', { clientX: m.left + m.width/2, clientY: m.top + m.height/2, bubbles: true, cancelable: true }));
      shell.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      shell.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      document.getElementById('closeLayoutEditorBtn').click();
      return true;
    })())`));
    await new Promise(r => setTimeout(r, 500));
    const dragErgebnis = JSON.parse(await js(`JSON.stringify({
      heroCol: getComputedStyle(document.getElementById('heroCard')).gridColumn })`));
    ok(dragErgebnis.heroCol !== '2 / span 4' && dragErgebnis.heroCol !== resize.heroCol,
       'Der Hero steht nach dem Ziehen woanders', dragErgebnis.heroCol);
    await pruefeKeinUeberlapp('Nach dem Ziehen');
    // Das Ziehen hat gespeichert - warten, bis die Datei geschrieben ist.
    await new Promise(r => setTimeout(r, 600));
    const vorDock = JSON.parse(fs.readFileSync(EINSTELLUNGEN, 'utf8')).blockLayout;
    ok(vorDock && vorDock.sidebar.edge === 'left', 'Nach dem Ziehen ist die Kante links', JSON.stringify(vorDock && vorDock.sidebar));

    // --- Andock-Knopf: Klick setzt die Leiste nach unten, keine Karte bewegt sich.
    await js(`(function(){
      document.querySelector('.nav-item[data-view="settings"]').click();
      document.getElementById('openLayoutEditorBtn').click();
      document.querySelector('.be-dock[data-dock="bottom"]').click();
      document.getElementById('closeLayoutEditorBtn').click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 500));
    const nachDockBlick = JSON.parse(await js(`JSON.stringify({
      edge: document.getElementById('shellEl').dataset.sbEdge })`));
    ok(nachDockBlick.edge === 'bottom',
       'Der Andock-Knopf setzt die Leiste nach unten', nachDockBlick.edge);
    await new Promise(r => setTimeout(r, 600));
    const nachDock = JSON.parse(fs.readFileSync(EINSTELLUNGEN, 'utf8')).blockLayout;
    ok(nachDock && nachDock.sidebar.edge === 'bottom',
       'Und der Klick speichert die neue Kante', JSON.stringify(nachDock && nachDock.sidebar));
    ok(JSON.stringify(nachDock.hero) === JSON.stringify(vorDock.hero),
       'Dabei bleibt die Kartenanordnung unangetastet',
       JSON.stringify({ vorher: vorDock.hero, nachher: nachDock.hero }));
    const mDock = await pruefeKeinUeberlapp('Nach dem Andocken');
    ok(mDock.sb === '1 / span 1' || mDock.sb === '1 / span 6',
       'Die Seitenleiste ist weiterhin in ihrer Spur', mDock.sb);
  }

  // -------------------------------------------------------------------
  // 11. Der Schnellzugriff
  // -------------------------------------------------------------------
  gruppe('11. Der Schnellzugriff');
  {
    await oeffnen({});
    const m = JSON.parse(await js(`JSON.stringify((function(){
      var alle = [].slice.call(document.querySelectorAll('.shortcut-kachel'));
      var out = { kacheln: alle.map(function(k){ return k.dataset.view; }),
        anzahl: alle.length };
      document.querySelector('.shortcut-kachel[data-view="servers"]').click();
      out.nachKlick = document.getElementById('shellEl').getAttribute('data-view');
      out.aktiv = [].map.call(document.querySelectorAll('.nav-item.active'),
        function(e){ return e.dataset.view; });
      document.querySelector('.nav-item[data-view="play"]').click();
      document.querySelector('.shortcut-kachel[data-view="settings"]').click();
      out.nachKlick2 = document.getElementById('shellEl').getAttribute('data-view');
      out.aktiv2 = [].map.call(document.querySelectorAll('.nav-item.active'),
        function(e){ return e.dataset.view; });
      return out;
    })())`));
    ok(m.anzahl === 8, 'Acht Kacheln (sechs Ansichten + zwei Aktionen)',
       JSON.stringify(m.kacheln));
    ok(m.kacheln.filter(Boolean).length === 6, 'Sechs davon sind Ansichten',
       JSON.stringify(m.kacheln));
    ok(m.nachKlick === 'servers', 'Ein Klick auf "Server" oeffnet die Server-Ansicht',
       String(m.nachKlick));
    ok(m.aktiv.length === 1 && m.aktiv[0] === 'servers',
       'Und die Seitenleiste zeigt genau diese Ansicht als aktiv', JSON.stringify(m.aktiv));
    ok(m.nachKlick2 === 'settings', 'Ein Klick auf "Einstellungen" funktioniert genauso',
       String(m.nachKlick2));
    ok(m.aktiv2.length === 1 && m.aktiv2[0] === 'settings',
       'Und wieder nur eine aktive Seitenleistenposition', JSON.stringify(m.aktiv2));
  }

  // -------------------------------------------------------------------
  // 12. Widgets bekommen die Schrift
  // -------------------------------------------------------------------
  gruppe('12. Die Widget-Kacheln erfahren die Schrift');
  {
    const m = JSON.parse(await js(`JSON.stringify((function(){
      var stile = window.WidgetHost && window.WidgetHost.themeStile
        ? window.WidgetHost.themeStile() : null;
      return stile;
    })())`));
    ok(!!m, 'themeStile() gibt es und liefert etwas', JSON.stringify(m));
    ok(typeof m['--ll-fs'] === 'string' && m['--ll-fs'].length > 0,
       '--ll-fs wird mitgegeben', JSON.stringify(m && m['--ll-fs']));
    // Und nach einem Wechsel der Textgroesse aendert sich der Wert auch -
    // sonst waere die Brille verdrahtet, aber nicht gerufen.
    await js(`(function(){
      var r = document.getElementById('schriftGroesse');
      r.value = '125'; r.dispatchEvent(new Event('input'));
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 300));
    const n = await js(`String(window.WidgetHost.themeStile()['--ll-fs'])`);
    ok(n === '1.25', 'Nach einer Aenderung stimmt --ll-fs wieder', JSON.stringify(n));
    const f = await js(`JSON.stringify((window.WidgetHost.themeStile()['--ll-font']||'').slice(0,40))`);
    ok(/font|Segoe|system/i.test(f.replace(/"/g, '')),
       '--ll-font wird mitgegeben und sieht nach einem Schriftstapel aus', f);
  }

  // -------------------------------------------------------------------
  // 10e. Umraeumen: was der Wechsel der Nachbarn wirklich tut
  // -------------------------------------------------------------------
  gruppe('10e. Umraeumen: berechneter Uebergang 0.3-0.35s oder 0s (Schalter UND Windows)');
  {
    // GEMESSEN wird die echte Lage (getBoundingClientRect), der berechnete
    // Uebergang und - das ist der eigentliche Fund - was der Browser gerade
    // wirklich animiert (getAnimations()). Nicht der Quelltext. Jede Aktion
    // laeuft dreimal:
    //   an       = KONTROLLE: die CSS-Regel traegt 0.35s/0.3s
    //   schalter = "Weniger Bewegung" in settings.json
    //   system   = Windows-Einstellung, per DevTools-Protokoll emuliert
    // Bei schalter/system muss dieselbe Aktion dieselbe berechnete Dauer auf 0s
    // bringen. Dass sich die Karte ueberhaupt bewegt hat, wird jedes Mal
    // eigens belegt - sonst waere "steht sofort am Ziel" auch bei einer
    // Karte wahr, die nie ihren Platz gewechselt hat (fehlendes Element,
    // falscher Selektor).
    //
    // BEFUND, Stand 28.09.2026, und der Grund fuer die KONTROLLE weiter
    // unten: dieser Wechsel gleitet nicht, er springt - auch bei
    // eingeschalteter Bewegung. Ein Wechsel von grid-column/grid-row wird
    // in Electron 32 (Chromium 128) nicht interpoliert; getAnimations()
    // ist waehrend des Umbaues leer. Die Karten rucken also seit jeher
    // sofort an ihren Platz, und das Tor ist die richtige Absicherung fuer
    // den Fall, dass es einmal gleitet - heute aendert es nur die berechnete
    // Dauer. Die Positionstest oben beweisen deshalb das Tor NICHT, nur die
    // Dauer-Test und die Animations-Kontrolle.
    const LAYOUT = { version: 2, sidebar: { edge: 'left' },
      hero:     { col: 1, row: 1, colSpan: 3, rowSpan: 4 },
      profile:  { col: 4, row: 1, colSpan: 2, rowSpan: 1 },
      stat:     { col: 4, row: 2, colSpan: 2, rowSpan: 2 },
      shortcut: { col: 4, row: 4, colSpan: 2, rowSpan: 1 } };

    // Aktion 'resize' = Hero wird groesser, Nachbarn weichen aus.
    // Aktion 'dock'   = die Spur dockt an eine andere Kante (unten).
    async function messung(aktion){
      await js(`(function(){
        document.querySelector('.nav-item[data-view="settings"]').click();
        document.getElementById('openLayoutEditorBtn').click();
        return true;
      })()`);
      await new Promise(r => setTimeout(r, 700));
      await js('window.__umraeumAktion = ' + JSON.stringify(aktion) + '; true;');
      return JSON.parse(await js(`new Promise(function(resolve){
        var SEL = { profile: '.be-leaf[data-block="profile"]', stat: '.be-leaf[data-block="stat"]',
                    sidebar: '#sidebarEl', overlay: '#viewOverlay' };
        function snap(){
          var o = {};
          Object.keys(SEL).forEach(function(k){
            var e = document.querySelector(SEL[k]);
            if(!e){ o[k] = null; return; }
            var r = e.getBoundingClientRect();
            // 'an' = was der Browser gerade wirklich animiert. Das ist die
            // entscheidende Groesse: eine CSS-Transition, die es nicht gibt,
            // sieht in der Position genauso aus wie eine, die nichts tut.
            // getAnimations() sieht man auch an einem verdeckten Fenster.
            var a = e.getAnimations();
            o[k] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                     dauer: getComputedStyle(e).transitionDuration,
                     an: a.length === 0 ? 'KEINE'
                        : a.map(function(x){ return (x.transitionProperty || '?') + ':' + x.playState; }).join(',') };
          });
          return o;
        }
        var vor = snap();
        var aktion = window.__umraeumAktion;
        if(aktion === 'dock'){
          document.querySelector('.be-dock[data-dock="bottom"]').click();
        } else {
          var shell = document.getElementById('beShell');
          var hero = document.querySelector('.be-leaf[data-block="hero"]');
          var kante = hero.querySelector('.be-e');
          var cs = getComputedStyle(shell);
          var spalten = cs.gridTemplateColumns.trim().split(' ').map(function(v){ return parseFloat(v); });
          var cellW = spalten.slice(1).reduce(function(a,b){ return a+b; }, 0) / 6;
          var r = hero.getBoundingClientRect();
          var s = { x: r.right, y: r.top + r.height / 2 };
          var e2 = { x: s.x + cellW * 1.4, y: s.y };
          kante.dispatchEvent(new MouseEvent('mousedown', { clientX: s.x, clientY: s.y, bubbles: true, cancelable: true }));
          shell.dispatchEvent(new MouseEvent('mousemove', { clientX: e2.x, clientY: e2.y, bubbles: true, cancelable: true }));
          shell.dispatchEvent(new MouseEvent('mouseup', { clientX: e2.x, clientY: e2.y, bubbles: true, cancelable: true }));
        }
        var t0 = snap();
        setTimeout(function(){
          var ende = snap();
          document.getElementById('closeLayoutEditorBtn').click();
          resolve(JSON.stringify({ vor: vor, t0: t0, ende: ende }));
        }, 700);
      })`));
    }

    const gleich = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

    // welche Elemente sich bei welcher Aktion bewegen muessen
    const BEWEGER = { resize: ['profile', 'stat'], dock: ['sidebar', 'overlay'] };

    async function pruefeModus(modus, erwartetAus){
      for (const aktion of ['resize', 'dock']) {
        await oeffnen(modus.settings);
        if (modus.vorher) await modus.vorher();
        const m = await messung(aktion);
        const tag = modus.name + ' / ' + aktion + ': ';
        for (const k of BEWEGER[aktion]) {
          ok(m.vor[k] && m.t0[k] && m.ende[k], tag + k + ' existiert (kein stilles Null)',
             JSON.stringify([!!m.vor[k], !!m.t0[k], !!m.ende[k]]));
          if (!(m.vor[k] && m.t0[k] && m.ende[k])) continue;
          ok(!gleich(m.vor[k], m.ende[k]), tag + k + ' hat wirklich den Platz gewechselt (sonst beweist die Messung nichts)',
             JSON.stringify({ vor: m.vor[k], ende: m.ende[k] }));

          // DIE KONTROLLE, und sie gilt fuer beide Modi gleich. Sie sagt
          // nicht "die Karte ist schon da" - das waere in jedem Modus wahr
          // und damit wertlos. Sie sagt: es laeuft gar kein Uebergang.
          //
          // Das ist keine Rechnung, sondern eine Messung: der Browser legt
          // jede laufende CSS-Transition als CSSTransition in getAnimations()
          // ab, und dort steht bei diesem Umbau nichts - auch dann nicht,
          // wenn die Karte im selben Tick schon am neuen Platz steht. Ein
          // Wechsel von grid-column/grid-row wird in diesem Chromium
          // (Electron 32) also gar nicht interpoliert, sondern gesetzt.
          //
          // Zwei Folgen, beide wichtig:
          //   - Der Sprung ist NICHT die Wirkung des Tors. Das Tor schaltet
          //     die berechnete Dauer von 0.35s auf 0s (das pruefen die
          //     Dauer-Pruefungen darunter), aber ein Uebergang, den es
          //     nicht gibt, kann man auch nicht wegschalten. Ohne diese
          //     Zeile waere der Test an dieser Stelle gruen, obwohl das
          //     Tor nichts bewirkt.
          //   - Wenn ein Chromium-Update grid-column doch interpolieren
          //     laesst, wird diese Pruefung rot. Genau so soll es sein: dann
          //     ist "springt ohne Uebergang" nicht mehr das, was man sieht,
          //     und die Dauer-Pruefungen allein tragen die Aussage nicht mehr.
          ok(m.t0[k].an === 'KEINE',
             tag + k + ' KONTROLLE: es laeuft kein Uebergang - der Platzwechsel ist ein Sprung, kein Gleiten',
             m.t0[k].an);

          const dauerSek = parseFloat(m.t0[k].dauer);
          if (erwartetAus) {
            ok(gleich(m.t0[k], m.ende[k]), tag + k + ' steht SOFORT am neuen Platz (kein Zwischenbild)',
               JSON.stringify({ t0: m.t0[k], ende: m.ende[k] }));
            ok(dauerSek === 0, tag + k + ' berechneter Uebergang ist 0s', m.t0[k].dauer);
          } else {
            ok(dauerSek > 0.25 && dauerSek < 0.4, tag + k + ' KONTROLLE: die CSS-Regel traegt 0.3-0.35s - das ist es, was das Tor abschaltet',
               m.t0[k].dauer);
          }
        }
      }
    }

    await pruefeModus({ name: 'Bewegung AN', settings: { blockLayout: LAYOUT } }, false);
    await pruefeModus({ name: 'Schalter "Weniger Bewegung"', settings: { wenigerBewegung: true, blockLayout: LAYOUT } }, true);

    // Windows-Einstellung emulieren. Kontrollen: die Medienabfrage ist wirklich
    // wahr, der Schalter ist wirklich aus - sonst mischen sich die Quellen.
    const dbg = fenster.webContents.debugger;
    let emuOk = true;
    try {
      dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await pruefeModus({
        name: 'Windows "Animationseffekte" aus', settings: { blockLayout: LAYOUT },
        vorher: async () => {
          const k = JSON.parse(await js(`JSON.stringify({
            mq: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            klasse: document.documentElement.classList.contains('ll-wenig-bewegung'),
            schalter: document.getElementById('bewegungSchalter').getAttribute('aria-checked') })`));
          ok(k.mq === true, 'Windows-Quelle: prefers-reduced-motion ist im Fenster wirklich wahr', JSON.stringify(k));
          ok(k.schalter === 'false', 'Windows-Quelle: der eigene Schalter ist dabei AUS (reine Windows-Quelle)', JSON.stringify(k));
          // Die Medienabfrage allein muss genuegen, auch ohne die Klasse:
          const ohneKlasse = await js(`(function(){
            document.documentElement.classList.remove('ll-wenig-bewegung');
            return getComputedStyle(document.getElementById('sidebarEl')).transitionDuration; })()`);
          ok(parseFloat(ohneKlasse) === 0,
             'Windows-Quelle: auch OHNE die Klasse ist der Uebergang der Seitenleiste 0s (@media wirkt allein)', ohneKlasse);
        }
      }, true);
    } catch (e) {
      emuOk = false;
      ok(false, 'Windows-Emulation ueber das DevTools-Protokoll lief ohne Fehler', String(e && e.message || e));
    } finally {
      try { await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } catch {}
      try { dbg.detach(); } catch {}
    }
  }

  // -------------------------------------------------------------------
  console.log('\n' + Z.join('\n'));
  console.log('\n=====================================================');
  if (probleme.length === 0) {
    console.log('ALLE ' + pruefungen + ' PRUEFUNGEN BESTANDEN');
  } else {
    console.log(probleme.length + ' von ' + pruefungen + ' PRUEFUNGEN FEHLGESCHLAGEN:');
    probleme.forEach(p => console.log('  - ' + p));
    process.exitCode = 1;
  }
  app.quit();
}).catch(err => {
  console.log(Z.join('\n'));
  console.error('\nFEHLER IM TESTABLAUF:', err && err.stack || err);
  process.exitCode = 1;
  app.quit();
});
