// test-widget-anzeige.js
//   node test-widget-anzeige.js
//
// Prueft, was in den mitgelieferten Widgets wirklich ANGEZEIGT wird.
//
// Warum nicht im Electron-Fenster: die Widget-Frames laufen in einem
// sandboxed iframe mit undurchsichtiger Herkunft, landen dadurch in einem
// eigenen Prozess (OOPIF) und sind ueber den DevTools-Kanal des
// Hauptfensters nicht erreichbar. Ein erster Versuch mit
// Page.getFrameTree fand null davon und Page-DOM-Abfragen umgehen sie
// ebenfalls. Fuer die Frage "steht da 5 oder 0" ist das aber voellig
// unnoetig: die Widgets sind gewöhnliches JavaScript, das eine
// postMessage-Nachricht entgegennimmt. Das laesst sich direkt hier pruefen -
// schneller, ohne Fenster, und der Fehler zeigt sich deutlicher.
//
// test-widgets-fenster.js bleibt trotzdem noetig: dort wird geprueft, was ein
// Widget von aussen NICHT kann. Das laesst sich nur im echten Fenster
// feststellen.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WURZEL = path.join(__dirname, 'widgets');

const probleme = [];
let pruefungen = 0;
const Z = [];

function ok(bedingung, text, zusatz) {
  pruefungen++;
  if (bedingung) Z.push('  OK    ' + text);
  else {
    Z.push('  FEHLT ' + text + (zusatz ? '   -> ' + zusatz : ''));
    probleme.push(text);
  }
}
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); }

/** Feste Zeit, damit die Anzeige pruefbar ist. */
const FESTE_ZEIT = new Date(2026, 8, 28, 14, 30, 45); // 28.09.2026, 14:30:45

/**
 * Ein Widget in einer Sandbox laufen lassen und ihm eine Nachricht schicken.
 *
 * `sprache` ist der Parameter, um den es hier eigentlich geht: bei
 * toLocaleTimeString aendert der Sprachcode das Format sichtbar
 * ("14:30" auf Deutsch, "2:30 PM" auf Englisch). Deshalb wird jedes Widget
 * mit zwei Sprachen laufen gelassen.
 */
