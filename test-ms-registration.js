/**
 * Prueft die Azure-App-Registrierung, ohne dass sich jemand anmeldet.
 *
 *   node test-ms-registration.js
 *
 * Warum es das gibt: "Login schlaegt fehl" allein sagt nichts. Es kann die
 * Registrierung sein, das Token, der abgelaufene Refresh-Token, das Spiel
 * selbst. Ohne Trennung dieser Faelle ist die Fehlersuche Raten.
 *
 * Der Trick: der Autorisierungs-Endpunkt von Microsoft beantwortet einen
 * unbekannten client_id mit einer Fehlerseite statt mit der Anmeldeseite.
 * Damit laesst sich die Registrierung vorab pruefen — ohne Anmeldung, ohne
 * Token, ohne etwas zu speichern.
 *
 * WICHTIG — und das ist der Grund fuer die eingebaute Kontrollprobe:
 * Die Unterscheidung ist NICHT verlaesslich, wenn man nur auf einen
 * Fehlercode prueft. Ein erster Versuch suchte nach "AADSTS…" und meldete
 * Erfolg — dabei lieferte eine voellig erfundene Client-ID dieselbe
 * Antwort. Die Fehlerseite nennt naemlich weder AADSTS noch einen Code,
 * sondern nur Klartext. Wer diese Kontrollprobe weglässt, haelt eine
 * funktionierende Registrierung fuer geprueft, auch wenn sie es nicht ist.
 *
 * Deshalb fragt dieses Skript beide Client-IDs ab. Findet es bei der
 * erfundenen keinen Fehler, dann ist die Pruefung selbst kaputt, und das
 * Skript sagt das, statt ein gruenes Zeichen zu drucken.
 */

const { Auth } = require('msmc');
const { resolveClientId, DEFAULT_REDIRECT_URI } = require('./src/main/auth');
const { userDataDir, appDirName } = require('./src/main/app-paths');

// Aus app-paths.js, nicht fest eingetragen. Fest eingetragen war hier
// "liquid-launcher" — und damit in einem anderen Ordner als dem, den der
// Launcher benutzt. Siehe app-paths.js für die ganze Erzaehlung.
const USER_DATA = userDataDir();

// Absichtlich ungueltig. Muss nachweislich scheitern, sonst traegt der Test
// nichts. Zufaellige Zahlen waeren schlechter: es gibt auch echte GUIDs,
// die Microsoft nicht kennt.
const KONTROLLE_ID = '00000000-0000-0000-0000-000000000000';

let fehler = 0;
function pruefe(bedingung, was) {
  if (bedingung) {
    console.log('  OK   ' + was);
  } else {
    fehler++;
    console.log('  FEHLT ' + was);
  }
}

/**
 * Die Autorisierungs-URL genau so bauen, wie msmc es beim Login tut, und die
 * Antwort einordnen.
 */
async function hole(clientId) {
  const url = new Auth({
    client_id: clientId,
    redirect: DEFAULT_REDIRECT_URI,
    prompt: 'select_account'
  }).createLink();

  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
  const html = await res.text();

  // Fehlerseiten erkennt man an drei unabhaengigen Merkmalen, nicht an einem.
  // "Oder" statt "und", weil Microsoft die Seite im Lauf der Zeit umbaut hat
  // und ein einzelnes Merkmal verschwinden kann.
  const merkmale = {
    'unauthorized_client': /unauthorized_client/i.test(html),
    'AADSTS-Fehler': /AADSTS\s?\d+/i.test(html),
    'Error-Info-Kommentar': /<!-{2,}Error Info/.test(html),
    'Klartext-Fehlerhinweis':
      /does not exist|is not enabled|isn't enabled|invalid_client|redirect_uri.{0,40}(invalid|not match)/i.test(html)
  };
  const fehlerseite = Object.values(merkmale).some(Boolean);

  // Sichtbarer Text der Seite, ohne HTML — fuer die Fehlermeldung.
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { url, status: res.status, html, fehlerseite, merkmale, text };
}

