@echo off
rem ============================================================
rem  Liquid Launcher starten
rem
rem  Dasselbe Muster wie bei "Anmeldung testen.bat": "npm start"
rem  setzt ein package.json im aktuellen Ordner voraus, findet also
rem  keins, wenn man aus dem Benutzerordner startet. Diese Datei
rem  wechselt deshalb zuerst in den Projektordner.
rem
rem  Bewusst nur ASCII und "rem" statt "#": eine .bat mit UTF-8-BOM
rem  verweigert unter Windows die Ausfuehrung ihrer ersten Zeile.
rem ============================================================

rem Diese Datei gehoert in den Projektordner. "%~dp0" ist genau der Ordner,
rem in dem die .bat selbst liegt - damit funktioniert sie, egal wohin das
rem Repository geklont wurde, und ohne einen festen Pfad, der beim Kopieren
rem schnell zu einem toten Verweis wird.

set "PROJ=%~dp0"

if not exist "%PROJ%package.json" (
  echo.
  echo  FEHLT: Diese .bat muss im Projektordner liegen.
  echo  Erwartet wurde: "%PROJ%package.json"
  echo.
  pause
  exit /b 1
)

cd /d "%PROJ%"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo  FEHLT: Electron ist nicht installiert.
  echo  In diesem Ordner zuerst "npm install" ausfuehren.
  echo.
  pause
  exit /b 1
)

chcp 65001 >nul

echo.
echo  Liquid Launcher startet. Dieses Fenster bitte offen lassen -
echo  es zeigt die Log-Zeilen des Spiels und ist der einzige Weg,
echo  einen Absturz nachzuvollziehen.
echo.
echo  Zum Beenden: das Fenster schliessen oder hier Strg+C.
echo  ============================================================
echo.

"node_modules\electron\dist\electron.exe" .

echo.
echo  Launcher beendet. Exit-Code: %ERRORLEVEL%
echo.
pause