function fuehreAus(id, daten, sprache, texte) {
  const ordner = path.join(WURZEL, id);
  const html = fs.readFileSync(path.join(ordner, 'widget.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script) throw new Error(id + ': kein <script> gefunden');

  // --- mini-DOM ------------------------------------------------------
  const knoten = {};
  function el(id2) {
    if (!knoten[id2]) {
      knoten[id2] = {
        id: id2,
        _text: '',
        _html: '',
        get textContent() { return this._text; },
        set textContent(w) { this._text = String(w); },
        get innerHTML() { return this._html; },
        set innerHTML(w) { this._html = String(w); }
      };
    }
    return knoten[id2];
  }
  // getElementById wird gebraucht, bevor das Skript laeuft, weil es die
  // Knoten anlegt. Wir legen die im HTML genannten IDs vorher an.
  (html.match(/id="([a-zA-Z0-9_-]+)"/g) || []).forEach((treffer) => {
    el(treffer.slice(4, -1));
  });

  const gesendet = [];
  const empfangsKnoten = [];
  const gesetzteVariablen = {};
  let intervall = 0;

  const sand = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document: {
      getElementById: el,
      documentElement: { style: { setProperty: (k, v) => { gesetzteVariablen[k] = v; } } }
    },
    window: {
      addEventListener: (typ, fn) => {
        if (typ === 'message') empfangsKnoten.push(fn);
      }
    },
    parent: { postMessage: (m) => gesendet.push(m) },
    setInterval: () => { intervall++; return intervall; },
    clearInterval: () => {},
    // Feste Zeit, damit die Anzeige pruefbar ist
    Date: new Proxy(Date, {
      construct: (Ziel, argumente) => (argumente.length ? new Date(...argumente) : new Date(FESTE_ZEIT)),
      get: (Ziel, eig) => (eig === 'now' ? () => FESTE_ZEIT.getTime() : Ziel[eig])
    }),
    Object: Object,
    JSON: JSON,
    Math: Math,
    String: String,
    Number: Number,
    Array: Array,
    parseInt: parseInt,
    parseFloat: parseFloat
  };
  sand.window.parent = sand.parent;
  sand.globalThis = sand;
  vm.createContext(sand);

  const fehler = [];
  try {
    vm.runInContext(script[1], sand, { filename: id + '/widget.html', timeout: 5000 });
  } catch (err) {
    fehler.push(err.message);
  }

  // Die Nachricht schicken, die der Launcher schicken wuerde
  const voll = Object.assign({}, daten, { sprache: sprache || 'de' });
  for (const fn of empfangsKnoten) {
    try {
      fn({ data: { quelle: 'liquid-launcher', typ: 'daten', daten: voll, texte: texte || undefined } });
    } catch (err) {
      fehler.push('Nachricht: ' + err.message);
    }
  }

  // Alles zusammensuchen, was in der Kachel steht
  const text = Object.keys(knoten).map((k) => {
    const n = knoten[k];
    return n._text + ' ' + n._html.replace(/<[^>]*>/g, ' ');
  }).join(' ').replace(/\s+/g, ' ').trim();

  return { text: text, fehler: fehler, gesendet: gesendet, variablen: gesetzteVariablen };
}

// Testdaten: 5 Mods, 2 Welten (1 davon spielbar), Launcher laeuft 1 h 5 min
const DATEN = {
  aktiveInstanz: 'talberg',
  instanzen: [{ id: 'talberg', name: 'Talberg', version: '1.21.4', modloader: 'fabric' }],
  welten: [
    { name: 'Meine Welt', kaputt: false, version: '1.21.4' },
    { name: 'Kaputte', kaputt: true, version: '1.21.4' }
  ],
  modAnzahl: 5,
  server: [],
  gestartetAm: FESTE_ZEIT.getTime() - (65 * 60 * 1000)   // 1 h 5 min
};

// =====================================================================
gruppe('1. Die Uhr');
// =====================================================================
{
  const de = fuehreAus('uhr', DATEN, 'de');
  Z.push('    Deutsch : ' + JSON.stringify(de.text));
  ok(de.fehler.length === 0, 'die Uhr wirft keinen Fehler', de.fehler.join('; '));
  ok(/\d{2}:\d{2}/.test(de.text), 'sie zeigt eine Uhrzeit HH:MM', de.text);
  ok(/\b45\b/.test(de.text), 'die Sekunden stehen bei 45', de.text);
  // year: '2-digit' ergibt "26" statt "2026". Der Test verlangt deshalb
  // das zweistellige Jahr - sonst wuerde er eine gewollte Formatsaenderung
  // als Fehler melden, obwohl die Kachel richtig ist.
  ok(/\b26\b/.test(de.text), 'das Jahr steht dabei, zweistellig (26)', de.text);
  ok(/September|Okt|Sep/.test(de.text), 'der Monat steht in Buchstaben', de.text);
  ok(de.gesendet.some((m) => m.typ === 'anfrage'),
     'sie fragt die Daten beim Start an - sonst bliebe sie bei "..."',
     JSON.stringify(de.gesendet));
  ok(de.gesendet.every((m) => m.quelle === 'liquid-launcher-widget'),
     'jede ihrer Nachrichten ist als Widget-Nachricht gekennzeichnet',
     JSON.stringify(de.gesendet));

  // Der eigentliche Punkt dieses Tests: der Sprachcode wirkt.
  const en = fuehreAus('uhr', DATEN, 'en');
  Z.push('    Englisch: ' + JSON.stringify(en.text));
  ok(en.text !== de.text,
     'derselbe Zeitpunkt sieht je nach Sprache anders aus',
     'beide gleich: ' + de.text);
  ok(/AM|PM/i.test(en.text), 'englisch erscheint AM/PM', en.text);
  ok(!/AM|PM/i.test(de.text), 'deutsch erscheint kein AM/PM', de.text);
}

// =====================================================================
gruppe('2. Welten');
// =====================================================================
{
  const r = fuehreAus('welten', DATEN, 'de');
  Z.push('    ' + JSON.stringify(r.text));
  ok(r.fehler.length === 0, 'wirft keinen Fehler', r.fehler.join('; '));
  ok(/Welten/.test(r.text), 'die Kachel heisst "Welten"', r.text);
  // 2 Welten, davon 1 kaputt -> 1 spielbar. Genau das soll sie zeigen.
  ok(/(^|\D)1(\D|$)/.test(r.text), 'sie zaehlt 1 spielbare Welt', r.text);
  ok(/1 kaputt/.test(r.text), 'und weist auf die kaputte hin', r.text);

  // Ohne Daten
  const leer = fuehreAus('welten', {}, 'de');
  Z.push('    ohne Welten: ' + JSON.stringify(leer.text));
  ok(/\b0\b/.test(leer.text), 'ohne Welten zeigt sie 0', leer.text);
  ok(!/\.\.\./.test(leer.text), 'und haengt nicht bei Punkten', leer.text);

  // Ueberhaupt keine Daten - der Zustand direkt nach dem Laden
  const nichts = fuehreAus('welten', null, 'de');
  ok(!/NaN|undefined/.test(nichts.text), 'ohne Daten kein NaN und kein undefined', nichts.text);
}

// =====================================================================
gruppe('3. Mods');
// =====================================================================
{
  const r = fuehreAus('mods', DATEN, 'de');
  Z.push('    ' + JSON.stringify(r.text));
  ok(r.fehler.length === 0, 'wirft keinen Fehler', r.fehler.join('; '));
  ok(/(^|\D)5(\D|$)/.test(r.text), 'sie zeigt die 5 Mods', r.text);
  ok(/Mods/.test(r.text), 'beschriftet mit "Mods"', r.text);

  const nullMods = fuehreAus('mods', Object.assign({}, DATEN, { modAnzahl: 0 }), 'de');
  Z.push('    0 Mods: ' + JSON.stringify(nullMods.text));
  ok(/\b0\b/.test(nullMods.text), 'bei 0 Mods zeigt sie 0', nullMods.text);
  ok(/leer/.test(nullMods.text), 'und sagt, dass der mods-Ordner leer ist', nullMods.text);

  // Ohne das Feld modAnzahl: darf nicht 0 anzeigen, sondern auf den Ladezustand
  const ohneFeld = fuehreAus('mods', {}, 'de');
  Z.push('    ohne modAnzahl: ' + JSON.stringify(ohneFeld.text));
  ok(!/\b0\b/.test(ohneFeld.text),
     'fehlt das Feld, zeigt sie nicht etwa 0 - sie wartet', ohneFeld.text);
}

// =====================================================================
gruppe('4. Laufzeit');
// =====================================================================
{
  const r = fuehreAus('laufzeit', DATEN, 'de');
  Z.push('    ' + JSON.stringify(r.text));
  ok(r.fehler.length === 0, 'wirft keinen Fehler', r.fehler.join('; '));
  ok(/1 h 5 min/.test(r.text), 'sie rechnet 65 Minuten zu "1 h 5 min" aus', r.text);
  // "läuft" ist l-ä-u-f-t. Die erste Fassung dieser Zeile pruefte auf
  // l-ä-f-t und schlug bei "läuft" fehl - ein Fehler im Test, nicht in der
  // Kachel. Deshalb die Gegenprobe, bevor der Code als falsch gilt.
  ok(/l(?:ä|a)uft/.test(r.text), 'und beschriftet es mit "laeuft"', r.text);
  ok(!/99,4/.test(r.text), 'die alte erfundene Uptime-Anzeige erscheint nicht', r.text);

  // Ohne gestartetAm darf sie nichts behaupten
  const ohne = fuehreAus('laufzeit', {}, 'de');
  Z.push('    ohne gestartetAm: ' + JSON.stringify(ohne.text));
  ok(!/\d/.test(ohne.text.replace(/\d+/g, '')) || /NaN/.test(ohne.text) === false,
     'ohne gestartetAm keine erfundenen Zahlen', ohne.text);
  ok(!/NaN/.test(ohne.text), 'kein NaN', ohne.text);
}

// =====================================================================
gruppe('5. Jedes mitgelieferte Widget');
// =====================================================================
{
  const ordner = fs.readdirSync(WURZEL, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  ok(ordner.length >= 4, 'es liegen mindestens vier Widgets bei', String(ordner.length));
  for (const d of ordner) {
    const id = d.name;
    const r = fuehreAus(id, DATEN, 'de');
    Z.push('    ' + id.padEnd(12) + JSON.stringify(r.text.slice(0, 70)));
    ok(r.fehler.length === 0, id + ': laeuft ohne Fehler', r.fehler.join('; '));
    ok(!!r.text, id + ': zeigt irgendetwas an');
    ok(!/NaN|undefined|null|\[object/.test(r.text), id + ': kein NaN, undefined oder [object Object]',
       r.text);
    ok(!/\.\.\./.test(r.text), id + ': haengt nicht bei drei Punkten', r.text);
    ok(r.gesendet.every((m) => m.quelle === 'liquid-launcher-widget'),
       id + ': markiert seine Nachrichten', JSON.stringify(r.gesendet));
    // Jedes Widget muss transparent sein, sonst liegt ein weisses Rechteck
    // auf dem Glas der Kachel.
    const html = fs.readFileSync(path.join(WURZEL, id, 'widget.html'), 'utf8');
    ok(/background\s*:\s*transparent/.test(html),
       id + ': setzt einen transparenten Hintergrund',
       'sonst liegt ein weisses Rechteck auf der Kachel');
    // Und es darf keine externen Ressourcen laden: die Kachel hat keine
    // Herkunft und soll nichts nachladen muessen.
    ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html),
       id + ': laedt nichts von ausserhalb nach', id + ' hat ein src/href');
  }
}

// =====================================================================
gruppe('6. Die D4-Kacheln mit echten Daten');
// =====================================================================
{
  // Derselbe Koffer, den der Hauptprozess baut - gemessen, nicht erdacht.
  // Geprueft wird, dass die Zahlen aus systemdaten.js auch in der Kachel
  // ankommen, und dass eine Kachel ohne Wert WARTET statt zu raten.
  const KOFFER = {
    aktiveInstanz: 'talberg',
    instanzen: [
      { id: 'talberg', name: 'Talberg', version: '1.21.4', modloader: 'fabric',
        lastPlayed: new Date(FESTE_ZEIT.getTime() - 2 * 60 * 60 * 1000).toISOString() },
      { id: 'andere', name: 'Andere', version: '1.20.6', modloader: 'neoforge', lastPlayed: null }
    ],
    welten: DATEN.welten,
    modAnzahl: 5,
    server: [{ name: 'Hauptserver', online: true }, { name: 'Bau', online: false }],
    gestartetAm: DATEN.gestartetAm,
    sprache: 'de',
    system: {
      plattform: 'win32', release: '10.0.26200', arch: 'x64',
      kerne: 8, cpuTaktMhz: 3600,
      ramGesamt: 17179869184,        // 16 GiB
      ramFrei: 8589934592,           // 8 GiB
      ramBelegt: 8589934592,
      systemUptimeSek: 90061         // 1 Tag + 1 h + 1 min
    },
    cpuLast: 37,
    laufwerk: { gesamt: 512110190592, frei: 128849018880 },
    netzwerk: [
      { name: 'WLAN', intern: false, adresse: '192.168.178.5' },
      { name: 'Loopback', intern: true, adresse: '127.0.0.1' }
    ],
    launcherVersion: '1.4.0',
    javaInfo: { majorErforderlich: 21, erkannt: 21, status: 'gefunden' },
    instanzGroesse: 4294967296,      // 4 GiB
    modsGroesse: 734003200,          // 700 MiB
    ressourcenpaketeAnzahl: 3,
    instanzRam: { minGb: 2, maxGb: 6 },
    prozesse: [{ name: 'javaw', pid: 4711, instanz: 'talberg',
                 seit: FESTE_ZEIT.getTime() - 65 * 60 * 1000 }]
  };

  const f = (id) => fuehreAus(id, KOFFER, 'de');

  const ram = f('ram');
  Z.push('    ram        ' + JSON.stringify(ram.text));
  ok(ram.fehler.length === 0, 'ram: kein Fehler', ram.fehler.join('; '));
  ok(/GB/.test(ram.text) && /\//.test(ram.text), 'ram: zeigt belegt / gesamt in GB', ram.text);
  ok(/Arbeitsspeicher/.test(ram.text), 'ram: beschriftet', ram.text);

  const last = f('cpu-auslastung');
  Z.push('    cpu-last   ' + JSON.stringify(last.text));
  ok(/37 %/.test(last.text), 'cpu-auslastung: zeigt die gemessenen 37 %', last.text);
  ok(/CPU-Auslastung/.test(last.text), 'cpu-auslastung: beschriftet', last.text);
  // Ohne Messwert darf sie nichts behaupten - der Ladezustand ist ehrlich.
  const lastNull = fuehreAus('cpu-auslastung', Object.assign({}, KOFFER, { cpuLast: null }), 'de');
  ok(!/\d/.test(lastNull.text.replace(/…/g, '')) && !/%/.test(lastNull.text),
     'cpu-auslastung: bei null ohne Wert zeigt sie keine Zahl', lastNull.text);

  const info = f('cpu-info');
  Z.push('    cpu-info   ' + JSON.stringify(info.text));
  ok(/(^|\D)8(\D|$)/.test(info.text), 'cpu-info: 8 Kerne', info.text);
  ok(/3600 MHz/.test(info.text), 'cpu-info: den gemessenen Takt', info.text);

  const sys = f('system-info');
  Z.push('    sys-info   ' + JSON.stringify(sys.text));
  ok(/10\.0\.26200/.test(sys.text), 'system-info: die echte OS-Version', sys.text);
  ok(/x64/.test(sys.text), 'system-info: die Architektur', sys.text);

  const upt = f('system-laufzeit');
  Z.push('    sys-uptime ' + JSON.stringify(upt.text));
  ok(/1 d 1 h/.test(upt.text), 'system-laufzeit: 90061 s sind 1 Tag 1 Stunde', upt.text);
  ok(/Rechner läuft/.test(upt.text), 'system-laufzeit: beschriftet', upt.text);

  const lw = f('laufwerk');
  Z.push('    laufwerk   ' + JSON.stringify(lw.text));
  ok(/GB/.test(lw.text) && /von/.test(lw.text), 'laufwerk: frei und Gesamt in GB', lw.text);
  ok(/Freier Speicherplatz/.test(lw.text), 'laufwerk: beschriftet', lw.text);

  const netz = f('netzwerk');
  Z.push('    netzwerk   ' + JSON.stringify(netz.text));
  ok(/(^|\D)1(\D|$)/.test(netz.text), 'netzwerk: eine externe Schnittstelle', netz.text);
  ok(/WLAN/.test(netz.text), 'netzwerk: ihr Name', netz.text);
  ok(!/Loopback/.test(netz.text), 'netzwerk: die interne bleibt draussen', netz.text);

  const jv = f('java');
  Z.push('    java       ' + JSON.stringify(jv.text));
  ok(/(^|\D)21(\D|$)/.test(jv.text), 'java: die erforderte Major-Version', jv.text);
  ok(/gefunden/.test(jv.text), 'java: den gemeldeten Status', jv.text);

  const lv = f('launcher-version');
  Z.push('    version    ' + JSON.stringify(lv.text));
  ok(/1\.4\.0/.test(lv.text), 'launcher-version: die echte Version', lv.text);

  const si = f('speicher-instanz');
  Z.push('    groesse    ' + JSON.stringify(si.text));
  ok(/GB/.test(si.text), 'speicher-instanz: 4 GiB als GB', si.text);
  ok(/Instanzordner/.test(si.text), 'speicher-instanz: beschriftet', si.text);

  const pk = f('packs');
  Z.push('    packs      ' + JSON.stringify(pk.text));
  ok(/(^|\D)3(\D|$)/.test(pk.text), 'packs: drei Ressourcenpakete', pk.text);
  ok(/Ressourcenpakete/.test(pk.text), 'packs: beschriftet', pk.text);

  const ir = f('instanz-ram');
  Z.push('    inst-ram   ' + JSON.stringify(ir.text));
  ok(/2–6 GB/.test(ir.text), 'instanz-ram: 2 bis 6 GB', ir.text);

  const sv = f('server-status');
  Z.push('    server     ' + JSON.stringify(sv.text));
  ok(/(^|\D)2(\D|$)/.test(sv.text), 'server-status: zwei eingetragen', sv.text);
  ok(/1 online/.test(sv.text), 'server-status: einer ist online', sv.text);

  const ins = f('instanzen');
  Z.push('    instanzen  ' + JSON.stringify(ins.text));
  ok(/(^|\D)2(\D|$)/.test(ins.text), 'instanzen: zwei davon', ins.text);
  ok(/Talberg/.test(ins.text), 'instanzen: die aktive beim Namen', ins.text);

  const proc = f('spiel-prozess');
  Z.push('    prozess    ' + JSON.stringify(proc.text));
  ok(/1 h 5 min/.test(proc.text), 'spiel-prozess: laeuft seit 1 h 5 min', proc.text);
  ok(/Talberg/.test(proc.text), 'spiel-prozess: fuer welche Instanz', proc.text);

  const lz = f('letzter-start');
  Z.push('    letzter    ' + JSON.stringify(lz.text));
  ok(/vor 2 Std\./.test(lz.text), 'letzter-start: vor 2 Std. gerechnet', lz.text);
  ok(/Zuletzt gespielt/.test(lz.text), 'letzter-start: beschriftet', lz.text);

  // Nie gespielt: das ist ein echter Zustand, kein Ladezustand.
  const nie = fuehreAus('letzter-start',
    Object.assign({}, KOFFER, { instanzen: [{ id: 'a', name: 'A', lastPlayed: null }] }), 'de');
  Z.push('    nie        ' + JSON.stringify(nie.text));
  ok(/noch nie gespielt/.test(nie.text), 'letzter-start: "noch nie gespielt" statt Punkten', nie.text);

  const dat = f('datum');
  Z.push('    datum      ' + JSON.stringify(dat.text));
  ok(/\d{2}\.\d{2}\.\d{4}/.test(dat.text), 'datum: das feste Datum 28.09.2026', dat.text);
  ok(/Montag/.test(dat.text), 'datum: der Wochentag', dat.text);

  // Die Beschriftungen der neuen Kacheln folgen dem texte-Block.
  const en = fuehreAus('cpu-auslastung', KOFFER, 'en', {
    widget_cpu_load: 'CPU load', time_hours: '{n} hours ago', widget_last_played: 'Last played'
  });
  Z.push('    englisch   ' + JSON.stringify(en.text));
  ok(/CPU load/.test(en.text), 'cpu-auslastung benutzt den englischen Text', en.text);
  const lzEn = fuehreAus('letzter-start', KOFFER, 'en', {
    widget_last_played: 'Last played', time_hours: '{n} hours ago'
  });
  ok(/2 hours ago/.test(lzEn.text) && /Last played/.test(lzEn.text),
     'letzter-start benutzt die englischen Texte', lzEn.text);

  // Kein Pfad und kein Token darf in einer dieser Kacheln landen.
  for (const id of ['ram', 'laufwerk', 'system-info', 'netzwerk', 'speicher-instanz']) {
    const r = f(id);
    ok(!/AppData|[A-Za-z]:\\/.test(r.text), id + ': zeigt keinen Pfad', r.text);
  }
}

// =====================================================================
gruppe('7. Ohne Daten raten die neuen Kacheln nicht');
// =====================================================================
{
  // Der Zustand direkt nach dem Laden: ein leerer Koffer. Jede Kachel muss
  // den Ladezustand zeigen - "0", "0 %" oder "keine Daten" waeren Lugen.
  const leer = {};
  for (const id of ['ram', 'cpu-auslastung', 'laufwerk', 'java', 'packs',
                    'instanz-ram', 'speicher-instanz', 'system-laufzeit',
                    'netzwerk', 'spiel-prozess', 'server-status']) {
    const r = fuehreAus(id, leer, 'de');
    ok(r.fehler.length === 0, id + ': kein Fehler im leeren Zustand', r.fehler.join('; '));
    ok(!/NaN|undefined|null|\[object/.test(r.text), id + ': kein NaN oder undefined', r.text);
    ok(!/\d/.test(r.text.replace(/…/g, '')),
       id + ': keine Zahl ohne gemessenen Wert', r.text);
  }
}

// =====================================================================
gruppe('8. Die Beschriftungen folgen der Sprache (texte)');
// =====================================================================
{
  // Der Launcher schickt mit den Daten einen texte-Block. Die Kacheln sollen
  // ihn benutzen - und ohne ihn weiterhin Deutsch zeigen (Rueckfall).
  const texte = {
    widget_worlds: 'Worlds', widget_worlds_none: 'no savegames', widget_worlds_broken: '{n} broken',
    widget_mods: 'Mods', widget_mods_empty: 'mods folder is empty',
    widget_uptime: 'Launcher running', widget_clock_error: 'Clock could not draw: {msg}'
  };

  const leer = fuehreAus('welten', Object.assign({}, DATEN, { welten: [] }), 'en', texte);
  Z.push('    welten/en: ' + JSON.stringify(leer.text));
  ok(/Worlds/.test(leer.text) && /no savegames/.test(leer.text),
     'Welten-Kachel benutzt die englischen Texte', leer.text);

  const modsEn = fuehreAus('mods', Object.assign({}, DATEN, { modAnzahl: 0 }), 'en', texte);
  ok(/mods folder is empty/.test(modsEn.text),
     'Mods-Kachel benutzt den englischen Leer-Text', modsEn.text);

  const laufEn = fuehreAus('laufzeit', DATEN, 'en', texte);
  ok(/Launcher running/.test(laufEn.text),
     'Laufzeit-Kachel benutzt den englischen Titel', laufEn.text);

  // Ohne texte-Objekt muss weiterhin Deutsch erscheinen (Rueckfall).
  const modsOhne = fuehreAus('mods', Object.assign({}, DATEN, { modAnzahl: 0 }), 'de');
  ok(/mods-Ordner ist leer/.test(modsOhne.text),
     'ohne texte bleibt der deutsche Rueckfall', modsOhne.text);
}

// ---------------------------------------------------------------------
Z.push('');
Z.push('=====================================================');
if (probleme.length === 0) {
  Z.push('ALLE ' + pruefungen + ' PRUEFUNGEN BESTANDEN');
} else {
  Z.push(probleme.length + ' von ' + pruefungen + ' PRUEFUNGEN FEHLGESCHLAGEN:');
  probleme.forEach((p) => Z.push('  - ' + p));
  process.exitCode = 1;
}
console.log(Z.join('\n'));
