# Liquid Launcher

<!-- ------------------------------------------------------------------ -->
<!-- English first on purpose. This project is documented in German      -->
<!-- because that is the language it was built in. When the reader is a  -->
<!-- third party - a reviewer, someone who found the repository - the    -->
<!-- first paragraphs have to answer "what is this, and is it            -->
<!-- legitimate" before anything else. The German documentation follows. -->
<!-- ------------------------------------------------------------------ -->

## About

Liquid Launcher is a desktop launcher for **Minecraft: Java Edition** on
Windows, written in Electron. It downloads and starts the **official,
unmodified** Mojang game client. It contains no modified game code, no
bundled mods, and nothing that alters gameplay. It manages instances, browses
existing worlds, lists servers with live ping, and sets per-instance memory and
window size.

It is a personal, non-commercial project, not affiliated with or endorsed by
Microsoft or Mojang Studios. It contains no advertising, no analytics, no
telemetry and no crash reporting, and it contacts only Microsoft and Mojang
endpoints. The user's own OAuth tokens are stored locally, encrypted, and are
never transmitted anywhere else.

### Microsoft login

The launcher implements the documented four-step Microsoft authentication flow:

1. Microsoft OAuth 2.0 authorization code flow with PKCE — public client,
   scope `XboxLive.signin offline_access`
2. Xbox Live authentication — `user.auth.xboxlive.com`
3. XSTS authorization — `xsts.auth.xboxlive.com`
4. Minecraft Services login —
   `api.minecraftservices.com/authentication/login_with_xbox`

Steps 1 to 3 complete successfully. Step 4 currently returns
`HTTP 403 — Invalid app registration` because this app is awaiting Microsoft
approval. **This is a documented platform limitation, not a defect in the
authentication code.** The full investigation — including the evidence that the
app registration itself is valid — is written up in the German section
*Login: was Microsoft blockiert und warum*.

The sole reason `XboxLive.signin` is requested: it lets the user sign in with
their own Microsoft account so that the game can prove to Microsoft's session
server that they own Minecraft: Java Edition. No other data is requested from
any Microsoft API.

---

## Auf Deutsch

Electron-Launcher für Minecraft mit "Liquid Glass"-UI.

**Status: Der Start funktioniert. Der Microsoft-Login scheitert an einer
Plattformgrenze, nicht an diesem Projekt.** Ein Klick auf „Spielen" lädt Java,
die Libraries, die Client-JAR und die Assets nach und startet Minecraft in
einem echten Fenster.

Beim Login kommen die ersten drei von vier Stufen sauber durch — OAuth, Xbox
Live und XSTS akzeptieren das Konto. Die letzte Stufe
(`login_with_xbox`) lehnt mit **`Invalid app registration`** ab, weil der
Endpunkt dem Xbox Developer Program vorbehalten ist. Details und Belege unter
*Login: was Microsoft blockiert und warum*.

Dazu gibt es inzwischen eine **Welten-Ansicht** (Spielstände der gewählten
Instanz lesen, starten, löschen), eine **Serverliste mit Live-Ping** (Status,
MOTD, Spielerzahl, Latenz — und ein Klick auf „Beitreten" startet direkt auf
dem Server) und **Startoptionen pro Instanz** (RAM und Fenstergröße, mit
vernünftigen Grenzen statt fester 1 GB/2 GB).

Verifiziert am 26.09.2026 mit einem echten Start von **1.21.4** ohne UI
(`node test-full-launch.js 1.21.4 60`): 84 Libraries, 9 Natives, Client-JAR,
4039 Assets (402 MB) geladen, JVM gestartet, LWJGL 3.3.3+5 initialisiert,
Textur-Atlanten erzeugt, 60 s lang gelaufen **ohne Absturz**, danach beendet.
Die einzigen Log-Fehler waren HTTP 401 vom Session-Server — das war der
fehlende Login (siehe unten), nicht der Startcode.

---

## Was funktioniert

### Startkette (komplett verdrahtet)

`src/main/ipc-handlers.js` → `instances:launch` führt aus:

1. **Java** — `requiredJavaMajor()` ermittelt die benötigte Java-Version aus der
   Minecraft-Version, `detectJava()` sucht eine passende Installation. Fehlt sie
   oder ist sie zu alt, lädt `downloadJava()` die JRE von Adoptium.
2. **Dateien** — `downloader.ensureVersionFiles()` lädt bei Bedarf die
   `version.json`, alle Libraries, die Natives, die **Client-JAR**, die
   log4j-Konfiguration und die Assets nach (SHA1-geprüft, 6 Downloads parallel).
3. **Argumente** — `resolveLaunchOptions()` baut Classpath, JVM- und
   Game-Argumente aus der `version.json` der jeweiligen Version. RAM und
   Fenstergröße kommen aus den Startoptionen **dieser** Instanz
   (siehe *RAM und Auflösung pro Instanz*).
4. **Prozess** — `process.launchProcess()` startet den JVM. `log`-, `running`-,
   `closed`- und `crashed`-Events werden ans UI durchgereicht.

`instances:stop` beendet den Prozess über `stopProcess()`. Beim Schließen des
Launchers räumen alle laufenden JVMs auf (`stopAllProcesses()` in `main.js`),
damit kein Java-Prozess ohne Fenster zurückbleibt.

### Microsoft-Login (implementiert, Client-ID hinterlegt)

`auth:addAccount` führt jetzt die echte Kette aus — über `msmc` (npm) von
Microsoft OAuth → Xbox Live → XSTS → Minecraft Services. Der Ablauf:

1. Klick auf „Account hinzufügen" → ein Electron-Fenster mit der
   Microsoft-Anmeldung öffnet sich. `prompt: 'select_account'` sorgt dafür, dass
   immer der Account-Auswahldialog erscheint — sonst merkt sich Windows den
   letzten Account und der Launcher meldet Erfolg, obwohl der falsche drin ist.
2. Nach der Rückleitung prüft der Code, ob dem Konto überhaupt Minecraft gehört.
   Gehört es keins, gibt es eine klare Meldung statt eines Absturzes mit
   `profile is not iterable`.
3. Der Account wird verschlüsselt gespeichert, das echte Token geht an den
   Spielstart. Weitere Details siehe *Tokens und Sicherheit* unten.

**Einrichtung (einmalig, im Browser):**

Die Einstellungs-Karte dafür gibt es nicht mehr — dort stand nur ein einzelnes
Eingabefeld, das die Kartenreihe unnötig gestreckt hat. Fehlt die Client-ID,
nennt der Login-Dialog selbst den Portalweg und das nötige Redirect-URI. Beide
Wege sind zugleich der Ersatz für das Handschreiben von `config.json`:

Auf der Kommandozeile:

```bash
node setup-client-id.js 12345678-1234-1234-1234-123456789012
# oder ohne Argument: fragt interaktiv ab
node setup-client-id.js --show   # nur anzeigen, ob etwas hinterlegt ist
```

Beide Wege schreiben nach `%APPDATA%\Liquid Launcher\config.json` (der Ordnername
kommt aus `productName` in `package.json` — siehe *Der userData-Ordner* unten),
**nicht** in den Code — so übersteht sie ein Update. Dritte Möglichkeit: die
Umgebungsvariable `LIQUID_LAUNCHER_CLIENT_ID`.

Eine Client-ID ist **kein Geheimnis**: Public Client IDs stehen in jedem
Installer, den man herunterlädt. Sie wird deshalb im Klartext gespeichert —
anders als der `accessToken`, der den Haupt-Prozess nie verlässt. Der Wert wird
beim Setzen auf das GUID-Format geprüft; eine mitkopierte Beschriftung wird
sofort abgelehnt und landet nicht in der Konfiguration.

Die GUID steht in *portal.azure.com* → *Microsoft Entra ID* → *App registrations*
→ *New registration*. Drei Details, an denen es typischerweise hakt:

| Einstellung | Wert | Warum |
|---|---|---|
| Supported account types | „Accounts in any organizational directory **and personal accounts**" | Minecraft-Käufe hängen an *persönlichen* Microsoft-Konten. Mit „Nur Organisationsverzeichnisse" findet der Login Konten ohne Minecraft. |
| Redirect URI (Plattform **Mobile and desktop applications**) | `https://login.live.com/oauth20_desktop.srf` | Muss exakt zu msmcs Endpunkt passen, siehe unten. |
| Client-Secret | **keines anlegen** | Es ist eine Desktop-App (Public Client). Ein Secret landet zwangsläufig im Installer und wird vom Nutzer extrahiert. msmc braucht keines. |

In Azure gibt es zwei ähnlich aussehende GUIDs. Genau die Verwechslung ist der
häufigste Grund für einen leeren Login-Dialog:

- **Directory (tenant) ID** — falsch
- **Application (client) ID** — richtig

**Der Redirect-URI war der Grund für stundenlanges Suchen.** In `auth.js` stand
zuvor `https://login.microsoftonline.com/common/oauth2/nativeclient`. Der Wert
ist korrekt — aber für den *v2*-Endpoint. msmc schickt den Token-Austausch
dagegen an `https://login.live.com/oauth20_token.srf` (Legacy, siehe
`node_modules/msmc/dist/cjs/auth/auth.js`, Methode `_get`). Mit gültiger
Client-ID und falschem URI gibt es trotzdem `AADSTS50011: The redirect URI does
not match`. Deshalb steht jetzt der Default der Library drin.

### Tokens und Sicherheit

Ein `accessToken` ist ein vollwertiger Login-Credential: damit kann jeder, der
ihn hat, den Account übernehmen — also darf er weder im Klartext auf der Platte
liegen noch im Renderer-Prozess. Beides ist umgesetzt:

- **Auf der Platte:** `account-store.js` legt `accessToken` und `refreshToken`
  mit `safeStorage.encryptString()` in `accounts.json` ab. Unter Windows ist das
  DPAPI, der Schlüssel hängt am Windows-Benutzerkonto und an der Maschine — eine
  kopierte `accounts.json` ist auf einem anderen Rechner wertlos. Öffentliche
  Felder (Name, UUID, Skin-URL) bleiben lesbar, damit die Account-Liste schnell
  laden kann.
  *Ist `safeStorage` nicht verfügbar, wird das Token gar nicht erst gespeichert*
  (kein Klartext-Fallback). Der Account bleibt in der Liste sichtbar, mit dem
  Hinweis „Anmeldung abgelaufen", und wird beim nächsten Start neu angemeldet.
- **Im Renderer:** `auth:listAccounts` und `auth:getActiveAccount` geben nur
  eine gefilterte Fassung zurück. `toPublicAccount()` ist eine Allowlist, damit
  ein neu hinzugefügtes Feld nicht versehentlich durchrutscht. Das echte Token
  verlässt den Haupt-Prozess nur auf einem Weg: `toLaunchAccount()` → `process.js`.
  `test-ipc-wiring.js` prüft das mit dem Text `TOP-SECRET`.
- **In den Logs** maskiert `process.js` den `accessToken` (ebenso geprüft).

Abgelaufene Tokens werden beim Start und vor jedem Spielstart im Hintergrund
erneuert (`refreshAccount()`), ohne dass der Nutzer etwas bemerkt. Schlägt die
Auffrischung fehl, startet Minecraft mit einem klaren Hinweis statt mit einem
stillen 401. Ist eine `accounts.json` nicht mehr entschlüsselbar (anderer
Rechner), markiert der Store den Account mit `needsRelogin`; das UI zeigt das
Als Marker neben dem Namen.

### Fehlermeldungen beim Login

msmc wirft keine echten `Error`-Objekte, sondern drei verschiedene Formen:

| Was msmc wirft | Woher | `err.message` |
|---|---|---|
| `"error.auth.xsts.child"` | `err()` in `xAuth()` | `undefined` |
| `{ response, ts }` | `errorResponse()` bei HTTP-Fehlern | `undefined` |
| `"error.gui.closed"` | Login-Fenster geschlossen | `undefined` |

Ohne Gegenwehr hätte der Nutzer bei **jedem** Login-Fehler nur
`"Anmeldung fehlgeschlagen."` gesehen — die entscheidende Information
steckt in der HTTP-Antwort, die msmc im Fehler mitwirft (`response`), aber nie
ausliest. `normalizeLoginError()` in `auth.js` holt sie heraus, macht daraus
einen echten `Error` und übersetzt die Codes:

- **AADSTS50011** → „Redirect-URI passt nicht, in Azure muss
  `https://login.live.com/oauth20_desktop.srf` stehen"
- **AADSTS50020 / AADSTS9002326** → „falscher Account-Typ, persönliche Konten fehlen"
- **AADSTS7000218** → „App verlangt ein Client-Secret, ist aber als Public Client registriert"
- **XErr 2148916233** → „kein Xbox-Profil, einmal bei xbox.com einloggen"
- **XErr 2148916238** → „Kindkonto, braucht Familienfreigabe"

Das Originalwort von Microsoft steht immer mit drin — das ist der
zuverlässigste Beleg, falls die Deutung danebenliegt. `test-auth-errors.js`
prüft das für alle neun Fälle mit genau den Fehlerformen, die msmc 5.0.5
tatsächlich produziert (den Object-Fall liest der Test aus dem Quelltext nach).

Deshalb ist die Frage „welche ID ist falsch?" überhaupt beantwortbar — und ein
falscher Redirect-URI muss nicht mehr fünf Stunden gesucht werden.

### Welten-Ansicht

Die Seitenleiste hat einen eigenen Punkt „Welten". Er zeigt die Spielstände der
gerade gewählten Instanz an — also alles, was unter `<instanz>/saves/` liegt —
mit Vorschaubild, Name, Version, Spielmodi, Schwierigkeit, Alter und Größe. Von
dort aus startet man direkt in eine Welt oder löscht sie.

**Woher die Daten kommen.** Der Haupt-Prozess liest jede `level.dat` selbst
(`nbt.js`, ein eigener gzip+NBT-Leser), statt dem Renderer Dateipfade zu geben.
`worlds.js` sammelt das ein. Angezeigt werden genau die Felder, die Minecraft
selbst schreibt:

| Anzeige | NBT-Feld |
|---|---|
| Name | `Data.LevelName` (fällt auf den Ordnernamen zurück) |
| Version | `Data.Version.Name` |
| zuletzt gespielt | `Data.LastPlayed` (Millisekunden) |
| Spielmodus | `Data.GameType` |
| Schwierigkeit | `Data.Difficulty`, `Data.hardcore` |
| Cheats | `Data.allowCommands` |
| mit Mods | `Data.WasModded` |
| Weltalter in Tagen | `Data.Time` / 20 / 60 / 60 / 24 |
| Größe | Summe über `region/`, `entities/`, `playerdata/`, … |

Zwei bewusste Entscheidungen:

- **Das Vorschaubild kommt als Data-URL zurück, nicht als Dateipfad.** Sonst
  landet `C:\Users\<Name>\AppData\...` im Renderer-Prozess und damit in jedem
  DevTools-Fenster und jeder Fehlermeldung. Getestet wird das auch.
- **Es gibt kein Feld mit dem Spielernamen.** Moderne `playerdata/*.dat`
  speichern kein `Name`-Feld mehr (entfernt mit 1.20.2). Das Feld würde immer
  leer bleiben — ein leeres Feld ist schlimmer als keines.

**Welten-ID ist der Ordnername**, nicht der Anzeigename. Quick Play braucht den
Ordnernamen: `--quickPlayPath` erwartet den Pfad zum `saves/<Ordner>`, und
`--quickPlaySingleplayer` ist die Welt-ID. Ein Anzeigename wie „Meine Riesenwelt"
existiert im Spiel gar nicht. Im Tooltip der Zeile steht der Ordnername deshalb
immer mit, auch wenn er sich vom Anzeigenamen unterscheidet.

**Starten aus der Welten-Ansicht.** `instances:launch` nimmt entweder eine reine
Instanz-ID (wie bisher) oder ein Objekt `{ instanceId, worldId }`. Quick Play
wird nur gesetzt, wenn wirklich eine Welt verlangt wurde — `has_quick_plays_support`
**und** `is_quick_play_singleplayer` müssen beide true sein, sonst filtert
`launchFeatures()` die Argumente wieder heraus. Ohne angeforderte Welt wird
überhaupt kein `quickPlay*`-Argument erzeugt: ein leerer `--quickPlayPath` wäre
für das Spiel ein *versuchter* Quick Play mit leerem Ziel, kein „kein Quick Play".

Das Ziel wird gegen die echte Weltliste geprüft, **bevor** die 500 MB Spiel
heruntergeladen werden. Ein Tippfehler in der Welt-ID kostet damit keinen
Download.

**Löschen ist mehrstufig abgesichert**, weil ein Klick hier wirklich Dateien
unwiderruflich entfernt:

- Der Knopf verlangt einen **zweiten Klick** („Wirklich löschen?"), statt ein
  `window.confirm` zu benutzen — das blockiert in Electron den Renderer und
  sieht aus wie ein eingefrorenes Fenster. Nach 5 s springt der Knopf zurück.
- Löschen ist gesperrt, solange die Instanz läuft.
- Die **letzte** Welt einer Instanz lässt sich nicht löschen. Wer sie löscht,
  verliert den Spielstand ohne Wiederherstellungsweg; die Meldung sagt das
  ausdrücklich.
- `assertSafeName` + `resolveInside` verhindern jeden Ausbruch aus `saves/`.

Diese letzte Prüfung ist nicht theoretisch: `test-worlds.js` schickt 20
Angriffsnamen durch `deleteWorld` (`..`, `../../x`, `C:\Windows`, `talberg/../../x`,
leerer String, …) und prüft danach, dass ein Beweisordner mit Testdaten noch
vollständig auf der Platte liegt. Zusätzlich wurde der Pfad gegen den **echten**
IPC-Kanal geprüft, nicht nur gegen die Funktion — mit zwei Welten im Verzeichnis,
damit wirklich die Namensprüfung greift und nicht zufällig der Letzte-Welt-Schutz.

**Zwei Layoutfehler, die erst das Messen im echten Fenster gefunden hat.** Die
Welten-Liste ist ursprünglich als Kachel-Raster gebaut worden. Das war falsch:
`icon.png` ist 64×64 Pixel, in einer 215 px breiten Kachel um Faktor 3,4
hochskaliert und unscharf, und es blieben nur knapp zwei Reihen sichtbar. Jetzt
sind es Zeilen mit 76 px Vorschaubild — nahe Originalauflösung, acht Welten ohne
Scrollen.

Der zweite Fehler war schwerer zu sehen: `.view-worlds` fehlte in der
`display:none`-Liste der Ansichts-Panels. Dadurch blieb das Welten-Panel **immer**
im Layout, lag über der Spiel-Ansicht und belegte eine eigene Rasterzeile, ohne
Höhenbegrenzung — bei flachen Fenstern war die Liste dann unerreichbar. Der
zweite: `min-width:auto` der Panels im Overlay gilt in der Hauptachse als
`min-content`. Ein Weltname aus `Data.LevelName` darf 200 Zeichen ohne ein
einziges Leerzeichen haben (bei geteilten oder modded Welten steht der Inhalt
unter fremder Kontrolle) — das Panel wurde 1768 px breit in einem 1360-px-Fenster
und schob das ganze Raster auseinander.

**Anzeigenamen werden escapt, nicht interpretiert.** Genau derselbe Weg ist der
Interessante: `Data.LevelName` stammt aus der Datei, nicht vom Dateisystem. Ein
Weltname wie `<img src=x onerror="…">` bleibt Text. Geprüft wird das nicht nur am
Escaper, sondern am Ergebnis: der Namensbereich enthält danach **null**
Kindelemente und genau einen Textknoten, und das `onerror` löst nicht aus.

### Serverliste mit Live-Ping

Die Seitenleiste hat einen eigenen Punkt „Server". Er zeigt die pro Instanz
gespeicherten Adressen und fragt sie live ab — **ohne** Minecraft zu starten:
Statuspunkt, Favicon, MOTD, Spielerzahl, Version und Latenz. Von dort aus
tritt man direkt bei.

**Der Ping läuft im Haupt-Prozess** (`mc-ping.js`), nicht im Renderer. Zwei
Gründe, und der zweite ist der wichtige: `sandbox: true` verbietet dem Renderer
ohnehin die Netzwerk-API, und ein Ping aus dem Renderer müsste die Adresse
ungeprüft übernehmen. So bekommt der Renderer ausschließlich Strings und
Zahlen zu sehen — er kann vom Server nichts annehmen, was nicht schon
Fließtext ist.

**Protokoll.** Der Server List Ping ist ein Handshake mit `next_state = 1`,
danach Status-Anfrage, Status-Antwort und Ping/Pong auf **derselben**
Verbindung. Vanilla prüft beim Ping kein Protokoll-Flag, deshalb ist das
zulässig. **Fehlender Pong ist kein Fehler**: `latencyMs` bleibt dann `null`,
`online` trotzdem `true`. Ein Server ohne Latenzangabe ist ein Normalfall, kein
Defekt.

**MOTD ist ein Chat-Baum von einem fremden Server.** Der `description`-Wert ist
kein String, sondern eine verschachtelte Struktur aus `text`, `extra`,
`translate`, `with`, `selector` und der uralten flachen Form `{ "": "…" }`.
`motdToText()` zieht das zu reinem Text flach — **in `mc-ping.js`, im
Haupt-Prozess**, nicht im Renderer. Das ist die eigentliche Entscheidung: was
hier flachgezogen wird, kann nicht mehr als HTML ankommen, egal was der Renderer
damit macht. Zusätzlich abgesichert:

| Grenze | Wert | Wofür |
|---|---|---|
| JSON-Paket | 1 MB | ein Server kann beliebig viel schicken |
| MOTD-Länge | 600 Zeichen | die Zeile zeigt zwei Zeilen |
| Baumtiefe | 12 | 10.000 Ebenen Verschachtelung |
| Knotenzahl | 300 | 5.000 Komponenten in einer Liste |
| Beispiel-Namen | 5 / 16 Zeichen | `players.sample` |
| Favicon | 256 KB | 64×64 PNG, mehr ist keins |

**Alle drei Grenzen melden „gekürzt" — auch die Längengrenze.** Das war ein
Fehler, den erst der Test fand: bei der Länge wurde still abgebrochen, also nach
142 von 5.000 Komponenten. Die MOTD sah danach vollständig aus (`truncated:
false`), war aber 4.400 Teile kürzer als die des Servers. Eine stillschweigend
gekappte MOTD ist schlimmer als eine gekürzte, weil der Benutzer der falschen
Annahme ist, er sehe alles.

**Steuerzeichen fliegen raus**, aus jedem Text des Servers: C0/C1, `U+200B` bis
`U+200F`, `U+2028`/`U+2029` und `U+FEFF`. Ohne `U+2028`/`U+2029` kann ein
Server in einem `innerHTML`-Kontext sogar Zeilen umbrechen, ohne dass ein
einziges `<` vorkommt.

**Favicons: nur `data:image/png;base64,` und die PNG-Magic-Bytes werden
geprüft.** Der Grund ist nicht die Dateigröße, sondern `data:image/svg+xml` —
das kann `<script>` enthalten und würde aus einem fremden Server direkt Code in
die Oberfläche bringen. Die Prüfung sitzt im Haupt-Prozess; der Renderer setzt
das Bild nur noch als `src` ein. Schlägt das Laden fehl, steht wieder das
Globe-Emoji — **nicht** ein leerer Kasten, der von einem kaputten Panel aussieht.

**SRV** wird wie im Spiel nur bei Port 25565 aufgelöst, mit eigenem 2-Sekunden-
Timeout und stillem Zurückfallen. Für den Beitritt wird die Adresse **nicht**
auf das SRV-Ziel umgeschrieben: das Spiel macht seine eigene SRV-Auflösung und
zeigt dem Benutzer dann den Namen, den er eingetippt hat.

**Adressen werden beim Eintragen geprüft und normalisiert.** `example.net` wird
als `example.net:25565` gespeichert, IPv6 bekommt Klammern, `host:abc` wird
abgelehnt, ein Duplikat auch. Sonst steht eine kaputte Adresse ewig in der Liste
und der Ping meldet jedes Mal nur „Adresse ungültig" — ohne dass man den Fehler
beim Tippen gesehen hätte.

**Beitreten.** `instances:launch` nimmt `{ instanceId, serverId }`. Über die
**ID**, nicht über die Adresse: der Haupt-Prozess schlägt in der `servers.json`
nach und nimmt erst dort die Adresse. So kann der Renderer keine beliebige
Adresse einschleusen. Adresse und ID werden gegen die echte Liste geprüft,
**bevor** die 500 MB Spiel heruntergeladen werden.

**Drei Fehler, die erst der Test gegen die echte `version.json` gefunden hat.**
Die Quick-Play-Argumente hängen in der `version.json` an vier getrennten
Features, und die Namen versprechen mehr, als sie tun:

| Feature | schaltet frei |
|---|---|
| `has_quick_plays_support` | `--quickPlayPath` |
| `is_quick_play_singleplayer` | `--quickPlaySingleplayer` |
| `is_quick_play_multiplayer` | `--quickPlayMultiplayer` |
| `is_quick_play_realms` | `--quickPlayRealms` |

`has_quick_plays_support` ist **keine** gemeinsame Voraussetzung für die anderen
drei, sondern schaltet allein `--quickPlayPath` frei. Beim Serverstart muss es
deshalb `false` bleiben — sonst schleppt der Start `--quickPlayPath ""` mit, und
das Spiel wertet einen leeren Pfad als *fehlgeschlagenen* Quick-Play-Versuch.
Gegen eine selbstgebaute `version.json` hätte man das nie gesehen; der Test
liest die echte Datei der installierten Version.

Zwei kleinere: die MOTD-Zwischenzusammenfassung setzte Zahlen als `text` still
schweigend leer (`{"text": 42}` → `""`), obwohl genau dieselbe Form im
Array-Zweig very gut funktionierte. Und eine leere MOTD wurde zu `" …"`.

**Grenzen im Renderer.** Der Ping-Zustand liegt in einem Cache, dessen Schlüssel
**Instanz + Server-ID** ist. Jede Instanz hat ihre eigene `servers.json`; mit
nur der Server-ID stünden beim Wechsel die Messwerte der vorherigen Instanz da,
mit fremder MOTD. Zusätzlich wird ein laufender Ping-Lauf abgebrochen, sobald
die Instanz wechselt — ein Ping auf einen toten Server dauert bis zu 5 Sekunden,
und in dieser Zeit kann der Benutzer wechseln.

**Alles vom Server geht durch `escapeHtml()`** oder wird per `textContent`
gesetzt. Name, Adresse, MOTD, Chips, Fehlermeldung, Tooltip: kein einziger
Pfad in den HTML-Baum ohne Escaping. Geprüft am Ergebnis im echten Fenster: eine
MOTD mit `<img src=x onerror=…>` und `<b>` erzeugt **null** Tags und **null**
ausgelöste Handler.

**Gemappt, aber aus gutem Grund nicht übersetzt:** `7/40`, `42 ms`, `1.21.4`.
Zahlen und Einheiten sind international gleich, und eine Übersetzung davon
liefert nur weitere Fehlerquellen.

### RAM und Auflösung pro Instanz

Die Karte „Startoptionen" in den **Einstellungen** gehört zur **gewählten
Instanz**, wie Welten und Server auch. Gespeichert wird in
`<Instanzordner>/instance-settings.json`; beim Start steht der Wert als
`-Xms…`/`-Xmx…` bzw. `--width`/`--height` in der Befehlszeile. Vorher stand dort
fest 1 GB/2 GB und 1280×720 — auf einem 32-GB-Rechner damit argerlich
unterversorgt und auf einem 4-GB-Notebook eine Einladung, in den Swap zu laufen.

**Warum die Prüfung im Haupt-Prozess sitzt und nicht im HTML.** Beide Werte
landen ungeprüft in einer Befehlszeile. Ein Tippfehler ist dort kein Formularfehler,
sondern ein Spiel, das gar nicht erst startet — mit einer Meldung, die nichts
über die Ursache sagt:

```
Initial heap size set to a larger value than the maximum heap size
Could not reserve enough space for object heap
```

`instance-settings.js` ist deshalb die letzte Gelegenheit, die Zahl zu prüfen.
Die Oberfläche kennt die Grenzen nur als *Anzeige*; sie kann sie nicht aufweichen.

**Was geprüft wird und was nicht:**

- **1 bis 64 GB, in halben Schritten.** `value * 2` muss ganzzahlig sein. 2,7 GB
  akzeptiert das JVM, meint aber kein Mensch — wer es eintippt, hat sich
  verrechnet.
- **64 GB ist eine harte Grenze, 65 nicht mehr.** Praktische Begründung:
  `-Xmx128G` auf einem 32-GB-Rechner endet in *Could not reserve enough space
  for object heap*. Darüber hinaus ist die Zahl mit Sicherheit ein Tippfehler.
- **Mindest ≤ Maximum.** Das ist der eine Fehler, der das Spiel gar nicht erst
  starten lässt. Ohne die Prüfung sieht der Benutzer nur ein Fenster, das sofort
  wieder zugeht.
- **Mehr als im Rechner steckt: Warnung, keine Ablehnung.** 8 GB auf einem
  16-GB-Rechner ist eine legitime Entscheidung, nur eine, von der man besser
  vorher weiß. Die Meldung nennt den Swap beim Namen, statt es zu verschweigen.
- **Hohes `-Xms` wird extra genannt.** `-Xms` wird beim Start sofort reserviert,
  `-Xmx` nur bei Bedarf. Über der Hälfte des physischen Speichers ist das echter
  Verbrauch von Anfang an und kein blosser Deckel.
- **Keine Ratio-Prüfung.** 3440×1440, Hochformat, alles ist erlaubt. Eine
  erfundene Regel, die gültige Auflösungen ablehnt, wäre schlimmer als keine.
- **Textfelder werden nicht mit `Number()` umgewandelt.** Der liefert `0` für
  `''`, `' '` und `null` — drei Eingaben, die wie eine Eingabe aussehen und
  trotzdem eine Zahl ergeben. Und er akzeptiert `Number('0x10') === 16`: der
  Benutzer hat sich verrechnet, bekommt aber 16 GB statt einer Meldung.
  Deshalb wird gegen eine Dezimalzahl geprüft statt umgewandelt. `4,5` wird
  abgewiesen und **nicht** still als `4` gelesen.
- **Die Auflösungsgrenzen stehen im Markup UND im Modul.** Das `min`/`max` an den
  number-Feldern ist Bedienkomfort; was der Start tatsächlich akzeptiert,
  entscheidet allein `instance-settings.js`.

**Bewusst keine freien Argumentlisten.** Die meisten Launcher bieten ein Feld
„extra JVM args". Es ist hier bewusst nicht vorhanden, aus zwei Gründen. Erstens
ginge jedes Argument ungeprüft in den argv des Prozesses — `-javaagent:` und
`-Dlog4j.configurationFile=…` laden fremden Code bzw. hijacken die
Log-Konfiguration. Der Benutzer ist hier selbst der Angreifer, aber bei einer
kopierten `instance-settings.json` ist das nicht offensichtlich, und ein
zusätzlicher Config-Kanal ist eine Angriffsfläche ohne Gegenwert. Zweitens wäre
ein `-Xmx` dort stillschweigend wirkungslos: die geprüften `-Xms`/`-Xmx` stehen
weiter hinten in der Argumentliste und gewinnen. RAM und Auflösung sind
dagegen typisiert — der Wert ist eine Zahl und kann per Konstruktion nichts
anderes transportieren als ihre Ziffernfolge.

**`instanceSettings:set` wirft bei einem Tippfehler nicht**, sondern antwortet mit
`fehler` und lässt den alten Stand unangetastet. Grund: die Felder werden beim
Tippen geprüft, nicht erst beim Speichern — ein Reject landete im Renderer als
unbehandelte Ablehnung, während der Benutzer noch tippt. Bei einer Ablehnung
springen die Felder auf den bestätigten Stand zurück, statt eine Zahl anzuzeigen,
die nirgends gespeichert ist.

**Eine kaputte Datei verhindert nie einen Start.** Sie fällt auf die Standardwerte
zurück und wird als „unlesbar" gemeldet — sichtbar kaputt, aber benutzbar. Was
aus der Datei kommt, wird trotzdem neu geprüft: eine von Hand auf `99999` gesetzte
`ramMaxGb` wird verworfen, nicht befolgt.

**Verifiziert.** 185 Prüfungen in `test-instance-settings.js` (Grenzen,
Einschleus-Versuche wie `4G -Dfoo=bar`, `0x10`, `99999999999999999999`,
`1e3`; Round-Trip; manipulierte Dateien; Prototyp-Vergiftung über `__proto__`).
Über den echten IPC-Kanal in `test-ipc-wiring.js`: Ablehnung lässt den alten Stand
exakt erhalten, eine reine Auflösungsänderung setzt den RAM nicht zurück.
`test-launch-chain.js` prüft die ganze Kette bis zur Befehlszeile:
`instance-settings.json` → `loadSettings` → `toLaunchInputs` →
`resolveLaunchOptions` → `-Xms1.5G`/`-Xmx6G` und `--width 2560 --height 1440`
als Paar, inklusive `has_custom_resolution`. Im echten Fenster gemessen: 0
Überläufe bei 1360 px und bei der Mindestbreite 1040 px, Felder dort 237–272 px
breit, keine abgeschnittene Beschriftung, Auto-Speichern nach 500 ms bestätigt
den echten Stand, Instanzwechsel lädt die Werte der anderen Instanz.

### Weitere fertige Bausteine

- **NBT-Leser** (`nbt.js`) — gzip + alle Tag-Typen, nur lesend. Eine kaputte
  `level.dat` ergibt einen sichtbaren, als „kaputt" markierten Eintrag und
  reißt die Liste nicht mit — der Ordner bleibt, die Welt ist halt nicht spielbar
- **Prozess-Handling** (`process.js`) — startet/­beendet Instanzen, maskiert den
  `accessToken` in allen Log-Zeilen, erkennt Abstürze und liefert die letzten
  Log-Zeilen mit
- **Java-Erkennung** (`java-runtime.js`) — sucht Java in PATH, an
  Standard-Installationsorten und in `~/.liquid-launcher/java`, prüft die
  Version und lädt sonst eine passende JRE
- **Mods** (`mods.js`) — echte Modrinth-Suche inkl. Versions-Auflösung passend
  zu Minecraft-Version und Modloader
- **Fabric Loader** (`fabricLoader.js`) — für Instanzen mit `modloader: "fabric"`
  wird das Profil von `meta.fabricmc.net` geholt und mit der
  Vanilla-`version.json` verschmolzen: Maven-Libraries werden auf die
  Mojang-Form gebracht, die MainClass ist danach der Fabric-Einstieg
  (`KnotClient`), und die Fabric-JVM-Argumente kommen dazu. Die Loader-Version
  steht in der `instance.json` (sonst neueste stabile, einmal ermittelt und
  gemerkt). Verifiziert in `test-fabric-loader.js` (63 Prüfungen, ohne Netz)
  und gegen den echten `userData`-Ordner bis zur fertigen `classpath`
- **Skin-Anzeige** (`skins:upload`/`getActive`/`vergessen` im Hauptprozess) - das
  Konto zeigt ein neutrales Personen-Symbol; ein Klick auf das Skin-Feld der
  Seitenleiste öffnet direkt die drehbare **Ganzkörper-Figur** samt zweiter
  Ebene (Hut, Jacke, Ärmel, Hosenbeine), in der sich eine **eigene** Skin-Datei
  wählen und wieder entfernen lässt. Der echte Mojang-Skinwechsel bleibt
  ausgeschlossen (siehe *Skin-Anzeige: Ganzkörper und zweite Ebene*).
- **Modpack-Import** (`modpackImport.js`) - Modrinth-`.mrpack`, CurseForge-`.zip`
  (`manifest.json`) und Prism/MultiMC-Instanzen lesen und installieren: Mods,
  Ressourcenpakete und `overrides/` in die Instanz, Zip-Slip-Schutz,
  Modrinth-Suche im UI
- **Ressourcenpakete** (`resourcepacks.js`) — Ansicht, `.zip`-Import, Löschen
  und der Schalter, der die `resourcePacks`-Zeile der `options.txt` anfasst
- **Grundschrift Geist** - die lizenzfreie Schrift (OFL) liegt lokal in
  `src/renderer/assets/fonts/` bei und ist die Standard-Schrift der Oberfläche;
  aus dem Netz wird keine Schrift geladen
- **12 Themes**, Sidebar, Instanz-Auswahl, Account-Verwaltung im UI

### Modpack-Import (Modrinth + CurseForge + Prism)

Der „Neues Modpack"-Dialog hat eine Import-Sektion: eine Modpack-Datei wird
gelesen und als neue Instanz angelegt — ganz ohne von Hand `mods/` und
`resourcepacks/` zu befüllen.

- **Zwei Formate.** Modrinth-`.mrpack` und CurseForge-`.zip` mit
  `manifest.json`. Das Prüfen zeigt erst die Zusammenfassung (Name,
  Pack-Version, Minecraft-Version, Modloader); geschrieben wird nichts, bevor
  nicht *Importieren* geklickt ist.
- **Wohin was kommt.** Mods nach `mods/`, Ressourcenpakete nach
  `resourcepacks/`, der Rest aus `overrides/` bzw. `client-overrides/` direkt
  in die Instanz. Steht dieselbe Datei in beiden `overrides`-Ordnern, gewinnt
  `client-overrides`. Bestehende Dateien bleiben ohne `ueberschreiben` stehen
  und werden als übersprungen gemeldet.
- **Zip-Slip wird abgelehnt, nicht repariert.** Jeder Pfad, den ein Pack
  schreiben will (Overrides und Downloads), wird vorher gegen den Instanzordner
  geprüft. Ein Pack mit `../`-Pfaden wird abgelehnt; nichts wird geschrieben,
  und eine halb angelegte Instanz wird wieder entfernt — es bleibt kein
  Geisterordner.
- **Modrinth-Suche direkt im UI.** Die Treffer zeigen Name, Minecraft-Version
  und Downloads; der Import holt die primäre `.mrpack`-Datei.
- **CurseForge: Die Such-API braucht einen Schlüssel, der Datei-Import
  nicht.** Ohne hinterlegten `curseforgeApiKey` (in `settings.json`, über die
  Einstellungen) antwortet die Suche mit einer verständlichen Meldung. Eine
  `.zip`-Datei lässt sich trotzdem importieren: die Dateien aus dem Manifest
  werden über ihre `downloadUrl` geladen.
- **Quilt und NeoForge werden ehrlich abgelehnt.** Der Launcher startet
  vanilla, fabric und forge. Ein Pack, das `quilt` oder `neoforge` verlangt,
  wird beim Import mit einer Meldung abgewiesen und legt keine Instanz an —
  eine Instanz, die sich nicht starten lässt, wäre schlimmer als keine.
- **Wurzelordner, Spiegel und Server-Mods.** Wurde das Zip aus einem Ordner
  gepackt, liegt z. B. `manifest.json` nicht ganz oben - der Import findet sie
  trotzdem. Mehrere `downloads`-Adressen werden der Reihe nach versucht, und
  Einträge, die nur für den Server gedacht sind (`env.server`), werden beim
  Client-Import übersprungen statt als Fehler gemeldet.
- **CurseForge auch ohne Schlüssel - und mit echtem Dateinamen.** Fehlt eine
  `downloadUrl`, wird öffentlich über
  `curseforge.com/api/v1/mods/<projekt>/files/<datei>/download` geladen. Der
  Dateiname steht erst nach den Weiterleitungen fest und wird aus der Endadresse
  übernommen; eine Text/HTML-Antwort wird abgelehnt, statt als kaputte `.jar`
  im `mods/`-Ordner zu landen.
- **Prism / MultiMC.** Ein Pack mit `instance.cfg` und `mmc-pack.json` wird
  erkannt; Name, Minecraft-Version und Loader kommen aus diesen Dateien, und der
  `.minecraft`-Spielordner wird übernommen. Es gilt derselbe Zip-Slip-Schutz.
- **Aufräumen bei Fehlschlag.** Bleibt am Ende keine einzige Datei installiert
  (nur Fehler), wird die eben angelegte Instanz wieder entfernt - ein leerer
  Import sieht sonst wie ein Erfolg aus.
- **Verifiziert.** 140 Prüfungen in `test-modpack-import.js`, 18 weitere in
  `test-modpack-import-formate.js` (Wurzelordner, Spiegel-URLs, Server-Mods,
  Prism/MultiMC, CurseForge ohne Schlüssel, Dateiname aus dem Download) -
  darunter roh gebaute Zips mit echten `../`-Angriffen - und 57 Prüfungen im
  echten Fenster in `test-modpack-import-fenster.js` (Import über die
  Oberfläche, Ablehnung, Modrinth-Suche, vier Sprachen).

### Ressourcenpakete einfügen und entfernen

Der Launcher verwaltet die Ressourcenpakete **der gewählten Instanz** — dieselbe
Idee wie beim Modpack-Import, nur für Texturen und Sprachdateien.

- **Der Ordner ist die Wahrheit.** Gelesen wird
  `<instanz>/resourcepacks/`. Ein Paket darf ein `.zip` **oder** ein entpackter
  Ordner sein; Minecraft akzeptiert beide, also zeigt der Launcher beide an.
- **Ein- und ausschalten im Spiel.** Minecraft kennt dafür kein
  Kommandozeilenargument. Der Schalter steht in `<instanz>/options.txt` in der
  Zeile `resourcePacks:[…]`. `resourcepacks.js` liest die Datei, ersetzt **nur
  diese eine Zeile** und lässt Reihenfolge, Kommentare und alle anderen Optionen
  unangetastet — ein komplettes Neuschreiben würde die Datei zerstören.
  `vanilla` bleibt immer erhalten: ohne diesen Eintrag startet das Spiel ohne
  Standardtexturen.
- **Doppelte Namen werden gemeldet, nicht stillschweigend bevorzugt.** Liegt
  dasselbe Paket einmal als `.zip` und einmal als Ordner vor, sagt der Launcher
  das, statt eines der beiden zu wählen.
- **Anzeige aus `pack.mcmeta`.** Das `pack_format` wird einer Minecraft-Version
  zugeordnet. Die Tabelle ist bewusst **unvollständig**: ab Format 24 (1.21.7
  und neuer) steht nichts mehr darin, und ein unbekanntes Format wird als
  „neuer als bekannt" beschriftet — eine geratene Zahl in einer Versionsanzeige
  wäre schlimmer als eine fehlende.
- **Ein defektes Paket stürzt nichts ab.** Fehlt oder bricht `pack.mcmeta`,
  wird das Paket trotzdem gelistet, mit dem Hinweis, und lässt sich löschen.
- **Import ohne Netz.** Ein eigener Dateidialog nimmt ein `.zip` an und kopiert
  es in den `resourcepacks/`-Ordner; der Kanal ist `packs:importLocal`.
- **Vorschaubild.** `pack.png` wird aus dem `.zip` bzw. dem Ordner gelesen und
  als Data-URL in die Liste gegeben, damit jedes Paket sein eigenes Bild zeigt
  statt eines allgemeinen Symbols. Dateien über 256 KB werden **nicht**
  eingebettet — dann bleibt das Symbol stehen, statt die Liste mit Megabyte
  durch den IPC-Kanal zu füllen. Fehlt `pack.png`, ist das kein Fehler.
- **Verifiziert.** 131 Prüfungen in `test-ressourcenpakete.js` (reines Node:
  Lesen, Ein-/Ausschalten, Zip-Slip, Versionstabelle, Vorschaubild) und 63 im
  echten Fenster in `test-ressourcenpakete-fenster.js`.

### Skin-Anzeige: Kopf, Ganzkörper und zweite Ebene

Der Skin erscheint an drei Stellen als Kopf und im Skin-Feld als ganze Figur.
Ein Klick auf das Skin-Feld der Seitenleiste öffnet direkt die
Ganzkörper-Ansicht.

- **Kopf an drei Stellen.** Neben dem Microsoft-Konto in der Liste, im Feld der
  Seitenleiste und in der Profilkarte zeigt der Launcher den Kopf des Skins.
  Der Kopf ist der 8×8-Ausschnitt der 64×64-Vorlage: Vorderseite bei `[8,8]`,
  Hut-Ebene bei `[40,8]`, als zwei Hintergrundbilder übereinander
  (`skinKopfStil`, `image-rendering: pixelated`). Ohne Skin steht dort weiter
  das neutrale Personen-Symbol. Kein fremder Dienst (etwa crafatar): die
  Textur ist dieselbe, die die Ganzkörper-Figur ohnehin lädt.

- **Die volle Gestalt zeigt weiter alles.** Ein Kopf ist bei einem Skin nur ein
  Achtel der Figur; die Ganzkörper-Ansicht zeigt deshalb zusätzlich die zweite
  Ebene (Hut, Jacke, Ärmel).
- **Die Figur wird aus der Textur gebaut, nicht auf ein Bild gehofft.** Aus der
  64×64-Skin-PNG (auch das alte 64×32-Format wird erkannt) setzt der Renderer
  sechs Körperteile als CSS-3D-Boxen zusammen (`SKIN_TEILE`): Kopf, Körper,
  zwei Arme, zwei Beine. Alle Flächen liegen an festen Texturpositionen, kein
  Pixel wird verschoben; `image-rendering: pixelated` hält die Pixel scharf.
- **Die zweite Ebene sitzt direkt darüber.** Hut, Jacke, beide Ärmel und beide
  Hosenbeine (`ebene2`) sind eigene, leicht größere Flächen über der Grundfigur.
  Wo der Skin dort leer ist, bleibt die Fläche durchsichtig, die Grundschicht
  bleibt sichtbar; die Rückseiten sind ausgeblendet (`backface-visibility:
  hidden`), damit ein leerer Layer nichts verdeckt.
- **Drehen von Hand, stiller Selbstlauf nur ohne "Weniger Bewegung".** Ziehen
  dreht die Figur; ohne `ll-wenig-bewegung` läuft sie zusätzlich leise von
  selbst und pausiert während des Ziehens. Die Größe richtet sich nach dem
  Fenster.
- **Eigene Datei wählen und "Vergessen".** Beide Knöpfe sitzen in der
  Ganzkörper-Ansicht. Ein `.png` wird geprüft (echte PNG-Signatur, IHDR mit
  64×64 oder 64×32, höchstens 2 MB) und nach
  `%APPDATA%\Liquid Launcher\skins\skin.png` kopiert. "Vergessen" entfernt
  sie wieder; danach greift wieder der Account-Skin.
- **Was das *nicht* ist: kein echter Skin-Wechsel.** Der Launcher zeigt eine
  eigene Datei nur **lokal an**. Den Skin auf dem Mojang-Konto zu ändern geht
  ausschließlich über die Session-API mit einem angemeldeten Microsoft-Konto -
  `skins:setActive` bleibt deshalb bewusst abgelehnt. Ohne das anzumeldende
  Konto gibt es keinen Weg, und einen zu erfinden wäre eine Lüge in der
  Oberfläche.
- **Verifiziert.** 15 Prüfungen in `test-skin-ganzkoerper.js` (reines Node) für
  die Ganzkörper-Figur: dass die alte, kaputte Profilkarten-Kopfanzeige weg
  ist, dass das Feld der Seitenleiste die Figur direkt öffnet, dass Auswahl,
  Entfernen und Meldung dort sitzen, die sechs Teile der zweiten Ebene samt
  Texturkoordinaten, die durchsichtige Grundfläche und das Erkennen des alten
  64×32-Formats. Dazu die Kopf-Prüfungen in `test-startseite.js`: die drei
  Stellen, die Textur-Ausschnitte `[8,8]` und `[40,8]`, der neutrale Rückfall
  und dass kein fremder Kopf-Dienst im Renderer steht.

### Startseite: die erste Einrichtung

Beim ersten Start erscheint eine Startseite, die in vier Schritten alles
Wesentliche einstellt. Sie ist überspringbar und lässt sich später über die
Einstellungen erneut öffnen.

- **Vier Schritte.** Sprache (dieselben neun Sprachen wie in den Einstellungen),
  Microsoft-Konto (Client-ID und Anmeldung), erste Instanz (Name, Version aus
  dem echten Versionsmanifest, Modloader) und ein Abschluss mit der
  Zusammenfassung. „Weiter", „Zurück" und „Überspringen" sitzen fest am Fuß;
  die Schrittleiste oben springt direkt zu einem Schritt.
- **Nur beim ersten Start.** Der Abschluss wird als `onboardingDone` in
  `settings.json` gemerkt (`settings:get/set` führt Teilwerte zusammen, der
  Hauptprozess braucht dafür keine neue Route). Fehlt der Wert, gilt die
  Einrichtung als offen.
- **Die Texte folgen der Sprache.** Sie stehen nicht als `data-i18n` im Markup,
  sondern werden über `obTexteAnwenden()` aus `t()` geholt. So muss der
  Onboarding-Bereich nicht in allen neun Sprachblöcken mitwachsen, und die
  Sprachparität in `test-einstellungen.js` bleibt unberührt.
- **Ohne echte App bleibt nichts kaputt.** Fehlt `window.launcher` (Vorschau im
  Browser), zeigt der Kontoschritt einen freundlichen Hinweis statt eines
  Absturzes; die Instanz-Versionen kommen dann aus dem Mock.
- **Verifiziert.** `test-startseite.js` (reines Node, 54 Prüfungen) sichert
  Aufbau und Verdrahtung: die drei Kopf-Stellen, die vier Schritte, die
  Client-ID-/Anmelde-/Instanz-Verdrahtung, `onboardingDone`, das erneute
  Öffnen und die neun Sprachen des Textblocks.

### Kleine Korrekturen aus der Ideen-Liste

Die erste Runde der Ideen-Liste betraf Fehler und Kleinigkeiten. Jede ist
einzeln umgesetzt und einzeln abgesichert:

- **Mod-Installation bleibt nicht mehr auf „Lädt …" hängen.** Der Knopf im
  Suchergebnis wurde nach einem erfolgreichen Download nie zurückgesetzt — die
  Mod lag bereits im `mods`-Ordner, der Knopf zeigte aber weiter den
  Ladezustand. Er zeigt jetzt „Installiert" (neuer Schlüssel
  `mod_installed_btn` in allen neun Sprachen); im Fehlerfall wird er sofort
  wieder freigegeben, statt zwei Sekunden gesperrt zu bleiben.
