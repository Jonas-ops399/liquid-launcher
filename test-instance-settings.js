/**
 * Tests fuer die Startoptionen pro Instanz (RAM + Aufloesung).
 *
 * Ohne Electron, ohne Fenster, ohne Java. Der interessanteste Teil ist
 * nicht "funktioniert 4 GB", sondern: welche Zahlen werden abgewiesen —
 * und vor allem, welche *durchgelassen* werden duerfen. Beides landet
 * ungeprueft als `-Xmx…` bzw. `--width …` in der Befehlszeile eines
 * Prozesses, und die Fehlermeldung des JVM sagt dem Benutzer nichts ueber
 * die Ursache.
 *
 *   node test-instance-settings.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('./src/main/instance-settings');

let pruefungen = 0;
let fehler = 0;

function pruefe(bedingung, beschreibung) {
  pruefungen++;
  if (!bedingung) {
    fehler++;
    console.log('  FEHLT  ' + beschreibung);
  }
}

function gleich(ist, soll, beschreibung) {
  // Zwei Zahlen und zwei Objekte sind nie ===. Deshalb der Vergleich ueber
  // den Inhalt — derselbe Fehler wie in test-server-ping.js.
  const a = JSON.stringify(ist);
  const b = JSON.stringify(soll);
  pruefe(a === b, `${beschreibung} (erwartet ${b}, bekam ${a})`);
}

function wirft(funktion, beschreibung, muster) {
  pruefungen++;
  try {
    const r = funktion();
    fehler++;
    console.log(`  FEHLT  ${beschreibung} — hat nicht geworfen, sondern ${JSON.stringify(r)} geliefert`);
  } catch (err) {
    if (muster && !new RegExp(muster, 'i').test(err.message)) {
      fehler++;
      console.log(`  FEHLT  ${beschreibung} — Meldung passt nicht: ${err.message}`);
    }
  }
}

function wirftNicht(funktion, beschreibung) {
  pruefungen++;
  try {
    return funktion();
  } catch (err) {
    fehler++;
    console.log(`  FEHLT  ${beschreibung} — hat geworfen: ${err.message}`);
    return null;
  }
}

function abschnitt(titel) {
  console.log('\n' + titel);
  console.log('-'.repeat(titel.length));
}

// ---------------------------------------------------------------- toNumber

abschnitt('Zahlen aus Textfeldern');

gleich(S.toNumber('4'), 4, 'String "4" wird 4');
gleich(S.toNumber(' 4 '), 4, 'getrimmter String');
gleich(S.toNumber('4 GB'), 4, 'Einheit "GB" wird weggemessen');
gleich(S.toNumber('4g'), 4, 'Einheit "g" wird weggemessen');
gleich(S.toNumber('4 gib'), 4, 'Einheit "GiB" wird weggemessen');
gleich(S.toNumber(2.5), 2.5, 'Zahl bleibt Zahl');
gleich(S.toNumber(0), 0, 'Null bleibt Null');

// Die drei Faelle, bei denen Number() still 0 liefert. Genau deshalb wird
// der leere String VOR der Umwandlung abgefangen: 0 ist eine gueltige Eingabe
// fuer "0 GB", aber ein leeres Feld darf nicht als 0 durchgehen.
for (const wert of ['', '   ', null, undefined, {}, [], true]) {
  pruefe(Number.isNaN(S.toNumber(wert)), `${JSON.stringify(wert)} ist keine Eingabe, sondern NaN`);
}

// Ein deutsches Komma ist die haeufigste Zahleneingabe, die nicht
// funktioniert. Wichtig ist, dass es ABGEWIESEN wird und nicht still als
// "4" gelesen wird — 4,5 als "4" zu lesen waere stiller Datenverlust.
pruefe(Number.isNaN(S.toNumber('4,5')), 'deutsches Komma wird nicht als 4,5 gelesen');
pruefe(Number.isNaN(S.toNumber('2 GB RAM')), 'Freitext wird nicht als Zahl gelesen');
pruefe(Number.isNaN(S.toNumber('0x10')), 'Hexadezimal wird nicht gelesen');
pruefe(Number.isNaN(S.toNumber('Infinity')), 'Infinity als String wird abgewiesen');
pruefe(Number.isNaN(S.toNumber(Infinity)), 'Infinity als Zahl wird abgewiesen');
pruefe(Number.isNaN(S.toNumber(NaN)), 'NaN bleibt NaN');

// ------------------------------------------------------------ RAM-Grenzen

abschnitt('RAM-Grenzen');

pruefe(S.isValidRam(1), '1 GB ist gueltig');
pruefe(S.isValidRam(1.5), '1,5 GB ist gueltig (halbe GB-Schritte)');
pruefe(S.isValidRam(4), '4 GB ist gueltig');
pruefe(S.isValidRam(64), '64 GB ist gueltig (Obergrenze)');

pruefe(!S.isValidRam(0.5), '0,5 GB ist zu wenig');
pruefe(!S.isValidRam(0), '0 GB ist ungueltig');
pruefe(!S.isValidRam(-2), 'negativer RAM ist ungueltig');
pruefe(!S.isValidRam(65), '65 GB ist ueber der Obergrenze');
pruefe(!S.isValidRam(640), '640 GB ist ein Tippfehler, kein Wunsch');
// Der Grund fuer die Halb-Schritte: 2,7 GB akzeptiert das JVM, meint aber
// kein Mensch. Wer es eintippt, hat sich verrechnet.
pruefe(!S.isValidRam(2.7), '2,7 GB sind kein halber Schritt');
pruefe(!S.isValidRam(0.25), '0,25 GB sind kein halber Schritt');
pruefe(!S.isValidRam('4'), 'reiner String ist fuer die Pruefung keine Zahl (wird vorher umgewandelt)');
pruefe(!S.isValidRam(NaN), 'NaN ist ungueltig');

// --------------------------------------------------------- Aufloesung

abschnitt('Aufloesungs-Grenzen');

pruefe(S.isValidResolution(1280, 720), '1280x720 ist gueltig');
pruefe(S.isValidResolution(640, 480), 'die Untergrenze ist gueltig');
pruefe(S.isValidResolution(7680, 4320), '8K ist gueltig');
pruefe(S.isValidResolution(3440, 1440), 'Ultrawide ist gueltig');
// Querformat ist erlaubt, Hochformat auch — ein Modding-Paket oder ein
// Beamer kann alles. Es gibt hier KEINE Ratio-Pruefung, und genau so soll es
// bleiben: eine erfundene Regel, die gueltige Aufloesungen ablehnt, waere
// schlimmer als keine Regel.
pruefe(S.isValidResolution(1080, 1920), 'Hochformat wird nicht grundsatzlich abgewiesen');

pruefe(!S.isValidResolution(639, 720), '639 px Breite ist zu schmal');
pruefe(!S.isValidResolution(1280, 479), '479 px Hoehe ist zu klein');
pruefe(!S.isValidResolution(7681, 720), '7681 px ist zu breit');
pruefe(!S.isValidResolution(1280.5, 720), 'halbe Pixel sind keine');
pruefe(!S.isValidResolution(1280, NaN), 'NaN ist ungueltig');
pruefe(!S.isValidResolution(NaN, NaN), 'beide NaN ist ungueltig');
// Querformat ist erlaubt, Hochformat auch — ein Modding-Paket oder ein
//投影仪 kann alles. Es gibt hier KEINE Ratio-Pruefung, und genau so soll es
// bleiben: eine erfundene Regel, die gueltige Aufloesungen ablehnt, waere
// schlimmer als keine Regel.

// ------------------------------------------------------ min > max

abschnitt('Mindest-RAM groesser als Maximum');

// Das ist der eine Fehler, der das Spiel gar nicht erst starten laesst:
// "Initial heap size set to a larger value than the maximum heap size".
// Ohne diese Pruefung sieht der Benutzer nur ein Fenster, das sofort
// wieder zugeht.
wirft(
  () => S.validateSettings({ ramMinGb: 4, ramMaxGb: 2 }),
  'min 4 / max 2 wird abgewiesen',
  'darf nicht groesser'
);
wirwtTest:
{
  // Gegenprobe: min gleich max ist erlaubt. Ein RAM-Wert, der nie wachsen
  // darf, waere eine eingebaute Sackgasse.
  const gleichRam = wirftNicht(
    () => S.validateSettings({ ramMinGb: 2, ramMaxGb: 2 }),
    'min gleich max ist gueltig'
  );
  gleich(gleichRam && gleichRam.settings, { ramMinGb: 2, ramMaxGb: 2, width: 1280, height: 720 },
    'min gleich max ergibt genau diese Einstellungen');
}

// ------------------------------------------------------ Fehlermeldungen

abschnitt('Verstaendliche Fehlermeldungen');

const faelle = [
  [{ ramMinGb: 0.5 }, /mindestens 1 GB/i, 'zu wenig RAM nennt die Untergrenze'],
  [{ ramMaxGb: 500 }, /zwischen 1 und 64/i, 'zu viel RAM nennt beide Grenzen'],
  [{ ramMaxGb: 'abc' }, /keine Zahl/i, 'Buchstaben werden als keine Zahl erkannt'],
  [{ ramMinGb: '' }, /keine Zahl/i, 'leeres Feld wird nicht als 0 gelesen'],
  [{ width: 0 }, /Breite/i, 'Breite 0 wird abgewiesen'],
  [{ height: 10000 }, /Hoehe/i, 'Hoehe 10000 wird abgewiesen'],
  [{ width: 1920.5 }, /ganze Zahl/i, 'halbe Pixel werden erkannt']
];
for (const [teil, muster, was] of faelle) {
  pruefungen++;
  try {
    S.validateSettings({ ...S.DEFAULTS, ...teil });
    fehler++;
    console.log(`  FEHLT  ${was} — wurde akzeptiert`);
  } catch (err) {
    if (!muster.test(err.message)) {
      fehler++;
      console.log(`  FEHLT  ${was} — Meldung passt nicht: ${err.message}`);
    }
  }
}

// Meherere Fehler auf einmal: der Benutzer hat zwei Felder falsch und will
// beide sehen, nicht viermal korrigieren.
pruefungen++;
try {
  S.validateSettings({ ramMinGb: 0, ramMaxGb: 999, width: 1, height: 99999 });
  fehler++;
  console.log('  FEHLT  vier falsche Felder wurden akzeptiert');
} catch (err) {
  const anzahl = err.felder ? err.felder.length : 0;
  pruefe(anzahl === 4, `vier falsche Felder ergeben vier Meldungen (bekam ${anzahl}: ${err.message})`);
}

// ------------------------------------------------- Einschleus-Versuche

abschnitt('Versuche, etwas anderes als eine Zahl einzuschleusen');

// Hier zaehlt nur EINE Eigenschaft: abgewiesen. Die genaue Formulierung der
// Meldung ist weiter oben geprueft — an dieser Stelle wuerde ein zweites
// Muster nur den Test laenger machen, ohne etwas zu sichern.
const angriffe = [
  '4G -Dfoo=bar',
  '-Xmx8G',
  '4; calc.exe',
  '4\n-XX:+UseCrapShell',
  '${env:PATH}',
  '99999999999999999999',
  '0x10',
  'Infinity',
  '1e3',
  '4,5',
  '',
  '   ',
  'null',
  { toString: () => '4' }
];
for (const wert of angriffe) {
  const beschriftung = typeof wert === 'string' ? JSON.stringify(wert) : Object.prototype.toString.call(wert);
  wirft(
    () => S.validateSettings({ ...S.DEFAULTS, ramMaxGb: wert }),
    `ramMaxGb = ${beschriftung} wird abgewiesen`
  );
  wirft(
    () => S.validateSettings({ ...S.DEFAULTS, width: wert }),
    `width = ${beschriftung} wird abgewiesen`
  );
}

// Und die Gegenprobe: was tatsaechlich durchkommt, ist eine Zahl. Aus 4 wird
// spaeter der String "4G" — und dort kann nichts mehr hinein.
const durchgelassen = wirftNicht(
  () => S.validateSettings({ ...S.DEFAULTS, ramMaxGb: 4 }),
  'die Zahl 4 kommt durch'
);
gleich(durchgelassen && durchgelassen.settings.ramMaxGb, 4, 'und bleibt die Zahl 4');
const args = S.toLaunchInputs(durchgelassen.settings);
gleich(args.memory, { min: '1G', max: '4G' }, 'daraus werden exakt die JVM-Argumente');
// Was im Argument steht, muss eine reine Zahl mit Einheit sein. Alles
// andere — ein Leerzeichen, ein Semikolon, ein weiteres Flag — wuerde
// process.js unveraendert in den argv schreiben.
pruefe(/^[\d.]+G$/.test(args.memory.max), `"${args.memory.max}" ist ausser Ziffern, Punkt und G nichts`);
pruefe(/^[\d.]+G$/.test(args.memory.min), `"${args.memory.min}" ist ebenfalls sauber`);
pruefe(/^-Xmx[\d.]+G$/.test('-Xmx' + args.memory.max), 'das fuehrt zu einem gueltigen -Xmx');

// --------------------------------------------- toLaunchInputs im Detail

abschnitt('Was davon im Start ankommt');

const launch = S.toLaunchInputs({ ramMinGb: 1.5, ramMaxGb: 4, width: 1920, height: 1080 });
gleich(launch.resolution, { width: 1920, height: 1080 }, 'Aufloesung durchgereicht');
gleich(launch.memory, { min: '1.5G', max: '4G' }, 'RAM durchgereicht, halbe GB mit Dezimalpunkt');

// 1.5 muss "1.5G" sein und nicht "1,5G". Ein Komma wuerde von der JVM als
// Argument-Trenner gelesen und der Start brechen mit einer Meldung, die nach
// Argumentfehler aussieht, obwohl die Zahl richtig eingegeben wurde.
pruefe(!launch.memory.min.includes(','), 'kein Dezimalkomma im JVM-Argument');

const klein = S.toLaunchInputs({ ramMinGb: 1, ramMaxGb: 1, width: 640, height: 480 });
gleich(klein.memory, { min: '1G', max: '1G' }, 'Untergrenze 1 GB');
gleich(klein.resolution, { width: 640, height: 480 }, 'Untergrenze 640x480');

// -------------------------------------------------------- Empfehlung

abschnitt('Empfehlung nach Rechenleistung');

gleich(S.recommendedRamGb(4), 2, '4 GB-Rechner: 2 GB');
gleich(S.recommendedRamGb(8), 3, '8 GB-Rechner: 3 GB');
gleich(S.recommendedRamGb(16), 4, '16 GB-Rechner: 4 GB');
gleich(S.recommendedRamGb(32), 4, '32 GB-Rechner: 4 GB (nicht mehr — Lueckenzuschlag)');
gleich(S.recommendedRamGb(64), 4, '64 GB-Rechner: 4 GB');
gleich(S.recommendedRamGb(2), 2, '2 GB-Rechner: 2 GB, mehr ginge nicht');

// ----------------------------------------------------------- Warnungen

abschnitt('Warnungen blockieren nichts');

const zuviel = wirftNicht(
  () => S.validateSettings({ ...S.DEFAULTS, ramMinGb: 2, ramMaxGb: 16 }, 8),
  '16 GB auf einem 8-GB-Rechner ist erlaubt'
);
gleich(zuviel && zuviel.settings.ramMaxGb, 16, 'der Wert bleibt, wie eingegeben');
pruefe(zuviel && zuviel.warnungen.length > 0, 'aber es gibt eine Warnung');
pruefe(zuviel && /Swap/i.test(zuviel.warnungen.join(' ')), 'die Warnung erklaert den Swap');

const passt = wirftNicht(
  () => S.validateSettings({ ...S.DEFAULTS, ramMinGb: 1, ramMaxGb: 4 }, 16),
  '4 GB auf einem 16-GB-Rechner ist unauffaellig'
);
gleich(passt && passt.warnungen, [], 'und warnt nicht');

// -Xms wird beim Start sofort reserviert, -Xmx nur bei Bedarf. Ein hohes
// -Xms ist daher echter Speicherverbrauch von Anfang an und kein blosser
// Deckel. Die Grenze liegt bei der Haelfte des physikalischen Speichers:
// wer mehr als die Haelfte dauerhaft belegt, laesst dem System zu wenig.
const hohesXms = wirftNicht(
  () => S.validateSettings({ ...S.DEFAULTS, ramMinGb: 12, ramMaxGb: 12 }, 16),
  'min=max=12 auf einem 16-GB-Rechner ist erlaubt'
);
pruefe(hohesXms && /sofort/i.test(hohesXms.warnungen.join(' ')),
  'ein -Xms ueber der Haelfte wird als sofortiger Speicherverbrauch genannt');
gleich(hohesXms && hohesXms.settings.ramMinGb, 12, 'der Wert bleibt trotzdem, wie eingegeben');

// Die Grenze sitzt genau in der Mitte: 8 von 16 warnt noch nicht.
const knappDrunter = wirftNicht(
  () => S.validateSettings({ ...S.DEFAULTS, ramMinGb: 8, ramMaxGb: 8 }, 16),
  'min=max=8 auf einem 16-GB-Rechner ist erlaubt'
);
gleich(knappDrunter && knappDrunter.warnungen, [], 'die Haelfte selbst warnt noch nicht');

// --------------------------------------------------------- Datei

abschnitt('Speichern und Laden');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-instset-'));
try {
  // ---- guter Fall
  const gut = S.validateSettings({ ramMinGb: 1, ramMaxGb: 4, width: 2560, height: 1440 }).settings;
  S.saveSettings(tmp, gut);
  const datei = path.join(tmp, 'instance-settings.json');
  pruefe(fs.existsSync(datei), 'die Datei wurde angelegt');
  const roh = JSON.parse(fs.readFileSync(datei, 'utf-8'));
  gleich(roh, gut, 'und enthaelt genau die Einstellungen');
  // Keine Hilfsfelder auf der Platte.
  gleich(Object.keys(roh).sort(), ['height', 'ramMaxGb', 'ramMinGb', 'width'], 'nur die vier Felder');
  pruefe(!fs.existsSync(`${datei}.tmp`), 'die Temp-Datei wurde umbenannt, nicht liegen gelassen');
  gleich(S.loadSettings(tmp), gut, 'Round-Trip liefert dieselben Werte');

  // ---- Einstellungen, die man auch wirklich speichern kann
  const neu = S.validateSettings({ ramMinGb: '2', ramMaxGb: '6 GB', width: ' 1920 ', height: 1080 }).settings;
  gleich(neu, { ramMinGb: 2, ramMaxGb: 6, width: 1920, height: 1080 }, 'Textfelder werden beim Speichern zu Zahlen');
  S.saveSettings(tmp, neu);
  gleich(S.loadSettings(tmp), neu, 'und kommen als Zahlen wieder');

  // ---- fehlende Datei
  const leer = fs.mkdtempSync(path.join(os.tmpdir(), 'll-instset-leer-'));
  try {
    const standard = S.loadSettings(leer);
    gleich(standard.ramMinGb, 1, 'ohne Datei: 1 GB Minimum');
    gleich(standard.ramMaxGb, 2, 'ohne Datei: 2 GB Maximum');
    gleich(standard.width, 1280, 'ohne Datei: 1280 px');
    pruefe(!!standard._problem, 'ohne Datei wird ein Problem vermerkt');
  } finally {
    fs.rmSync(leer, { recursive: true, force: true });
  }

  // ---- kaputte Dateien. Der Grundsatz: ein Start darf nie an einer
  // Einstellungsdatei scheitern, also faellt alles auf die Standardwerte
  // zurueck und wird als kaputt vermerkt.
  const kaputte = [
    ['{ kein json', 'unsinniger Text'],
    ['', 'leere Datei'],
    ['[]', 'JSON-Array'],
    ['null', 'null'],
    ['"text"', 'JSON-String'],
    ['42', 'JSON-Zahl']
  ];
  for (const [inhalt, was] of kaputte) {
    fs.writeFileSync(datei, inhalt);
    const g = S.loadSettings(tmp);
    gleich(g.ramMaxGb, 2, `${was} faellt auf den Standard zurueck`);
    gleich(g.width, 1280, `${was}: Aufloesung ebenfalls Standard`);
    pruefe(!!g._problem, `${was} wird als kaputt vermerkt`);
  }

  // ---- halbwegs gueltige Datei mit einem kaputten Feld. Der gueltige Teil
  // bleibt erhalten — ein einzelnes falsches Feld darf nicht alle anderen
  // Einstellungen zuruecksetzen.
  const felder = [
    [{ ramMinGb: 2, ramMaxGb: 4, width: 1920, height: 'kaputt' }, 'height: 4 GB, 1920 px'],
    [{ ramMinGb: 99999, ramMaxGb: 4, width: 1920, height: 1080 }, 'unmoegliches min'],
    [{ ramMinGb: 1, ramMaxGb: 4, width: 1920, height: 1080 }, 'alles gueltig'],
    [{ ramMinGb: 1, ramMaxGb: 2, width: 0, height: 0 }, 'beide Aufloesungen 0'],
    [{ ramMinGb: '4 GB', ramMaxGb: 6, width: '1920', height: '1080' }, 'alle als Text']
  ];
  for (const [inhalt, was] of felder) {
    fs.writeFileSync(datei, JSON.stringify(inhalt));
    const g = S.loadSettings(tmp);
    if (inhalt.width === 1920 && inhalt.height !== 'kaputt') {
      gleich(g.width, 1920, `${was}: gueltige Breite bleibt erhalten`);
    }
    if (inhalt.height === 1080) {
      gleich(g.height, 1080, `${was}: gueltige Hoehe bleibt erhalten`);
    }
    // Nichts durchgelassen, was die Grenzen verletzt.
    pruefe(S.isValidRam(g.ramMinGb), `${was}: min bleibt im erlaubten Bereich`);
    pruefe(S.isValidRam(g.ramMaxGb), `${was}: max bleibt im erlaubten Bereich`);
    pruefe(g.ramMinGb <= g.ramMaxGb, `${was}: min ist nicht groesser als max`);
  }

  // ---- die wichtige Zeile: eine von Hand manipulierte Datei darf den Start
  // nicht mit 9999 GB wegschicken.
  fs.writeFileSync(datei, JSON.stringify({ ramMinGb: 9999, ramMaxGb: 99999, width: 99999, height: 99999 }));
  const manipuliert = S.loadSettings(tmp);
  gleich(manipuliert.ramMaxGb, 2, 'manipulierte 99999 GB werden verworfen');
  gleich(manipuliert.ramMinGb, 1, 'manipulierte 9999 GB werden verworfen');
  gleich(manipuliert.width, 1280, 'manipulierte 99999 px werden verworfen');
  gleich(manipuliert.height, 720, 'manipulierte 99999 px werden verworfen');

  // ---- min > max in der Datei
  fs.writeFileSync(datei, JSON.stringify({ ramMinGb: 8, ramMaxGb: 4 }));
  const verdreht = S.loadSettings(tmp);
  pruefe(verdreht.ramMinGb <= verdreht.ramMaxGb, 'min > max in der Datei wird geradegezogen');
  gleich(verdreht.ramMaxGb, 4, 'dabei bleibt max erhalten');

  // ---- Negative Werte
  fs.writeFileSync(datei, JSON.stringify({ ramMinGb: -8, ramMaxGb: -1, width: -1920, height: -1080 }));
  const negativ = S.loadSettings(tmp);
  gleich(negativ.ramMinGb, 1, 'negativer RAM faellt zurueck');
  gleich(negativ.ramMaxGb, 2, 'negativer RAM faellt zurueck');
  gleich(negativ.width, 1280, 'negative Breite faellt zurueck');

  // ---- Objekt statt Zahl
  fs.writeFileSync(datei, JSON.stringify({ ramMaxGb: { gross: true }, width: [1920, 1080] }));
  const objekt = S.loadSettings(tmp);
  gleich(objekt.ramMaxGb, 2, 'Objekt statt Zahl faellt zurueck');
  gleich(objekt.width, 1280, 'Array statt Zahl faellt zurueck');

  // ---- Prototyp-Vergiftung: __proto__ in einer JSON-Datei darf nichts
  // veraendern. JSON.parse erzeugt __proto__ als normalen eigenen
  // Eintrag; wenn der Code es in ein Objekt mischt, waere das eine
  // Prototype-Pollution.
  fs.writeFileSync(datei, JSON.stringify({ ramMaxGb: 4, __proto__: { vergiftet: true } }));
  const proto = S.loadSettings(tmp);
  gleich(proto.vergiftet, undefined, 'kein __proto__ ueberlebt das Laden');
  gleich({}.vergiftet, undefined, 'Object.prototype ist unberuehrt');
  gleich(proto.ramMaxGb, 4, 'der gueltige Wert daneben wird trotzdem gelesen');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// -------------------------------------------------------- describe()

abschnitt('Was das UI bekommt');

const d = S.describe();
pruefe(typeof d.physicalRamGb === 'number' && d.physicalRamGb > 0, `physischer RAM wird gemeldet: ${d.physicalRamGb} GB`);
pruefe(d.limits.ramMin === 1 && d.limits.ramMax === 64, 'die Grenzen kommen mit');
pruefe(d.limits.resMinW === 640 && d.limits.resMaxW === 7680, 'auch die Aufloesungsgrenzen');
pruefe(d.recommendedRamGb >= 2 && d.recommendedRamGb <= 4, `Empfehlung: ${d.recommendedRamGb} GB`);
pruefe(S.isValidRam(d.settings.ramMaxGb), 'der empfohlene Standard ist selbst ein gueltiger Wert');
pruefe(d.settings.ramMinGb <= d.settings.ramMaxGb, 'und min <= max');

// Die Voreinstellung muss auf jedem Rechner startbar sein. Sonst liefert
// der Standard auf einem 4-GB-Notebook einen Wert, den validateSettings
// zurueckweisen wuerde — und die Oberflaeche waere die Ursache fuer einen
// Startabbruch.
const startbar = S.validateSettings({ ...d.settings }, d.physicalRamGb);
gleich(startbar.settings, d.settings, 'die Voreinstellung besteht die eigene Pruefung');

// ------------------------------------------------------ JSON-Tauglichkeit

abschnitt('IPC-Tauglichkeit');

const durch = S.validateSettings({ ...S.DEFAULTS, ramMaxGb: 4 });
const json = JSON.stringify(durch);
const zurueck = JSON.parse(json);
gleich(zurueck, durch, 'das Ergebnis ueberlebt JSON.stringify/parse');
gleich(Object.keys(zurueck), ['settings', 'warnungen'], 'genau zwei Felder nach aussen');
pruefe(Array.isArray(zurueck.warnungen), 'warnungen ist ein Array');
pruefe(zurueck.warnungen.every(w => typeof w === 'string'), 'jede Warnung ist ein String');

// ---------------------------------------------------------------- Abschluss

console.log('\n' + '='.repeat(70));
if (fehler === 0) {
  console.log(`✅ Alle ${pruefungen} Prüfungen bestanden.`);
  process.exit(0);
} else {
  console.log(`❌ ${fehler} von ${pruefungen} Prüfungen fehlgeschlagen.`);
  process.exit(1);
}
