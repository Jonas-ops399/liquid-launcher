// test-einstellungen.js
//   node test-einstellungen.js
//
// Testet den Umbau der Einstellungen: Karten-Raster mit Suche, der
// Schrift-Wahl mit eigener Datei, den Schalter "Weniger Bewegung" und den
// Schnellzugriff anstelle der Neuigkeiten-Karte.
//
// Warum dieser Test ueberhaupt existiert:
//
// 1. Ein Fehler ist beim Umbau schon passiert. Ein Kommentarblock wurde
//    beim Erweitern so zerlegt, dass der CSS-Parser die darauffolgende
//    .settings-raster-Regel fuer eine kaputte Selektorzeile hielt und
//    wegwarf. Ergebnis: kein display:grid, alle Karten in einer Spalte -
//    und im Fenster sah es nach einem Absichtsentscheid aus. node --check
//    haette das nie gemeldet, die Regel ist ja valides CSS.
//    Deshalb prueft dieser Test zuerst die Klammerbilanz und dann jede
//    neue Klasse einzeln gegen eine im Fenster gemessene Erwartung.
//
// 2. Beim Umbenennen von news nach shortcut und beim Ergaenzen der neuen
//    Schluessel in vier Sprachen bleibt haeufig eine Haelfte stehen. Ein
//    Schluessel, der nur auf Deutsch existiert, faellt nicht auf - er wird
//    einfach nie benutzt. Der Test vergleicht deshalb die Schluessel-
//    Mengen aller vier Sprachen.
//
// 3. "font-size: 12px ist umgestellt" ist eine Behauptung, keine Pruefung.
//    Geprueft wird: es gibt KEINE font-size mehr ohne calc(... * var(--fs)).
//
// Kein jsdom, kein Electron. Alles hier laesst sich am Text pruefen. Was
// das Fenster braucht (Greifen, Scrollen, echte Schriftbreiten), steht in
// test-einstellungen-fenster.js.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WURZEL = __dirname;
const HTML = path.join(WURZEL, 'src', 'renderer', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const style = src.slice(src.indexOf('<style>') + 7, src.indexOf('</style>'));
const script = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

let checks = 0;
const problems = [];
function ok(cond, msg, extra) {
  checks++;
  console.log((cond ? '  OK   ' : '  FEHLT ') + msg + (cond || !extra ? '' : '  ->  ' + extra));
  if (!cond) problems.push(msg);
}
function group(t) { console.log('\n--- ' + t + ' ---'); }

// Kommentare entfernen, damit die Pruefungen unten wirklich den Code
// sehen und nicht seinen Kommentar. Ohne das flaggt der Test die
// Kommentarzeile, die den Bug von vorhin BESCHRIEBEN hat - und der Test
// waere dann strenger als der Fehler und wuerde ihn als Korrektur
// verlangen.
function ohneKommentare(text, stil) {
  // Zeilenkommentare (nur in den Skript-Teilen; im CSS gibt es // nicht)
  let r = text;
  if (stil !== 'js') return r.replace(/\/\*[\s\S]*?\*\//g, ' ');
  r = r.replace(/\/\*[\s\S]*?\*\//g, ' ');        // Block
  r = r.replace(/(^|[^:])\/\/[^\n]*/g, '$1');      // Zeile
  return r;
}
const cssOhne = ohneKommentare(style, 'css');
const jsOhne = ohneKommentare(script, 'js');

console.log('== Einstellungen: Raster, Suche, Schrift, Bewegung, Schnellzugriff ==');

// =====================================================================
// 1. Der CSS-Block ist nicht zerbrochen
// =====================================================================
group('1. Der CSS-Block ist nicht zerbrochen');

// Klammerbilanz. Genau hier ist der Fehler von vorhin passiert: ein
// verwaistes "*/" hat eine Folgezeile zur Selektorzeile gemacht, und die
// Regel danach wurde verschluckt.
{
  let tief = 0, tiefstes = 0;
  for (const z of cssOhne) {
    if (z === '{') tief++;
    else if (z === '}') { tief--; if (tief < tiefstes) tiefstes = tief; }
  }
  ok(tief === 0, 'Alle geschweiften Klammern im <style> sind zu (Tiefe am Ende 0)',
     'Tiefe am Ende: ' + tief);
  ok(tiefstes === 0, 'Keine Klammer wird zu früh geschlossen',
     'tiefster Zwischenstand: ' + tiefstes);
  // Und der eigentliche Auslöser: nach dem Kommentarende darf kein
  // Prosa-Fragment mehr dastehen. Auf eine Zahl allein wird nicht geprüft
  // - die ist im CSS normal (Theme-Werte, Fractions). Erst das Muster
  // "Zahl und danach ein Wort" zeigt Kommentar-Reste.
  const verdacht = cssOhne.split('\n').filter(z =>
    /^\s*\d+(?:px|rem|em|%)?\s+(?:ist|sind|waere|w\u00e4re|also|oder)\b/.test(z));
  ok(verdacht.length === 0,
     'Hinter dem Kommentarende steht kein Prosa-Fragment mehr (genau das war der Fehler)',
     verdacht.join(' | '));
}

// =====================================================================
// 2. Jede neue Klasse hat eine Regel, und die Regel greift
// =====================================================================
group('2. Die neuen Klassen haben eine CSS-Regel');
{
  // Diese Liste ist mit den im Fenster gemessenen Werten abgeglichen
  // (test-einstellungen-fenster.js, Abschnitt "CSS"). Sie ist absichtlich
  // konkret statt "irgendetwas mit settings-" - ein Tippfehler im
  // Klassennamen faellt dann auf, statt still zu verschwinden.
  const erwartet = [
    ['.settings-scroll', 'overflow-y:auto', 'der scrollbare Bereich'],
    ['.settings-kopf', 'position:sticky', 'klebende Kopfzeile'],
    ['.settings-suche', 'display:flex', 'Suchfeld'],
    ['.settings-raster', 'display:grid', 'zweispaltiges Kartenraster'],
    ['.settings-karte', 'border-radius', 'Karte'],
    ['.settings-karte.breit', 'grid-column', 'Login-Karte ueber beide Spalten'],
    ['.settings-feld', 'display:flex', 'eine Zeile in einer Karte'],
    ['.settings-select', 'cursor:pointer', 'Schrift-Auswahl'],
    ['.settings-regler', 'display:flex', 'Textgroessen-Schieber'],
    ['.settings-schalter', 'position:relative', 'Bewegungs-Schalter'],
    ['.settings-fehler', 'color', 'Statuszeile'],
    ['.settings-zuruecksetzen', 'cursor:pointer', 'Zuruecksetzen-Knopf'],
    ['.settings-leer', 'display:none', 'Hinweis bei leerer Suche'],
    ['.shortcut-card', 'display:flex', 'Schnellzugriff-Karte'],
    ['.shortcut-raster', 'display:grid', 'Raster der vier Sprungziele'],
    ['.shortcut-kachel', 'cursor:pointer', 'einzelne Sprungziel-Kachel'],
    ['.ll-wenig-bewegung', 'transition:none', 'Klasse des Schalters'],
  ];
  for (const [sel, eig, wofuer] of erwartet) {
    // Die Regel muss im <style> stehen UND die Eigenschaft mit sich
    // bringen. Nur "Selektor kommt vor" reicht nicht - genau daran ist
    // der Fehler von vorhin gescheitert.
    const muster = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{[^}]*' +
      eig.split(':')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
    ok(muster.test(style), sel + ' setzt ' + eig + '  (' + wofuer + ')');
  }
}

// =====================================================================
// 3. Textgroesse: keine font-size ohne den Faktor
// =====================================================================
group('3. Textgroesse wirkt auf jede Schriftgroesse');
{
  const ohne = [...style.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)];
  ok(ohne.length === 0,
     'Keine einzige font-size ohne calc(... * var(--fs)) mehr',
     ohne.length + ' Stueck: ' + ohne.slice(0, 5).map(m => m[0]).join(', '));
  const mit = (style.match(/font-size:\s*calc\(/g) || []).length;
  ok(mit >= 70, 'Die meisten Schriftgroessen sind umgestellt (' + mit + ' Stueck)',
     'erwartet wurde >= 70');

  ok(/--fs\s*:\s*1\s*;/.test(style), ':root setzt --fs auf 1 (Auslieferungsstand 100 %)');
  ok(/--font-ui\s*:\s*[^;]+;/.test(style), ':root setzt --font-ui');
  const benutzt = (style.match(/var\(--fs\)/g) || []).length;
  ok(benutzt >= 70, 'var(--fs) wird auch benutzt, nicht nur definiert (' + benutzt + ')');
  ok(/var\(--font-ui\)/.test(style), 'var(--font-ui) wird benutzt (html,body)');
  // Ohne das waeren Rahmen, Abstaende und Schriftgroesse gemeinsam
  // skaliert worden - die Oberflaeche waere bei 125 % einfach nur breiter.
  const zoom = /body\s*\{[^}]*zoom/.test(style);
  ok(!zoom, 'Kein zoom auf body (der Hintergrund rechnet mit window.innerWidth)');
}

// =====================================================================
// 4. Hover: alle vier Karten reagieren, zwei davon bewegen sich
// =====================================================================
group('4. Hover auf der Startseite');
{
  ok(/function bewegungAus\(\)\s*\{\s*return wenigerBewegung \|\| systemMotion\.matches;/.test(script),
     'bewegungAus() fragt Systemwert UND eigenen Schalter ab');
  ok(!/reduceMotion\.matches/.test(script),
     'Keine eigene zweite matchMedia-Abfrage mehr im Hover-Teil',
     (script.match(/reduceMotion/g) || []).length + ' Vorkommen');

  // Beide Stufen muessen das pruefen. Vorher pruefte nur Stufe 2, und die
  // @media-Regel im CSS nahm Stufe 1 nur die Transition - sie sprang also
  // statt zu gleiten.
  const stufe1 = (script.match(/const MAGNETIC_SELECTOR[\s\S]*?(?=\/\/ -+ Hover-Bewegung)/) || [''])[0];
  const stufe2 = (script.match(/\/\/ -+ Hover-Bewegung[\s\S]*?(?=\/\/ -+ Server-Panel)/) || [''])[0];
  const n1 = (stufe1.match(/bewegungAus\(\)/g) || []).length;
  const n2 = (stufe2.match(/bewegungAus\(\)/g) || []).length;
  ok(n1 >= 2, 'Stufe 1 (Kn\u00f6pfe) fragt bewegungAus() - auch beim Ueberfahren, nicht nur beim Bewegen',
     n1 + ' Aufrufe');
  ok(n2 >= 2, 'Stufe 2 (Karten) fragt bewegungAus()', n2 + ' Aufrufe');

  const hoverSel = (script.match(/const HOVER_SELECTOR = '([^']+)'/) || [])[1] || '';
  for (const s of ['.hero', '.profile-card', '.stat-tile', '.world-card', '.srv-row']) {
    ok(new RegExp('(^|,\\s*)' + s.replace('.', '\\.') + '(\\s*,|$)').test(hoverSel),
       'HOVER_SELECTOR enthaelt ' + s, hoverSel);
  }
  for (const s of ['.stat-card', '.shortcut-card']) {
    ok(!new RegExp('(^|,\\s*)' + s.replace('.', '\\.') + '(\\s*,|$)').test(hoverSel),
       'HOVER_SELECTOR enthaelt ' + s + ' NICHT (traegt bewegliche Teile)');
  }
  // Kein translate() im CSS fuer Hero/Profil: die Bewegung kommt aus dem
  // Skript. Zwei Stellen, die dieselbe transform-Eigenschaft umkaempfen,
  // ergeben ein Zittern.
  const heroBlock = (style.match(/\.hero:hover[^{]*\{[^}]*\}/) || [''])[0];
  ok(!/transform/.test(heroBlock), 'CSS setzt fuer .hero:hover KEIN transform (nur Optik)');
  const statBlock = (style.match(/\.stat-card:hover[^{]*\{[^}]*\}/) || [''])[0];
  ok(/border-color|box-shadow/.test(statBlock), 'CSS gibt .stat-card:hover sichtbare Optik');
}

// =====================================================================
// 5. Schnellzugriff ersetzt die Neuigkeiten-Karte
// =====================================================================
group('5. Schnellzugriff statt Neuigkeiten');
{
  ok(!/\bnews-card\b|\bnews-item\b|\bnews-title\b/.test(src),
     'Keine .news-*-Klassen mehr im File',
     (src.match(/\bnews-[a-z]+\b/g) || []).join(', '));
  const kacheln = [...src.matchAll(/class="shortcut-kachel[^"]*"[^>]*data-view="([^"]+)"/g)].map(m => m[1]);
  ok(kacheln.length === 4, 'Genau vier Sprungziele in der Karte', kacheln.join(', '));
  for (const v of ['worlds', 'mods', 'servers', 'settings']) {
    ok(kacheln.includes(v), 'Sprungziel ' + v + ' vorhanden');
  }
  // Die Kachel raeumt nicht nur die Ansicht, sie setzt auch den aktiven
  // Seitenleisten-Knopf - sonst leuchtet unten links eine Ansicht als
  // aktiv, die gar nicht offen ist.
  ok(/onViewChanged\(view\)/.test(script), 'Die Kachel ruft dieselbe Funktion auf wie die Seitenleiste');
  const verdrahtung = (script.match(/shortcut-kachel\[data-view\][\s\S]*?\n  \}\);/) || [''])[0];
  ok(/classList\.add\('active'\)/.test(verdrahtung), 'Die Kachel setzt auch den aktiven Seitenleisten-Knopf');
  ok(/data-i18n="shortcut_title"/.test(src), 'Die Karte hat einen uebersetzbaren Titel');
}

// =====================================================================
// 6. Umbenennung news -> shortcut inklusive Migration
// =====================================================================
group('6. Das gespeicherte Karten-Layout wird mitgenommen');
{
  ok(/function layoutUebernehmen\(/.test(script), 'layoutUebernehmen() gibt es');
  ok(/gespeichert\.news && !gespeichert\.shortcut/.test(script),
     'Migration: ein altes news-Feld wird zu shortcut');
  ok(/ziel\.shortcut\s*=\s*\{\s*\.\.\.ziel\.shortcut,\s*\.\.\.gespeichert\.news\s*\}/.test(script),
     'Migration: die alten Werte werden uebernommen, nicht die neuen verworfen');
  // Und sie muss auch laufen - eine nicht aufgerufene Migrationsfunktion
  // waere ein toter Zweig, der beim Lesen sehr plausibel aussieht.
  const aufrufe = (script.match(/layoutUebernehmen\(/g) || []).length;
  ok(aufrufe >= 2, 'layoutUebernehmen() wird auch aufgerufen (Funktion + Aufrufstelle)',
     aufrufe + ' Vorkommen');
  ok(/layoutUebernehmen\(s\.blockLayout\)/.test(script),
     'Der Aufruf bekommt das gespeicherte Layout');
  // Der alte Block-Name darf nirgends mehr als Zeichenkette im Code stehen.
  // Ueber den kommentarlosen Teil des Skripts geprueft, nicht ueber einen
  // herausgeschnittenen Abschnitt: "irgendwo im Layout-Teil" waere eine
  // kleinere Aussage als "nirgends im Code".
  const newsStrings = (jsOhne.match(/['"]news['"]/g) || []).length;
  ok(newsStrings === 0, 'Kein Block "news" mehr als Zeichenkette irgendwo im Skript',
     newsStrings + ' Vorkommen');
  const shortcutStrings = (jsOhne.match(/['"]shortcut['"]/g) || []).length;
  ok(shortcutStrings >= 3, 'Der Block "shortcut" steht im Standard-Layout, in der Migration und beim Speichern',
     shortcutStrings + ' Vorkommen');
  // Die einzige Stelle, an der "news" noch auftauchen darf: der
  // Migrationszweig, der die alten gespeicherten Werte uebernimmt.
  ok(/\.news\b/.test(jsOhne), 'Die Migration greift noch auf das alte Feld zu');
  ok(/data-block="shortcut"/.test(src), 'Die Karte traegt data-block="shortcut"');
  ok(!/data-block="news"/.test(src), 'Kein data-block="news" mehr im Markup');
}

// =====================================================================
// 7. Suche in den Einstellungen
// =====================================================================
group('7. Die Suche findet Karten');
{
  ok(/function suchtextVon\(/.test(script), 'suchtextVon() gibt es');
  ok(/for\(const sprache of Object\.keys\(TRANSLATIONS\)\)/.test(script),
     'Die Suche laeuft durch ALLE Sprachen, nicht nur die gerade aktive');
  ok(/classList\.toggle\('unsichtbar'/.test(script), 'Nicht passende Karten werden ausgeblendet');
  ok(/settingsLeer\.classList\.toggle\('an'/.test(script), 'Der Leer-Hinweis erscheint');
  ok(/\.unsichtbar\s*\{[^}]*display\s*:\s*none/.test(style),
     'CSS blendet .unsichtbar wirklich aus (nicht nur unsichtbar im Sinne von transparent)');
  ok(/id="settingsSuche"/.test(src), 'Das Suchfeld existiert im Markup');
  ok(/id="settingsLeer"/.test(src), 'Der Leer-Hinweis existiert im Markup');
  // Der Cache darf nicht das erste Suchergebnis einfrieren.
  ok(/_llSuchtext === undefined/.test(script),
     'Der Suchtext wird pro Karte zwischengespeichert (Sonst laeuft die Suche bei jedem Tastendruck ueber 4 Sprachen)');
}

// =====================================================================
// 8. Die eigene Schriftdatei
// =====================================================================
group('8. Eigene Schriftdatei');
{
  const ipc = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'ipc-handlers.js'), 'utf8');
  const preload = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'preload.js'), 'utf8');

  ok(/ipcMain\.handle\('schriften:waehlen'/.test(ipc), 'IPC-Kanal zum Auswaehlen');
  ok(/ipcMain\.handle\('schriften:lesen'/.test(ipc), 'IPC-Kanal zum Lesen');
  ok(/ipcMain\.handle\('schriften:vergessen'/.test(ipc), 'IPC-Kanal zum Entfernen');
  ok(/fonts:\s*\{[\s\S]*choose[\s\S]*read[\s\S]*forget/.test(preload),
     'preload.js stellt window.launcher.fonts bereit');

  ok(/'.ttf': 'font\/ttf'/.test(ipc) && /'.woff2': 'font\/woff2'/.test(ipc),
     'Nur echte Schriftformate sind erlaubt');
  ok(/const SCHRIFT_MAX_BYTES = 4 \* 1024 \* 1024/.test(ipc), 'Groessengrenze 4 MB');
  ok(/groesse > SCHRIFT_MAX_BYTES/.test(ipc), 'Die Grenze wird auch geprueft, nicht nur definiert');
  ok(/groesse === 0/.test(ipc), 'Eine leere Datei wird abgewiesen');

  // Pfadabwehr: aus settings.json kommt nur der Dateiname, und er wird
  // noch einmal gegen die eigene Endung-Liste geprueft.
  ok(/const sicher = path\.basename\(name\);/.test(ipc), 'Nur der Dateiname wird uebernommen (path.basename)');
  ok(/if \(sicher !== name\) return null;/.test(ipc), 'Ein Pfad mit Verzeichnis wird verworfen');
  ok(/hasOwnProperty\.call\(SCHRIFT_ENDUNGEN, schriftEndung\(sicher\)\)/.test(ipc),
     'Auch der aus settings.json gelesene Name wird gegen die Endung-Liste geprueft');
  ok(/settingsStore = \{ \.\.\.settingsStore, eigeneSchrift: name \}/.test(ipc),
     'settings.json speichert nur den Dateinamen, nicht die Bytes');

  // Data-URI statt file:// - sonst muesste webSecurity aus.
  ok(/dataUri: 'data:' \+ SCHRIFT_ENDUNGEN/.test(ipc), 'Die Bytes kommen als Data-URI');
  // Genau das ist der Grund fuer die Data-URI. Faellt webSecurity einmal
  // auf false, waere der Umweg nicht mehr noetig - und niemand faelle es.
  const main = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'main.js'), 'utf8');
  ok(/webSecurity:\s*true/.test(main), 'webSecurity ist weiterhin true (Haupt-Fenster)');
  ok(!/webSecurity:\s*false/.test(main) && !/allowRunningInsecureContent:\s*true/.test(main),
     'webSecurity wird nirgends abgeschaltet');
  ok(!/nodeIntegration:\s*true/.test(main), 'nodeIntegration nirgends true');

  // Der Name der Familie steht fest. Ein Name aus der Datei muesste in
  // eine CSS-Regel geschrieben werden - das waere eine Injection-Stelle.
  ok(/const EIGENE_FONT_NAME = 'LiquidEigeneSchrift'/.test(script),
     'Der @font-face-Familienname steht fest im Code');
  const faceBlock = (script.match(/@font-face\{font-family:"' \+ EIGENE_FONT_NAME[\s\S]{0,200}?font-display:swap;\}';/) || [''])[0];
  ok(faceBlock.length > 0, 'Die @font-face-Regel gefunden',
     'Abschnitt: ' + JSON.stringify(script.slice(script.indexOf('@font-face'), script.indexOf('@font-face') + 120)));
  ok(faceBlock && !/daten\.name/.test(faceBlock),
     'Der Dateiname wird nicht in die CSS-Regel geschrieben');
  // Erlaubt ist ausschliesslich die Data-URI. Ein Pfad, ein Nachladen aus
  // dem Internet - alles andere waere eine zweite Angriffsstelle.
  ok(faceBlock && /src:url\(' \+ daten\.dataUri \+ '\);/.test(faceBlock.replace(/\s+/g, ' ')),
     'src ist ausschliesslich die Data-URI aus dem Haupt-Prozess',
     JSON.stringify((faceBlock || '').replace(/\s+/g, ' ')));
  ok(faceBlock && !/https?:|file:\/\//.test(faceBlock),
     'Keine externe Quelle in der @font-face-Regel');
  ok(!/fonts:\s*\{[^}]*node:fs/.test(preload),
     'preload.js greift nicht selbst auf die Datei zu (Renderer laeuft sandboxed)');
}

// =====================================================================
// 9. Widgets erben die Schrift mit
// =====================================================================
group('9. Widgets bekommen Schrift und Groesse durchgereicht');
{
  const host = fs.readFileSync(path.join(WURZEL, 'src', 'renderer', 'widget-host.js'), 'utf8');
  ok(/--font-ui/.test(host) && /--ll-font/.test(host), 'widget-host.js reicht --font-ui als --ll-font weiter');
  ok(/--fs/.test(host) && /--ll-fs/.test(host), 'widget-host.js reicht --fs als --ll-fs weiter');
  ok(/--ll-fs'\s*:\s*'1'/.test(host), 'Widgets bekommen auch dann einen Wert, wenn nichts gesetzt ist');

  // Vier mitgelieferte Widgets, alle vier muessen die Variablen benutzen -
  // sonst staende die Uhr in Times New Roman, waehrend der Rest in der
  // eingestellten Schrift steht.
  const ordner = path.join(WURZEL, 'widgets');
  const namen = fs.existsSync(ordner) ? fs.readdirSync(ordner) : [];
  ok(namen.length === 4, 'Vier mitgelieferte Widgets', namen.join(', '));
  for (const n of namen) {
    const w = fs.readFileSync(path.join(ordner, n, 'widget.html'), 'utf8');
    ok(/var\(--ll-font/.test(w), n + ': benutzt --ll-font');
    const ohne = (w.match(/font-size:\s*\d+(?:\.\d+)?px/g) || []).length;
    ok(ohne === 0, n + ': keine font-size ohne --ll-Faktor', ohne + ' Stueck');
  }
  // Und das nur als Lese-Rechte, nicht als Schreibweg: die Brille darf
  // keine beliebigen Variablen durchreichen. THEME_QUELLE ist eine Liste
  // von Paaren - kein Objekt, sonst waere "welche Farbe" und "welche
  // Schrift" beim Erweitern leicht unterschiedlich zu behandeln.
  const quelle = (host.match(/const THEME_QUELLE = \[[\s\S]*?\];/) || [''])[0];
  ok(quelle.length > 0, 'THEME_QUELLE gefunden');
  ok(/'--font-ui',\s*'--ll-font'/.test(quelle), "'--font-ui' geht als '--ll-font' weiter");
  ok(/'--fs',\s*'--ll-fs'/.test(quelle), "'--fs' geht als '--ll-fs' weiter");
  // Fuenf Paare, plus die klammernde Liste selbst - deshalb wird nach
  // "['" gezaehlt und nicht nach "[".
  const paare = (quelle.match(/\['/g) || []).length;
  ok(paare === 5, 'Genau fuenf Paare in der Liste', paare + ' Paare');
  ok(!/theme\s*=|setProperty\s*\(/.test(quelle), 'Die Liste beschreibt nur, sie schreibt nichts');
  // THEME_STANDARD muss fuer beide neuen Variablen einen Wert haben, sonst
  // waere var(--ll-fs) in einem Widget ohne gesetzten Faktor unaufgeloest.
  const standard = (host.match(/const THEME_STANDARD = \{[\s\S]*?\};/) || [''])[0];
  ok(/'--ll-fs'\s*:\s*'1'/.test(standard), "THEME_STANDARD kennt '--ll-fs'");
  ok(!/'--ll-font'\s*:/.test(standard),
     "THEME_STANDARD kennt '--ll-font' NICHT - dafuer gibt es den echten Stapel aus :root");
}

// =====================================================================
// 10. Speichern: was gesetzt wird und was gelesen wird
// =====================================================================
group('10. Was gespeichert wird');
{
  for (const [schluessel, warum] of [
    ['schrift', 'die gewaehlte Schrift'],
    ['schriftGroesse', 'die Textgroesse'],
    ['wenigerBewegung', 'der Schalter'],
  ]) {
    ok(new RegExp('\\b' + schluessel + ':').test(script),
       'Gespeichert wird: ' + schluessel + '  (' + warum + ')');
  }
  // Der Schalter darf nicht die Schrift mitschleppen. Beide stehen in
  // derselben Karte, sind aber verschiedene Einstellungen.
  ok(/settings\.set\(\{ wenigerBewegung: wenigerBewegung \}\)/.test(script),
     'Der Schalter schreibt seinen eigenen Schluessel');
  ok(/schrift: aktuelleSchrift,\s*\n\s*schriftGroesse: aktuelleGroesse/.test(script),
     'Die beiden anderen stehen zusammen, aber getrennt vom Schalter');

  // Werte aus settings.json werden geprueft, nicht uebernommen.
  ok(/g >= FS_MIN && g <= FS_MAX/.test(script), 'Eine Textgroesse ausserhalb 85-125 wird verworfen');
  ok(/s\.schrift === 'eigene' \|\| schriftSuchen\(s\.schrift\)/.test(script),
     'Ein unbekannter Schriftname aus settings.json wird verworfen');
  ok(/Number\.isFinite\(g\)/.test(script), 'NaN wird verworfen');
  // Und der Eintrag "Eigene Datei" darf ohne Datei nicht stehen bleiben -
  // sonst waere er eine Auswahl, fuer die es nichts gibt.
  ok(/if\(aktuelleSchrift === 'eigene'\) aktuelleSchrift = 'standard';/.test(script),
     'Ohne geladene Datei faellt "Eigene Datei" auf die Standardschrift zurueck');
}

// =====================================================================
// 11. Die vier Sprachen sind vollstaendig
// =====================================================================
group('11. Alle vier Sprachen haben dieselben Schluessel');
{
  const a = script.indexOf('const TRANSLATIONS = {');
  const b = script.indexOf('\n  };', a);
  ok(a > 0 && b > a, 'TRANSLATIONS gefunden',
     a + ' … ' + b);
  if (a > 0 && b > a) {
    // Die Objektliteral-Schreibweise in einem frischen Kontext auswerten.
    // Nicht mit einem Regex die Schluessel zaehlen: eine Zeile wie
    // "a: 'x', b: 'y'," laesst sich mit Regex nur raten.
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(script.slice(a, b + 4) + '\n;__ergebnis = TRANSLATIONS;', ctx);
    const tab = ctx.__ergebnis;
    ok(!!tab && Object.keys(tab).length === 4, 'TRANSLATIONS liess sich auswerten',
       tab ? Object.keys(tab).join(', ') : 'null');

  const sprachen = Object.keys(tab);
  ok(sprachen.length === 4, 'Vier Sprachen', sprachen.join(', '));
  const voll = new Set(Object.keys(tab[sprachen[0]]));
  for (const sp of sprachen) {
    const keys = new Set(Object.keys(tab[sp]));
    const fehlen = [...voll].filter(k => !keys.has(k));
    const zuviel = [...keys].filter(k => !voll.has(k));
    ok(fehlen.length === 0, sp + ': kein Schluessel fehlt', fehlen.join(', '));
    ok(zuviel.length === 0, sp + ': kein Schluessel ohne Entsprechung', zuviel.join(', '));
    for (const k of keys) {
      if (typeof tab[sp][k] !== 'string') ok(false, sp + '.' + k + ' ist Text');
    }
  }
  const neu = [
    'shortcut_title', 'card_display_title', 'card_window_title',
    'settings_subtitle', 'settings_search_ph', 'settings_search_empty',
    'settings_font_title', 'settings_fontsize_title',
    'settings_ownfont_title', 'settings_ownfont_load', 'settings_ownfont_clear',
    'settings_motion_title', 'settings_motion_hint', 'settings_font_reset',
  ];
  for (const k of neu) {
    const fehltWo = sprachen.filter(sp => typeof tab[sp][k] !== 'string' || !tab[sp][k].trim());
    ok(fehltWo.length === 0, 'Neuer Schluessel in allen Sprachen: ' + k, 'fehlt in ' + fehltWo.join(', '));
  }
  ok(!sprachen.some(sp => /\bnews_/.test(Object.keys(tab[sp]).join(' '))),
     'Keine news_*-Schluessel mehr uebrig');

  // Der Untertitel musste ehrlich werden: er stand lange auf
  // "Fenstergr\u00f6\u00dfe & -position", obwohl die Seite inzwischen Sprache,
  // Darstellung, Fenster, Widgets und Anmeldung zeigt.
  ok(!sprachen.every(sp => /Fenstergr\u00f6\u00dfe & -position/i.test(tab[sp].settings_subtitle || '')),
     'settings_subtitle beschreibt nicht mehr nur das Fenster');

  // Jeder data-i18n-Schluessel im Markup braucht eine Uebersetzung.
  const benutzt = new Set([...src.matchAll(/data-i18n(?:-[a-z]+)?="([a-z0-9_]+)"/g)].map(m => m[1]));
  const ohne = [...benutzt].filter(k => !voll.has(k));
  ok(ohne.length === 0, 'Jeder data-i18n-Schluessel im Markup existiert mindestens auf Deutsch',
     ohne.join(', '));
  // data-i18n-placeholder braucht Unterstuetzung in applyStaticTranslations.
  ok(/dataset\.i18nPlaceholder|getAttribute\('data-i18n-placeholder'\)/.test(script),
     'applyStaticTranslations() wertet data-i18n-placeholder aus (sonst bleibt der Platzhalter deutsch)');
  } else {
    // Ohne die Tabelle waeren die Pruefungen darueber stillschweigend
    // leer gelaufen. Das darf nicht als Erfolg durchgehen.
    ok(false, 'Ohne TRANSLATIONS sind die Sprachpruefungen nicht gelaufen');
  }
}

// =====================================================================
console.log('\n=====================================================');
if (problems.length === 0) {
  console.log('ALLE ' + checks + ' PRUEFUNGEN BESTANDEN');
} else {
  console.log(problems.length + ' von ' + checks + ' PRUEFUNGEN FEHLGESCHLAGEN:');
  problems.forEach(p => console.log('  - ' + p));
  process.exitCode = 1;
}
