// test-auth.js
// Isolierter Test für den echten Microsoft-Login — läuft als eigene kleine
// Electron-App (msmc braucht Electron für das Login-Fenster, ein reines
// "node test-auth.js" wie beim Java-Test geht hier nicht).
//
// Voraussetzung: eine gültige Azure-Client-ID. Die kommt NICHT in auth.js
// hinein, sondern nach %APPDATA%\liquid-launcher\config.json
// (siehe *Microsoft-Login* in der README, oder: node setup-client-id.js).
// Ob sie Microsoft akzeptiert, sagt vorher node test-ms-registration.js.
//
// Ausführen mit:
//   npx electron test-auth.js
//
// Dieser Test speichert nichts. loginWithMicrosoft() liefert den Account nur
// zurück; das Speichern macht der Launcher über die eigene Konto-Verwaltung.
// Wer hier erfolgreich ist, ist also NICHT im Launcher angemeldet — dort
// trotzdem einmal "Account hinzufügen" klicken.

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loginWithMicrosoft, resolveClientId } = require('./src/main/auth');
const { userDataDir, appDirName, vergleicheMitElectron } = require('./src/main/app-paths');

// Derselbe Ordner, den auch der Launcher benutzt.
//
// Zwei Fehler waren hier schon drin, und beide haben dasselbe Problem
// erzeugt: Test und Konfiguration lagen im selben FALSCHEN Ordner und waren
// sich deshalb einig — während die echte App woanders nachsah.
//
//   1. Fester Name statt package.json. Electron nimmt fuer den userData-
//      Ordner "productName" ("Liquid Launcher"), nicht "name"
//      ("liquid-launcher"). app-paths.js liest das jetzt aus package.json.
//   2. app.getPath('userData') ist hier ebenfalls unbrauchbar: dieses Skript
//      laeuft als einzelne Datei (electron test-auth.js), und dann ist
//      app.getName() "Electron" — nicht der Name des Projekts.
//
// Deshalb wird der Pfad berechnet und nicht abgefragt. vergleicheMitElectron
// haelt beide Weise nebeneinander, damit eine Abweichung sofort auffaellt.
const USER_DATA = userDataDir();

// Kein Geheimnis ausgeben. Ein Token-Anfang ist zwar kein vollständiges
// Credential, aber es hat an dieser Stelle auch keinen Zweck: die Länge und ein
// Fingerabdruck beantworten dieselbe Frage ("ist es derselbe Token wie
// vorher?") und geben nichts preis, das weitergegeben werden könnte.
const fingerabdruck = (wert) => {
  const s = typeof wert === 'string' ? wert : '';
  if (!s) return '(leer)';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
};

