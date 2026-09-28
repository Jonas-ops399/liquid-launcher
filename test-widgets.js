// test-widgets.js
//   node test-widgets.js
//
// Testet die Widget-Suche in src/main/widgets.js.
//
// Der Schwerpunkt liegt nicht auf "funktioniert das Lesen", sondern auf der
// Pfad-Sicherheit: die Widget-ID kommt aus settings.json und damit aus einer
// Datei, die jeder bearbeiten kann. Ohne die Pruefungen waere das hier ein
// Lesekanal aus dem Launcher heraus in beliebige Dateien.
//
// Deshalb steht in diesem Test jeder Angriff zuerst und die Pruefung danach.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const W = require('./src/main/widgets.js');

const WURZEL = path.join(os.tmpdir(), 'liquid-launcher-widgettest');
const EINGEBAUT = path.join(WURZEL, 'eingebaut');
const BENUTZER = path.join(WURZEL, 'benutzer');
const AUSSERHALB = path.join(WURZEL, 'geheim');

fs.rmSync(WURZEL, { recursive: true, force: true });
fs.mkdirSync(EINGEBAUT, { recursive: true });
fs.mkdirSync(BENUTZER, { recursive: true });
fs.mkdirSync(AUSSERHALB, { recursive: true });

function legeAn(ordner, id, manifest, html) {
  const ziel = path.join(ordner, id);
  fs.mkdirSync(ziel, { recursive: true });
  fs.writeFileSync(path.join(ziel, 'widget.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  if (html !== undefined) fs.writeFileSync(path.join(ziel, 'widget.html'), html, 'utf-8');
  return ziel;
}

// Testdaten
legeAn(EINGEBAUT, 'uhr', { id: 'uhr', titel: 'Uhr', breite: 1 }, '<div id="z"></div>');
legeAn(EINGEBAUT, 'welten', { id: 'welten', titel: 'Welten', breite: 1 }, '<div>w</div>');
legeAn(BENUTZER, 'meine-uhr', { id: 'meine-uhr', titel: 'Meine Uhr', breite: 2 }, '<p>hi</p>');
// Kaputt: kein Manifest
fs.mkdirSync(path.join(BENUTZER, 'kaputt-ohne-manifest'), { recursive: true });
// Kaputt: Manifest ohne gueltige ID
legeAn(BENUTZER, 'kaputt-mit-id', { id: '../flucht', titel: 'Falsch' });
// Kaputt: Manifest ohne Titel
legeAn(BENUTZER, 'kaputt-ohne-titel', { id: 'kaputt-ohne-titel' });
// Unsichtbar: Punkt-Ordner
legeAn(BENUTZER, '.versteckt', { id: 'versteckt', titel: 'Versteckt' });

// Datei, die NICHT gelesen werden darf
fs.writeFileSync(path.join(AUSSERHALB, 'widget.json'),
  JSON.stringify({ id: 'geheim', titel: 'Geheim' }), 'utf-8');
fs.writeFileSync(path.join(AUSSERHALB, 'widget.html'),
  'DIESE DATEI DARF NICHT GELADEN WERDEN', 'utf-8');

// Eine dritte Wurzel, die auf denselben gefaehrlichen Ordner zeigt
const WURZELN = [
  { ordner: EINGEBAUT, quelle: 'eingebaut' },
  { ordner: BENUTZER, quelle: 'benutzer' },
  { ordner: AUSSERHALB, quelle: 'benutzer' }   // <- der Angreifer-Ordner
];

const problems = [];
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) {
    console.log('  OK   ' + msg);
  } else {
    console.log('  FEHLT ' + msg + (extra ? '  ->  ' + extra : ''));
    problems.push(msg);
  }
}
function group(t) { console.log('\n--- ' + t + ' ---'); }

