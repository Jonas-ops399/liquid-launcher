// test-hover-move.js
//   node test-hover-move.js
//
// Testet die Hover-Bewegung fuer Karten und Zeilen (Stufe 2) in index.html.
//
// Warum es diesen Test gibt: "Syntax ist gueltig" beweist nichts. Der Effekt
// kann syntaktisch einwandfrei sein und trotzdem nicht funktionieren, weil
// der Selektor die Elemente nicht trifft, die man im Fenster sieht.
//
// Der Test laedt den echten Code aus index.html - nicht eine Kopie. Wenn dort
// jemand einen Klassennamen umbenennt, faellt dieser Test um, statt still
// weiter gruen zu sein.
//
// Kein jsdom dafuer: es ist keines installiert, und fuer diese Logik reicht ein
// Shim. Geprueft wird namlich das, was hier tatsaechlich falsch sein kann:
//   - trifft der Selektor die Elemente, die es im Fenster gibt
//   - ist der Weg pro Frame begrenzt (kein Wegspringen ans andere Ende)
//   - bleibt der Bezugspunkt stehen (sonst Flackern, siehe Kommentar im Code)
//   - gewinnt Stufe 1, wenn Button in Karte (sonst wandert beides)
//   - ist zuruecksetzen und Aufräumen vollstaendig

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = path.join(__dirname, 'src', 'renderer', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');

// =====================================================================
// Den echten Code aus index.html ziehen
// =====================================================================
function extract(re, what) {
  const m = src.match(re);
  if (!m) {
    console.error('KANN NICHT EXTRAHIEREN: ' + what);
    console.error('  Gesucht nach: ' + re);
    process.exit(2);
  }
  return m[0];
}

const magneticDecl = extract(
  /const MAGNETIC_SELECTOR =[^;]+;/,
  'MAGNETIC_SELECTOR');

// Ab hier ruft BEIDE Stufen bewegungAus() statt selbst matchMedia
// auszuwerten. Die Funktion wird deshalb mit in die Sandbox geladen - ein
// Test, der sich eine eigene "reduced-motion"-Abfrage baut, prueft nicht das,
// was im Fenster laeuft.
const bewegungDecl = extract(
  /const systemMotion = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);[\s\S]*?\n  \}\n/,
  'bewegungAus');

// Stufe 1 wird MIT geladen. Ohne sie koennte der Test nicht feststellen, ob
// ein Button in einer Karte sich einmal oder zweimal bewegt - und genau das ist
// die Fehlerart, die man beim reinen Betrachten des Codes uebersieht.
const magneticTier1 = extract(
  /const MAGNETIC_STRENGTH[\s\S]*?(?=  \/\/ -+ Hover-Bewegung)/,
  'Stufe-1-Block');

const hoverCode = extract(
  /  \/\/ -+ Hover-Bewegung[\s\S]*?\/\/ -+ Server-Panel -+/,
  'Hover-Block');

const hoverBody = hoverCode.replace(/\/\/ -+ Server-Panel -+\s*$/, '');

// Der Shim bildet getBoundingClientRect als ECHTE Eigenschaft ab, nicht als
// Methode. Das ist Absicht: in einem echten Browser aendert sich die
// Position, sobald wir selbst ein transform setzen. Wuerde der Test hier eine
// Funktion zurueckgeben, waere der Elementpositionstest in Abschnitt 3
// bedeutungslos.
function shimRect() {
  return this._rect;
}

// =====================================================================
// DOM-Shim
// =====================================================================
class ShimElement {
  constructor(opts = {}) {
    this.tag = opts.tag || 'div';
    this.className = opts.className || '';
    this.id = opts.id || '';
    this.style = {};
    this.parent = null;
    this.children = [];
    Object.defineProperty(this, 'rect', {
      get: shimRect,
      set: v => { this._rect = v; },
      enumerable: true,
      configurable: true
    });
    this._rect = opts.rect || { left: 0, top: 0, width: 100, height: 40 };
  }
  getBoundingClientRect() { return this._rect; }
  contains(el) {
    let n = el;
    while (n) { if (n === this) return true; n = n.parent; }
    return false;
  }
  matches(sel) {
    if (sel === 'button') return this.tag === 'button';
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    return false;
  }
  closest(sel) {
    const list = sel.split(',').map(s => s.trim()).filter(Boolean);
    let n = this;
    while (n) {
      for (const s of list) if (n.matches(s)) return n;
      n = n.parent;
    }
    return null;
  }
}

