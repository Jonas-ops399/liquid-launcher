# Widgets

Der Launcher kann Kacheln auf der Startseite anzeigen, die du selbst
geschrieben hast — als HTML-Datei im eigenen Ordner, ohne dass irgendetwas am
Launcher geändert werden muss.

Mitgeliefert werden vier: **Uhr**, **Welten**, **Mods**, **Laufzeit**.

---

## Wie du ein eigenes Widget baust

### 1. Ordner für eigene Widgets öffnen

**Einstellungen → Widgets → „Ordner für eigene Widgets öffnen"**

Das ist
`%APPDATA%\Liquid Launcher\widgets\`

### 2. Einen Ordner anlegen

```
widgets/
└── meine-uhr/
    ├── widget.json
    └── widget.html
```

### 3. `widget.json` schreiben

```json
{
  "id": "meine-uhr",
  "titel": "Meine Uhr",
  "beschreibung": "Zeigt die Zeit in New York",
  "breite": 1
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `id` | ja | Name des Ordners. Nur Buchstaben, Ziffern, `-` und `_`. |
| `titel` | ja | Steht in der Liste in den Einstellungen. |
| `beschreibung` | nein | Ein Satz, der in der Liste erscheint. |
| `breite` | nein | `1` (halbe Reihe) oder `2` (ganze Reihe). Vorgabe: `1`. |
| `html` | nein | Anderer Dateiname statt `widget.html`. |

### 4. `widget.html` schreiben

```html
<!doctype html>
<html><head><meta charset="utf-8">
<style>
  /* transparent, sonst liegt ein weißes Rechteck auf dem Glas */
  html, body { margin:0; height:100%; background:transparent; }
  body { display:flex; align-items:center; justify-content:center; font:22px sans-serif; }
</style>
</head><body>
<div id="z">--:--</div>
<script>
  function male() {
    document.getElementById('z').textContent =
      new Date().toLocaleTimeString('en-US',
        { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
  }
  male();
  setInterval(male, 1000);
</script>
</body></html>
```

### 5. In den Einstellungen auf **Hinzufügen** klicken

### 6. Anordnen

Auf der Startseite oben auf der Kachelreihe auf **Anpassen** klicken. Dann
lassen sich die Kacheln ziehen und über das `×` entfernen.

---

## Welche Farben das Widget bekommt

Der Launcher schickt dir drei CSS-Variablen, damit die Kachel zum Theme passt:

| Variable | Bedeutung |
|---|---|
| `--ll-text-hi` | helle Schrift, für den Hauptwert |
| `--ll-text-lo` | gedämpfte Schrift, für Beschriftung |
| `--ll-accent` | Akzentfarbe |

Benutze sie mit einem Fallback, falls nichts kommt:

```css
.wert { color: var(--ll-text-hi, #fff); }
.lbl  { color: var(--ll-text-lo, rgba(255,255,255,.62)); }
```

Die Farben kommen beim Laden der Kachel und bei jedem Wechsel des
Farbschemas, damit eine offene Kachel nicht die alten Farben behält.

---

## Welche Daten du benutzen kannst

Du kannst jederzeit Daten anfordern:

```js
parent.postMessage({ quelle: 'liquid-launcher-widget', typ: 'anfrage' }, '*');
```

Die Antwort kommt als `message`-Ereignis:

```js
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (!d || d.quelle !== 'liquid-launcher') return;
  if (d.typ === 'daten') {
    var welten = d.daten.welten;   // Array
    var mods   = d.daten.modAnzahl; // Zahl
  }
});
```

### Die vollständige Liste

| Feld | Inhalt |
|---|---|
| `aktiveInstanz` | ID der gerade gewählten Instanz, sonst `null` |
| `instanzen` | `[{ id, name, version, modloader }]` |
| `welten` | `[{ name, version, lastPlayed, groesse, gameTypeName, schoen, cheats, kaputt }]` |
| `modAnzahl` | Anzahl der `.jar` in der gewählten Instanz |
| `server` | `[{ name, address, online, spieler, version, latenz, motd }]` |
| `gestartetAm` | Zeitstempel, wann der Launcher gestartet wurde (Zahl in ms) |
| `sprache` | Sprachcode, z.B. `"de"`, `"en"`, `"es"`, `"fr"` |

Das sind **genau sieben Felder**. Die Liste ist eine Positivliste im
Hauptprozess; ein später ergänztes Feld geht nicht automatisch mit.

**Zu `sprache`:** es ist ein Sprachcode, kein Locale wie `"de-DE"`. Die
Einstellungen des Launchers speichern nur `"de"`, `"en"`, `"es"`, `"fr"`.
Als Argument für `toLocaleTimeString` funktioniert `"de"` direkt.

```js
jetzt.toLocaleTimeString(daten.sprache, { hour: '2-digit', minute: '2-digit' });
// sprache "de" -> "14:30"
// sprache "en" -> "02:30 PM"
```

### Und was ausdrücklich nicht

**Kein Token. Kein Konto. Kein Dateisystem.** Kein `theme` — die Farben kommen
stattdessen als eigene Nachricht (siehe oben), weil sie sich beim Wechsel des
Farbschemas ändern, ohne dass irgendetwas gespeichert wird.

Die Felder werden erst im Hauptprozess zusammengestellt und dort gekürzt. Der
Renderer baut den Koffer nicht — dort liegt nach einem Login das Konto-Objekt,
und es soll nicht in eine Struktur geraten, die zum Weiterreichen gedacht ist.

### Ein Fehler anzeigen

```js
parent.postMessage({
  quelle: 'liquid-launcher-widget', typ: 'fehler',
  nachricht: 'Keine Daten — ist eine Instanz gewählt?'
}, '*');
```

Der Text erscheint als rotes Feld in der Kachel. Die übrigen Kacheln laufen
weiter.

---

## Was dein Widget **nicht** kann

Das ist keine Absichtserklärung, sondern im echten Fenster gemessen
(`test-widgets-fenster.js`, Abschnitt 6):

| | Hauptseite | Dein Widget |
|---|---|---|
| `window.launcher` | vorhanden | **nicht vorhanden** |
| `auth.getActiveAccount` (Token) | vorhanden | **nicht vorhanden** |
| `require`, `process`, `module` | – | **nicht vorhanden** |
| `parent.launcher` | – | **`SecurityError`** |
| `top.launcher` | – | **`SecurityError`** |
| `localStorage` | – | **`SecurityError`** |
| `document.cookie` | – | **`SecurityError`** |

Dein Widget läuft in einem `<iframe sandbox="allow-scripts">`. Ohne
`allow-same-origin` hat es eine undurchsichtige Herkunft und kann das Fenster
der App nicht erreichen.

Es kann Daten **empfangen**, aber nichts **auslösen**. Es kann keine Instanz
starten, keine Welt löschen, keine Einstellung ändern. Das ist Absicht: ein
Widget ist ein Anzeigefeld, kein Bedienknopf.

---

## Ein Widget überschreiben

Liegt in deinem Ordner ein Widget mit derselben `id` wie ein mitgeliefertes,
gewinnt deins. `widgets/uhr/` in deinem Ordner ersetzt die mitgelieferte Uhr —
ohne dass am Code etwas geändert wird.

---

## Wenn etwas nicht geht

**Die Kachel bleibt leer.** `<html>` und `<body>` brauchen
`background:transparent`. Sonst liegt ein weißes Rechteck auf dem Glas.

**Die Kachel zeigt „…" dauerhaft.** Dein Skript hat nicht
`parent.postMessage({ quelle: 'liquid-launcher-widget', typ: 'anfrage' }, '*')`
gesendet. Ohne das kommt keine Antwort.

**„Widget nicht gefunden".** Die `id` in `widget.json` muss dem Ordnernamen
entsprechen, und beide dürfen nur Buchstaben, Ziffern, `-` und `_` enthalten.

**Änderungen erscheinen nicht.** In den Einstellungen auf **Kacheln neu
laden** klicken. Das liest die Dateien von der Platte, ohne den Launcher zu
beenden.

**Die Kachel zeigt eine Fehlermeldung.** Dann hat dein Skript selbst eine
`fehler`-Meldung geschickt oder die Datei ließ sich nicht lesen.

---

## Mitgelieferte Widgets

| `id` | Titel | Zeigt |
|---|---|---|
| `uhr` | Uhr | Uhrzeit, Sekunden und Datum im Format der eingestellten Sprache |
| `welten` | Welten | Anzahl spielbarer Welten, mit Hinweis auf kaputte |
| `mods` | Mods | Anzahl installierter Mods der gewählten Instanz |
| `laufzeit` | Laufzeit | Wie lange der Launcher schon läuft |

**Es gibt keine Kachel „Spielzeit".** Die frühere Kachel zeigte `12,4 h` —
ein fester Wert im HTML, den nie ein JavaScript gefüllt hat. Eine echte
Spielzeit müsste der Launcher erst über Start und Ende jedes Spiels
mitschreiben. Das ist nicht gemacht, also steht dort lieber nichts, was
erfunden wäre.

---

## Dateien

| Datei | Inhalt |
|---|---|
| `src/main/widgets.js` | Suche, Manifest-Prüfung, Positivliste — ohne Electron, damit der Test unter reinem Node läuft |
| `src/renderer/widget-host.js` | Baut die Kacheln, verwaltet die Frames, schickt die Daten |
| `widgets/*/widget.html` | die vier mitgelieferten Widgets |
| `test-widgets.js` | 96 Prüfungen, reines Node |
| `test-widget-anzeige.js` | 58 Prüfungen: was die Kacheln wirklich anzeigen, reines Node |
| `test-widgets-fenster.js` | 63 Prüfungen im echten Electron-Fenster |

### Die Tests ausführen

```
node test-widgets.js
node test-widget-anzeige.js
node_modules\electron\dist\electron.exe test-widgets-fenster.js
```

Der dritte Test braucht Electron, weil er die Sandbox *wirklich* prüft. Ein
Test mit nachgebautem DOM würde bei genau den Eigenschaften nichts aussagen, um
die es hier geht.