// =====================================================================
group('1. Angriffe auf die Widget-ID werden abgewiesen');
// =====================================================================
const ANGRIFFE = [
  '../../../../Windows/System32/drivers/etc/hosts',
  '..',
  '../geheim',
  '..\\geheim',
  '/absolut/pfad',
  'C:\\Windows\\System32',
  'uhr/../../../x',
  '',
  '.versteckt',
  'a'.repeat(65),
  'mit punkt',
  null,
  undefined,
  42,
  { id: 'x' }
];
for (const a of ANGRIFFE) {
  const r = W.istGueltigeId(a);
  ok(r === false, 'ID abgewiesen: ' + JSON.stringify(a));
  const h = W.liesWidgetHtml(WURZELN, a);
  ok(h.ok === false, '  -> und liesWidgetHtml liefert nichts',
     h.ok ? 'HAT GELIEFERT: ' + h.html : '');
}
{
  // Das ist der eigentliche Angriff: die ID zeigt auf einen Ordner, den der
  // Angreifer als zusaetzliche Wurzel eingetragen hat. Er liegt INNERHALB des
  // Wurzelordners, also waere er fuer einen naivenPfadcheck unsichtbar -
  // gefangen werden muss er durch die ID-Pruefung.
  const h = W.liesWidgetHtml(WURZELN, 'geheim');
  ok(h.ok === false, 'Ordner "geheim" in der dritten Wurzel wird NICHT ausgeliefert',
     h.ok ? 'HAT GELIEFERT: ' + h.html : 'zurueckgewiesen: ' + h.fehler);
}
{
  // Kontrolle: der Ordner ist sehr wohl lesbar. Ohne diese Zeile waere der
  // Test oben auch gruen, wenn schlicht gar nichts gefunden wuerde.
  const inhalt = fs.readFileSync(path.join(AUSSERHALB, 'widget.html'), 'utf-8');
  ok(inhalt.indexOf('DARF NICHT') !== -1,
     'Kontrolle: die Datei selbst IST lesbar - es liegt also am Filter');
}

// =====================================================================
group('2. Pfadpruefung liegtInnerhalb');
// =====================================================================
ok(W.liegtInnerhalb(EINGEBAUT, path.join(EINGEBAUT, 'uhr')) === true, 'Kind liegt drin');
ok(W.liegtInnerhalb(EINGEBAUT, EINGEBAUT) === false, 'die Wurzel selbst gilt nicht');
ok(W.liegtInnerhalb(EINGEBAUT, path.join(EINGEBAUT, '..', 'x')) === false, 'ein Level raus');
ok(W.liegtInnerhalb(EINGEBAUT, path.join(AUSSERHALB, 'x')) === false, 'fremder Ordner');
ok(W.liegtInnerhalb(EINGEBAUT, path.join(BENUTZER, 'uhr')) === false, 'fremder Wurzelordner');

// =====================================================================
group('3. Manifest-Pruefung');
// =====================================================================
ok(W.pruefeManifest({ id: 'uhr', titel: 'Uhr' }).ok === true, 'gueltiges Manifest');
ok(W.pruefeManifest({ id: 'uhr' }).ok === false, 'ohne Titel abgewiesen');
ok(W.pruefeManifest({ titel: 'Uhr' }).ok === false, 'ohne id abgewiesen');
ok(W.pruefeManifest({ id: 'uhr', titel: '   ' }).ok === false, 'leerer Titel abgewiesen');
ok(W.pruefeManifest(null).ok === false, 'null abgewiesen');
ok(W.pruefeManifest([]).ok === false, 'Array abgewiesen');
ok(W.pruefeManifest('text').ok === false, 'String abgewiesen');
{
  // Unsinnige Breite soll die Kachel nicht verschwinden lassen
  const m = W.pruefeManifest({ id: 'a', titel: 'A', breite: 99 }).manifest;
  ok(m.breite === 2, 'Breite 99 wird auf 2 begrenzt');
  const m2 = W.pruefeManifest({ id: 'b', titel: 'B', breite: 'breit' }).manifest;
  ok(m2.breite === 1, 'Breite "breit" faellt auf 1 zurueck');
  const m3 = W.pruefeManifest({ id: 'c', titel: 'C' }).manifest;
  ok(m3.breite === 1, 'ohne Breite: 1');
}
{
  // Ein HTML-Pfad im Manifest ist Benutzereingabe und darf kein Pfad sein
  const m = W.pruefeManifest({
    id: 'x', titel: 'X',
    html: '../../../Windows/System32/drivers/etc/hosts'
  }).manifest;
  ok(m.html === 'hosts', 'HTML-Pfad im Manifest wird auf den Dateinamen reduziert',
     JSON.stringify(m.html));
}

// =====================================================================
group('4. Auflisten');
// =====================================================================
const alle = W.listeWidgets(WURZELN);
const ids = alle.map(w => w.id);
ok(ids.includes('uhr'), 'eingebautes Widget gefunden');
ok(ids.includes('welten'), 'zweites eingebautes Widget gefunden');
ok(ids.includes('meine-uhr'), 'Benutzer-Widget gefunden');
ok(!ids.includes('kaputt-mit-id'), 'Widget mit ungueltiger ID nicht gelistet');
ok(!ids.includes('kaputt-ohne-titel'), 'Widget ohne Titel nicht gelistet');
ok(!ids.includes('versteckt'), 'Punkt-Ordner nicht gelistet');
ok(!ids.includes('geheim'), 'Ordner "geheim" nicht gelistet');
ok(alle.every(w => w.titel.length > 0), 'jedes gelistete Widget hat einen Titel');
{
  const ohneQuelle = W.listeWidgets([{ ordner: EINGEBAUT }]);
  ok(ohneQuelle.every(w => w.quelle === 'eingebaut'), 'Quelle faellt auf "eingebaut" zurueck');
}
{
  // Eine Wurzel, die es nicht gibt, darf nichts werfen - das ist der Fall
  // beim allerersten Start, bevor der Ordner angelegt wurde.
  let geworfen = false;
  try { W.listeWidgets([{ ordner: path.join(WURZEL, 'gibtsnicht'), quelle: 'benutzer' }]); }
  catch (e) { geworfen = true; }
  ok(geworfen === false, 'fehlender Wurzelordner wirft keine Exception');
}