function make(sel) {
  // "div.world-card" -> tag div, Klasse world-card
  // ".stat-tile"     -> tag div, Klasse stat-tile
  // Mehrere Klassen: "div.a.b" -> Klasse "a b"
  const dot = sel.indexOf('.');
  if (dot === -1) return new ShimElement({ tag: sel });
  return new ShimElement({
    tag: sel.slice(0, dot),
    className: sel.slice(dot + 1).split('.').join(' ')
  });
}

// Eltern-Kette aufbauen: makeChain('div.world-card', 'button')
function makeChain(specs) {
  const els = specs.map(make);
  for (let i = 1; i < els.length; i++) {
    els[i].parent = els[i - 1];
    els[i - 1].children.push(els[i]);
  }
  return els[els.length - 1]; // innerstes Element = das, worueber gehovert wird
}

const listeners = {};
const documentShim = {
  addEventListener(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
  }
};

let reduceMotion = false;

// Ein echter Browser liefert hier KEIN Schnappschuss, sondern ein lebendes
// MediaQueryList: matchMedia() wird einmal aufgerufen, .matches wird aber bei
// jeder Abfrage neu ausgewertet. Mit einem Schnappschuss waere der Test in
// Abschnitt 7 stillschweigend gruen geblieben - der eingeblendete Code fragt
// reduceMotion.matches bei JEDEM Ereignis ab, und nur so wirkt eine
// nachtraegliche Aenderung der Systemeinstellung ueberhaupt.
const mediaQueryList = { get matches() { return reduceMotion; } };

const sandbox = {
  document: documentShim,
  window: { matchMedia: () => mediaQueryList },
  Element: ShimElement,
  setTimeout, clearTimeout, console,
  Math, WeakMap, Object, Array, String, Number, JSON,
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(
  'let wenigerBewegung = false;\n' +
  bewegungDecl + '\n' + magneticDecl + '\n' + magneticTier1 + '\n' + hoverBody,
  sandbox,
  { filename: 'hover-code.js' }
);

// Der eigene Schalter "Weniger Bewegung". Getrennt vom Systemwert, damit
// beide Quellen einzeln pruefbar sind.
function schalterAn(an) {
  vm.runInContext('wenigerBewegung = ' + (an ? 'true' : 'false') + ';', sandbox);
}

function fire(type, target, relatedTarget) {
  for (const fn of (listeners[type] || [])) {
    fn({ target, relatedTarget, clientX: 0, clientY: 0 });
  }
}

// Mausbewegung: erst mouseover, dann mousemove mit Koordinaten
function hover(target, x, y) {
  fire('mouseover', target, null);
  const c = { target, relatedTarget: null, clientX: x, clientY: y };
  for (const fn of (listeners.mousemove || [])) fn(c);
}

function unhover(target, relatedTarget) {
  fire('mouseout', target, relatedTarget || null);
}

// translate(...) aus dem Inline-Style lesen
function tx(el) {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
}

// =====================================================================
// Prüfungen
// =====================================================================
const problems = [];
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  console.log((cond ? '  OK   ' : '  FEHLT ') + msg + (cond || !extra ? '' : '  ->  ' + extra));
  if (!cond) problems.push(msg);
}
function group(t) { console.log('\n--- ' + t + ' ---'); }

console.log('== Hover-Bewegung: Karten und Zeilen ==');