(async () => {
  console.log('Azure-App-Registrierung prüfen');
  console.log('='.repeat(70));
  console.log('userData: ' + USER_DATA);
  console.log('         (Ordnername aus package.json: "' + appDirName() + '")');
  console.log('Redirect: ' + DEFAULT_REDIRECT_URI);
  console.log('');

  const clientId = resolveClientId(USER_DATA);
  if (!clientId) {
    console.log('FEHLT  Keine Client-ID hinterlegt. Siehe Setup → Microsoft-Login.');
    process.exit(1);
  }
  console.log('Client-ID: ' + clientId);
  console.log('');

  // ---- Kontrollprobe zuerst ------------------------------------------------
  // Sie entscheidet, ob die eigentliche Pruefung aussagekraeftig ist.
  console.log('Kontrollprobe (erfundene Client-ID muss scheitern)');
  const kontrolle = await hole(KONTROLLE_ID);
  pruefe(kontrolle.fehlerseite,
    'eine erfundene Client-ID wird als Fehler erkannt (Antwort ' + kontrolle.status + ', ' +
    kontrolle.html.length + ' Zeichen)');

  if (!kontrolle.fehlerseite) {
    console.log('');
    console.log('FEHLT  Die Kontrollprobe ist fehlgeschlagen: Microsoft unterscheidet hier');
    console.log('       nicht mehr zwischen gueltig und ungueltig. Diese Pruefung kann');
    console.log('       dann nichts aussagen — bitte selbst ueber');
    console.log('       Einstellungen → Microsoft-Login → "Account hinzufuegen" testen.');
    process.exit(1);
  }
  console.log('       erkannt über: ' +
    Object.entries(kontrolle.merkmale).filter(([, v]) => v).map(([k]) => k).join(', '));
  console.log('');

  // ---- eigentliche Registrierung -----------------------------------------
  console.log('Hinterlegte Client-ID');
  const ist = await hole(clientId);
  console.log('  HTTP ' + ist.status + ', ' + ist.html.length + ' Zeichen');
  console.log('  URL: ' + ist.url);
  console.log('');

  if (ist.fehlerseite) {
    console.log('FEHLT  Microsoft lehnt die Registrierung ab.');
    console.log('       Erkannt über: ' +
      Object.entries(ist.merkmale).filter(([, v]) => v).map(([k]) => k).join(', '));
    console.log('');
    console.log('       Meldung von Microsoft:');
    const kurz = ist.text.length > 400 ? ist.text.slice(0, 400) + ' …' : ist.text;
    console.log('         ' + kurz);
    console.log('');
    console.log('       Häufigste Ursachen:');
    console.log('         * Redirect-URI fehlt, ist falsch geschrieben oder steht');
    console.log('           unter der Plattform "Web" statt "Öffentlicher Client/nativ"');
    console.log('         * die Registrierung ist noch nicht fertig gespeichert');
    console.log('         * die GUID ist die "Anwendungs-ID" des falschen Eintrags');
    process.exit(1);
  }

  pruefe(true, 'Microsoft liefert die echte Anmeldeseite');
  pruefe(/pass\s*word|password/i.test(ist.html), 'die Seite enthaelt ein Passwortfeld');
  pruefe(!/<!-{2,}Error Info/.test(ist.html), 'keine Fehlerseite');

  console.log('');
  console.log('='.repeat(70));
  if (fehler === 0) {
    // Dieser Erfolgssatz war einmal ("Der Login sollte jetzt funktionieren")
    // und war damit schlicht falsch. Nachgemessen am 27.09.2026: genau diese
    // gueltige Registrierung liess den Login an der VIERTEN von vier Stufen
    // scheitern, mit "Invalid app registration".
    //
    // Der Grund fuer die falsche Zusage war die Verwechslung zweier Dinge:
    // "gueltig" (Microsoft kennt die client_id) und "freigeschaltet"
    // (darf den Dienst XboxLive.signin benutzen). Die Pruefung hier belegt
    // nur das erste. Ein Gruen an dieser Stelle ist deshalb keine Aussage
    // darueber, ob der Login durchgeht - es ist eine Voraussetzung, nicht
    // das Ergebnis.
    console.log('✅ Die App-Registrierung ist gültig: Microsoft kennt die Client-ID');
    console.log('   und liefert die echte Anmeldeseite.');
    console.log('');
    console.log('Das ist eine Voraussetzung, KEIN Nachweis, dass der Login klappt.');
    console.log('Der Weg von hier zum fertigen Login hat noch drei Stufen, und an');
    console.log('genau dieser Prüfung sieht das Ergebnis genauso aus wie jetzt:');
    console.log('');
    console.log('   1. OAuth            wird hier geprüft          ✅');
    console.log('   2. Xbox Live                                  ungeprüft');
    console.log('   3. XSTS                                        ungeprüft');
    console.log('   4. login_with_xbox                             ungeprüft');
    console.log('');
    console.log('An Stufe 4 kann eine vollkommen gültige Registrierung mit');
    console.log('"Invalid app registration" abgewiesen werden, weil dieser');
    console.log('Endpunkt dem Xbox Developer Program vorbehalten ist. Auch das');
    console.log('wäre mit diesem Test nicht erkennbar - es kommt dort eine');
    console.log('gültige Anmeldeseite zurück, nur eben 403 am Ende.');
    console.log('');
    console.log('Ebenfalls ungeprüft: ob dein Konto eine Java-Edition-Berechtigung');
    console.log('hat. Beides zeigt sich erst beim echten Anmeldeversuch.');
  } else {
    console.log('❌ ' + fehler + ' Prüfung(en) fehlgeschlagen.');
  }
  process.exit(fehler === 0 ? 0 : 1);
})().catch(err => {
  console.error('Prüfung nicht durchführbar:', err.message);
  console.error('Das kann auch am Netz liegen — dann ist das Skript nur kein Beweis,');
  console.error('nicht aber ein Gegenbeweis.');
  process.exit(1);
});
