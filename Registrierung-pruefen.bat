@echo off
rem ============================================================
rem  Liquid Launcher - Azure-Registrierung pruefen
rem
rem  Wozu: Nach der Aufnahme in das Xbox Developer Program
rem  bekommst du eine (oder eine neue) Client-ID. Bevor du damit
rem  den Login erneut versuchst, pruefe hier, ob Microsoft sie
rem  ueberhaupt als oauthauthorize-endpunkt annimmt.
rem
rem  Das ist ein reiner Netzwerktest: kein Fenster, kein Login,
rem  keine Aenderung an irgendetwas. Er liest die Client-ID aus
rem  dem config.json und fragt Microsoft damit einmal.
rem
rem  Liest absichtlich die GLEICHE config.json, die auch der
rem  Launcher liest (siehe src\main\app-paths.js). Geprueft
rem  wird also genau die ID, mit der der Launcher spaeter
rem  wirklich arbeitet - nicht irgendeine andere aus einer Liste.
rem
rem  WICHTIG - was dieser Test NICHT zeigt:
rem  Auch nach der Aufnahme in das Developer Program sieht die Antwort
rem  von Microsoft hier exakt gleich aus wie jetzt: eine ganz normale
rem  Anmeldeseite mit Passwortfeld. Der Endpunkt login_with_xbox wird
rem  hier gar nicht angefragt - genau der lehnt die Self-Made-Registrierung
rem  mit "Invalid app registration" ab.
rem
rem  Der Test kann also nur eine kaputte Registrierung zeigen, nicht aber
rem  eine freigeschaltete. Er ist eine Abwaechsprobe, kein Nachweis.
rem
rem  "rem" statt "#", damit die Datei unter jeder Codepage laeuft.
rem  Bewusst ohne Umlaute/Emoji: eine .bat mit UTF-8-BOM verweigert
rem  unter Windows die erste Zeile.
rem ============================================================

rem Wechselt in den Ordner, in dem diese .bat liegt. Ohne das Zeile
rem sucht node die Dateien im aktuellen Arbeitsverzeichnis - und
rem genau daran sind drei fruehere Fehlversuche gescheitert.
cd /d "%~dp0"

echo.
echo  Liquid Launcher - Registrierung pruefen
echo  ============================================================
echo  Arbeitsordner: %CD%
echo.

if not exist "test-ms-registration.js" (
  echo  FEHLT: test-ms-registration.js liegt nicht neben dieser Datei.
  echo.
  pause
  exit /b 1
)

rem Ohne installierte Abhaengigkeiten bricht node mit einem nackten
rem "Cannot find module 'msmc'" plus Stacktrace ab - das sieht nach einem
reparieren Fehler aus, ist aber nur "npm install fehlt". Genau das wird
rem hier abgefangen.
if not exist "node_modules\msmc" (
  echo  FEHLT: Die Abhaengigkeiten sind nicht installiert.
  echo.
  echo  In diesem Ordner zuerst "npm install" ausfuehren,
  echo  danach diese Datei erneut starten.
  echo.
  echo  Grund: test-ms-registration.js laeuft ueber node und braucht
  echo  das Paket "msmc". Ohne Installation gibt es keinen Stapeltrace,
  echo  sondern nur die Ausgabe "Cannot find module 'msmc'" - die ist
  echo  irrefuehrend, weil sie nach einem Programmfehler aussieht.
  echo.
  pause
  exit /b 1
)

rem Ohne das kommen Umlaute aus der Node-Ausgabe als Fragezeichen an.
chcp 65001 >nul

echo  Waehrend der Pruefung geht KEIN Fenster auf und es wird
echo  NICHTS gespeichert. Es wird nur Microsoft gefragt, ob es
echo  die hinterlegte Client-ID kennt.
echo.
echo  ------------------------------------------------------------
echo.

node "test-ms-registration.js"

set CODE=%ERRORLEVEL%

echo.
echo  ------------------------------------------------------------
echo  Programm beendet. Exit-Code: %CODE%
echo.

if not "%CODE%"=="0" (
  echo  Das ist ein echter Fehler. Inhalt von config.json ansehen:
  echo    notepad "%APPDATA%\Liquid Launcher\config.json"
  echo.
) else (
  echo  Gruen heisst nur: Microsoft KENNT die Client-ID. Es heisst nicht,
  echo  dass der Login durchgeht - die Endpunkte Xbox Live, XSTS und
  echo  login_with_xbox sind hier nicht beteiligt. Fuer die endgueltige
  echo  Antwort bleibt nur ein Versuch:
  echo    im Launcher  Einstellungen - Microsoft-Login - Account hinzufuegen
  echo.
)

pause