// ---------------------------------------------------------------------
group('1. Der Selektor trifft die Elemente, die es wirklich gibt');
// ---------------------------------------------------------------------
{
  const karte = makeChain(['div.world-card']);
  const rect = { left: 400, top: 200, width: 200, height: 120 };
  karte.closest('.world-card').rect = rect;

  hover(karte, rect.left + 40, rect.top + 20);   // Zeiger zur linken oberen Ecke
  const t = tx(karte.closest('.world-card'));
  ok(t !== null, 'Welt-Karte bewegt sich beim Ueberfahren',
     'Inline-transform war: ' + JSON.stringify(karte.closest('.world-card').style.transform));
  ok(t && Math.abs(t.x) <= 5 && Math.abs(t.y) <= 5,
     'Welt-Karte bleibt innerhalb der 5px-Grenze',
     t ? JSON.stringify(t) : 'kein transform');
}
{
  const ziel = makeChain(['div.srv-row']);
  const k = ziel.closest('.srv-row');
  k.rect = { left: 0, top: 0, width: 900, height: 56 };
  hover(ziel, 20, 5);
  ok(tx(k) !== null, 'Server-Zeile bewegt sich (breit, trotzdem begrenzt)');
}
{
  const ziel = makeChain(['div.stat-tile']);
  const k = ziel.closest('.stat-tile');
  k.rect = { left: 0, top: 0, width: 120, height: 80 };
  hover(ziel, 110, 70);
  ok(tx(k) !== null, 'Stat-Kachel bewegt sich');
}
// Die zwei grossen Karten, die es vorher gar nicht gab. Ohne eigene
// Bewegung im Inneren duerfen sie mitlaufen.
for (const [name, sel] of [['Hero-Karte', '.hero'], ['Profilkarte', '.profile-card']]) {
  const ziel = makeChain(['div' + sel]);
  const k = ziel.closest(sel);
  k.rect = { left: 0, top: 0, width: 600, height: 200 };
  hover(ziel, 580, 190);
  ok(tx(k) !== null, name + ' bewegt sich beim Ueberfahren',
     'Inline-transform war: ' + JSON.stringify(k.style.transform));
}

// ---------------------------------------------------------------------
group('2. Der Weg ist begrenzt - kein Springen ans andere Ende');
// ---------------------------------------------------------------------
{
  const k = make('div.world-card');
  k.rect = { left: 0, top: 0, width: 100, height: 40 };
  fire('mouseover', k, null);
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: 9999, clientY: 9999 });
  }
  const t = tx(k);
  ok(t && t.x === 5 && t.y === 5, 'Extrem weit rechts unten = exakt 5px, nicht mehr',
     t ? JSON.stringify(t) : 'kein transform');
}
{
  const k = make('div.world-card');
  k.rect = { left: 0, top: 0, width: 100, height: 40 };
  fire('mouseover', k, null);
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: -9999, clientY: -9999 });
  }
  const t = tx(k);
  ok(t && t.x === -5 && t.y === -5, 'Extrem weit links oben = exakt -5px',
     t ? JSON.stringify(t) : 'kein transform');
}
{
  // Genau in der Mitte -> kein Versatz. Sonst haette die Karte schon beim
  // blossen Beruehren einen Sprung.
  const k = make('div.world-card');
  k.rect = { left: 100, top: 100, width: 200, height: 60 };
  fire('mouseover', k, null);
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: 200, clientY: 130 });
  }
  const t = tx(k);
  ok(t && t.x === 0 && t.y === 0, 'Mittig = kein Versatz (kein Sprung beim Beruehren)',
     t ? JSON.stringify(t) : 'kein transform');
}

