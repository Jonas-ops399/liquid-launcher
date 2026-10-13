// test-ideen-fixes.js
//   node test-ideen-fixes.js
//
// Sichert die kleinen Korrekturen aus der Ideen-Liste ab, die sich am Text
// pruefen lassen — ohne Electron und ohne jsdom. Alles, was ein echtes Fenster
// braucht (Klick auf den Schalter, sichtbare Hoehen), steht weiterhin in den
// jeweiligen -fenster-Tests.
//
// Warum je Korrektur eine Pruefung:
// Diese Aenderungen sind unsichtbar, sobald sie wieder herausfallen. Ein
// "Installieren"-Knopf, der nach dem Erfolg auf "Lädt …" stehen bleibt, faellt
// im Code nicht auf, und ein geloeschter Markup-Block ebenso wenig. Der Test
// benennt deshalb jede einzelne Zusage.

const fs = require('node:fs');
const path = require('node:path');

const WURZEL = __dirname;
const HTML = fs.readFileSync(path.join(WURZEL, 'src', 'renderer', 'index.html'), 'utf8');
const IPC = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'ipc-handlers.js'), 'utf8');
const RP = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'resourcepacks.js'), 'utf8');

let checks = 0;
const problems = [];
function ok(cond, msg, extra) {
  checks++;
  console.log((cond ? '  OK   ' : '  FEHLT ') + msg + (cond || !extra ? '' : '  ->  ' + extra));
  if (!cond) problems.push(msg);
}
function group(t) { console.log('\n--- ' + t + ' ---'); }

console.log('== Ideen-Fixes: Mods, Konto, Schalter, Einstellungen, Modpacks ==');

