@echo off
rem ============================================================
rem  Liquid Launcher - Microsoft-Login testen
rem
rem  Warum es diese Datei gibt: "npx electron test-auth.js" loest
rem  den Dateinamen gegen das AKTUELLE Arbeitsverzeichnis auf.
rem  Aus dem Benutzerordner gestartet kommt dann:
rem      unable to find electron app at c:/Users/<Name>/test-auth.js
rem  Die Schraegstriche sind nicht die Ursache - der Ordner schon.
rem  Diese Datei wechselt selbst in ihren eigenen Ordner, deshalb
rem  ist es egal, von wo sie gestartet wird.
rem
rem  "rem" statt "#", damit die Datei unter jeder Codepage laeuft.
rem  Bewusst ohne Umlaute/Emoji: eine .bat mit UTF-8-BOM verweigert
rem  unter Windows die erste Zeile. Das fenster unten bleibt deshalb
rem  stehen, damit die Ausgabe ueberhaupt lesbar ist.
rem ============================================================

rem Wechselt in den Ordner, in dem diese .bat liegt.
cd /d "%~dp0"

echo.
echo  Liquid Launcher - Login-Test
echo  ============================================================
echo  Arbeitsordner: %CD%
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo  FEHLT: Electron nicht gefunden.
  echo  In diesem Ordner zuerst "npm install" ausfuehren.
  echo.
  pause
  exit /b 1
)

if not exist "test-auth.js" (
  echo  FEHLT: test-auth.js liegt nicht neben dieser Datei.
  echo.
  pause
  exit /b 1
)

rem Ohne das kommen die Umlaute und das Haekchen aus der Node-Ausgabe
rem als Fragezeichen bei dir an.
chcp 65001 >nul

echo  Es oeffnet sich jetzt ein Microsoft-Fenster. Du musst dich dort
echo  selbst anmelden - in diesem Fenster hier kannst du nur zusehen.
echo.
echo  Fenster schliessen, sobald du durch bist oder abgebrochen hast.
echo  (Dann erscheint unten das Ergebnis.)
echo.
echo  ------------------------------------------------------------
echo.

"node_modules\electron\dist\electron.exe" "test-auth.js"

set CODE=%ERRORLEVEL%

echo.
echo  ------------------------------------------------------------
echo  Programm beendet. Exit-Code: %CODE%
echo.
if "%CODE%"=="0" echo  Das ist auch bei einem Login-Fehler 0 - bitte die Zeilen oben lesen.
echo.
pause