// ---------------------------------------------------------------------
group('3. Der Bezugspunkt bleibt stehen (kein Flackern)');
// ---------------------------------------------------------------------
{
  // Kern des Problems: wenn der Mittelpunkt bei jedem mousemove neu aus
  // getBoundingClientRect() gelesen wird, wandert das Element seinen eigenen
  // Referenzpunkt mit und kann in ein Hin-und-Her-Schwingen geraten.
  const k = make('div.srv-row');
  k.rect = { left: 0, top: 0, width: 900, height: 56 };
  fire('mouseover', k, null);

  // Das Element "rutscht" jetzt tatsaechlich - so spiegelt ein echter Browser
  // die eigene Position zurueck, sobald ein transform gesetzt ist. Ein echter
  // Browser liefert ab hier also veraenderte Werte an getBoundingClientRect.
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: 700, clientY: 4 });
  }
  const erster = tx(k);
  // Jetzt meldet der Browser die verschobene Position zurueck:
  k.rect = { left: 4, top: -1, width: 900, height: 56 };
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: 700, clientY: 4 });
  }
  const zweiter = tx(k);
  ok(erster && zweiter && erster.x === zweiter.x && erster.y === zweiter.y,
     'Gleiche Zeigerposition = gleicher Versatz, trotz verschobener Elementposition',
     JSON.stringify(erster) + ' -> ' + JSON.stringify(zweiter));
}

// ---------------------------------------------------------------------
group('4. Stufe 1 gewinnt, wenn ein Button in der Karte steckt');
// ---------------------------------------------------------------------
{
  const karte = make('div.world-card');
  karte.rect = { left: 0, top: 0, width: 300, height: 100 };
  const btn = new ShimElement({ tag: 'button', className: 'mod-action' });
  btn.rect = { left: 10, top: 10, width: 60, height: 30 };
  btn.parent = karte;
  karte.children.push(btn);

  fire('mouseover', btn, null);
  for (const fn of listeners.mousemove) {
    fn({ target: btn, relatedTarget: null, clientX: 40, clientY: 25 });
  }
  ok(karte.style.transform === undefined || karte.style.transform === '',
     'Karte bleibt still, wenn der Zeiger auf einem Button darin ist',
     'Karte hatte: ' + karte.style.transform);
  ok(btn.style.transform !== undefined && btn.style.transform !== '',
     'Der Button selbst bewegt sich (Stufe 1 unberuehrt)');
}

// ---------------------------------------------------------------------
group('5. Zuruecksetzen und Aufraeumen');
// ---------------------------------------------------------------------
{
  const k = make('div.world-card');
  k.rect = { left: 0, top: 0, width: 100, height: 40 };
  fire('mouseover', k, null);
  for (const fn of listeners.mousemove) {
    fn({ target: k, relatedTarget: null, clientX: 90, clientY: 5 });
  }
  ok(tx(k) !== null, 'vor dem Verlassen: versetzt');

  unhover(k);
  ok(k.style.transform === '', 'nach mouseout: transform geleert',
     'war: ' + JSON.stringify(k.style.transform));
  ok(/cubic-bezier/.test(k.style.transition || ''),
     'nach mouseout: Feder-Transition gesetzt',
     'war: ' + JSON.stringify(k.style.transition));
}
{
  // Wechsel auf ein Kind-Element darf nicht zuruecksetzen. Sonst zittert
  // jede Zeile, sobald man ueber eine Schaltflaeche darin faehrt.
  const karte = make('div.world-card');
  karte.rect = { left: 0, top: 0, width: 200, height: 60 };
  const kind = new ShimElement({ tag: 'div', className: 'world-info' });
  kind.parent = karte;
  karte.children.push(kind);

  fire('mouseover', karte, null);
  for (const fn of listeners.mousemove) {
    fn({ target: karte, relatedTarget: null, clientX: 190, clientY: 5 });
  }
  const vorher = tx(karte);
  unhover(karte, kind);
  ok(vorher !== null && tx(karte) !== null,
     'Wechsel auf ein Kind setzt nicht zurueck',
     'vorher ' + JSON.stringify(vorher) + ', nachher ' + JSON.stringify(tx(karte)));
}