// =====================================================================
group('5. Benutzer kann ein eingebautes Widget ersetzen');
// =====================================================================
legeAn(BENUTZER, 'uhr', { id: 'uhr', titel: 'Uhr (meine)', breite: 1 }, '<p>eigen</p>');
{
  const neu = W.listeWidgets(WURZELN);
  const treffer = neu.filter(w => w.id === 'uhr');
  ok(treffer.length === 1, 'es gibt genau ein Widget mit der ID "uhr" (kein Doppeleintrag)',
     'gefunden: ' + treffer.length);
  ok(treffer[0] && treffer[0].titel === 'Uhr (meine)',
     'die spaetere Wurzel gewinnt - das eigene Widget ersetzt das eingebaute',
     treffer[0] ? treffer[0].titel : '(keins)');
  ok(treffer[0] && treffer[0].quelle === 'benutzer', 'Quelle ist "benutzer"');
  const h = W.liesWidgetHtml(WURZELN, 'uhr');
  ok(h.ok && /eigen/.test(h.html), 'und es liefert das eigene HTML',
     h.ok ? h.html : h.fehler);
}

// =====================================================================
group('6. HTML laden');
// =====================================================================
{
  const h = W.liesWidgetHtml(WURZELN, 'uhr');
  ok(h.ok === true, 'HTML laesst sich laden');
  ok(h.manifest && h.manifest.titel === 'Uhr (meine)', 'Manifest kommt mit');
  ok(W.liesWidgetHtml(WURZELN, 'gibtsnicht').ok === false, 'unbekannte ID liefert nichts');
}
{
  // Ordner da, HTML-Datei fehlt -> sauberer Fehler statt Exception
  fs.rmSync(path.join(BENUTZER, 'ohne-html'), { recursive: true, force: true });
  legeAn(BENUTZER, 'ohne-html', { id: 'ohne-html', titel: 'Ohne HTML' });
  const h = W.liesWidgetHtml(WURZELN, 'ohne-html');
  ok(h.ok === false, 'fehlende widget.html liefert Fehler statt Exception');
}