- **Installierte Mods zeigen ihr Projektbild.** `downloadModForInstance` legt
  `iconUrl` (Modrinths `icon_url`) in `mods-meta.json` ab; die Liste der
  installierten Mods benutzt dasselbe `modIconHtml` wie die Suche. Von Hand
  hineingelegte `.jar`-Dateien ohne Metadaten behalten das allgemeine Symbol.
- **Ressourcenpakete zeigen `pack.png`** als Vorschau (Details im Abschnitt
  *Ressourcenpakete einfügen und entfernen*).
- **Konten tragen ihren Minecraft-Kopf** statt eines Emoji-Smileys: zuerst die
  rohe Skin-PNG (auf die Vorderseite zugeschnitten), sonst das fertig
  gerenderte Kopfbild, sonst der Smiley als Rückfall.
- **Der Schalter ist aus = grau, an = farbig.** Der Zustand war schon vorher
  semantisch richtig, aber der fast weiße Griff ließ „aus" wie eine schwache
  Aktivierung aussehen. Jetzt: matte graue Spur mit Innenlicht gegen eine
  leuchtende Akzent-Spur mit Glanzkante.
- **Microsoft-Login-Karte aus den Einstellungen entfernt** (Details im
  Abschnitt *Einstellungen*).
- **Die helle „Leiste" über der Einstellungs-Suche** war der klebende Kopf mit
  hellem Verlauf; er ist jetzt ein dunkler, weich verlaufender Blur, und das
  Suchfeld selbst ist ohne Fokus unsichtbar.
- **Modpack-Auswahl heißt „Entfernen" statt „Löschen"** (in allen neun
  Sprachen). Das Verhalten bleibt endgültig — die Beschriftung verspricht nur
  nicht mehr fälschlich ein bloßes Herausnehmen.
- **Die Startoptionen sind in die Einstellungen gewandert.** Der eigene
  Seitenleisten-Punkt „Startoptionen" ist weg; RAM und Fenstergröße der
  gewählten Instanz stehen jetzt als vierte Karte in den Einstellungen. Die
  Feld-IDs sind unverändert geblieben, damit die bewährte Speicherlogik
  (500 ms nach der letzten Eingabe, Prüfung im Haupt-Prozess) ohne Umbau
  weiterläuft.
- **Widgets übersetzen sich mit.** Titel und Beschreibung in `widget.json`
  dürfen jetzt je Sprache angegeben werden, und die Kacheln bekommen ihre
  Beschriftungen über die `daten`-Nachricht (Details im Abschnitt *Widgets auf
  der Startseite*).

**Verifiziert.** 75 Prüfungen in `test-ideen-fixes.js` (statisch gegen die
ausgelieferten Dateien, inkl. der Einstellungskarten, des entfernten
Startoptionen-Punkts, der Widget-Sprachschlüssel, der gestaffelten
Kachel-Einblendung und des Schnellzugriffs samt Screenshot) und 6 neue
Prüfungen in `test-ressourcenpakete.js` für das `pack.png`-Vorschaubild.

### Die weiße Leiste im Modpack-Dialog