// ---------------------------------------------------------------------
group('6. Bewusst ausgeschlossen');
// ---------------------------------------------------------------------
// Wichtig: "Karte sichtbar reagiert" und "Karte bewegt sich" sind zwei
// verschiedene Fragen. Die Stat- und die Schnellzugriff-Karte reagieren
// sichtbar (Rahmen, Flaeche) - ueber die :hover-Regeln im CSS. Bewegen
// duerfen sie sich trotzdem nicht: in der Stat-Karte sitzen die
// Widget-Kacheln, die selbst wandern, und die Schnellzugriff-Karte
// traegt vier Knoepfe aus Stufe 1. Beide wuerden sonst zweimal
// gleichzeitig nachlaufen.
{
  for (const [name, sel] of [
    ['Stat-Karte (Container)', 'div.stat-card'],
    ['Schnellzugriff-Karte', 'div.shortcut-card'],
    ['Einstellungskarte', 'div.settings-karte'],
    ['Glasflaeche (allgemein)', 'div.glass'],
    ['Welt-Editor-Karte', 'div.we-card'],
    ['Startoptionen-Karte', 'div.opts-card'],
  ]) {
    const k = make(sel);
    k.rect = { left: 0, top: 0, width: 400, height: 60 };
    fire('mouseover', k, null);
    for (const fn of listeners.mousemove) {
      fn({ target: k, relatedTarget: null, clientX: 380, clientY: 5 });
    }
    ok(k.style.transform === undefined || k.style.transform === '',
       name + ' bewegt sich NICHT (traegt bewegliche Teile oder steht in den Einstellungen)',
       'hat: ' + k.style.transform);
  }
}

// ---------------------------------------------------------------------
group('7. "Weniger Bewegung" wird respektiert - beide Quellen, beide Stufen');
// ---------------------------------------------------------------------
// Zwei unabhaengige Quellen, die beide nur abschalten duerfen:
//   - die Windows-Einstellung (prefers-reduced-motion)
//   - der eigene Schalter in den Einstellungen
// Frueher hat nur Stufe 2 auf die Windows-Einstellung geachtet; Stufe 1 lief
// weiter und sprang statt zu gleiten, weil die @media-Regel im CSS nur die
// Transition nahm, nicht das Nachfuehren.
{
  function bewegeStufe2() {
    const k = make('div.world-card');
    k.rect = { left: 0, top: 0, width: 100, height: 40 };
    hover(k, 90, 5);
    return tx(k) !== null;
  }
  function bewegeStufe1() {
    const b = make('button');
    b.rect = { left: 0, top: 0, width: 100, height: 40 };
    hover(b, 90, 5);
    return b.style.transform !== undefined && b.style.transform !== '';
  }

  reduceMotion = true;
  ok(!bewegeStufe2(), 'Windows-Einstellung: Karten bleiben still');
  ok(!bewegeStufe1(), 'Windows-Einstellung: Knöpfe bleiben ebenfalls still');
  reduceMotion = false;

  ok(bewegeStufe2() && bewegeStufe1(),
     'Ohne Einstellung: beide Stufen laufen wieder');

  schalterAn(true);
  ok(!bewegeStufe2(), 'Eigener Schalter: Karten bleiben still');
  ok(!bewegeStufe1(), 'Eigener Schalter: Knöpfe bleiben ebenfalls still');
  schalterAn(false);
  ok(bewegeStufe2() && bewegeStufe1(), 'Schalter aus: beide Stufen laufen wieder');

  // Der Schalter darf die Windows-Einstellung nicht aufheben. Wer in Windows
  // "Animationen reduzieren" gesetzt hat, will das auch hier.
  reduceMotion = true;
  schalterAn(false);
  ok(!bewegeStufe2() && !bewegeStufe1(),
     'Schalter AUS hebt die Windows-Einstellung NICHT auf (nur abschalten, nicht einschalten)');
  reduceMotion = false;
}

// ---------------------------------------------------------------------
console.log('\n=====================================================');
if (problems.length === 0) {
  console.log('ALLE ' + checks + ' PRUEFUNGEN BESTANDEN');
} else {
  console.log(problems.length + ' von ' + checks + ' PRUEFUNGEN FEHLGESCHLAGEN:');
  problems.forEach(p => console.log('  - ' + p));
  process.exitCode = 1;
}