// =====================================================================
group('7. Positivliste: was ein Widget sehen darf');
// =====================================================================
{
  // Der Kontrollfall. Ein realistischer Datenkoffer, wie ihn der Renderer
  // schicken koennte - mit Token und allem. Geprueft wird nicht "kam etwas
  // an", sondern "kam das Falsche auch an".
  const koffer = {
    aktiveInstanz: { id: 'talberg' },
    instanzen: [{ id: 'talberg', name: 'Talberg' }],
    welten: [{ name: 'Meine Welt' }],
    modAnzahl: 12,
    server: [{ name: 'Ein Server' }],
    gestartetAm: 1700000000000,
    sprache: 'de',
    // Alles, was NICHT auf der Liste steht:
    //
    // "theme" steht hier bewusst mit drin, obwohl es erlaubt sein KOEHNTE.
    // Es ist absichtlich NICHT auf der Positivliste: die Einstellungen
    // speichern nur "blockLayout" und "language", es gibt kein
    // settings.theme. Das Feld war deshalb immer null. Die Farben kommen
    // stattdessen als eigene Nachricht aus den CSS-Variablen. Diese Zeile
    // ist die Kontrolle gegen das alte Verhalten - ohne sie wuerde niemand
    // merken, wenn jemand das Feld wieder aufnimmt.
    theme: { textHi: '#fff' },
    accessToken: 'GEHEIM-TOKEN',
    refreshToken: 'GEHEIM-REFRESH',
    accounts: [{ username: 'jonas', accessToken: 'NOCHMAL-TOKEN' }],
    accountsStorePfad: 'C:\\Users\\Anwender\\AppData\\Roaming\\Liquid Launcher\\accounts.json',
    fs: 'fs-modul',
    require: 'require-funktion',
    child_process: 'kindprozesse',
    settingsStore: { clientId: '11111111-2222-3333-4444-555555555555' }
  };
  const raus = W.filtereDatenFuerWidget(koffer);

  ok(raus.accessToken === undefined, 'accessToken wird NICHT durchgereicht');
  ok(raus.refreshToken === undefined, 'refreshToken wird NICHT durchgereicht');
  ok(raus.accounts === undefined, 'accounts wird NICHT durchgereicht');
  ok(raus.accountsStorePfad === undefined, 'der Pfad zur accounts.json wird NICHT durchgereicht');
  ok(raus.fs === undefined, 'fs wird NICHT durchgereicht');
  ok(raus.require === undefined, 'require wird NICHT durchgereicht');
  ok(raus.child_process === undefined, 'child_process wird NICHT durchgereicht');
  ok(raus.settingsStore === undefined, 'settingsStore wird NICHT durchgereicht');
  ok(raus.theme === undefined, 'theme wird NICHT durchgereicht - es gibt keine theme-Einstellung',
     JSON.stringify(raus.theme));

  ok(raus.aktiveInstanz !== undefined, 'aktiveInstanz kommt an');
  ok(Array.isArray(raus.instanzen), 'instanzen kommt an');
  ok(Array.isArray(raus.welten), 'welten kommt an');
  ok(raus.modAnzahl === 12, 'modAnzahl kommt an');
  ok(Array.isArray(raus.server), 'server kommt an');
  ok(raus.gestartetAm !== undefined, 'gestartetAm kommt an');
  ok(raus.sprache === 'de', 'sprache kommt an');

  {
    // Gegenprobe zur Liste selbst: sie enthaelt genau die sieben Felder und
    // sonst nichts. Eine Liste, die still waechst, faellt hier auf.
    const erlaubt = W.ERLAUBTE_DATENFELDER.slice().sort();
    ok(JSON.stringify(erlaubt) ===
       JSON.stringify(['aktiveInstanz','gestartetAm','instanzen','modAnzahl','server','sprache','welten']),
       'die Positivliste enthaelt genau die sieben erwarteten Felder',
       JSON.stringify(erlaubt));
  }

  // Gegenprobe: der ganze Koffer als JSON darf kein Token enthalten
  const alsText = JSON.stringify(raus);
  ok(alsText.indexOf('TOKEN') === -1, 'im gesamten Ergebnis kommt das Wort TOKEN nicht vor');
  ok(alsText.indexOf('AppData') === -1, 'und kein AppData-Pfad');

  ok(W.filtereDatenFuerWidget(null) !== null, 'null-Eingabe wirft nicht');
  ok(Object.keys(W.filtereDatenFuerWidget(null)).length === 0, 'null ergibt eine leere Liste');
  ok(Object.keys(W.filtereDatenFuerWidget('text')).length === 0, 'String ergibt eine leere Liste');
}

// =====================================================================
group('8. Die mitgelieferten Widgets sind in Ordnung');
// =====================================================================
{
  const eigener = path.join(__dirname, 'widgets');
  const vorhanden = fs.existsSync(eigener);
  ok(vorhanden === true, 'der Ordner widgets/ existiert im Projekt',
     'erwartet: ' + eigener);
  if (vorhanden) {
    const liste = W.listeWidgets([{ ordner: eigener, quelle: W.QUELLE_EINGEBAUT }]);
    ok(liste.length > 0, 'es liegt mindestens ein eingebautes Widget bei',
       'gefunden: ' + liste.length);
    ok(liste.some(w => w.id === 'uhr'), 'die Uhr ist dabei');
    let fehler = 0;
    for (const w of liste) {
      const h = W.liesWidgetHtml([{ ordner: eigener, quelle: W.QUELLE_EINGEBAUT }], w.id);
      if (!h.ok) { console.log('       -> ' + w.id + ': ' + h.fehler); fehler++; }
      else if (!h.html.trim()) { console.log('       -> ' + w.id + ': HTML ist leer'); fehler++; }
    }
    ok(fehler === 0, 'jedes eingebaute Widget liefert HTML',
       fehler + ' fehlerhaft');
    // Kein eingebautes Widget darf in die Positivliste hineinreichen
    for (const w of liste) {
      const h = W.liesWidgetHtml([{ ordner: eigener, quelle: W.QUELLE_EINGEBAUT }], w.id);
      ok(h.html.indexOf('accessToken') === -1,
         w.id + ' redet im HTML nicht von accessToken');
    }
  }
}

// ---------------------------------------------------------------------
console.log('\n=====================================================');
fs.rmSync(WURZEL, { recursive: true, force: true });
if (problems.length === 0) {
  console.log('ALLE ' + checks + ' PRUEFUNGEN BESTANDEN');
} else {
  console.log(problems.length + ' von ' + checks + ' PRUEFUNGEN FEHLGESCHLAGEN:');
  problems.forEach(p => console.log('  - ' + p));
  process.exitCode = 1;
}