app.whenReady().then(async () => {
  console.log('userData:    ' + USER_DATA);
  console.log('Ordnername:  "' + appDirName() + '" (aus package.json: productName)');
  console.log('app.getName(): ' + app.getName() +
    '   <- "Electron", weil dieses Skript als Einzeldatei laeuft');
  console.log('');

  // Gegenprobe gegen das, woran es tatsächlich gescheitert ist.
  //
  // app.getName() ist hier "Electron" und damit als Vergleich unbrauchbar.
  // Stattdessen: der berechnete Ordner muss die Dateien enthalten, die nur
  // der echte Launcher anlegt. Legt dieses Skript seinen eigenen Ordner an,
  // ist er leer — und genau daran ist vorher die Prüfung gescheitert: Test
  // und Konfiguration teilten sich einen Ordner, den die App nie benutzt hat.
  //
  // Eine Datei, die ausschliesslich der Launcher schreibt:
  const nurVomLauncher = ['settings.json', 'instances.json', 'window-state.json', 'versions', 'instances'];
  const gefunden = nurVomLauncher.filter((n) => fs.existsSync(path.join(USER_DATA, n)));

  console.log('Pruefung, ob das wirklich der Launcher-Ordner ist:');
  console.log('  erwartete Dateien: ' + nurVomLauncher.join(', '));
  console.log('  davon vorhanden:   ' + (gefunden.length ? gefunden.join(', ') : '(keine)'));

  if (!gefunden.length) {
    console.log('');
    console.log('  ⚠ WARNUNG: In diesem Ordner liegt nichts, was der Launcher angelegt');
    console.log('    hat. Entweder ist er der falsche — oder der Launcher wurde noch');
    console.log('    nie gestartet. Ohne "instances.json"/"versions" ist das nicht');
    console.log('    unterscheidbar, also: einmal den Launcher starten und wiederholen.');
  } else {
    console.log('  ✅ sieht nach dem Ordner des Launchers aus');
  }
  console.log('');

  const clientId = resolveClientId(USER_DATA);
  console.log('Client-ID:   ' + (clientId || '(KEINE — config.json prüfen)'));
  console.log('config.json: ' + path.join(USER_DATA, 'config.json') +
    (fs.existsSync(path.join(USER_DATA, 'config.json')) ? '  (vorhanden)' : '  (FEHLT)'));
  console.log('');

  if (!clientId) {
    // Nicht einfach den Login versuchen und mit der Meldung von auth.js
    // dastehen: die beschreibt den Weg ueber Azure, und genau der wurde
    // schon einmal vergeblich beschritten, weil die Datei am falschen
    // Ort lag. Hier geht es um etwas anderes.
    console.error('❌ Keine Client-ID unter ' + USER_DATA);
    console.error('');
    console.error('   Diese Meldung sagt NICHT, dass deine Azure-App fehlt. Sie sagt,');
    console.error('   dass genau in diesem Ordner keine config.json mit "microsoftClientId"');
    console.error('   liegt. Beides hat schon einmal zugleich ausgesehen.');
    console.error('');
    console.error('   Pruefen mit:  node setup-client-id.js --show');
    console.error('   Oder im Launcher: Einstellungen -> Microsoft-Login');
    app.quit();
    return;
  }

  try {
    const account = await loginWithMicrosoft(USER_DATA, (status) => {
      console.log('  … ' + status);
    });

    console.log('');
    console.log('✅ Login erfolgreich! Das bedeutet:');
    console.log('   • die Client-ID wird von Microsoft akzeptiert');
    console.log('   • der OAuth-Tausch mit Rückleitung lief durch');
    console.log('   • Xbox Live und XSTS haben das Konto durchgelassen');
    console.log('   • dem Konto gehört Minecraft Java Edition');
    console.log('');
    console.log('Username:     ' + account.username);
    console.log('UUID:         ' + account.uuid);
    console.log('XUID:         ' + (account.xuid || '(null — Feature stumm)'));
    console.log('Skin-URL:     ' + (account.skinUrl || '(keine)'));
    console.log('Token gültig bis: ' + new Date(account.expiresAt).toLocaleString('de-DE'));
    console.log('');
    console.log('Nur zur Kontrolle, ohne dass etwas von Wert preisgegeben wird:');
    console.log('  accessToken:  ' + (account.accessToken || '').length + ' Zeichen, Fingerabdruck ' +
      fingerabdruck(account.accessToken));
    console.log('  refreshToken: ' + (account.refreshToken || '').length + ' Zeichen, Fingerabdruck ' +
      fingerabdruck(account.refreshToken));
    console.log('');
    console.log('Noch offen ist damit nur noch der Start selbst: eine Welt öffnen.');
    console.log('Das ist getrennt von hier — siehe *Was verifiziert ist* in der README.');
  } catch (err) {
    console.error('');
    console.error('❌ Login fehlgeschlagen: ' + err.message);
    console.error('');
    console.error('Einordnung:');
    console.error('  • "Client-ID …"  → config.json prüfen (node setup-client-id.js)');
    console.error('  • "besitzt kein Minecraft" → der Kauf fehlt dem Konto. Eine');
    console.error('    App-Registrierung hilft dort nicht weiter, auch keine andere.');
    console.error('  • Fenster geschlossen → der Nutzungsbedingungen-Dialog wurde');
    console.error('    abgebrochen; nichts wurde gespeichert, es ist kein Fehler.');
  } finally {
    app.quit();
  }
});

