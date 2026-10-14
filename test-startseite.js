// test-startseite.js  (laeuft unter reinem Node: node test-startseite.js)
//
// Zwei Zusagen, die leicht wieder verlorengehen:
//
//   1. Der Skin-Kopf wird an drei Stellen gezeigt (Seitenleiste, Profilkarte,
//      Kontoliste) und aus der Skin-Textur selbst gebaut - Vorderseite [8,8],
//      Hut-Ebene [40,8]. Kein fremder Dienst wie crafatar.
//   2. Beim ersten Start erscheint eine Startseite, die durch Sprache, Konto
//      und erste Instanz fuehrt. Sie merkt sich ihren Abschluss in
//      settings.json (onboardingDone) und laesst sich erneut oeffnen.
//
// Geprueft wird der Quelltext - so wie bei test-skin-ganzkoerper.js. Das
// reicht: ob eine Zeile da ist, ist genau die Frage. Ob sie zur Laufzeit
// wirkt, pruefen die Fenster-Tests.
const fs = require('node:fs'), path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'index.html'), 'utf-8');
let n = 0, bad = 0;
const ok = (c, t) => { n++; if (!c) { bad++; console.log('  FEHLT', t); } };

const schnitt = (muster) => (HTML.match(muster) || [''])[0];

// ---------------------------------------------------------------------
console.log('--- Skin-Kopf an drei Stellen ---');
// ---------------------------------------------------------------------
ok(/\.skin-kopf\{/.test(HTML), 'CSS fuer den Skin-Kopf ist vorhanden');
ok(/image-rendering:pixelated/.test(schnitt(/\.skin-kopf\{[\s\S]*?\}/)),
   'der Kopf wird pixelgenau gezeichnet (image-rendering:pixelated)');
ok(/function skinKopfStil\(/.test(HTML) && /function skinKopfElement\(/.test(HTML),
   'Kopf wird aus der Textur gebaut (skinKopfStil/skinKopfElement)');
ok(/el\.style\.cssText = skinKopfStil\(/.test(HTML),
   'der Kopf wird als Element gestaltet (kein style="-Attribut, das an url(" scheitert)');
ok(/-8 \* q/.test(HTML) && /-40 \* q/.test(HTML),
   'Vorderseite [8,8] und Hut-Ebene [40,8] der 64x64-Vorlage');
ok(/const KOPF_NEUTRAL = '<svg/.test(HTML), 'neutrales Personen-Symbol als Rueckfall');

// Die drei Stellen.
ok(/kopfFeldSetzen\(avatarFeld, url, 42\)/.test(HTML), 'Kopf in der Seitenleiste');
ok(/kopfFeldSetzen\(document\.getElementById\('profilKopf'\), url, 48\)/.test(HTML),
   'Kopf in der Profilkarte');
ok(/skinKopfElement\(acc\.skinUrl, 34\)/.test(HTML), 'Kopf in der Kontoliste');
ok(/<div class="profil-kopf" id="profilKopf">/.test(HTML),
   'die Profilkarte bringt das Kopffeld mit');
ok(/function updateSkinKoepfe\(/.test(HTML) && /updateSkinKoepfe\(\);/.test(HTML),
   'die Koepfe werden nach Konto-/Skin-Wechsel aktualisiert');
// Nach dem eigenen Skin und nach dem Entfernen mitgezogen.
ok((HTML.match(/updateSkinKoepfe\(\);/g) || []).length >= 3,
   'Aktualisierung nach Laden, Hochladen und Entfernen');

// Kein fremder Dienst im Renderer: der Kopf kommt aus der Textur selbst.
// (Der Name darf in einem Kommentar vorkommen - geprueft wird die Adresse.)
ok(!/crafatar\.(com|io|net)/i.test(HTML) && !/avatarUrl/.test(HTML),
   'kein fremder Kopf-Dienst im Renderer (nur die ohnehin geladene Textur)');

// ---------------------------------------------------------------------
console.log('--- Startseite (erste Einrichtung) ---');
// ---------------------------------------------------------------------
const ob = schnitt(/<div class="ob-overlay" id="onboarding"[\s\S]*?\n  <\/div>\n/);
ok(ob.length > 0, 'die Startseite ist als Overlay vorhanden');
ok(ob.includes('id="obLangRow"'), 'Schritt Sprache: Sprachauswahl');
ok(ob.includes('id="obClientId"') && ob.includes('id="obLoginBtn"'),
   'Schritt Konto: Client-ID und Microsoft-Anmeldung');
ok(ob.includes('id="obInstVersion"') && ob.includes('id="obInstLoader"') && ob.includes('id="obInstCreate"'),
   'Schritt Instanz: Version, Modloader, Anlegen');
ok(ob.includes('id="obWeiter"') && ob.includes('id="obZurueck"') && ob.includes('id="obSkip"'),
   'Weiter, Zurueck und Ueberspringen sind da');
for (const seite of ['sprache', 'konto', 'instanz', 'fertig']) {
  ok(new RegExp('data-ob-page="' + seite + '"').test(ob), 'Seite ' + seite + ' vorhanden');
}
// Die Texte kommen ueber t() (obTexteAnwenden) - nicht als data-i18n. Sonst
// verlangte test-einstellungen denselben Schluessel in allen neun Sprachen.
ok(!/data-i18n/.test(ob), 'Startseiten-Texte laufen nicht ueber data-i18n');

ok(/const OB_REIHENFOLGE = \['sprache', 'konto', 'instanz', 'fertig'\]/.test(HTML),
   'feste Reihenfolge der Schritte');
ok(/obErneutBtn/.test(HTML) && /function obOeffnen\(/.test(HTML),
   'die Startseite laesst sich erneut oeffnen');
ok(/obPruefen\(s\)/.test(HTML) || /obPruefen\(settings\)/.test(HTML),
   'beim Start wird auf den ersten Start geprueft');
ok(/settings\.onboardingDone !== true/.test(HTML),
   'nur ohne onboardingDone erscheint die Startseite');
ok(/settings\.set\(\{ onboardingDone: true \}\)/.test(HTML),
   'der Abschluss wird in settings.json gemerkt');
ok(/function obInstanzZeigen\(/.test(HTML) && /versionenLaden\(\)/.test(HTML),
   'die Versionen kommen aus dem echten Manifest');
ok(/window\.launcher\.instances\.create\(/.test(HTML),
   'die erste Instanz wird ueber den echten IPC-Kanal angelegt');

// ---------------------------------------------------------------------
console.log('--- Texte in allen neun Sprachen ---');
// ---------------------------------------------------------------------
const texte = schnitt(/const OB_TEXTE = \{[\s\S]*?\n  \};/);
ok(texte.length > 0, 'OB_TEXTE ist vorhanden');
for (const sprache of ['de', 'en', 'es', 'fr', 'pt', 'it', 'pl', 'tr', 'ru']) {
  ok(new RegExp('\\n    ' + sprache + ': \\{').test(texte), 'Sprache ' + sprache + ' in OB_TEXTE');
}
for (const schluessel of ['ob_title', 'ob_subtitle', 'ob_reopen', 'ob_done_summary', 'ob_app_only']) {
  ok(texte.includes(schluessel + ':'), 'Schluessel ' + schluessel + ' vorhanden');
}
// Die Rueckmeldung beim Anlegen liegt im kleinen Zusatzblock - ebenfalls
// fuer alle Sprachen.
const zusatz = schnitt(/const OB_TEXTE_2 = \{[\s\S]*?\n  \};/);
for (const sprache of ['de', 'en', 'es', 'fr', 'pt', 'it', 'pl', 'tr', 'ru']) {
  ok(new RegExp('\\n    ' + sprache + ': \\{').test(zusatz), 'Sprache ' + sprache + ' in OB_TEXTE_2');
}

// ---------------------------------------------------------------------
console.log('');
if (bad === 0) console.log('  OK    ' + n + ' Checks, 0 Fehler');
else console.log('  ' + bad + ' von ' + n + ' Checks fehlgeschlagen');
process.exit(bad === 0 ? 0 : 1);