// =====================================================================
group('1. Mods: Installations-Knopf bleibt nicht auf "Lädt"');
// =====================================================================
{
  // Neun Sprachen: der neue Schluessel muss ueberall da sein.
  const sprachen = ['de', 'en', 'es', 'fr', 'pt', 'it', 'pl', 'tr', 'ru'];
  const anzahl = (HTML.match(/mod_installed_btn:/g) || []).length;
  ok(anzahl === sprachen.length, 'mod_installed_btn existiert in allen neun Sprachen',
     String(anzahl) + ' (erwartet ' + sprachen.length + ')');

  // Der Erfolgszweig setzt den Knopf auf den Fertig-Text um, statt ihn auf
  // mod_installing_btn zu lassen. Und der Fehlerzweig gibt ihn wieder frei.
  const block = (HTML.match(/btn\.addEventListener\('click', async \(\) => \{[\s\S]*?\n      \}\);/g) || []).find(b => b.includes('modsInstall'));
  ok(Boolean(block), 'der Installations-Handler ist auffindbar');
  if (block) {
    ok(/await modsInstall\(mod\);[\s\S]*?mod_installed_btn/.test(block),
       'nach erfolgreichem Install wird der Knopf auf "Installiert" gesetzt');
    ok(/catch\(err\)\{[\s\S]*?btn\.disabled = false/.test(block),
       'im Fehlerfall wird der Knopf wieder freigegeben');
  }
  // Ohne den neuen Schluessel in `sprachen` waere die Schleife oben sinnlos —
  // deshalb wird `sprachen` wenigstens einmal benutzt.
  ok(sprachen.length === 9, 'neun Sprachen geprueft');
}

// =====================================================================
group('2. Konto: keine Kopfanzeige mehr');
// =====================================================================
{
  ok(HTML.includes('class="mod-icon account-head"'),
     'die Kontozeile bringt weiter ein Symbolfeld mit');
  ok(!/kopfSetzen|kopfAnzeigen|wuerfelFuellen|profileFace/.test(HTML),
     'kein Code zum Zuschneiden oder Anzeigen eines Kopfes uebrig');
  ok(/row\.querySelector\('\.account-head'\)\.innerHTML = '<svg/.test(HTML),
     'das Konto zeigt ein neutrales Personen-Symbol statt eines Kopfes');
}

// =====================================================================
group('3. Schalter: aus = grau, an = farbig, Liquid Glass');
// =====================================================================
{
  const block = (HTML.match(/\.settings-schalter\{[\s\S]*?\.settings-schalter:focus-visible\{[^}]*\}/) || [])[0] || '';
  ok(block.length > 0, 'der Schalter-CSS-Block ist auffindbar');
  ok(!/--glass-fill-strong/.test(block),
     'der Aus-Zustand nutzt kein helles Fuell-Overlay mehr');
  ok(/\.settings-schalter\[aria-checked="true"\][\s\S]*?rgba\(255,184,107/.test(block)
     || /\[aria-checked="true"\][\s\S]*?rgba\(255,184,107/.test(block),
     'der An-Zustand ist eingefaerbt (Akzentfarbe)');
  ok(/inset 0 1px/.test(block), 'der Schalter hat eine Glas-Innenkante (inset-Schatten)');
}

// =====================================================================
group('4. Einstellungen: Microsoft-Karte entfernt, keine weisse Leiste');
// =====================================================================
{
  ok(!HTML.includes('id="clientIdInput"'),
     'das Client-ID-Feld ist aus dem Markup entfernt');
  ok(!HTML.includes('data-i18n="settings_microsoft_title"'),
     'die Microsoft-Karte steht nicht mehr in den Einstellungen');
  // Der Code darf trotzdem nicht am fehlenden Feld abstuerzen.
  ok(/if\(!clientIdStatus\) return;/.test(HTML),
     'showClientIdStatus prueft auf ein fehlendes Feld');
  ok(/if\(!clientIdInput \|\| !redirectUriHint\) return;/.test(HTML),
     'loadClientId prueft auf ein fehlendes Feld');

  const kopf = (HTML.match(/\.settings-kopf\{[\s\S]*?\n  \}/) || [])[0] || '';
  ok(kopf.length > 0, 'der Einstellungs-Kopf ist auffindbar');
  // Der Kommentar im Block nennt den alten Wert — geprueft wird die echte
  // background-Zeile, nicht das Wort im Kommentar.
  ok(/background:linear-gradient\(180deg, rgba\(10,16,22/.test(kopf),
     'der klebende Kopf nutzt den dunklen Verlauf statt des hellen');
  const suche = (HTML.match(/\.settings-suche\{[\s\S]*?\n  \}/) || [])[0] || '';
  ok(/background:transparent/.test(suche),
     'das Suchfeld ist ohne Fokus unsichtbar (transparent)');
}

// =====================================================================
group('5. Modpack: "Entfernen" statt "Loeschen"');
// =====================================================================
{
  ok(/inst_del_btn: 'Entfernen'/.test(HTML), 'der deutsche Knopf heisst "Entfernen"');
  ok(!/inst_del_btn: 'Loeschen'/.test(HTML), 'die alte Beschriftung ist weg');
}

// =====================================================================
group('6. Mods: Bild des Projekts wird mitgespeichert');
// =====================================================================
{
  ok(/iconUrl: project\.icon_url \|\| null/.test(IPC),
     'downloadModForInstance schreibt iconUrl in die Metadaten');
  ok(/if\(mod\.iconUrl\)/.test(HTML), 'renderInstalled zeigt iconUrl an');
}

// =====================================================================
group('7. Ressourcenpakete: pack.png als Vorschau');
// =====================================================================
{
  ok(/function packBild\(/.test(RP), 'packBild existiert im Hauptprozess');
  ok(/module\.exports = \{[\s\S]*?packBild/.test(RP), 'packBild ist exportiert');
  ok(/bild: packBild\(voll, istOrdner\)/.test(RP), 'listPacks liefert das Bild mit');
  ok(/function packIconHtml\(pack\)/.test(HTML), 'der Renderer hat einen Paket-Bild-Helfer');
  ok(/\$\{packIconHtml\(pack\)\}/.test(HTML), 'die Paketzeile benutzt den Bild-Helfer');
}

// =====================================================================
group('8. Startoptionen stehen in den Einstellungen, nicht in der Leiste');
// =====================================================================
{
  ok(!HTML.includes('data-view="launchopts"'),
     'der eigene Navigationspunkt "Startoptionen" ist entfernt');
  ok(!HTML.includes('id="viewLaunchOpts"'),
     'die eigene Ansicht ist entfernt');
  ok(HTML.includes('id="settingsLaunchoptsCard"'),
     'die Startoptionen sind als Einstellungs-Karte vorhanden');
  // Die Feld-IDs bleiben unveraendert — daran haengt die Speicherlogik.
  ok(HTML.includes('id="optsRamMin"') && HTML.includes('id="optsRamMax"')
     && HTML.includes('id="optsWidth"') && HTML.includes('id="optsHeight"'),
     'alle vier Felder (RAM min/max, Breite/Hoehe) existieren weiter');
  ok(/const optsPanel = document\.getElementById\('settingsLaunchoptsCard'\)/.test(HTML),
     'die Speicherlogik haengt an der neuen Karte');
  ok(/if\(view === 'settings'\) loadLaunchOpts\(\);/.test(HTML),
     'beim Oeffnen der Einstellungen werden die Startwerte geladen');
}

// =====================================================================
group('9. Widgets sprechen die eingestellte Sprache');
// =====================================================================
{
  // Jeder Widget-Text muss in allen neun Sprachfassungen stehen. Fehlt eine,
  // faellt es im Code nicht auf - die Kachel zeigt dann auf Englisch weiter
  // Deutsch. Deshalb wird gezaehlt, nicht gesucht.
  const sprachen = ['de', 'en', 'es', 'fr', 'pt', 'it', 'pl', 'tr', 'ru'];
  const schluessel = [
    'widget_customize','widget_done','widget_empty','widget_empty_edit','widget_remove',
    'widget_load_failed','widget_unknown_error','widget_none_found','widget_own',
    'widget_in','widget_add','widget_added','widget_already','widget_app_only',
    'widget_files_hint','widget_folder_failed','widget_reloaded',
    'widget_worlds','widget_worlds_none','widget_worlds_broken',
    'widget_mods','widget_mods_empty','widget_uptime','widget_clock_error',
    // ---- Phase D4: die 20 neuen Kacheln -------------------------------
    'widget_instances','widget_instances_none',
    'widget_instance_active','widget_instance_none','widget_instance_ram',
    'widget_last_played',
    'widget_size_instance','widget_size_mods','widget_size_worlds',
    'widget_packs','widget_packs_none',
    'widget_ram','widget_ram_free',
    'widget_cpu_load','widget_cpu_cores',
    'widget_sys_uptime','widget_sys_info',
    'widget_disk_free','widget_disk_total',
    'widget_java_found','widget_java_wait','widget_java_none','widget_no_data',
    'widget_launcher_version',
    'widget_net','widget_net_none',
    'widget_process','widget_process_none','widget_process_running',
    'widget_server','widget_server_none','widget_server_online',
    // Wiederverwendet fuer "Zuletzt gespielt" - muessen deshalb auch in
    // allen neun Sprachen stehen, sonst faellt die Kachel auf Deutsch zurueck.
    'time_now','time_hours','time_days','time_never'
  ];
  let fehlend = [];
  for (const k of schluessel) {
    const n = (HTML.match(new RegExp(k + ':', 'g')) || []).length;
    if (n !== sprachen.length) fehlend.push(k + '=' + n);
  }
  ok(fehlend.length === 0,
     'alle ' + schluessel.length + ' Widget-Schluessel in neun Sprachen vorhanden',
     fehlend.join(', '));

  // Die Kacheln bekommen die Texte ueber die daten-Nachricht...
  ok(/function widgetTexteAktualisieren/.test(HTML),
     'der Renderer baut den texte-Block');
  ok(/WidgetHost\.setzeTexte/.test(HTML), 'der Renderer reicht die Texte an WidgetHost weiter');
  const HOST = fs.readFileSync(path.join(WURZEL, 'src', 'renderer', 'widget-host.js'), 'utf8');
  ok(/setzeTexte/.test(HOST) && /zusammen\.texte = aktuelleTexte\(\)/.test(HOST),
     'widget-host haengt die Texte an die daten-Nachricht');

  // ...und jedes eingebaute Widget liest sie. Vier Namen festzuschreiben
  // waere zu wenig: seit Phase D4 liegen 24 Kacheln bei.
  const mitgeliefert = fs.readdirSync(path.join(WURZEL, 'widgets'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  ok(mitgeliefert.length === 24, '24 mitgelieferte Widgets', mitgeliefert.join(', '));
  for (const id of mitgeliefert) {
    const w = fs.readFileSync(path.join(WURZEL, 'widgets', id, 'widget.html'), 'utf8');
    ok(/d\.texte|tx\(/.test(w), 'Widget "' + id + '" liest d.texte');
  }

  // Die Manifeste der eingebauten Widgets nennen Titel und Beschreibung je
  // Sprache, damit auch die Verwaltung mitwechselt.
  for (const id of mitgeliefert) {
    const j = JSON.parse(fs.readFileSync(path.join(WURZEL, 'widgets', id, 'widget.json'), 'utf8'));
    ok(j.titel && typeof j.titel === 'object' && sprachen.every((s) => j.titel[s]),
       'Widget "' + id + '" hat einen Titel in allen neun Sprachen');
    ok(j.beschreibung && typeof j.beschreibung === 'object'
       && sprachen.every((s) => j.beschreibung[s]),
       'Widget "' + id + '" hat eine Beschreibung in allen neun Sprachen');
  }
  // Der Hauptprozess loest den Titel nach der eingestellten Sprache auf.
  ok(/listeWidgets\(widgetWurzeln\(\), settingsStore\.language/.test(
       fs.readFileSync(path.join(WURZEL, 'src', 'main', 'ipc-handlers.js'), 'utf8')),
     'widgets:list uebergibt die eingestellte Sprache');
}

// =====================================================================
group('10. Startseite: Kacheln blenden gestaffelt ein');
// =====================================================================
{
  // Die Animation steht im CSS. Fehlt der Keyframe oder die Regel, erscheinen
  // die Kacheln wieder hart - im Quelltext sieht man davon nichts.
  ok(/@keyframes kachelAuf\{/.test(HTML), 'der Keyframe "kachelAuf" existiert');

  const regel = (HTML.match(/\.stat-grid\.wdg-auf \.stat-tile\{[^}]*\}/) || [])[0] || '';
  ok(regel.length > 0, 'die Einblende-Regel fuer die Kacheln existiert');
  // fill-mode "backwards", NICHT "both": mit "both" bliebe der Endzustand
  // stehen und wuerde das Inline-transform der Hover-Bewegung ueberschreiben.
  ok(/animation:\s*kachelAuf[^;]*backwards/.test(regel),
     'die Regel nutzt kachelAuf mit fill-mode "backwards" (kein Konflikt mit Hover)');
  ok(/animation-delay:\s*calc\([^;]*--wdg-i[^;]*55ms\)/.test(regel),
     'die Verzoegerung staffelt sich ueber --wdg-i');

  ok(/\.ll-wenig-bewegung \.stat-grid\.wdg-auf \.stat-tile\{\s*animation:none/.test(HTML),
     '"Weniger Bewegung" schaltet die Einblendung ab');
  ok(/prefers-reduced-motion[^@]*?\.stat-grid\.wdg-auf \.stat-tile\{\s*animation:none/
       .test(HTML.replace(/\s+/g, ' ')) || /prefers-reduced-motion[\s\S]{0,80}animation:none/.test(HTML),
     'die Systemeinstellung schaltet sie ebenfalls ab');

  const HOST = fs.readFileSync(path.join(WURZEL, 'src', 'renderer', 'widget-host.js'), 'utf8');
  ok(/function kachelnAnimieren/.test(HOST), 'widget-host kennt kachelnAnimieren');
  ok(/classList\.remove\('wdg-auf'\)[\s\S]{0,400}offsetWidth[\s\S]{0,200}classList\.add\('wdg-auf'\)/
       .test(HOST),
     'das erneute Abspielen erzwingt einen Reflow (sonst kein Neustart)');
  ok(/style\.setProperty\('--wdg-i'/.test(HOST), 'jede Kachel bekommt ihre laufende Nummer');
  ok(/kachelnAnimieren,/.test(HOST), 'kachelnAnimieren ist exportiert');

  // Beim Zurueckwechseln auf die Startseite laeuft die Einblendung erneut.
  ok(/if\(view === 'play' && window\.WidgetHost[\s\S]{0,300}kachelnAnimieren\(\)/.test(HTML),
     'der Ansichtswechsel auf "play" spielt die Einblendung erneut');
}

// =====================================================================
group('11. Schnellzugriff: alle Ziele plus Screenshot');
// =====================================================================
{
  const PRELOAD = fs.readFileSync(path.join(WURZEL, 'src', 'main', 'preload.js'), 'utf8');

  // Jede Ansicht der Seitenleiste muss auch als Kachel da sein. Ein fehlendes
  // data-view faellt im Code nicht auf - die Kachel fehlt dann einfach.
  const raster = (HTML.match(/<div class="shortcut-raster">([\s\S]*?)<\/div>\s*<div class="shortcut-status"/) || [])[1] || '';
  const views = ['worlds', 'mods', 'resourcepacks', 'servers', 'account', 'settings'];
  const fehlend = views.filter(v => !new RegExp('data-view="' + v + '"').test(raster));
  ok(raster.length > 0, 'das Schnellzugriff-Raster ist auffindbar');
  ok(fehlend.length === 0,
     'alle sechs Ansichten sind als Kachel erreichbar',
     fehlend.join(', '));

  // Die beiden Aktionen, die keine Ansicht oeffnen.
  ok(/data-action="theme"/.test(raster), 'die Kachel "Design aendern" existiert');
  ok(/data-action="screenshot"/.test(raster), 'die Kachel "Screenshot" existiert');

  // Neun Sprachen fuer die drei neuen Schluessel.
  for (const k of ['shortcut_screenshot', 'shortcut_shot_saved', 'shortcut_shot_failed']) {
    const n = (HTML.match(new RegExp(k + ':', 'g')) || []).length;
    ok(n === 9, 'Schluessel ' + k + ' steht in neun Sprachen', 'gefunden: ' + n);
  }

  // Der Klick auf "Design" oeffnet das echte Panel, der Screenshot ruft den Kanal.
  ok(/aktion === 'theme'[\s\S]{0,80}e\.stopPropagation\(\)[\s\S]{0,80}trigger\.click\(\)/.test(HTML),
     '"Design aendern" oeffnet das Design-Panel (ohne sofortiges Schliessen)');
  ok(/window\.launcher\.screenshots[\s\S]{0,80}\.capture\(\)/.test(HTML),
     'die Screenshot-Kachel ruft den Screenshot-Kanal');

  // Die Kette Renderer -> preload -> Hauptprozess.
  ok(/screenshots:\s*\{[\s\S]{0,120}capture:\s*invoke\('screenshot:capture'\)[\s\S]{0,120}openFolder:\s*invoke\('screenshot:openFolder'\)/.test(PRELOAD),
     'preload.js gibt screenshot:capture und :openFolder frei');
  ok(/ipcMain\.handle\('screenshot:capture'/.test(IPC), 'der Hauptprozess registriert screenshot:capture');
  ok(/ipcMain\.handle\('screenshot:openFolder'/.test(IPC), 'der Hauptprozess registriert screenshot:openFolder');
  ok(/capturePage\(\)/.test(IPC), 'der Screenshot zeichnet das echte Fenster (capturePage)');
  ok(/toPNG\(\)/.test(IPC) && /screenshots/.test(IPC),
     'das Bild landet als PNG im screenshots-Ordner');
  // Kein Werfen: ein misslungener Screenshot ist eine Zeile, kein Absturz.
  ok(/screenshot:capture'[\s\S]{0,700}ok: false/.test(IPC),
     'screenshot:capture antwortet mit { ok:false } statt zu werfen');
  // Der Renderer bekommt keinen Pfad und kein fs - nur den Dateinamen.
  ok(!/screenshots[\s\S]{0,200}node:fs/.test(PRELOAD),
     'preload.js greift nicht auf das Dateisystem zu');
}

console.log('\n' + '='.repeat(66));
if (problems.length) {
  console.log(`❌ ${problems.length} von ${checks} Pruefungen fehlgeschlagen:`);
  problems.forEach(p => console.log('   - ' + p));
  process.exitCode = 1;
} else {
  console.log(`✅ Alle ${checks} Pruefungen bestanden.`);
}