Beim Ausklappen der Versionsliste in *Neues Modpack* war die Optionsliste weiß
auf weiß: das Popup eines nativen `<select>` zeichnet Chromium/Windows mit
weißem Systemhintergrund, während die Optionstexte über das eigene Stylesheet
weiß waren. Gemessen an 60 echten Versionen aus dem Mojang-Manifest:
Optionstext `rgb(255,255,255)` auf `rgb(22,50,63)` nach dem Fix. Dazu kam ein
Ladezustand („Lade Versionen …") und ein Leerzustand: eine leere Liste wird
**nicht** gespeichert, damit ein einmaliger Netzfehler beim nächsten Öffnen
erneut lädt statt dauerhaft leer zu bleiben.

### Bewegen beim Überfahren

Karten und Listenzeilen folgen dem Zeiger leicht — dieselbe Idee wie an den
Buttons in der Seitenleiste, nur schwächer.

| | Weg | Skalierung |
|---|---|---|
| Buttons, Schalter, `.nav-item` (bestehend) | 0.28, bis 10px | 1.03 |
| Karten und Zeilen (neu) | 0.16, bis 5px | keine |

Erfasst sind `.world-card`, `.mod-row` (Accounts), `.srv-row` (Server),
`.stat-tile` und `.lang-row`.

Nicht alle Karten bewegen sich — manche reagieren nur sichtbar:

| | reagiert sichtbar | bewegt sich mit |
|---|---|---|
| `.world-card`, `.mod-row`, `.srv-row`, `.stat-tile`, `.lang-row` | ja | ja |
| `.hero`, `.profile-card`, `.stat-card`, `.shortcut-card`, `.settings-karte`, `.glass`, `.we-card`, `.opts-card` | ja | **nein** |

Die zweite Zeile bekommt nur die Optik (Rahmen, Schatten, Anhebung) — ein
wandernder Block ohne eigenen Klick-Handler sieht nach kaputtem Layout aus.
`.stat-card` ist außerdem der *Container* über der Kachelreihe; läge der
Selektor dort, wanderte die ganze Karte samt Überschrift mit.

`.hero` und `.profile-card` sind aus der Bewegung wieder herausgenommen worden:
Beide sind große, ruhige Flächen, und ein langsames Nachwandern großer Blöcke
lenkt mehr ab, als es Leben in die Oberfläche bringt. Sie heben sich beim
Überfahren weiterhin leicht an (CSS), folgen dem Zeiger aber nicht mehr —
`HOVER_SELECTOR` führt sie nicht. `test-hover-move.js` misst das an beiden
Karten als „bleibt still".

**Bewusst nicht erfasst:** die frühere Newskarte ist inzwischen der
Schnellzugriff (siehe unten), und `.settings-row` sind reine Beschriftungszeilen.

Vier Fehler, die dabei auffielen und die `test-hover-move.js` festhält:

1. **Der Bezugspunkt muss beim Betreten festgehalten werden.** Wird er bei
   jedem `mousemove` neu aus `getBoundingClientRect()` gelesen, schiebt das
   Element seinen eigenen Referenzpunkt mit. Am Rand entsteht dann ein
   Flackern: Element wandert aus dem Zeiger → `mouseout` → zurückschnellen →
   wieder unter dem Zeiger → `mouseover` → von vorn. Bei breiten Zeilen wie
   `.srv-row` ist das sichtbar, bei den 46px-Buttons nicht — die kommen
   ohnehin nicht weit genug, um herauszurutschen.
2. **Stufe 1 muss Vorrang haben, wenn ein Button in einer Karte steckt.**
   Sonst wandert beides: die Karte als Karte und der Button als Button. Der
   Guard sitzt deshalb im gemeinsamen `hoverTarget()`.
3. **Inline-Styles müssen nach dem Rücklauf wieder weg.** `el.style.transition`
   überschreibt sonst dauerhaft die Transition aus dem CSS, und das nächste
   Aufblitzen verläuft sich anders, als das Stylesheet es vorsieht.
4. **Der `mousemove`-Pfad muss genauso gesperrt sein wie der `mouseover`-Pfad.**
   Der Zustand in `hoverState` überlebt das Verlassen einer Karte absichtlich
   520 ms, damit der Rücklauf weich aussieht. In diesem Zeitfenster bewegt
   sich die Karte trotz abgeschalteter Bewegung weiter — und schaltet man
   genau darin den Schalter „Weniger Bewegung" um, wandert sie unter dem
   Zeiger weiter, während man auf die Einstellung schaut, die man gerade
   ausgeschaltet hat. Beide Pfade fragen deshalb `bewegungAus()`, und
   `bewegungAnwenden()` räumt über `hoverAufraeumen()` alles weg, was gerade
   unterwegs ist.

**Verifiziert.** 29 Prüfungen in `test-hover-move.js`, das den echten Code aus
`index.html` lädt statt einer Kopie. Abschnitt 7 prüft beide Bewegungsquellen
(Windows-Einstellung *Animationseffekte* und der eigene Schalter) an beiden
Stufen. Zusätzlich im echten Electron-Fenster gemessen: eine Kachel mit
196×78 px sitzt bei `translate(4.72px, 2.92px)` nach simuliertem Zeigerkontakt,
also unterhalb der 5px-Grenze. **Nicht verifiziert:** die Optik mit eigenen
Augen — gemessen ist die Geometrie, nicht das Aussehen.

### Einstellungen

Die Ansicht *Einstellungen* ist von einer langen Liste von Zeilen zu vier
Karten umgebaut worden, in **einer einzigen Spalte**. Ein zweispaltiges Raster
wurde verworfen: bei der vorgegebenen Breite rutschten die Karten in drei
Spalten und die Zuordnung wurde unübersichtlich — eine Spalte liest sich von
oben nach unten, ohne dass das Auge zwischen Spalten springt.

| Karte | Inhalt |
|---|---|
| **Darstellung** | Sprache, Schrift, Textgröße, eigene Schriftdatei, „Weniger Bewegung" |
| **Karten-Layout** | Raster der Startseite ansehen und anordnen |
| **Widgets** | Widgets hinzufügen |
| **Startoptionen** | RAM und Fenstergröße der gewählten Instanz |

Die frühere Karte **Microsoft-Login** (Eingabefeld, „Entfernen"-Knopf,
aufklappbare Azure-Anleitung) ist entfernt: Sie war die einzige Karte mit freiem
Text, ein Fremdkörper im Raster aus Auswahl-Elementen, und das Feld wurde nur
einmal beim Einrichten gebraucht. Die Client-ID wird jetzt über
`setup-client-id.js`, `config.json` oder `LIQUID_LAUNCHER_CLIENT_ID` gesetzt;
fehlt sie, nennt der Login-Dialog den Portalweg selbst.

Die frühere Karte **Fenster** (Breite, Höhe, Position, zentrieren,
zurücksetzen) ist ebenfalls entfernt. Die Fenstergröße stellt man am
Fensterrahmen ein, und ein Formular dafür war eine zweite, konkurrierende Stelle
für dieselbe Sache.

Ganz oben steht ein **Suchfeld**. Es findet nicht nur den sichtbaren Text,
sondern die Übersetzungen aller Sprachen: Wer auf Deutsch „schrift"
eintippt, findet die Karte auch dann, wenn die Oberfläche gerade auf Englisch
steht. Grundlage ist der Textinhalt der Karte plus alle Werte, die hinter
`data-i18n` stehen — deshalb ist der Treffer über die Sprachumschaltung hinweg
nicht blind.

#### Schrift und Textgröße

* **Schrift** — acht Systemschriften als Auswahlliste. Jede ist ein echter
  Stapel mit Rückfall, keine Familie ohne Ersatz; „Consolas" bringt als
  zweiten Eintrag „Cascadia Mono" mit, damit die Oberfläche auch dort lesbar
  bleibt, wo Cascadia fehlt.
* **Textgröße** — 85 bis 125 Prozent in Schritten von 5.
* **Eigene Datei** — eine `.ttf`/`.otf`/`.woff`/`.woff2` aus dem eigenen
  Rechner. Höchstens 4 MB, landet in
  `%APPDATA%\Liquid Launcher\schrift\`.
* **Schrift und Größe zurücksetzen** — beides auf Standard in einem Klick.

**Wie die eigene Datei in die Oberfläche kommt.** Der Renderer läuft als
`file://`, und `webSecurity` bleibt eingeschaltet — eine `@font-face`-Regel auf
einen Dateipfad würde der Browser als „Zugriff auf andere Herkunft" ablehnen.
Die Datei kommt deshalb nicht als Pfad, sondern als **Data-URI** über einen
eigenen IPC-Kanal (`schriften:waehlen` / `schriften:lesen` /
`schriften:vergessen`) aus dem Hauptprozess in die Seite. Der feste
Familienname `LiquidEigeneSchrift` ist ein Bezeichner, kein Dateiname; der
echte Dateiname steht in `settings.json` und in der Statuszeile, **nicht** in
der CSS-Regel. Die Bytes landen also nur im Arbeitsspeicher.

**Drei Dinge, die dabei auffielen:**

1. **Die Textgröße ist ein Multiplikator, kein `zoom`.** Jede `font-size` in
   `index.html` steht als `calc(Npx * var(--fs))`, und `--fs` ist der
   Faktor aus dem Regler. `zoom` am `<body>` wäre kürzer, skaliert aber
   auch Raster, Abstände und Bildmaßstäbe und macht die Kacheln des
   Layout-Rasters kaputt.
2. **Absätze ohne `calc()` wären ein stiller Fehler.** Eine nackte
   `font-size: 14px` fällt weder auf noch auf — sie ignoriert den Regler.
   `test-einstellungen.js` prüft deshalb, dass es in der ganzen Datei
   **keine** `font-size` ohne `calc` gibt.
3. **Ungültige Bytes müssen abgewiesen werden.** Eine Datei mit Müll im
   Kopf ließ sich als Data-URI einhängen, und die Oberfläche behauptete
   trotzdem „Eigene Datei", während nichts angezeigt wurde. `eigeneFontLaden()`
   prüft die Datei jetzt mit `document.fonts.load()` und fällt bei einem
   Fehlschlag auf die Systemschrift zurück — mit der Meldung *„Die Datei …
   lässt sich nicht als Schrift verwenden."* Der Test prüft beide Wege
   gegeneinander: dieselbe Datei mit brauchbaren und mit unbrauchbaren Bytes.

#### „Weniger Bewegung"

Ein Schalter in der Karte *Darstellung*. Er sperrt **beide** Stufen der
Überfahrtsbewegung — die Karten genauso wie die Knöpfe — und er wirkt
zusammen mit der Windows-Einstellung *Einstellungen → Barrierefreiheit →
Animationseffekte*. Beide Quellen laufen über eine einzige Abfrage,
`bewegungAus()`, statt zweier; zwei unabhängige Abfragen derselben Sache
laufen beim nächsten Ändern auseinander.

Zusätzlich setzt der Schalter die Klasse `ll-wenig-bewegung` auf `<html>`.
Die schaltet die weichen Übergänge ab — nicht die Bewegung selbst, das macht
`bewegungAus()`. Der Unterschied ist sichtbar: eine Karte, die gerade
unterwegs ist, hält sonst mitten in der Bewegung an.

#### Schnellzugriff statt Newskarte

Die Newskarte war statischer Text ohne Klick-Handler. Sie ist durch eine
Schnellzugriff-Karte ersetzt. Dort steht jetzt **jedes** Ziel der Seitenleiste —
**Welten**, **Mods**, **Ressourcenpakete**, **Server**, **Account**,
**Einstellungen** — plus zwei Aktionen, die es sonst nur versteckt gibt. Ein
Klick auf ein Ziel wechselt die Ansicht und setzt den Eintrag in der
Seitenleiste entsprechend. Der Kartenblock heißt im gespeicherten Layout jetzt
`shortcut` statt `news`; alte `settings.json` werden beim Start übernommen
(`layoutUebernehmen()`).

Weil acht Kacheln nicht mehr in eine Kartenhöhe passen, rollt die Karte
(`overflow-y:auto`), wenn das Fenster klein ist.

##### Screenshot und Design als Kachel

- **Design ändern** öffnet dasselbe Panel wie das Symbol unten links. Dabei
  stoppt der Klick die Weitergabe (`stopPropagation`): der globale
  Dokument-Klick schließt ein offenes Panel, sobald der Klick außerhalb liegt —
  ohne den Stopp würde das gerade geöffnete Panel im selben Klick wieder
  zugemacht.
- **Screenshot** ruft einen neuen Kanal `screenshot:capture`. Der Hauptprozess
  zeichnet das Fenster (`webContents.capturePage`) und legt das PNG unter
  `%APPDATA%\Liquid Launcher\screenshots\` ab; der Renderer bekommt **nur den
  Dateinamen** zurück, kein `fs` und keine Bytes. Schlägt die Aufnahme fehl,
  antwortet der Kanal mit `{ ok:false, fehler }` statt zu werfen — die
  Statuszeile in der Karte zeigt dann die Meldung statt still zu bleiben. Ein
  zweiter Kanal `screenshot:openFolder` öffnet den Ordner.

#### Seitenleiste als eigene Spur

Die Seitenleiste ist keine Rasterspalte mehr, sondern eine eigene schmale Spur
(72 px) **neben** dem unveränderten 6×4-Kartenraster. Sie lässt sich in
*Einstellungen → Karten-Layout* an alle vier Kanten andocken (links, rechts,
oben, unten) — ohne dass dafür eine Karte angefasst werden muss. Die
gespeicherten Koordinaten bleiben 1..6 / 1..4; `gridVersatz()` rechnet beim
Anzeigen den Versatz zur Spur um. Ein Layout aus Version 1 (Leiste als
Rasterspalte/-zeile eins) wird beim Start automatisch zurückgeschoben
(`layoutUebernehmen()`).

Beim Umgruppieren im Editor wird ein Zug **nie abgelehnt**: Stößt eine Karte
gegen eine Nachbarin, weicht die in den nächsten freien Platz ihrer Größe aus
und schrumpft nur, wenn sonst nichts passt (`naechsteFreie()`, `ausweichen()`,
`spanBegrenzen()`). Das Umräumen animiert leicht (0,35 s auf
`grid-column`/`grid-row` für die echten Karten).

#### Drei Fehler, die erst der Fenster-Test gefunden hat

1. **`syncLayout()` hat gespeichert.** Die Funktion wird beim Start und bei
   jedem einzelnen Mauspixel eines Zuges aufgerufen. Beim ersten Aufruf hat
   sie deshalb das **Standardlayout** in die Datei geschrieben, bevor das
   gespeicherte gelesen war — die eigene Anordnung der Karten war nach dem
   ersten Start futsch und kam nie wieder. Sichtbar geworden ist das an der
   Migration von `news` nach `shortcut`, die im Fenster-Test nicht griff,
   obwohl sie in `test-einstellungen.js` nachweislich vorhanden war.
   Jetzt gilt: `syncLayout()` **wendet nur an**, `layoutSpeichern()` **schreibt
  **, und das nur beim Loslassen der Maustaste — ein Zug über drei Sekunden
   schreibt nicht mehr Hunderte Dateien.
2. **Ein abgebrochener `mouseover` ließ die Karte weiterlaufen.** Siehe
   *Bewegen beim Überfahren*, Punkt 4.
3. **Die Einstellungen lagen unter der Seitenleisten-Spur.** Nach dem Umbau
   deckte das Ansichts-Overlay die ganze Fläche inklusive der 72-px-Spur ab;
   die Einstellungskarten standen bei 1400-px-Fensterbreite in drei Spalten.
   Jetzt liegt die Ansicht neben der Spur (`kartenbereichRect()`), und das
   Raster steht in einer einzigen Spalte — dieselbe Breite bei jeder
   Fenstergröße, kein Umbrechen zwischen Spalten.

**Verifiziert.** 145 Prüfungen in `test-einstellungen.js` (statisch, prüft die
ausgelieferte Datei) und 204 Prüfungen in `test-einstellungen-fenster.js` im
echten Electron-Fenster mit 1400×900, echtem `preload` und echter `index.html`.
Im Fenster gemessen: der Einstellungsbereich ist 1595 px hoch bei 664 px
sichtbar, also wirklich rollbar; die Schrift wird als `--font-ui`
angewendet; 110 % machen aus 44 px Überschrift 48,4 px; die Suche findet
`FENSTER` genauso wie `fenster`; das Layout übersteht zwei Starts
unverändert. **Nicht verifiziert:** wie es mit eigenen Augen aussieht.

### Widgets auf der Startseite

Die vier Kacheln oben in der Startseite sind jetzt Widgets. Sie liegen als
Ordner mit `widget.json` + `widget.html` im Projekt unter `widgets/`, und
eigene Widgets kommen nach `%APPDATA%\Liquid Launcher\widgets\`. Beide Wurzeln
werden gleichzeitig durchsucht — ein eigenes Widget mit derselben `id` ersetzt
ein mitgeliefertes, ohne dass Code geändert werden muss.

**Hinzufügen** in den Einstellungen unter „Widgets". **Reihenfolge und
Entfernen** auf der Startseite über „Anpassen" oben auf der Kachelreihe (ziehen
und `×`). Beides steht an zwei Stellen, weil beides verschiedene Fragen sind:
*welche* Kacheln es gibt, ist eine Einstellung, *wie sie aussehen* ist_layout_.

Mitgeliefert werden 24 Widgets. Neben den vier Grundkacheln (`uhr`, `datum`,
`welten`, `mods`) gibt es Kacheln fuer `laufzeit`, `instanzen`,
`instanz-version`, `instanz-ram`, CPU (`cpu-info`, `cpu-auslastung`),
`ram`, `laufwerk`, `netzwerk`, `java`, `launcher-version`, `spiel-prozess`,
`system-info`, `system-laufzeit`, `letzter-start`, `server-status`, `packs`,
`welten` und die drei Ordnergroessen (`speicher-instanz`, `speicher-mods`,
`speicher-welten`). **Alle zeigen echte, gemessene Werte** (Details unter
*System- und Instanz-Kacheln*). Die vollstaendige Anleitung zum Schreiben
eigener Widgets steht in **[WIDGETS.md](WIDGETS.md)**.

#### Widgets sprechen die eingestellte Sprache

Ein Widget besteht aus zwei Teilen, die beide übersetzt werden müssen: dem
**Manifest** (Titel und Beschreibung in der Verwaltung) und dem **Inhalt** der
Kachel. Beide Wege sind gebaut:

- In `widget.json` dürfen `titel` und `beschreibung` entweder ein einzelner
  String sein (wie bisher) **oder** ein Objekt je Sprache (`de`, `en`, `es`,
  `fr`, `pt`, `it`, `pl`, `tr`, `ru`, z. B.
  `{ "de": "Welten", "en": "Worlds", "es": "Mundos", "fr": "Mondes", … }`). Der
  Hauptprozess löst den Text in `widgets.js` (`SPRACHEN`) nach
  `settingsStore.language` auf; fehlt die gewählte Sprache, greift Deutsch.
- Die Kacheln bekommen die Oberflächentexte über die `daten`-Nachricht: der
  Renderer baut aus den 56 `widget_*`-Schlüsseln einen `texte`-Block
  (`window.__wdgTexte`) und reicht ihn an `WidgetHost.setzeTexte()`. Der Host
  hängt ihn an jede `daten`-Nachricht an. Die Kachel-Skripte lesen `d.texte`
  und fallen ohne ihn auf ihren eingebauten deutschen Text zurück — ältere oder
  fremde Widgets funktionieren also unverändert.

Beim Umschalten der Sprache werden sowohl die Kacheln als auch die Widget-Liste
in den Einstellungen neu gezeichnet. Bewusst **deutsch als Rückfall**: eine
fehlende Übersetzung darf keine leere Kachel erzeugen.

#### Neun Sprachen

Die Oberfläche spricht **neun Sprachen**: Deutsch, Englisch, Spanisch,
Französisch, Portugiesisch, Italienisch, Polnisch, Türkisch und Russisch. Alle
stehen als Blöcke in `TRANSLATIONS` (`index.html`) und tragen dieselben **273**
Schlüssel; `test-einstellungen.js` wertet das Objekt in einem frischen
`vm`-Kontext aus und vergleicht die Schlüsselmengen, statt sie mit einem Regex
zu raten. Die Knopfreihe in den Einstellungen entsteht datengetrieben aus
`LANGUAGE_NAMES` — eine neue Sprache braucht dort nur einen Eintrag, keinen
neuen Knopf-Code. `SPRACHEN` in `widgets.js` führt dieselben Codes, damit auch
Widget-Titel und -Beschreibungen mitwechseln.

Der deutsche Block ist die **Quelle**: fehlt in einer Sprache ein Schlüssel,
liefert `t()` den deutschen Text (und im Notfall den Schlüsselnamen) statt einer
leeren Zeile. Die Widget-Inhalte fallen ebenso auf Deutsch zurück, wenn ein
älteres Widget keinen `d.texte`-Block kennt.

#### System- und Instanz-Kacheln (Phase D4)

Aus vier Kacheln wurden 24. Alle neuen liegen im selben Projektordner
`widgets/` als Ordner mit `widget.json` + `widget.html` und werden über
denselben Mechanismus gefunden wie die alten. Hinzugekommen sind:

| Kachel | Angezeigter Wert |
|---|---|
| `cpu-info` | CPU-Kerne und Takt |
| `cpu-auslastung` | Auslastung in Prozent |
| `ram` | belegter / gesamter Arbeitsspeicher, dazu frei |
| `laufwerk` | freier Platz des Datenträgers mit den Welten (von gesamt) |
| `netzwerk` | Anzahl IPv4-Schnittstellen nach außen, dazu ihre Namen |
| `java` | benötigte Java-Version, dazu gefunden/„wird ermittelt"/„keine" |
| `launcher-version` | Version aus `package.json` |
| `spiel-prozess` | läuft ein Spiel, wie lange |
| `system-info` | Betriebssystem-Familie |
| `system-laufzeit` | wie lange der Rechner schon läuft |
| `instanz-version` | aktive Instanz und ihre Minecraft-Version |
| `instanz-ram` | RAM-Bereich der aktiven Instanz (`min–max GB`) |
| `instanzen` | Anzahl Instanzen, dazu die aktive |
| `letzter-start` | zuletzt gespielt („gerade eben"/„vor N Std."/„noch nie") |
| `server-status` | Anzahl Server, dazu „N online" |
| `packs` | Anzahl Ressourcenpakete |
| `speicher-instanz`, `speicher-mods`, `speicher-welten` | rekursiv gezählte Ordnergröße |
| `uhr`, `datum`, `welten`, `mods` | unverändert (die vier früheren) |

**Ein eigenes, reines Messmodul.** `src/main/systemdaten.js` misst die Werte und
braucht dafür kein `require('electron')` — dieselbe Regel wie `widgets.js` und
`app-path.js`, damit der Test unter reinem Node läuft. Der Hauptprozess gibt
die Pfade hinein, die er sonst aus `app` hätte.

**Nur gemessen, nichts geschätzt.** Jedes Feld ist eine Zahl aus einer echten
Quelle: `os.cpus()` zählt Takte, `os.freemem()` Bytes, `statfsSync` Blöcke,
`readdirSync` Dateien. **Eine CPU-Temperatur fehlt deshalb bewusst**: unter
Windows lässt sie sich ohne Zusatztreiber nicht auslesen, und „irgendein Wert"
wäre eine Lüge in einer Kachel, die vorgibt, gemessen zu haben. Lieber eine
Kachel ohne Wert als eine mit erfundenem.

**Die CPU-Auslastung braucht zwei Messpunkte.** `os.cpus()` liefert kumulative
Zeiten seit dem Boot; aus einem einzelnen Messpunkt folgt keine Auslastung. Das
Modul hält deshalb den letzten Messpunkt und liefert beim **ersten** Aufruf
`null` — „noch keine Angabe" statt einer Zahl, die aus nichts folgt. Erst der
zweite Aufruf nennt einen Prozentwert. `berechneAuslastung` ist eine reine
Funktion und einzeln geprüft.

**Zwei Kanäle, zwei Taktungen.** Leichte, schnell veraltende Werte (System, CPU,
Laufwerk, laufende Spiel-Prozesse) kommen über den eigenen Kanal
`widgets:systemdaten`; der Renderer
fragt ihn alle **4 s** ab (`widget-host.js`, `datenFrisch`) und lässt den Takt
aus, solange das Fenster im Hintergrund liegt (`document.hidden`). Schwere Werte
— die drei rekursiven Ordnergrößen — hängen weiterhin nur am vollen Koffer
`widgets:daten`. Ein 4-Sekunden-Takt, der jedes Mal durch `saves/`, `mods/` und
den Instanzordner wandert, wären tausende `stat`-Aufrufe pro Minute für Zahlen,
die sich kaum ändern.

**Die Positivliste wuchs von sieben auf 18 Felder** (`ERLAUBTE_DATENFELDER` in
`widgets.js`). Jedes neue Feld ist eine Zahl, ein Byte-Wert oder ein kleines
Objekt daraus — **nie ein Pfad und nie ein Benutzername**. Ein Pfad in einem
Kachel-Feld wäre ein Lesekanal in einen sandboxed Frame, den es nicht braucht.
Der Test prüft das am Ergebnis: in den Ausgaben steht kein `AppData` und kein
Laufwerksbuchstabe.

#### Die Kacheln kommen gestaffelt ins Bild

Vorher erschienen alle Kacheln im selben Frame. Jetzt bekommt jede von
`widget-host.js` eine laufende Nummer (`--wdg-i`), und das CSS verschiebt den
Anfang ihrer Einblendung um `--wdg-i * 55 ms`. Die Kacheln laufen so von links
oben nach rechts unten auf, statt auf einmal da zu sein.

Beim Zurückwechseln auf die Startseite läuft die Einblendung erneut
(`onViewChanged('play')` → `WidgetHost.kachelnAnimieren()`). Der Host entfernt
die Klasse `wdg-auf`, erzwingt einen Reflow über `offsetWidth` und setzt sie
zurück — ohne den Reflow fasst der Browser beides in einem Frame zusammen und
nichts passiert. Im **Bearbeiten-Modus bleibt sie aus**: sonst hüpft das Raster
bei jeder Umsortierung neu auf.

**Ein Detail, das leicht schiefgeht:** `animation-fill-mode` ist `backwards`,
nicht `both`. Mit `both` bliebe der Endzustand der Animation stehen und würde
das Inline-`transform` der Hover-Bewegung dauerhaft überschreiben — die Kacheln
würden sich nicht mehr unter dem Zeiger bewegen. Mit `backwards` zeigt die
Kachel während der Verzögerung ihren Startzustand und gibt danach die Kontrolle
an die Hover-Bewegung zurück. „Weniger Bewegung" und die Systemeinstellung
`prefers-reduced-motion` schalten die Einblendung ganz ab.

#### Die vier früheren Kacheln zeigten erfundene Zahlen

Das war der eigentliche Anlass. Die alten Kacheln standen fest im HTML:

```html
<div class="stat-tile"><div class="val">12,4 h</div><div class="lbl">Spielzeit</div></div>
<div class="stat-tile"><div class="val">3</div><div class="lbl">Welten</div></div>
<div class="stat-tile"><div class="val">28</div><div class="lbl">Mods aktiv</div></div>
<div class="stat-tile"><div class="val">99,4%</div><div class="lbl">Uptime</div></div>
```

Kein JavaScript hat diese Werte jemals geschrieben. `12,4 h`, `3`, `28` und
`99,4%` waren ausgeschriebene Zahlen ohne Quelle. Mit den Widgeten stehen dort
jetzt Werte, die aus dem Datenträger gezählt werden.

**Eine Kachel weniger, aus einem Grund:** es gibt keine „Spielzeit". Eine echte
Spielzeit müsste der Launcher bei jedem Start *und* Beenden mitschreiben; das ist
nicht gebaut. Eine Kachel zu bauen, die „12,4 h" anzeigt, wäre genau der Fehler
gewesen, den die alte Kachel gemacht hat — also steht dort lieber nichts.

#### Warum ein Widget keine Kachel mit `innerHTML` ist

Der naheliegende Weg wäre gewesen, den HTML-String der Kachel direkt einzusetzen.
Das ist abgelehnt. Grund: die Kachel darf echte Daten bekommen, und eine
eingesetzte Kachel könnte sich mit einem `onclick` an den Hauptframe hängen.
Ein `<iframe sandbox="allow-scripts">` kann das nicht.

Drei Regeln, die nicht verhandelbar sind:

1. **`sandbox="allow-scripts"` ohne `allow-same-origin`.** Mit
   `allow-same-origin` wäre die Kachel ein Frame wie die Hauptseite selbst, und
   `frame-busting` bringt nichts mehr: gleiche Herkunft, gleiche Rechte.
2. **Eine Positivliste der Datenfelder**, im Hauptprozess, nicht im Renderer.
   Der Renderer hält nach einem Login das Konto-Objekt; baut er den Datenkoffer
   selbst, landet das Token in einer Struktur, die ausschließlich zum Weiterreichen
   gedacht ist. Die Liste hat genau 18 Felder (vorher sieben; D4 hat elf
   ergänzt), und ein später ergänztes
   Datenfeld geht nicht automatisch mit.
3. **Der Absender wird über `event.source` geprüft, nicht über `event.origin`.**
   Ein Frame mit undurchsichtiger Herkunft hat `origin` `"null"` — eine
   Herkunftsprüfung wäre wertlos. `event.source` lässt sich nicht fälschen.

**Widgets werden nicht aus dem Internet geladen.** Auf einem Rechner, auf dem
OAuth-Tokens liegen, ist beliebiges JavaScript aus einer fremden Quelle kein
vertretbares Risiko. Der Ordner wird geöffnet, die Dateien werden von Hand
hineingelegt.

#### Was gemessen wurde

Die Behauptung „ein Widget kommt nicht an das Token" lässt sich mit keinem
DOM-Nachbau prüfen. `test-widgets-fenster.js` startet ein echtes Electron-Fenster
mit dem echten `preload.js` und der echten `index.html` und lässt ein Test-Widget
aus dem Widget-Ordner jeden Weg probieren, den ein bösartiges Widget nähme:

| | Hauptseite | Widget |
|---|---|---|
| `window.launcher` | vorhanden | `undefined` |
| `auth.getActiveAccount` (Token) | vorhanden | `undefined` |
| `require` / `process` / `module` / `electron` | – | `undefined` |
| `parent.launcher` | – | **`SecurityError`** |
| `top.launcher` | – | **`SecurityError`** |
| `localStorage` | – | **`SecurityError`** |
| `document.cookie` | – | **`SecurityError`** |

Im übermittelten JSON steht kein `accessToken`, keine Client-ID und kein
AppData-Pfad. Gegenprobe, damit das nicht vakuum-grün ist: der Hauptframe
*kann* das Token abrufen, und ein Kanal-Aufruf mit echten Testdaten liefert
`modAnzahl: 2` und `welten: 2` — nicht 0, weil die Testdaten echte `.jar`-Dateien
und echte `saves`-Ordner enthalten.

**Drei Fehler, die dabei auffielen:**

1. `widget-host.js` suchte nach einem Element `statInstanceId`, das es in
   `index.html` nie gab. Kein Absturz — die Abfrage lieferte `''`, die Kacheln
   bekamen einen leeren Datenkoffer und zeigten „0 Welten" bei einer Instanz,
   die Welten hat. Ein Absturz wäre aufgefallen, eine falsche Zahl nicht.
2. Der Sprachschlüssel hieß in den Einstellungen `language`, gelesen wurde
   `sprache` — und `language` kommt in `src/main` **null Mal** vor. Die Uhr
   zeigte deshalb unabhängig von der eingestellten Sprache immer Deutsch.
   Jetzt getestet: `sprache: "de"` ergibt `14:30`, `"en"` ergibt `02:30 PM`.
3. Der Datenkoffer enthielt ein Feld `theme`, das es nicht gibt — die
   Einstellungen speichern nur `blockLayout` und `language`. Das Feld war
   dauerhaft `null` und tat so, als gäbe es Farben. Die Farben kommen jetzt als
   eigene Nachricht aus den CSS-Variablen des Fensters, die stimmen auch nach
   einem Farbwechsel.

**Verifiziert.** 141 Prüfungen in `test-widgets.js` (Suche, Manifest inkl.
Sprachobjekt, Pfad-Traversal, Positivliste mit 18 Feldern), **81** in
`test-widget-systemdaten.js` (reines Node: die CPU-Auslastung aus zwei
Messpunkten, der erste Wert `null`, Ordnergröße und Eintragszahl mit und ohne
Ordner, die Byte-Felder ohne Pfad), 278 in `test-widget-anzeige.js` (was
die Kacheln tatsächlich anzeigen — die Widget-Skripte werden mit fester Uhrzeit
in einer Sandbox laufen gelassen; die D4-Gruppen prüfen jede neue Kachel mit
echten Daten und die „ohne Daten wird nicht geraten"-Fälle; die letzte Gruppe
prüft, dass sie `d.texte`
benutzen und ohne ihn deutsch bleiben), 72 in `test-widgets-fenster.js` (echtes
Fenster; die letzte Gruppe prüft die gestaffelte Einblendung über den
berechneten Stil).

**Nicht verifiziert:** das Aussehen. Screenshots wurden erzeugt, aber nicht mit
Augen geprüft — die Kachelhöhe von 92 px, die Raster-Umbrüche und das
Ziehen-und-Ablegen sind gemessen, nicht gesehen.

**Nicht möglich:** den gerenderten Text aus den Widget-Frames im DevTools-Kanal
auslesen. Frames mit undurchsichtiger Herkunft laufen in einem eigenen Prozess
(OOPIF) und erscheinen weder in `Page.getFrameTree` noch als
Ausführungskontext des Hauptfensters. Der erste Versuch darüber fand null Frames
und meldete leere Kacheln, ohne dass etwas kaputt war. Deshalb der zweite Weg
über die Widget-Skripte direkt.

### Tests

Skripte, die ohne Electron-Fenster laufen und daher schnell Fehler finden:

```bash
node test-launch-chain.js 1.21.4   # Argument-Kette + Client-JAR (~27 MB)
node test-fabric-loader.js         # Fabric: Maven-Libraries, Verschmelzen, Classpath (63 Prüfungen)
node test-java-runtime.js          # Java-Erkennung
node test-ipc-wiring.js            # lädt main.js/ipc-handlers.js mit Fake-Electron
node test-account-store.js         # Token-Verschlüsselung, ohne echten Account
node test-auth-errors.js           # Login-Fehler werden verständlich übersetzt
node test-worlds.js                # NBT-Leser, Welt-Metadaten, Löschschutz (94 Prüfungen)
node test-server-ping.js           # Server-Ping, MOTD, Favicons (206 Prüfungen)
node test-instance-settings.js     # RAM-/Auflösungs-Prüfung, Grenzfälle (185 Prüfungen)
node test-instances.js             # Modpack-Speicher auf der Platte (85 Prüfungen)
node test-modpack-import.js        # Modpack-Dateien: Formate, Zip-Slip, Loader (140 Prüfungen)
node test-modpack-import-formate.js # neue Import-Faelle: Wurzelordner, Prism/MultiMC, CurseForge ohne Schluessel (18 Prüfungen)
node test-ressourcenpakete.js      # Ressourcenpakete: Ordner, pack.mcmeta, options.txt, pack.png (131 Prüfungen)
node test-ideen-fixes.js           # Ideen-Liste: Mod-Knopf, Konto-Symbol, Schalter, Microsoft-Karte, Startoptionen, Widget-Sprache, Kachel-Einblendung, Schnellzugriff, neun Sprachen (139)
node test-prozess-stoppen.js        # Beenden ist kein Absturz (19, braucht Java 11+)
node test-hover-move.js             # Hover-Bewegung der Karten (29 Prüfungen)
node test-einstellungen.js          # Einstellungen, Suche, Schrift, Paritaet neun Sprachen (198 Prüfungen)
node test-snippets.js               # die injizierten Snippets sind gültiges JS (46)
node test-widgets.js                # Widget-Suche, Manifest, Positivliste, Paketfilter (141 Prüfungen)
node test-widget-systemdaten.js     # System-/Dateiwerte der D4-Kacheln (81 Prüfungen)
node test-widget-anzeige.js         # was die Kacheln wirklich anzeigen (278 Prüfungen)
node test-ms-registration.js        # Azure-Registrierung gegen Microsoft prüfen (Netz)
npx electron test-auth.js           # echter Login, isoliert (öffnet ein Fenster)
node test-full-launch.js 1.21.4 60  # echter Start, ohne UI (ca. 500 MB beim ersten Mal)
node_modules\electron\dist\electron.exe test-widgets-fenster.js      # echtes Fenster (72)
node_modules\electron\dist\electron.exe test-einstellungen-fenster.js # echtes Fenster (205)
node_modules\electron\dist\electron.exe test-schnellzugriff-fenster.js # echtes Fenster: Kacheln, Design-Panel, Screenshot-Kanal (18)
node_modules\electron\dist\electron.exe test-modpacks-fenster.js      # echtes Fenster (74)
node_modules\electron\dist\electron.exe test-modpack-import-fenster.js # echtes Fenster: Import-Dialog, Suche, 4 Sprachen (57)
node_modules\electron\dist\electron.exe test-ressourcenpakete-fenster.js # echtes Fenster: Ansicht, Schalter, Loeschen (63)
node test-skin-ganzkoerper.js       # Ganzkoerper-Figur, zweite Ebene (15 Prüfungen)
node test-startseite.js             # Skin-Kopf an drei Stellen, erste Einrichtung (54 Prüfungen)
```

`test-modpacks-fenster.js` heißt mit dem Zusatz `-fenster`, weil ein Test ohne
das echte Fenster unter `node` zwar startet, aber nichts prüft: er braucht ein
`BrowserWindow` und antwortet auf `instances:*` mit dem echten `instances.js` auf
einem eigenen `userData`. Es ist deshalb kein Nachbau der Speicherlogik, sondern
die Oberfläche gegen die echte.

`test-prozess-stoppen.js` startet keine 500 MB, sondern eine winzige
`.java`-Datei als Ersatz für das Spiel. Das ist kein Test über eine nachgebaute
Logik: `process.js` läuft unverändert, gespawnt wird wirklich, der Abschluss- und
der Stopp-Zweig wirklich. Nur das Spiel ist ein Ersatz — nötig, weil sich der
Fehler genau dort zeigt, wo ein Prozess mit *unklarem* Exit-Code endet, nachdem
jemand *Beenden* geklickt hat, und ein echter Rundlauf diese Kombination selten
liefert. Fehlt ein startbares Java, meldet der Test das als Fehlschlag, nicht als
Bestand.

`test-widgets-fenster.js` und `test-einstellungen-fenster.js` brauchen das
`electron.exe` aus `node_modules` direkt und nicht `npx electron` — sie setzen
vor `registerIpcHandlers()` ein eigenes `userData`, damit der Test weder das
echte `accounts.json` noch den echten Widget-Ordner anfasst. Der Widget-Test
meldet Konsolenfehler, trennt dabei aber zwischen Fehlern der App und solchen,
die der Test selbst verursacht: die Fensterkanäle (`window:*`) liegen in
`main.js` und nicht in `ipc-handlers.js`, also registriert dieser Test sie
nicht.

**"Neustart" in den Fenster-Tests heißt nicht "Seite neu laden".**
`settings.json` wird bei `registerIpcHandlers()` genau einmal von der Platte
gelesen. Ein blasses `reload()` lieferte deshalb den alten, im Speicher
liegenden Stand — und alle Persistenz-Prüfungen wären grün gewesen, ohne dass
irgendetwas gespeichert worden wäre. Die Fenster-Tests melden deshalb **alle**
Kanäle ab, die in `ipc-handlers.js` vorkommen (die Liste wird aus der Quelle
gelesen, nicht abgetippt), und registrieren sie neu.

Drei Dinge, die bei diesen Tests Zeit gekostet haben und die darum hier
stehen:

1. **Ein Fenster, nicht ein neues pro Abschnitt.** Chromium verweigert
   gelegentlich das Laden (`ERR_FAILED (-2)`), wenn das vorherige gerade
   abgeräumt wird.
2. **Jedes injizierte Snippet wird einzeln auf Syntax geprüft**
   (`test-snippets.js`). `node --check` auf der *Testdatei* meldet einen fehlenden Backtick
   **nicht**: der Backtick schließt den Template-String, und alles danach
   wird stillschweigend zu Text im String. Die Datei ist gültiges JavaScript
   und tut nicht, was da steht. Der Fehler tauchte dann erst zur Laufzeit
   drüben im Renderer auf, als `Uncaught SyntaxError` ohne Zeilennummer
   vom echten Code.
3. **Ein fehlendes DOM-Element ergibt eine falsche Zahl, keinen Absturz.**
   Ein `querySelector` mit leerem Ergebnis liefert `0`, `null` oder `''` —
   der Test meldet „0 Treffer" und man sucht den Fehler im Programm, während
   er im Test steht. Deshalb hat jeder Test eine Kontrolle, und jede Messung
   steht neben einer zweiten Messung, die sich vom selben Wert unterscheiden
   muss: gültige gegen unbrauchbare Datei, gültiger gegen ungültiger Pfad,
   gespeichertes Layout gegen Standardlayout.

`test-launch-chain.js` prüft unter anderem, dass die Client-JAR an erster
Stelle der Classpath steht, dass keine macOS-Bibliotheken auf der Windows-Classpath
landen, dass `--demo` **nicht** gesetzt ist und dass kein `${platzhalter}`
unersetzt bleibt.

`test-account-store.js` braucht keinen Microsoft-Account: `safeStorage` wird als
Fake injiziert. Geprüft wird, dass **kein** Klartext-Token auf der Platte
landet, dass der Round-Trip funktioniert, dass nach außen keine Token-Felder
gelangen und dass eine kaputte `accounts.json` den Launcher nicht umwirft. Der
Test hat während der Entwicklung einen echten Bug gefunden: im Pfad ohne
Verschlüsselung wurden die Accounts samt Metadaten übersprungen und waren damit
aus der UI verschwunden.

`test-ipc-wiring.js` prüft zusätzlich, dass `auth:addAccount` ohne hinterlegte
Client-ID mit einer *brauchbaren* Meldung abweist (die den Portalweg, den
Redirect-URI und die `config.json` nennt) statt mit `Cannot read property of
undefined` — und dass der Default-Redirect zu msmcs Endpunkt passt. Außerdem
prüft es die beiden Startoption-Kanäle über den echten IPC-Kanal: dass
`instanceSettings:set` bei einem Tippfehler **nicht** wirft, sondern mit
`fehler` antwortet und den alten Stand unangetastet lässt, und dass eine reine
Auflösungsänderung den RAM nicht zurücksetzt.

`test-worlds.js` braucht kein Fenster und keine Spieldateien. Der Test
schreibt sich `level.dat`-Dateien selbst (inklusive kaputter und
falsch-strukturierter NBT) und prüft 94 Dinge: alle zwölf Tag-Typen des Parsers,
welche Felder woher kommen, Ordner mit Punkt-Präfix, abgebrochene
Größenberechnung, das Nicht-Vorhandensein eines Spielernamens — und 20
Löschangriffe, gefolgt von der Kontrolle, dass ein Beweisordner mit Testdaten
unangetastet blieb.

`test-server-ping.js` startet **echte TCP-Server, die das Protokoll sprechen**,
statt die Antworten zu mocken. Geprüft werden 206 Dinge: neun gültige und
elfen zurückgewiesene Adressen, der vollständige Rundlauf auf Byte-Ebene (die
Handshake-Bytes werden einzeln inspiziert), ein Server ohne Pong, sechs
Fehlerfälle, sechzehn MOTD-Formen, feindliche MOTDs (10.000 Ebenen tief,
5.000 Komponenten, 500.000 Zeichen, Steuerzeichen) mit Zeitmessung, die
Favicon-Prüfung und die JSON-Serialisierbarkeit des Rückgabewerts.

Ein Detail an diesem Test, das Zeit gekostet hat: `net.Server` hat **kein**
`closeAllConnections()` — das gibt es nur auf `http.Server`. Der Wunsch, nach
dem Test schnell fertig zu werden, wurde mit einem Aufruf erledigt, den es auf
`net.Server` nicht gibt. Der Test brach daraufhin mit
`closeAllConnections is not a function` ab. Der eigentliche Fehler lag tiefer:
`net.Server.close()` wartet auf **jede** offene Verbindung, und der Client hat
nur seinen eigenen Socket zerstört — der Server-Socket blieb offen, `close()`
hing fest, und Node beendete das Skript mit Exit 0 **ohne eine einzige
Zusammenfassung**. Ein Test, der stillschweigend grün aussieht, obwohl er
hängen blieb, ist schlimmer als ein roter. Die Hilfsfunktion zerstört ihre
Sockets jetzt selbst.

Und: **Minecraft setzt zwischen zwei Chat-Komponenten kein Trennzeichen.**
`{"extra":["A","B","C"]}` ergibt `"ABC"`, nicht `"A B C"`. Der erste Testlauf
hatte hier die falsche Erwartung — nicht der Code. Wer Leerzeichen erwartet, hat
die Chat-Semantik falsch verstanden und würde im echten Spiel einen
zusammenklebenden Text sehen.

### Registrierung prüfen, ohne sich anzumelden

`test-ms-registration.js` beantwortet die Frage, die bei *„Login schlägt fehl"*
sonst keiner beantworten kann: Ist die Azure-Registrierung schuld, oder das
Konto, oder das Spiel? Es geht dafür keine Anmeldung durch und speichert
nichts — es stellt genau die Autorisierungs-URL, die msmc später auch stellt,
und schaut, was zurückkommt.

Das Skript **prüft zuerst seine eigene Prüfung.** Es fragt zusätzlich eine
absichtlich erfundene Client-ID ab und verlangt, dass die *diese* als Fehler
erkannt wird. Findet es sie nicht, sagt es das und bricht ab, statt ein grünes
Häkchen zu drucken.

Nicht aus Übervorsicht. Der erste Versuch suchte nach `AADSTS`-Fehlercodes und
meldete „Registrierung gültig" — und dieselbe Antwort kam bei
`00000000-0000-0000-0000-000000000000`. Die Prüfung war wertlos und behauptete
das Gegenteil. Grund: die Fehlerseite von Microsoft nennt weder `AADSTS` noch
eine Nummer, sondern nur Klartext:

> We're unable to complete your request
> **unauthorized_client:** The client does not exist or is not enabled for consumers.

Erkennbar ist sie stattdessen an der Größe (3.500 gegen 30.640 Zeichen), am
`Error Info`-Kommentar und an diesem Text. Das Skript wertet deshalb vier
unabhängige Merkmale aus.

Ergebnis für die hinterlegte ID: Microsoft liefert die echte Anmeldeseite mit
Passwortfeld, keine Fehlerseite. Die Registrierung ist gültig.

**Was daraus nicht folgt — und was trotzdem sehr leicht falsch gelesen wird.**
Das Skript hat einmal zum Schluss ausgegeben: *„✅ Die App-Registrierung ist
gültig. Der Login sollte jetzt funktionieren."* Dieser Satz war falsch, und zwar
an einer Stelle, an der man nicht auf die Idee kommt, ihm zu misstrauen: Am
27.09.2026 lief genau diese geprüfte Registrierung durch drei weitere Stufen
und wurde an der letzten mit `Invalid app registration` abgewiesen.

Der Fehler war die Verwechslung von **gültig** und **freigeschaltet**:

| | bedeutet | geprüft durch dieses Skript |
|---|---|---|
| *gültig* | Microsoft kennt die `client_id` und liefert die Anmeldeseite | ✅ ja |
| *freigeschaltet* | die App darf `login_with_xbox` benutzen | ❌ nein |

Der Test fragt nur den Autorisierungs-Endpunkt. `login_with_xbox` — der
Endpunkt, der tatsächlich blockiert — wird gar nicht angefragt. Er kann eine
kaputte Registrierung zuverlässig zeigen, aber eine freigeschaltete
**niemals** bestätigen. Ein grünes Häkchen ist deshalb eine Abwächsprobe, kein
Nachweis. Der Erfolgssatz des Skripts sagt das jetzt ausdrücklich.

Deshalb ist `Registrierung-pruefen.bat` auch das Werkzeug für den Fall, dass die
Client-ID später einmal wechselt: es fängt einen Tippfehler in der GUID oder
eine gelöschte App in zwei Sekunden ab, lange bevor man ein Anmeldefenster
öffnet. Siehe *Registrierung prüfen, ohne sich anzumelden* im Abschnitt über
die `.bat`-Dateien.

### Der Login selbst, isoliert

`test-auth.js` macht den nächsten Schritt ohne den ganzen Launcher: es öffnet
das Microsoft-Fenster, meldet jeden Schritt (`onStatus`) und gibt am Ende den
Account aus. Braucht `npx electron`, weil msmc für das Login-Fenster Electron
braucht — ein reines `node test-auth.js` geht nicht.

```bash
npx electron test-auth.js
```

**Im Projektordner ausführen.** Der Befehl löst `test-auth.js` gegen das
aktuelle Arbeitsverzeichnis auf, nicht gegen den Ort der Datei. Aus einem
anderen Ordner kommt daher:

```
unable to find electron app at c:/Users/<Name>/test-auth.js
```

Die Schrägstriche sind nicht die Ursache — Electron gibt Pfade intern immer so
aus, und Windows kommt damit klar. Gemeint ist `C:\Users\<Name>\test-auth.js`,
also den Benutzerordner. Es gibt zwei Wege:

```bash
# 1) in den Projektordner wechseln (nutzt das electron aus node_modules)
cd <Pfad-zum-Projektordner>
npx electron test-auth.js

# 2) absoluten Pfad angeben — der darf auch von überall kommen
node_modules\electron\dist\electron.exe "C:\...\launcher\test-auth.js"
```

Variante 2 ist nachgemessen und funktioniert auch mit einem fremden
Arbeitsverzeichnis: die `require('./src/main/auth')` in `test-auth.js` lösen
sich über den **Ort der Datei** auf, nicht über den aktuellen Ordner. Nur der
Dateiname `test-auth.js` allein wird gegen den aktuellen Ordner geprüft — und
das ist der Unterschied, an dem es scheitert.

### Login: was Microsoft blockiert und warum

Am 27.09.2026 mit einer eigenen Azure-App-Registrierung
(`df3c3ec3-…`) durchgespielt. Das Ergebnis ist eindeutig und hat nichts mit
dem Code zu tun:

| Stufe | Endpunkt | Ergebnis |
|---|---|---|
| 1. OAuth | `login.live.com` | ✅ |
| 2. Xbox Live | `user.auth.xboxlive.com/user/authenticate` | ✅ |
| 3. XSTS | `xsts.auth.xboxlive.com/xsts/authorize` | ✅ Token wird ausgestellt |
| 4. Minecraft | `api.minecraftservices.com/authentication/login_with_xbox` | ❌ **HTTP 403** |

Die Antwort von Microsoft lautet wörtlich:

```
Invalid app registration, see https://aka.ms/AppRegInfo for more information
```

**Das ist keine Fehlkonfiguration.** Der Endpunkt `login_with_xbox` ist für den
Dienst `XboxLive.signin` reserviert, und den gibt Microsoft nur im Rahmen des
**Xbox Developer Program** frei. Eine selbst angelegte
Azure-App-Registrierung kommt dort nicht durch — unabhängig von Kontotyp,
Redirect-URI, Client-Secret oder Public-Client-Flag. Alle diese Varianten sind
in den Microsoft-Q&A-Fragen anderer Launcher-Entwickler vom Februar und Juli
2026 durchprobiert worden, mit identischer Fehlermeldung; eine davon hat eine
beantwortete, von Microsoft bestätigte Antwort:

> You would need to be registered on the Xbox Developer program. […] Once you
> have enrolled into the program, you will be able to use the XboxLive.signin
> service.

Der Link `aka.ms/AppRegInfo`, den Minecraft in der Fehlermeldung nennt,
liefert inzwischen kein Anmeldeformular mehr.

**Warum das hier so lange gedauert hat:** Die ersten drei Stufen sind grün. Die
Registrierung ist nachweislich gültig, der Redirect stimmt, der Kontotyp
stimmt, das Konto wird von Xbox Live akzeptiert. Es sieht deshalb bis zum
letzten Aufruf nach einem Fehler in diesem Projekt aus — ist aber keiner. Die
Diagnose stand am Ende nicht im Log, sondern in der Frage *„wo genau hängt es
fest?"*.

**Was übrig bleibt:**

1. **Xbox Developer Program / ID@xbox.** <https://developer.microsoft.com/games/publish>
   Dort wird die App für `XboxLive.signin` freigeschaltet. Für ID@xbox ist die
   Teilnahme kostenlos, verlangt aber ein eingereichtes Spiel.
2. **Den offiziellen Minecraft-Launcher zum Anmelden nutzen** und den eigenen
   Launcher für alles andere weiterverwenden.

Was ausdrücklich **nicht** hilft: eine zweite App-Registrierung anlegen, ein
Client-Secret erzeugen, den Kontotyp ändern oder den Redirect korrigieren. Der
Code ist an dieser Stelle vollständig und wird nicht verändert.

#### Weg 1: Xbox Developer Program (ID@xbox) — der offizielle Weg

Die Anforderungen stammen aus der Microsoft-Dokumentation selbst
(Stand der Abfrage: 27.09.2026), nicht aus einer Zusammenfassung. **Sie sind
erheblich höher, als der Satz „verlangt aber ein eingereichtes Spiel" vermuten
lässt**, und das sollte vor der Anmeldung klar sein:

1. **Ein neues, eigenes Microsoft-Konto anlegen.** Die Anleitung verlangt
   ausdrücklich eine *Personal Microsoft Account*, der mit **keiner** Xbox-Konsole,
   **keinem** Windows-Gerät und **keinem** Microsoft-Store-Dienst verknüpft ist.
   Damit bleiben dein Spiele-Konto und deine Veröffentlichungs-Zugangsdaten
   getrennt. Zwei-Faktor-Authentifizierung wird direkt empfohlen.
   <https://account.microsoft.com>
2. **Anmelden bei** <https://developer.microsoft.com/games/publish> → **ID@Xbox**
   → *Apply Now* → *Select ID@Xbox*.
3. **Kontaktdaten und Studio-Informationen ausfüllen**, dann *Submit
   Introduction*. Es folgt eine gegenseitige **Geheimhaltungsvereinbarung (NDA)**
   — laut Anleitung in etwa 20 Minuten, sonst bis zu 3 Werktagen unterwegs.
   Vorher abzuschließen sind außerdem ein **Partner-Center-Konto**, die
   *App Developer Agreement*, und die Anmeldung als Xbox-Partner.
4. **Ein Spielkonzept einreichen** — *New Application* unter *Game Concepts*.
   Gefragt sind Entwickler und Publisher, Kernfunktionen und Beschreibung,
   **Zielveröffentlichungstermin**, Zielplattformen, Marktverfügbarkeit und
   **Preis**, Xbox-Netzwerk-Funktionen und UGC-Unterstützung. Dazu empfohlen:
   Gameplay-Video oder Trailer.
   ⚠️ **An dieser Stelle steht „Registered business number, such as a tax ID".**
   Das ist der Punkt, an dem private Hobby-Projekte in der Praxis hängen
   bleiben. Ein echtes Spiel sowie belastbare Geschäftsdaten sind auf jeden
   Fall zu erwarten — das ist kein Self-Service für „ich baue gerade einen
   Launcher".
5. **Prüfung durch Xbox:** offiziell 10–15 Werktage, in der Spitze bis zu
   **3 Wochen**. Nach Ablauf: Bestätigung plus zwei Verträge — eine
   *Title Licensing Agreement (TLA)* und eine *GDK License Agreement*.
6. **Beide Verträge unterschreiben.** Erst danach ist die Bewerbung abgeschlossen
   und das Programm beigetreten.

**Was das für dieses Projekt heißt:** Die Kette ist danach vollständig. Die neue
bzw. freigeschaltete Client-ID wird im Launcher über `setup-client-id.js` bzw.
`config.json` hinterlegt und gespeichert; am Code ändert sich nichts. Ob die
Freischaltung tatsächlich angekommen ist, zeigt erst ein Anmeldeversuch — der
Autorisierungs-Endpunkt sieht vorher und nachher gleich aus.

**Ehrliche Einordnung:** Das ist der einzige dokumentierte und rechtlich
saubere Weg. Er ist aber kein Formsache-Weg, sondern ein Vertrags- und
Prüfverfahren mit Wochen Wartezeit. Der Aufwand steht in keinem Verhält zu
„ein Minecraft-Launcher für mich selbst".

#### Weg 2: offizieller Minecraft-Launcher

Der offizielle Launcher ist bereits für `login_with_xbox` freigeschaltet. Für
Anmeldung und Spiel also den offiziellen Launcher benutzen und diesen Launcher
für Instanzen, Welten-Ansicht, Server-Ping, RAM und Auflösung weiterverwenden.

⚠️ **Hier ist eine Korrektur an einer früheren Aussage in diesem README.** Es
wurde suggeriert, man könne sich beim offiziellen Launcher anmelden und das
Token für den eigenen Launcher nutzen. **Dafür gibt es keinen Weg.** Der
offizielle Launcher gibt sein Token nicht heraus, und es existiert keine
Brücke, die man einhängen könnte. Weg 2 bedeutet deshalb: mit dem offiziellen
Launcher *spielen*, nicht: Token beschaffen.

#### Wenn Weg 1 zu viel ist

Dann ist die ehrliche Lage: **alle Funktionen dieses Launchers außer dem Login
sind fertig und geprüft** — Startkette, Welten-Ansicht, Server-Ping, RAM und
Auflösung pro Instanz. Was fehlt, ist ein Token, und das ist keine
Programmiersache, sondern eine Freigabeentscheidung von Microsoft. Das Spiel
startet und bleibt im Titelbildschirm, weil jede Welt eine Session lädt.

### Anmeldung-testen.bat

Für Windows-Nutzer ist das der einfachste Weg, weil nichts abgetippt werden
muss — **Doppelklick**, fertig. Die Datei liegt im Projektordner und macht
dreierlei, was beim manuellen Aufruf jedes Mal wieder schiefging:

1. `cd /d "%~dp0"` — wechselt in den Ordner, in dem die `.bat` selbst liegt.
   Damit ist das Arbeitsverzeichnis egal, wo sie gestartet wird.
2. Prüft vorher, ob `node_modules\electron\dist\electron.exe` und
   `test-auth.js` wirklich da sind, und sagt es laut, wenn nicht.
3. `chcp 65001` und ein `pause` am Ende — ohne beides ist die Ausgabe entweder
   unleserlich (`Grüße` wird zu `Gr??se`) oder das Fenster ist zu, bevor man
   irgendetwas gelesen hat.

Aus demselben Grund ist die `.bat` bewusst ohne Umlaute, Bindestriche und
Emoji geschrieben: eine Batch-Datei mit UTF-8-BOM verweigert unter Windows die
Ausführung ihrer ersten Zeile.

Erfolg hier heißt: Client-ID wird akzeptiert, OAuth-Tausch mit Rückleitung lief
durch, Xbox Live und XSTS haben das Konto durchgelassen, **und dem Konto gehört
Minecraft Java Edition**. Fehlt der letzte Punkt, ist nicht die Registrierung
schuld, sondern der fehlende Kauf.

Zwei Dinge, die beim Benutzen dieses Skripts wichtig sind:

**Es speichert nichts.** `loginWithMicrosoft()` liefert den Account zurück; das
Speichern macht der Launcher über die eigene Konto-Verwaltung. Wer hier
erfolgreich war, ist also **nicht** im Launcher angemeldet — dort trotzdem einmal
*Account hinzufügen* klicken.

**Der userData-Ordner ist der von `Electron`, nicht Electron selbst beantwortet
werden — und `productName` schlägt `name`.**

Das war der teuerste Fehler in diesem Projekt, und er hat drei Runden gedauert,
weil er sich als „Login schlägt fehl" tarnte. Nachgemessen, nicht geraten:

| | `name` | `productName` | was Electron nimmt | `userData` |
|---|---|---|---|---|
| `electron .` (der Launcher) | `liquid-launcher` | `Liquid Launcher` | **productName** | `Roaming\Liquid Launcher` |
| `electron test-auth.js` | — | — | Dateiname | `Roaming\Electron` |

Damit entstanden **zwei** Fehler gleichzeitig:

1. Die `config.json` lag in `Roaming\liquid-launcher` — geschrieben von
   `setup-client-id.js`, das den Ordnernamen fest eingetragen hatte. Der
   Launcher las aus `Roaming\Liquid Launcher` und meldete *„keine Azure-Client-ID
   hinterlegt"*. **Die Fehlermeldung zeigte zusätzlich auf die falsche Datei**
   und schickte damit auf eine zweite Azure-App-Anlage.
2. `test-auth.js` benutzte denselben falschen Ordner. Test und Konfiguration
   lagen also im **selben** falschen Ordner und waren sich einig — während die
   echte App woanders nachsah. Der Login-Test lief grün durch, und die App
   scheiterte. Ein Test, der das Falsche bestätigt, ist schlimmer als keiner:
   Er hat aktiv behauptet, es stimme.

Daraus folgt die Regel, die jetzt in `src/main/app-paths.js` steckt: Der
Ordnername wird **einmal** aus `package.json` gelesen und von allen benutzt, die
kein Fenster offen haben. Fest eingetragen wird er nirgends mehr.

Und deshalb wird `userDataDir` auch nicht einfach abgefragt: bei einem
Einzeldatei-Start liefert `app.getPath('userData')` den Ordner `Electron` statt
den des Projekts. `test-auth.js` prüft zur Absicherung, ob im berechneten
Ordner überhaupt Dateien liegen, die **nur** der Launcher anlegt
(`instances.json`, `versions/`, `settings.json`) — ein leerer Ordner bedeutet
„falscher Ordner" und nicht „noch nie gestartet".

### Ein Fehler, den nur der Test gefunden hat

`addAccountBtn` hatte kein `try/catch`. Das war unauffällig, solange
`authAddAccount()` niemals scheitern konnte — der Demo-Code erfand ja einfach
einen Account. Mit dem echten Login kann der Aufruf aber regelmäßig fehlschlagen
(keine Client-ID, Fenster geschlossen, Konto besitzt kein Minecraft), und eine
unbehandelte Rejection im Renderer bedeutet: der Klick läuft ins Leere und der
Nutzer sieht *gar nichts*. Der Handler fängt Fehler jetzt ab, zeigt sie in einer
Statuszeile und deaktiviert den Button für die Dauer des Logins (sonst öffnet
jeder Doppelklick ein weiteres Microsoft-Fenster).

---

## Drei Bugs, die den Start blockiert haben

Damit niemand sie für "klar" hält — sie sind behoben, aber die Falle ist
schnell wieder gestellt:

**1. Die Minecraft-JAR wurde nie geladen.** Der Code suchte in `libraries` nach
`com.mojang:minecraft-client`. Den Eintrag gibt es nicht (mehr) — Minecraft
liegt seit Jahren in `versionJson.downloads.client`. Als Ausweichpfad wurde
irgendeine beliebige Library auf die Classpath gehängt, das Spiel crashte
sofort mit `ClassNotFoundException`. Die Client-JAR wird jetzt aus
`downloads.client` geladen, SHA1-geprüft, nach `versions/<id>/client.jar`
gelegt und an **erster** Stelle der Classpath gestellt.

**2. Der Native-Classifier wurde ignoriert.** In modernen Manifesten steht der
Classifier im *Namen*: `org.lwjgl:lwjgl:3.3.3:natives-windows`. Der Code
schaute nur nach `downloads.classifiers` — das gibt es bei aktuellen Versionen
gar nicht. Ergebnis: **null** Natives, Minecraft startet nicht. Verschlimmerend:
weil der Classifier beim Bauen des Dateinamens unter den Tisch fiel, landete
`jtracy-1.0.29-natives-windows.jar` (enthält nur die DLL) in `jtracy-1.0.29.jar`
und **überschrieb** die echte Klassen-JAR — daher
`NoClassDefFoundError: com/mojang/jtracy/TracyClient`. Behoben: der Pfad kommt
jetzt aus `downloads.artifact.path`, wo Mojang den Classifier korrekt
eingerechnet hat. Das alte Format wird weiterhin unterstützt.

**3. `filterArguments()` prüfte Feature-Regeln falsch.** Statt zu prüfen, ob
ein Feature den *richtigen Wert* hat, galt jede Regel als erfüllt, sobald ihr
Wert nicht `false` war. Dadurch hing `--demo` automatisch am Startaufruf. Jetzt
wird der Wert exakt verglichen.

Kleinere Korrekturen: doppeltes `-cp` (version.json **und** `process.js`),
doppelte `-D`-Properties, fest verdrahtete G1GC-Flags aus der Minecraft-1.8-Zeit,
`p.isFulfilled` (existiert auf Promises nicht — das Concurrency-Limit griff
nie), eine `unhandled rejection` im `.catch()` (konnte den Main-Prozess
abschießen), `execSync` mit Template-String → `execFile` mit Argumentliste,
und die macOS-Argument-Prüfung.

---

## Offen

- **Der Login ist durch eine Plattformgrenze blockiert, nicht durch Code.**
  Die Kette funktioniert bis zur dritten von vier Stufen; die letzte lehnt mit
  `Invalid app registration` ab, weil `login_with_xbox` dem Xbox Developer
  Program vorbehalten ist. **Entschieden (27.09.2026): Weg 1, Teilnahme an
  ID@xbox.** Das ist ein Vertrags- und Prüfverfahren mit echten
  Geschäftsdaten, Spielkonzept und 10–15 Werktagen Prüfzeit — kein
  Self-Service, und der Aufwand steht in keinem Verhält zu einem
  Eigenbau-Launcher. Die vollständigen Schritte und die Stelle, an der private
  Projekte typischerweise hängen bleiben, stehen unter
  *Weg 1: Xbox Developer Program (ID@xbox)*.
  Am Code ändert sich dafür nichts: die freigeschaltete Client-ID wird über
  `setup-client-id.js` bzw. `config.json` hinterlegt, und `Registrierung pruefen.bat`
  prüft in zwei Sekunden, ob sie überhaupt akzeptiert wird.
  Bis dahin startet das Spiel, bleibt aber im Titelbildschirm: jede Welt lädt
  eine Session, und die braucht ein Token. **Das ist kein Bug im Startcode.**
- **Modloader: Fabric ist verdrahtet, Forge nicht.** Eine Instanz mit
  `modloader: "fabric"` startet mit echtem Fabric Loader: der Launcher holt das
  Profil von `meta.fabricmc.net` (Version aus der Instanz, sonst die neueste
  stabile — und merkt sie sich in der `instance.json`), lädt die
  Loader-Libraries und startet über
  `net.fabricmc.loader.impl.launch.knot.KnotClient`. Damit wirken die Mods im
  `mods`-Ordner. Der Weg ist in `src/main/fabricLoader.js` gekapselt und in
  `test-fabric-loader.js` (63 Prüfungen) abgesichert. **Forge bleibt offen:**
  eine Forge-Instanz startet weiter als Vanilla, mit demselben ehrlichen
  Hinweis im Log. Der Modpack-Import lehnt Packs mit `quilt` oder `neoforge`
  schon beim Import ab.
- **Ressourcenpakete sind gebaut.** Die Ansicht listet den `resourcepacks`-Ordner
  der gewählten Instanz, der Schalter schreibt die `resourcePacks`-Zeile in
  `<instanz>/options.txt` (nur diese eine Zeile — der Rest der Datei bleibt
  unangetastet), `pack.mcmeta` wird aus `.zip` und entpackten Ordnern gelesen,
  und ein Import kommt sowohl über die Ansicht (eigene `.zip`) als auch über
  Modpack-Dateien (`adm-zip`). Jedes Paket zeigt sein `pack.png` als Vorschau,
  sofern vorhanden. Verifiziert in `test-ressourcenpakete.js` (131 Prüfungen)
  und `test-ressourcenpakete-fenster.js` im echten Fenster (63 Prüfungen).
- **Start-Log.** Die Log-Zeilen gehen ans UI (dort landen sie in der
  DevTools-Konsole) und zusätzlich nach
  `%APPDATA%/Liquid Launcher/logs/launch.log`, damit ein Absturz nach dem
  Schließen des Fensters nachvollziehbar bleibt. Ein echtes Log-Panel im UI
  gibt es noch nicht.
- **Fremde Modloader.** Fabric ist verdrahtet (siehe oben), **Forge nicht**: eine
  Forge-Instanz startet als Vanilla, Mods im `mods`-Ordner bleiben dort ohne
  Wirkung, und das Log sagt das beim Start.
- **Spielzeit-Kachel.** Es gibt sie nicht mehr. Eine echte Spielzeit müsste der
  Launcher bei jedem Start *und* Beenden mitschreiben — das ist nicht gebaut.
  Bis dahin steht dort nichts, statt einer Zahl ohne Quelle.
- **Widgets aus fremden Quellen.** Es gibt keinen Mechanismus, der Widgets
  aus dem Internet lädt. Auf einem Rechner mit OAuth-Tokens ist beliebiges
  JavaScript aus fremder Quelle kein vertretbares Risiko; die Dateien werden
  von Hand in `%APPDATA%\Liquid Launcher\widgets\` gelegt.
- **Die eigene Schriftdatei wird nicht aus der Oberfläche entfernt.** „Entfernen"
  löscht die Datei und den Eintrag; es gibt keinen Weg, sie nur für diesen
  Start zu umgehen, ohne den Ordner von Hand zu leeren. Bewusst so: ein
  zweiter Schalter „nur für diese Sitzung" wäre eine Einstellung, die man
  nicht wiederfindet.
- **Eine tote Datei liegt noch herum:** `%APPDATA%\Liquid Launcher\instances.json`
  (374 Byte, vom 17.09.2026). Von dem alten, fest verdrahteten Modpack-Bild
  übrig geblieben. **Kein Code liest sie** — die Modpacks stehen jetzt in
  `<instanz>/instance.json`. Sie ist absichtlich *nicht* gelöscht worden: sie zu
  entfernen wäre eine Handlung an Nutzerdaten ohne Auftrag, und solange sie
  existiert, ist die Frage „liest da noch irgendwo die alte Liste?" eine, die
  mit `grep` beantwortet werden kann und nicht mit Vermutungen. Löschen ist eine
  Zeile, sollte aber eine bewusste Entscheidung sein.

---

## Was verifiziert ist — und was nicht

Wichtig für die Erwartung, sonst hält man nach dem ersten Login einen Bug für
ausgeschlossen.

**Verifiziert (mit Code und Tests):**

- Die hinterlegte Azure-Client-ID wird von Microsoft **akzeptiert**: der
  Autorisierungs-Endpunkt liefert die echte Anmeldeseite mit Passwortfeld statt
  einer Fehlerseite. Geprüft am 27.09.2026 mit `test-ms-registration.js`,
  inklusive Kontrollprobe, die eine erfundene Client-ID zuverlässig durchfallen
  lässt — ohne diese Gegenprobe war derselbe Test zunächst grün für eine
  Registrierung, die es gar nicht gab
- Der Start bis zum Titelbildschirm, wiederholt am 26.09.2026 mit 1.21.4 und
  35 s Laufzeit ohne Absturz
- Die sechs Account-Argumente, die ein echter Microsoft-Login liefert, werden
  korrekt und in der richtigen Form übergeben (`--username`, `--uuid`,
  `--accessToken`, `--userType msa`, `--xuid`, `--clientId`) — geprüft in
  `test-launch-chain.js`
- Kein leeres Argument in der Befehlszeile (siehe unten)
- Jede msmc-Fehlerform ergibt eine lesbare Meldung
- **Die Meldung benennt die konkrete Stufe der Kette.** Bei
  `error.auth.minecraft.login` (HTTP 403 von
  `api.minecraftservices.com/authentication/login_with_xbox`) steht jetzt
  ausdrücklich, dass OAuth, Xbox Live und XSTS vorher erfolgreich waren und
  dass die **Berechtigung für Java Edition** fehlt — samt
  `minecraft.net/has-java` und den typischen Ursachen (nur Bedrock, falsches
  Konto, Steam-Version, Drittanbieter-Key). Vorher kam nur
  *„Minecraft-Server haben die Xbox-Anmeldung abgelehnt. (HTTP 403)"* — ohne
  jede Handlungsanweisung. Gefunden durch einen Test, der die alte
  Ein-Zeilen-Meldung ausdrücklich **nicht** mehr zulässt
- Der `errorMessage`-Schlüssel der Minecraft-Server wird gelesen. Er fehlte in
  der Liste der ausgewerteten Felder, wodurch der Servertext in *jeder*
  Antwort der Minecraft-Server verloren ging
- Die Welten-Ansicht liest echte `level.dat` aus vier verschiedenen Welten
  (Überleben, Kreativ, Hardcore, kaputt) und zeigt die Werte an, die Minecraft
  selbst hineingeschrieben hat
- Der Löschablauf im echten Fenster: nach dem ersten Klick ist **nichts**
  gelöscht, nach dem zweiten ist der Ordner weg, der Nachbarordner unberührt
- Kein Angriff auf `worlds:delete` kommt durch, über den echten IPC-Kanal
  geprüft — der Beweisordner blieb vollständig stehen
- Ein Weltname mit HTML (`<img src=x onerror=…>`, aus der `level.dat` selbst)
  bleibt Text: null Kindelemente, ein Textknoten, `onerror` löst nicht aus
- Kein Dateipfad und kein „AppData" im Ergebnis von `worlds:list` — das
  Vorschaubild kommt als Data-URL
- Die Liste scrollt bei allen zulässigen Fensterhöhen (400 px bis 860 px), und
  keine Weltenzeile ragt aus ihrem Panel
- Der Server-Ping spricht das echte Protokoll gegen lokale Server, die es
  wirklich antworten — inklusive Byte-für-Byte-Inspection der Handshake
- Kein Angriff auf die MOTD kommt durch: 10.000 Ebenen Tiefe, 5.000 Komponenten,
  500.000 Zeichen, Steuerzeichen, `data:image/svg+xml` — jeweils gekappt, jeweils
  gemeldet, nie als HTML weitergereicht
- Eine kaputte `servers.json`-Adresse (`host:abc`) bricht den Start **vor** dem
  500-MB-Download ab; ein unbekannter `serverId` ebenso
- Der Server-Start erzeugt genau **ein** Quick-Play-Argumentpaar, geprüft gegen
  die echte `version.json` von 1.21.4 — kein leeres `--quickPlayPath` und kein
  `--quickPlaySingleplayer` beim Serverstart
- Im echten Fenster: eine 500-Zeichen-MOTD mit `<img src=x onerror=…>` und `<b>`
  erzeugt null Tags und null ausgelöste Handler; keine der zwölf Zeilen ragt
  aus ihrem Panel, auch bei der Minimalbreite von 1040 px nicht
- Ein echtes Favicon-PNG wird geladen, eine kaputte Data-URL fällt auf das
  Globe-Emoji zurück (und nicht auf einen leeren Kasten)
- **Startoptionen:** kein Wert bringt etwas anderes als eine Zahl in die
  Befehlszeile durch. `4G -Dfoo=bar`, `0x10`, `1e3`, `99999999999999999999`,
  `4,5` (deutsches Komma) und eine per Hand manipulierte Datei mit `99999` GB
  werden alle abgewiesen — 185 Prüfungen in `test-instance-settings.js`
- `min > max`, `5 px` Breite und ein absichtlich eingeschleustes Argument werden
  über den echten IPC-Kanal abgewiesen, **und der alte Stand bleibt dabei
  byteweise derselbe**. Eine reine Auflösungsänderung setzt den RAM nicht zurück
- Der empfohlene Wert skaliert mit dem Rechner (31 GB physikalisch → 4 GB
  statt der festen 2 GB), und der Reset-Knopf übernimmt diesen Vorschlag statt
  stur auf 1/2 GB zurückzugehen
- Startoptionen einer Instanz beeinflussen eine andere nicht: nach dem Wechsel
  auf eine zweite Instanz stehen deren Werte in den Feldern, und beim
  Zurückwechseln kommen die eigenen zurück
- **Widgets kommen nicht an das Token.** Im echten Fenster gemessen, nicht im
  DOM-Nachbau: `window.launcher`, `require`, `process`, `module` und `electron`
  sind in der Kachel `undefined`; `parent.launcher`, `top.launcher`,
  `localStorage` und `document.cookie` werfen `SecurityError`. Im übermittelten
  JSON steht kein `accessToken`, keine Client-ID, kein AppData-Pfad. Als
  Gegenprobe *kann* der Hauptframe das Token abrufen, und mit echten Testdaten
  liefert der Kanal `modAnzahl: 2` und `welten: 2`
- **Die Kacheln zeigen echte Zahlen.** Die mitgelieferten Widget-Skripte werden
  mit festgehaltener Uhrzeit in einer Sandbox laufen gelassen: die Uhr zeigt
  `14:30` auf Deutsch und `02:30 PM` auf Englisch, Welten und Mods zeigen die
  gezählten Werte, ohne `modAnzahl` zeigt „Mods" **nicht** etwa 0, sondern den
  Ladezustand
- **Ein kaputtes Widget reißt nichts mit.** Eine unbekannte Widget-ID erzeugt
  eine Kachel mit Fehlermeldung; die übrigen Kacheln bleiben bestehen
- **Entfernen und Anordnen** wirken auf `settings.json` und überdauern einen
  Neustart; im Bearbeiten-Modus sind die Kacheln ziehbar, außerhalb nicht
- **Die Einstellungen sind vier Karten in einer einzigen Spalte.** Eine
  zweispaltige Anordnung wurde verworfen, weil die Karten bei der
  vorgegebenen Breite umbrachen und unübersichtlich wurden. Sie bleiben auch
  mit Seitenleisten-Spur einspaltig, weil die Ansicht **neben** der Spur liegt
  (`kartenbereichRect()`). Im Fenster gemessen: der Bereich ist 1595 px hoch
  bei 664 px sichtbar, rollt also wirklich
- **Die Suche findet Karten über die Sprachumschaltung hinweg.** Gesucht wird
  in allen neun Sprachfassungen, nicht nur im gerade sichtbaren Text;
  `ANORDNUNG` findet dieselbe Karte wie `anordnung` (Karten-Layout), ein
  Unsinnswort findet nichts und sagt das
- **Die Textgröße ist ein Multiplikator.** 120 % machen aus 44 px Überschrift
  52,8 px; in der ganzen `index.html` gibt es keine einzige `font-size` ohne
  `calc(... * var(--fs))`, weil eine nackte `font-size` den Regler ignorieren
  würde, ohne dass irgendetwas auffällt
- **Die eigene Schriftdatei kommt als Data-URI an und wird als Schrift
  erkannt**, mit brauchbaren Bytes geprüft gegen dieselbe Datei mit Müll im
  Kopf: im ersten Fall bleibt „Eigene Datei" gewählt, im zweiten fällt die
  Auswahl auf die Systemschrift zurück und die Statuszeile sagt, dass sich
  die Datei nicht als Schrift verwenden lässt. Der echte Dateiname steht in
  `settings.json`, **nicht** in der erzeugten `@font-face`-Regel
- **Eine kaputte Schriftdatei wird nicht als geladen gemeldet.** Ohne die
  Prüfung mit `document.fonts.load()` hätte die Oberfläche weiter
  „Eigene Datei" behauptet, während der Browser die Bytes stillschweigend
  verworfen hätte
- **Der Schalter „Weniger Bewegung" wirkt auf beide Bewegungsstufen und
  beide Quellen** — eigene Einstellung und Windows-*Animationseffekte*. Im
  Fenster geprüft: die Karte bewegt sich beim Überfahren, steht mit
  eingeschaltetem Schalter still, und kommt nach dem Ausschalten zurück.
  Einschließlich des Falls, in dem der Schalter genau in den 520 ms
  umgeschaltet wird, in denen der Rücklauf einer Karte noch läuft
- **Das Karten-Layout überlebt einen Neustart.** Gemessen über zwei Starts
  hinweg an der ausgelieferten Datei. Vor dieser Korrektur schrieb der
  Startvorgang selbst das Standardlayout in die Datei, und die eigene
  Anordnung war nach dem ersten Start weg — dieser Fehler ist in
  `test-einstellungen-fenster.js` als eigener Abschnitt festgehalten
- **Ein altes Layout mit `news` wird übernommen**, mit einer Gegenprobe:
  dieselbe Position einmal mit `news` und einmal mit `shortcut` gespeichert
  ergibt dasselbe Ergebnis, und dieses Ergebnis ist nachweislich **nicht** die
  Standardposition
- **Die Seitenleiste fährt an alle vier Kanten, ohne eine Karte anzufassen.**
  Im Fenster-Test (Gruppen 10c/10d) gemessen: Spur 72 px links, rechts, oben
  und unten; die Karten bleiben an ihrem Platz; ein Zug wird nie abgelehnt —
  die Nachbarn weichen von selbst aus oder schrumpfen nur, wenn sonst nichts
  passt. Das Dock-Ergebnis übersteht zwei Starts.
- **Die Modpacks sind echt.** Anlegen, Umbenennen, Duplizieren, Löschen und die
  Technik nachtragen laufen im echten Fenster über den echten IPC gegen das
  echte `instances.js` — 74 Prüfungen in `test-modpacks-fenster.js`. Die vorher
  fest einprogrammierten erfundenen Modpacks (`vanilla-survival`, `atm10`,
  `create-ab`) und ihr Ersatz in der Vorschau sind weg; `talberg` ist der einzige
  verbliebene Ordner und bleibt unangetastet, weil es ein echter Spielstand ist.
- **Der Modpack-Import ist echt getestet.** 140 Prüfungen in `test-modpack-import.js`, 18 in `test-modpack-import-formate.js` — darunter roh gebaute Zips mit echten `../`-Angriffen —
  und 57 im echten Fenster in `test-modpack-import-fenster.js`: Datei-Prüfen,
  Import über die Oberfläche, ehrliche Ablehnung von Quilt, Modrinth-Suche,
  vier Sprachen.
- **Der Leerzustand hat einen Weg heraus.** Ohne jedes Modpack steht das im
  Dropdown, und der Knopf *Neues Modpack* führt zum Dialog. Das war vorher nur
  darstellbar, indem vier erfundene Modpacks fest einprogrammiert waren.
- **Ein Ordner ohne `instance.json` ist reparierbar, nicht verloren.** Der
  Launcher erkennt die vorhandene Version aus `mods-meta.json`, sagt beim Start
  von sich aus Bescheid, und falls man abbricht, gibt es in der Verwaltungszeile
  einen Knopf *Technik* — sonst wäre ein Altbestand nicht startbar und nicht
  reparierbar gewesen, also ein Sackgassen-Modpack. Der Knopf ist auffälliger
  als die drei anderen, weil er keine Nebenhandlung ist, sondern die
  Voraussetzung dafür, dass das Ding überhaupt läuft. Getestet über den Abbruch
  hinweg: nach dem Abbrechen ist der Weg zurueck wirklich offen.
- **Nach dem Speichern kommt der Dialog nicht von selbst wieder.** Genau einmal
  je Start. Das ist über den Quelltext abgesichert und im Fenster geprüft: der
  Versuch, den Knopf zu entfernen, lässt vier Prüfungen rot werden — unter anderem
  die, die den *Titel* des geöffneten Dialogs prüft. Ohne diese Titelspur wäre
  der Test grün gewesen, obwohl nur *Umbenennen* geklickt worden war, denn das
  geht ebenfalls auf, zeigt die Version und sieht identisch aus.
- **`lastPlayed` kommt aus Belegen, nicht aus dem Ordnereintrag.** Kette:
  neueste `saves/<Welt>/level.dat`, sonst neuester Eintrag in `saves/`, sonst
  neueste Datei in `logs/` (deckt „nur auf Servern gespielt" ab). Der Ordnermtime
  ist als Beleg entfernt — ein frisch angelegter Ordner hat immer „jetzt" und
  würde „gerade eben" behaupten, ohne dass gespielt wurde. Drei Prüfungen in
  `test-instances.js` sichern das ab.
- **Ein Beenden ist kein Absturz.** `stopProcess()` notiert die Absicht, bevor es
  irgendetwas an den Prozess schickt, und der Abschluss-Zweig entscheidet danach
  statt allein nach dem Exit-Code. Gemessen am echten Prozess: Exit-Code `null`
  bzw. `1`, gemeldet wird *beendet* mit dem Zusatz, dass es Absicht war. Vorher
  schrieb die Oberfläche nach jedem normalen Feierabend *Minecraft ist
  abgestürzt* und dazu die letzten 15 Log-Zeilen als Fehlerliste — unter anderem,
  dass das Spiel gerade sauber lief. 19 Prüfungen in
  `test-prozess-stoppen.js`, gegen einen echten Prozess (eine winzige
  `.java`-Datei statt des Spiels), mit Gegenprobe.
- **Das Beenden braucht keinen Timeout mehr.** Der erste Versuch — ein
  `SIGTERM` an den Kindprozess — stand vorher im `else`-Zweig und lief unter
  Windows nie: Windows kennt keine Prozessgruppen, die negative PID findet dort
  nichts, und der Wurf wurde weggeschluckt. Gemessen: `process.kill(-pid)` wirft
  `ESRCH`, mit und ohne `detached: true` (das war als Ursache vermutet und ist
  es nicht). Vorher kostete jeder Klick auf *Beenden* die vollen 10 Sekunden,
  danach riss `taskkill /F` den Baum weg. Jetzt: **1 ms** statt **8192 ms** bei
  einem Timeout von 8000 ms.

**Nicht verifiziert, weil man dafür hinschauen muss:**

- **Wie die Widget-Kacheln aussehen.** Gemessen ist die Geometrie: 92 px
  Kachelhöhe, Raster-Umbrüche, `sandbox="allow-scripts"` an jedem Frame, kein
  `allow-same-origin`. Screenshots wurden erzeugt, aber nicht mit Augen
  geprüft. Sie liegen unter
  `%LOCALAPPDATA%\Temp\opencode\shot-startseite.png`, `shot-kacheln.png` und
  `shot-bearbeiten.png` — der erste Aufruf des Launchers ist die eigentliche
  Abnahme.
- **Ob das Ziehen und Ablegen sich gut anfühlt.** Die Reihenfolge wird korrekt
  gespeichert; die Bedienung ist ungetestet.

**Noch nicht verifiziert, weil es einen echten Microsoft-Account braucht:**

- Dass die Anmeldung bis zum gespeicherten Token durchläuft. Nachgemessen am
  27.09.2026, wie weit die Kette kommt: Client-ID wird akzeptiert, OAuth läuft
  durch, **Xbox Live akzeptiert das Konto, XSTS stellt ein Token aus** — und
  erst die letzte von vier Stufen lehnt mit `Invalid app registration` ab.
  Grund ist eine Plattformgrenze, kein Fehler hier: siehe *Login: was Microsoft
  blockiert und warum*. Solange die nicht aufgelöst ist, lässt sich die
  Session-Kette nicht weiter verifizieren — unabhängig davon, wie der Code
  aussieht
- **Dass eine Welt aufgeht.** Das ist der eigentliche Test: Beim Laden einer
  Welt meldet sich das Spiel beim Session-Server an. Mit dem Fake-Token
  scheitert das. Der Beweis aus dem Log, dass die Kette an der richtigen Stelle
  hängt:

  ```
  Could not authorize you against Realms server:
    java.lang.RuntimeException: Failed to parse into SignedJWT: demo-token
  ```

  Das Spiel *versucht* also, unseren Token als JWT zu lesen — ein echter
  `accessToken` von Mojang ist genau eins. Mit gültigem Token entfällt die
  Meldung. Die ganze Session-Kette ist damit de facto implementiert, aber
  natürlich nicht durchgespielt.
- **Dass Quick Play wirklich in die gewählte Welt springt.** Die Argumente
  werden gebaut, korrekt gepaart übergeben und von 1.21.4 geparst (50 s echter
  Start, 177 Log-Zeilen, kein Absturz). Ob das Spiel damit die richtige Welt
  öffnet, ist dieselbe offene Session-Frage wie oben: Quick Play führt zum
  Welt-Laden, und das scheitert ohne gültiges Token an der Anmeldung. Die
  Welten-ID ist der Ordnername, weil `--quickPlaySingleplayer` genau das
  erwartet — ein Anzeigename wäre hier schlicht falsch gewesen.
- **Dass Quick Play wirklich auf den Server verbindet.** Dasselbe wie oben:
  `--quickPlayMultiplayer` wird gebaut, korrekt gepaart übergeben und von 1.21.4
  geparst, und die Adresse ist die aus der `servers.json` kanonisch
  normalisierte Form. Der eigentliche Verbindungsaufbau ist dieselbe
  Session-Frage wie beim Weltstart.
- **Dass ein echter Server auf die echte Status-Anfrage antwortet.** Geprüft ist
  das gegen lokale Server, die das Protokoll selbst sprechen. Die hatte
  `players`, `version` und eine Chat-Baum-MOTD. Wie sich ein Server mit
  Proxy-Protokoll (BungeeCord/Velocity), mit `velocity` im Status-JSON oder mit
  einem `favicon` in ungewöhnlicher Größe verhält, ist nicht geprüft — genau
  dort wäre `sample` oder `version.name` plötzlich kein String.
- **Dass das Spiel mit diesen Werten auch sauber läuft.** Die Argumentkette ist
  bis zum fertigen `-Xmx` und `--width` geprüft, aber kein Start lief mit
  eingestellten Werten. Offen bleibt vor allem eine Frage, die sich nicht durch
  Lesen des Codes beantworten lässt: `-Xms` gleich `-Xmx` (was die Oberfläche
  erlaubt) ist gültig, aber `-Xms6G -Xmx6G` auf einem 4-GB-Rechner startet
  vermutlich gar nicht erst.

**Zu `--clientId`:** 1.21.4 erwartet den Wert (`--clientId ${clientid}`).
`toLaunchAccount()` lieferte ihn zunächst nicht, dadurch stand dort ein leeres
Argument. Das funktionierte nur, weil `process.js` mit `spawn(exe, array)` ohne
Shell startet — der Leerstring bleibt also ein eigenes `argv`-Element. Sobald
jemand die Argumente zum Loggen in einen String joint, rückt der nächste Wert um
eine Position nach vorn und `--xuid` landet als *Wert* von `--clientId`.
Deshalb wird die Client-ID jetzt mitgegeben, und `test-launch-chain.js` schlägt
fehl, falls wieder ein leeres Argument auftaucht.

### Bekanntes Verhalten

**Ein Beenden beendet die JVM sofort — es speichert nicht vorher.** Unter Windows
kennt das System kein `SIGTERM`; Node setzt dort ein `TerminateProcess`. Das
Spiel bekommt also keine Gelegenheit, noch zu speichern, egal ob der erste
Versuch oder der Notfallweg greift. Wer das braucht, muss dem Fenster vorher ein
`WM_CLOSE` schicken statt den Prozess zu beenden. Die *Verzögerung* von früher
(„~8 Sekunden bis gar nichts passiert") ist behoben, siehe *Was verifiziert ist*.

**Ein Modpack ohne eingetragene Version startet nicht.** Das ist Absicht, keine
Einschränkung: ohne Version gibt es kein `mainClass` und keine `version.json`. Der
Launcher fragt deshalb beim Start nach und bietet die Technik später noch einmal
an, statt das Modpack zu einem stillen Totalausfall zu machen.

---

## Setup

Voraussetzung: [Node.js](https://nodejs.org) (Version 18 oder neuer).

```bash
npm install
npm start
```

**Unter Windows einfacher: `Liquid Launcher.bat` im Projektordner per
Doppelklick** (im Benutzerordner liegt eine Weiterleitung mit demselben Namen).
`npm start` erwartet ein `package.json` im aktuellen Ordner und findet keins,
wenn man aus dem Benutzerordner startet — dieselbe Falle wie beim Login-Test,
deshalb macht die `.bat` vorher `cd /d "%~dp0"`. Sie hält das Konsolenfenster
offen, weil dort die Log-Zeilen des Spiels landen; das ist der einzige Weg,
einen Absturz nachzuvollziehen, wenn das Launcher-Fenster schon zu ist.

### Microsoft-Login einrichten

Einmalig nötig, sonst startet das Spiel nur im Titelbildschirm und lässt sich
nicht spielen:

```bash
node setup-client-id.js            # führt durch die Eingabe
```

und einmalig die App im Azure-Portal anlegen (3 Minuten, Details in der
Tabelle unter *Microsoft-Login*).

```bash
node test-ms-registration.js          # prüft die Registrierung, ohne Anmeldung
```

Meldet das Skript ✅, ist die Registrierung in Ordnung und ein schlagender Login
liegt danach an etwas anderem — am Konto, am abgelaufenen Token oder am Spiel.

Zum Anmelden selbst: **`Anmeldung-testen.bat` im Projektordner per Doppelklick.**
Kein `cd`, kein Abtippen, kein Verzeichnis-Fehler.

"Download-Ordner" in den Einstellungen steht auf `%APPDATA%\Liquid Launcher` —
dort landen `versions/`, `assets/` und `java/`. Der erste Start einer Version
lädt ca. 500 MB und dauert ein paar Minuten; danach ist alles gecacht. Der
Fortschritt erscheint als Log-Zeilen (`Assets: 40% (1600/4039)`) im DevTools
und in der Log-Datei.

## Ordnerstruktur

```
src/
  main/
    main.js           App-Start, Fenster, Sicherheit, Aufräumen beim Beenden
    preload.js        contextBridge -> window.launcher
    ipc-handlers.js   alle IPC-Kanäle; instances:launch/stop = Startkette
    downloader.js     version.json, Libraries, Natives, Client-JAR, Assets,
                      Classpath- und Argumentbau
    fabricLoader.js   Fabric Loader: Profil von meta.fabricmc.net holen, mit der
                      Vanilla-version.json verschmelzen (Maven-Libraries auf die
                      Mojang-Form bringen), Loader-Version waehlen; ohne Electron
    java-runtime.js   Java finden / passende JRE laden
    process.js        JVM starten & beenden, Log-Maskierung, Absturz-Erkennung
    auth.js           Microsoft-Login (msmc): OAuth -> Xbox -> XSTS -> Minecraft
    app-paths.js      userData-Ordner aus package.json (productName schlaegt name)
    account-store.js  Accounts + verschluesselte Tokens (safeStorage/DPAPI)
    nbt.js            NBT-Leser (gzip, alle Tag-Typen), nur lesend
    worlds.js         Welten auflisten, Metadaten, loeschen (+ Pfadschutz)
    mc-ping.js        Server List Ping: Status, MOTD flachgezogen, Favicons
    instance-settings.js  Startoptionen pro Instanz: RAM + Aufloesung, geprueft
    instances.js       Modpacks auf der Platte: anlegen, umbenennen, duplizieren,
                      loeschen; instance.json je Ordner; liest nie und schreibt
                      beim Lesen nichts
    modpackImport.js   Modpack-Dateien (CurseForge .zip, Modrinth .mrpack)
                      lesen und installieren; Zip-Slip-Schutz; ohne Electron
    widgets.js        Widget-Suche, Manifest-Pruefung, Positivliste (ohne Electron)
    mods.js           Modrinth
    resourcepacks.js  Ressourcenpakete einer Instanz: lesen, .zip-Import,
                      loeschen, Schalter in options.txt (ohne Electron)
  renderer/
    index.html        komplettes UI (Design, Themes, Logik)
    widget-host.js    baut die Widget-Kacheln, sandboxed Frames, Daten-Bruecke
    assets/           Hintergrund-Fotos
widgets/               die 24 mitgelieferten Widgets (uhr, welten, mods, laufzeit,
                       CPU, RAM, Laufwerk, Netzwerk, Java, …)
                       eigene kommen nach %APPDATA%\Liquid Launcher\widgets\
WIDGETS.md             Anleitung zum Schreiben eigener Widgets
setup-client-id.js       Azure-Client-ID eintragen (mit Anleitung und Pruefung)
test-launch-chain.js    Argument-Kette isoliert testbar
test-fabric-loader.js   Fabric Loader: Maven-Format, Verschmelzen, Versionswahl,
                        Classpath-Zusammenspiel (ohne Netzwerk, ohne Electron)
test-full-launch.js    echter Start isoliert testbar
test-java-runtime.js   Java-Erkennung
test-ipc-wiring.js     Electron-Seite und Startkette isoliert testbar
test-account-store.js  Token-Verschluesselung isoliert testbar
test-auth-errors.js    Login-Fehlermeldungen isoliert testbar
test-worlds.js         NBT-Leser, Welt-Metadaten, Loeschschutz
test-server-ping.js    Server-Ping, MOTD, Favicons (echte TCP-Server)
test-instance-settings.js  Startoptionen: Grenzen, Einschleus-Versuche, Datei
test-instances.js          Modpack-Speicher: anlegen, umbenennen, duplizieren,
                          loeschen, Altbestand, kaputte Dateien, atomar
test-modpack-import.js     Modpack-Dateien: Formate, Zip-Slip, Loader, Overrides
test-modpack-import-formate.js  neue Import-Faelle: Wurzelordner, Prism/MultiMC,
                          CurseForge ohne Schluessel, Server-Mods
test-modpack-import-fenster.js  echtes Fenster: Import-Dialog, Ablehnung, Suche,
                          4 Sprachen
test-ressourcenpakete.js   Ressourcenpakete: Ordner, pack.mcmeta, options.txt
test-ressourcenpakete-fenster.js  echtes Fenster: Ansicht, Schalter, Loeschen
test-skin-ganzkoerper.js   Ganzkoerper-Figur aus sechs Teilen, zweite Ebene
test-startseite.js         Skin-Kopf an drei Stellen, erste Einrichtung (Onboarding)
test-modpacks-fenster.js   echtes Fenster: Modpack-Dropdown, Dialog, Altbestand,
                          Loeschen, und dass die Modsliste dem Wechsel folgt
test-prozess-stoppen.js    Beenden ist kein Absturz, gegen einen echten Prozess
test-hover-move.js        Hover-Bewegung der Karten: Weg, Grenze, Vorrang, beide Quellen
test-einstellungen.js     Einstellungen: Karten, Suche, Schrift, Sicherheit, i18n
test-einstellungen-fenster.js  echtes Fenster: 4 Karten in einer Spalte, Suche, Schrift, Persistenz
test-schnellzugriff-fenster.js  echtes Fenster: sechs Ansichten als Kacheln, Design-Panel,
                           Screenshot-Kanal und Statuszeile
test-snippets.js          die injizierten Snippets sind gueltiges JavaScript
test-widgets.js           Widget-Suche, Manifest, Pfad-Traversal, Positivliste
test-widget-anzeige.js    was die Kacheln tatsaechlich anzeigen (feste Uhrzeit)
test-widget-systemdaten.js System- und Dateiwerte der D4-Kacheln (reines Node)
test-widgets-fenster.js   echtes Electron-Fenster: Sandbox, Tokens, Bedienung
test-ms-registration.js    Azure-Registrierung gegen Microsoft, mit Kontrollprobe
test-auth.js          echter Login isoliert (npx electron, kein UI vom Launcher)
Anmeldung-testen.bat  Doppelklick-Wrapper fuer test-auth.js (Windows)
Registrierung-pruefen.bat  Doppelklick-Wrapper fuer test-ms-registration.js
Liquid-Launcher.bat   Doppelklick-Wrapper fuer "npm start" (Windows)
```

Auf dem Desktop liegen zusätzlich drei Weiterleitungen mit sprechenden Namen
(`Anmeldung testen.bat`, `Registrierung pruefen.bat`, `Liquid Launcher.bat`),
damit niemand den tiefen Pfad zum Projektordner abtippen muss. Sie prüfen,
ob die Ziel-Datei noch existiert, und geben sonst eine verständliche Meldung
statt eines „kann nicht gefunden werden".

⚠️ Der Dateiname auf dem Desktop ist bewusst **ohne Umlaut** (`pruefen`), genau
wie bei den anderen beiden. Der erste Entwurf hieß `Registrierung prüfen.bat`
und wäre unter einer Codepage, die `ü` nicht darstellen kann, schwer
aufzurufen gewesen — die anderen `.bat`-Dateien sind aus demselben Grund ohne
Umlaute geschrieben.


## Build

```bash
npm run build:win
```

Erzeugt eine `.exe` über `electron-builder` (Konfiguration in `package.json`
unter `"build"`).

## Hinweis

Kein Mojang-/Minecraft-Branding im Produktnamen verwenden (rechtlich).
