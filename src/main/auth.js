// src/main/auth.js
// Echter Microsoft-Login für Minecraft über die Library "msmc" (npm.im/msmc).
// Kapselt die 4-stufige Kette:
//   Microsoft OAuth -> Xbox Live (user.auth) -> XSTS -> Minecraft Services
//
// ------------------------------------------------------------------
// WICHTIG — der Redirect-URI ist nicht frei wählbar:
// msmc schickt den Token-Austausch an den Legacy-Endpoint
// https://login.live.com/oauth20_token.srf (siehe node_modules/msmc/dist/cjs/
// auth/auth.js, Methode _get). Der passende Redirect für DIESEN Endpoint ist
// https://login.live.com/oauth20_desktop.srf — er ist auch der Default der
// Library. Der häufiger genannte Wert
// https://login.microsoftonline.com/common/oauth2/nativeclient gehört zum
// v2-Endpoint (login.microsoftonline.com/.../oauth2/token) und wird von
// msmc NICHT benutzt. Mit dem falschen URI bekommt man eine gültige
// Client-ID, aber trotzdem "AADSTS50011: The redirect URI ... does not match".
// ------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { Auth } = require('msmc');

// Placeholder. Wird nur benutzt, wenn weder Umgebungsvariable noch
// config.json eine Client-ID liefern — dann ist der Login nicht möglich
// und wir sagen das auch klar.
const FALLBACK_CLIENT_ID = 'DEINE-AZURE-CLIENT-ID-HIER-EINTRAGEN';

// Muss zu "Redirect URI" in der Azure-App-Registration passen. Siehe Kommentar
// oben. Wird als zweites Element in der config.json überschreibbar gemacht,
// falls jemand eine eigene App-Registration mit anderem URI nutzt.
const DEFAULT_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';

let cachedClientId;

/**
 * Ermittelt die Azure Client-ID. Reihenfolge:
 *   1. Umgebungsvariable LIQUID_LAUNCHER_CLIENT_ID
 *      (praktisch fuer Tests und CI)
 *   2. config.json im userData-Ordner
 *      (ueberschreibt den Build, ohne den Code anzufassen — wichtig, weil
 *       der userData-Ordner beim Update unangetastet bleibt)
 *   3. Der Platzhalter oben
 */
function resolveClientId(userDataDir) {
  if (cachedClientId) return cachedClientId;

  const fromEnv = (process.env.LIQUID_LAUNCHER_CLIENT_ID || '').trim();
  if (fromEnv) {
    cachedClientId = fromEnv;
    return cachedClientId;
  }

  try {
    if (userDataDir) {
      const configPath = path.join(userDataDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const fromFile = (config.microsoftClientId || '').trim();
        if (fromFile) {
          cachedClientId = fromFile;
          return cachedClientId;
        }
      }
    }
  } catch {
    // Eine kaputte config.json darf den Launcher nicht zum Absturz bringen —
    // dann eben ohne sie weitermachen (und der Login scheitert spaeter mit
    // einer klaren Meldung).
  }

  cachedClientId = '';
  return '';
}

function resolveRedirectUri(userDataDir) {
  try {
    if (userDataDir) {
      const configPath = path.join(userDataDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (typeof config.microsoftRedirectUri === 'string' && config.microsoftRedirectUri.trim()) {
          return config.microsoftRedirectUri.trim();
        }
      }
    }
  } catch { /* siehe oben */ }
  return DEFAULT_REDIRECT_URI;
}

/**
 * Baut den Auth-Manager. Wirft mit einer konkreten Anleitung, wenn keine
 * Client-ID hinterlegt ist — das ist mit Abstand der häufigste Grund, warum
 * ein Login nicht funktioniert.
 */
function makeAuthManager(userDataDir) {
  const clientId = resolveClientId(userDataDir);

  if (!clientId || clientId.startsWith('DEINE-')) {
    // Der Pfad wird berechnet, nicht fest eingetragen. Er war hier vorher
    // als "%APPDATA%\liquid-launcher" fest verdrahtet und damit FALSCH —
    // Electron legt den userData-Ordner nach "productName" an, also
    // "%APPDATA%\Liquid Launcher". Diese Meldung hat den Nutzer dadurch
    // auf eine Datei gezeigt, die der Launcher gar nicht liest. Genau
    // deshalb: einpflegen statt hinschreiben.
    const ziel = path.join(userDataDir || path.join(process.env.APPDATA || '', 'Liquid Launcher'), 'config.json');
    throw new Error(
      'Keine Azure-Client-ID hinterlegt, daher ist kein Microsoft-Login möglich.\n\n' +
      'Gesucht wurde in:\n' +
      '   ' + ziel + '\n' +
      (fs.existsSync(ziel)
        ? 'Die Datei existiert, ist aber unlesbar oder ohne "microsoftClientId".\n\n'
        : 'Die Datei existiert dort nicht.\n\n') +
      'So behebst du das (der einfachste Weg ist wirklich Punkt 1):\n' +
      '1. Im Launcher: Einstellungen -> Microsoft-Login -> Client-ID einfuegen -> Speichern\n' +
      '2. Oder auf der Kommandozeile:\n' +
      '   node setup-client-id.js\n' +
      '\n' +
      'Falls die Datei von Hand geschrieben wird, braucht sie genau diesen Inhalt:\n' +
      '   { "microsoftClientId": "DEINE-GUID" }\n' +
      '\n' +
      'Die App-Registrierung selbst, falls du sie noch nicht hast:\n' +
      '   portal.azure.com -> Microsoft Entra ID -> App registrations -> New registration\n' +
      '   Supported account types: "Accounts in any organizational directory and personal accounts"\n' +
      '   Redirect URI (Plattform "Mobile and desktop applications"):\n' +
      '     https://login.live.com/oauth20_desktop.srf\n' +
      '   Client-Secret: keines anlegen'
    );
  }

  return new Auth({
    client_id: clientId,
    redirect: resolveRedirectUri(userDataDir),
    // "select_account" zwingt Microsoft, den Account-Auswahldialog zu zeigen.
    // Ohne das merkt sich Windows den letzten Account stillschweigend — und der
    // Launcher meldet Erfolg, obwohl der falsche Account verbunden ist.
    prompt: 'select_account'
  });
}

/**
 * Hash-UUID in die übliche 8-4-4-4-12-Form bringen. msmc liefert sie ohne
 * Bindestriche, das Spiel erwartet sie mit.
 */
function formatUuid(rawId) {
  if (!rawId || rawId.includes('-')) return rawId;
  return rawId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

/**
 * baut das gespeicherte Account-Objekt.
 *
 * WICHTIG: `accessToken` und `xboxSave` bleiben hier im Haupt-Prozess. Was ans
 * UI geht, ist `toPublicAccount()` weiter unten. Ein Renderer-Prozess ist die
 * am leichtesten kompromittierte Stelle der App — ein Token darf dort nicht
 * liegen.
 */
function toStoredAccount(minecraftToken, xbox) {
  const profile = minecraftToken.profile;

  // profile ist laut msmc-Typen optional. Es ist nur gesetzt, wenn das Konto
  // Minecraft wirklich besitzt — das ist ein sehr häufiger Fall (z.B. wenn
  // jemand nur Game Pass Ultimate zum Testen hat), und der Fehler ist
  // "profile is not iterable", was nicht weiterhilft.
  if (!profile || !profile.id) {
    throw new Error(
      'Diesem Microsoft-Konto gehört kein Minecraft Java Edition. ' +
      'Zum Kaufen: minecraft.net — zum Beschenken: minecraft.net/gift.'
    );
  }

  const activeSkin = (profile.skins || []).find(s => s.state === 'ACTIVE');
  const uuid = formatUuid(profile.id);

  // msmc liefert die echte Ablaufzeit mit (exp = Unix-Zeitstempel in ms). Die
  // alte Fassung hat stattdessen pauschal 23 Stunden angesetzt und ist damit
  // nach jedem Neustart davon ausgegangen, das Token sei noch gueltig.
  const expiresAt = minecraftToken.exp > 1e11
    ? minecraftToken.exp
    : Date.now() + 23 * 3600 * 1000;

  return {
    id: uuid,
    username: profile.name,
    uuid,
    avatarUrl: `https://crafatar.com/avatars/${profile.id}?size=64&overlay`,
    skinUrl: activeSkin ? activeSkin.url : null,

    // --- ab hier nur fuer den Haupt-Prozess, nie ans UI senden ---
    accessToken: minecraftToken.mcToken,
    refreshToken: xbox.save(),
    expiresAt,
    // xuid wird als --xuid ans Spiel uebergeben (siehe downloader.js
    // buildGameArgs). Ohne den Wert bleiben manche Microsoft-Features stumm.
    xuid: minecraftToken.xuid || null,
    isDemo: !!minecraftToken.isDemo?.()
  };
}

/**
 * Die öffentliche, gefilterte Fassung für den Renderer.
 * Absichtlich eine Allowlist: neue/geheime Felder können so nicht versehentlich
 * durchrutschen.
 */
function toPublicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    uuid: account.uuid,
    avatarUrl: account.avatarUrl,
    skinUrl: account.skinUrl,
    xuid: account.xuid,
    isDemo: !!account.isDemo,
    expiresAt: account.expiresAt
  };
}

/**
 * Öffnet das Microsoft-Anmeldefenster und meldet den Status über onStatus.
 * onStatus(text) wird mit kurzen, deutschen Schritten gefüttert, damit das UI
 * dem Nutzer zeigen kann, worauf es gerade wartet — ansonsten sieht ein
 * 20-Sekunden-Fenster nach einem Hänger aus.
 */
async function loginWithMicrosoft(userDataDir, onStatus = () => {}) {
  const authManager = makeAuthManager(userDataDir);

  try {
    onStatus('Microsoft-Anmeldung wird geöffnet …');
    // Die zweiten Parameter sind die Fenster-Eigenschaften. msmc gibt seinen
    // Default ohne webPreferences weiter, und auf der Microsoft-Seite laeuft
    // dann zwar kein Node (Electron 32 hat nodeIntegration standardmaessig aus),
    // aber "explizit ist besser": Eine Fremdseite ohne contextIsolation im
    // Haupt-Prozess ist genau die Sorte Fenster, die man nicht haben will.
    const xbox = await authManager.launch('electron', {
      width: 520,
      height: 680,
      resizable: false,
      title: 'Microsoft-Anmeldung — Liquid Launcher',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Wir wollen nur sehen, wann die Weiterleitung zurueckkommt, nicht
        // deren Inhalt laden.
        images: true,
        javascript: true
      }
    });

    onStatus('Minecraft-Zugang wird geprüft …');
    const minecraftToken = await xbox.getMinecraft();
    return toStoredAccount(minecraftToken, xbox);
  } catch (err) {
    // msmc wirft keine echten Errors (siehe Kommentar bei
    // normalizeLoginError). Ohne das käme im UI eine leere Meldung an.
    throw await normalizeLoginError(err);
  }
}

/**
 * Erneuert das Minecraft-Token aus dem gespeicherten Refresh-Token, ohne dass
 * sich der Nutzer erneut anmelden muss. Genau das braucht ein Launcher, der
 * einen Account über Monate gespeichert hält.
 */
async function refreshAccount(userDataDir, stored) {
  if (!stored || !stored.refreshToken) {
    throw new Error('Kein Refresh-Token gespeichert — bitte neu anmelden.');
  }
  const authManager = makeAuthManager(userDataDir);
  try {
    const xbox = await authManager.refresh(stored.refreshToken);
    const minecraftToken = await xbox.getMinecraft();
    return toStoredAccount(minecraftToken, xbox);
  } catch (err) {
    // Auch hier: msmc-Fehler in lesbare Errors übersetzen. Besonders wichtig,
    // weil ein stiller Refresh-Fehler sonst nur als "Minecraft startet nicht"
    // auftaucht.
    throw await normalizeLoginError(err);
  }
}

/**
 * Prüft, ob das gespeicherte Token noch gültig ist — ohne Netzwerkzugriff, nur
 * anhand der Ablaufzeit. `reserveMs` sorgt dafür, dass ein Token nicht
 * mitten im Startvorgang abläuft (Assets laden dauert bei 500 MB locker
 * ein paar Minuten).
 */
function isAccountTokenValid(account, reserveMs = 5 * 60 * 1000) {
  return !!account?.expiresAt && Date.now() < account.expiresAt - reserveMs;
}

/**
 * Object Form des Account für den Start (enthält das echte accessToken).
 * Nur im Haupt-Prozess verwenden, nie an den Renderer schicken.
 *
 * userDataDir wird gebraucht, um die Client-ID aufzulösen: 1.21.4 erwartet
 * sie als `--clientId`. Ein leeres Argument funktioniert zwar (spawn übergibt
 * ein Array, der Leerstring bleibt also ein eigenes argv-Element), ist aber
 * unnötig fragil — sobald jemand die Argumente zum Loggen in einen String
 * joinet, verschwindet der Leerstring und `--xuid` landet plötzlich als *Wert*
 * von `--clientId`. Besser, der Wert ist einfach gefüllt.
 */
function toLaunchAccount(account, userDataDir) {
  if (!account) return null;
  return {
    username: account.username,
    uuid: account.uuid,
    accessToken: account.accessToken,
    userType: 'msa',
    xuid: account.xuid || '',
    isDemo: !!account.isDemo,
    clientId: resolveClientId(userDataDir) || ''
  };
}

function resetClientIdCache() {
  cachedClientId = undefined;
}

// ==========================================================================
// Fehlerübersetzung
//
// msmc wirft drei völlig verschiedene Dinge, und keines davon ist ein Error:
//   1. einen String wie "error.auth.xsts.child"      (XSTS-Login, GUI geschlossen)
//   2. { response, ts }                             (HTTP-Fehler: Microsoft,
//                                                     Xbox, Minecraft-Dienste)
//   3. echte Fehler aus dem eigenen Code
// Folge: err.message ist bei 1. und 2. undefined, und die eigentlich
// entscheidende Information steckt in der HTTP-Antwort, die msmc im Fehler
// mitwirft, aber nie ausliest. Ein Nutzer sähe also nur "Failed to login to
// Microsoft account" — ohne Hinweis darauf, ob die Client-ID falsch, der
// Redirect falsch oder der Account-Typ falsch war. Genau diese Frage muss man
// beantworten können, also holen wir die echten Codes aus der Antwort.
// ==========================================================================

// Die AADSTS-Codes, die in der Praxis wirklich vorkommen. Die lange
// error_description von Azure wird trotzdem mit ausgegeben — sie ist das
// eigentliche Beweisstück, diese Liste nur die schnelle Deutung.
const AADSTS_HINTS = {
  AADSTS50011: 'Der Redirect-URI passt nicht zur App-Registration. In Azure muss unter "Redirect URI" genau '
    + 'https://login.live.com/oauth20_desktop.srf stehen (Plattform "Mobile and desktop applications").',
  AADSTS50020: 'Der Account gehört zu einem anderen Verzeichnistyp. In Azure muss "Supported account types" auf '
    + '"Accounts in any organizational directory and personal accounts" stehen — sonst werden nur Firmen-Accounts akzeptiert.',
  AADSTS9002326: 'Falscher Account-Typ: In Azure ist "Nur persönliche Microsoft-Konten" oder "Nur Organisationsverzeichnisse" '
    + 'eingestellt. Für Minecraft brauchst du persönliche Konten.',
  AADSTS7000218: 'Die App-Registration verlangt ein Client-Secret. Für eine Desktop-App wird keines gebraucht — '
    + 'als "Public Client" anlegen und die ID hier eintragen.',
  AADSTS50076: 'Mehrstufige Authentifizierung (MFA) ist aktiv. Im erschienenen Fenster abbrechen und es nochmal '
    + 'ohne MFA versuchen.',
  AADSTS50079: 'MFA ist erzwungen. Der Login kann mit dieser App-Registration nicht abgeschlossen werden.',
  AADSTS50194: 'Die App ist für öffentliche Clients gedacht, registriert wurde sie aber als "Web". '
    + 'In Azure auf "Mobile and desktop applications" umstellen.',
  AADSTS900023: 'Ungültige Redirect-URI-Angabe in der App-Registration.'
};

// Xbox/XSTS-Fehler kommen als nummerischer XErr-Code.
const XERR_HINTS = {
  2148916233: 'Dieses Microsoft-Konto hat kein Xbox-Profil. Meist hilft es, sich einmal bei xbox.com einzuloggen und das Profil zu erstellen.',
  2148916235: 'Xbox Live ist in diesem Land nicht verfügbar.',
  2148916238: 'Das Konto ist ein Kindkonto (unter 18) und braucht eine Familienfreigabe. In der Microsoft-Familienverwaltung freigeben.',
  2148916236: 'Der Account benötigt eine koreanische Jugendschutzfreigabe.',
  2148916237: 'Der Account benötigt eine koreanische Jugendschutzfreigabe.'
};

// Übersetzt die msmc-Fehlerstrings in verständliche Texte.
const LEXICON_DE = {
  'error.auth.xsts.userNotFound': 'Dieses Microsoft-Konto hat kein Xbox-Profil. Logge dich einmal bei xbox.com ein, damit es angelegt wird.',
  'error.auth.xsts.bannedCountry': 'Xbox Live ist in diesem Land nicht verfügbar.',
  'error.auth.xsts.child': 'Das Konto ist ein Kindkonto (unter 18) und braucht eine Familienfreigabe.',
  'error.auth.xsts.child.SK': 'Der Account benötigt eine koreanische Jugendschutzfreigabe.',
  'error.auth.xsts': 'Xbox-Sicherheitstoken konnte nicht erstellt werden.',
  'error.auth.xboxLive': 'Die Xbox-Live-Anmeldung ist fehlgeschlagen.',
  'error.auth.minecraft.login': 'Minecraft-Server haben die Xbox-Anmeldung abgelehnt.',
  'error.auth.minecraft.profile': 'Dem Konto gehört kein Minecraft Java Edition. Kaufen auf minecraft.net, verschenken auf minecraft.net/gift.',
  'error.auth.minecraft.entitlements': 'Die Spielberechtigungen konnten nicht geprüft werden.',
  'error.gui.closed': 'Anmeldung abgebrochen.'
};

/**
 * Liest aus einer HTTP-Antwort den echten Grund.
 * node-fetch-Responses können nur einmal gelesen werden, deshalb wird der
 * Body hier vollständig konsumiert — danach ist `response.text()` nicht mehr
 * verfügbar, was msmc aber ohnehin nicht mehr tut.
 */
async function readErrorBody(response) {
  if (!response || typeof response.text !== 'function') return null;
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Manche Antworten sind HTML (z.B. eine ADFS-Seite). Nur den Textanfang
    // übernehmen, nicht 200 Zeilen HTML in die Fehlermeldung stopfen.
    return { error_description: raw.slice(0, 200) };
  }
}

function findAadstsCode(text) {
  if (!text) return null;
  const m = String(text).match(/AADSTS\d+/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * Wandelt alles, was msmc werfen kann, in einen echten `Error` mit
 * verständlicher deutscher Meldung um.
 */
async function normalizeLoginError(err) {
  // Bereits ein sauberer Error (z.B. aus makeAuthManager) — durchreichen.
  if (err instanceof Error) return err;

  // Fall 1: Fehler als String (XSTS-Codes, GUI vom Nutzer geschlossen)
  if (typeof err === 'string') {
    const text = LEXICON_DE[err];
    if (text) return new Error(text);
    if (err.includes('closed')) return new Error(LEXICON_DE['error.gui.closed']);
    return new Error(`Anmeldung fehlgeschlagen: ${err}`);
  }

  // Fall 2: { response, ts } aus msmcs errorResponse()
  if (err && typeof err === 'object' && err.response) {
    const body = await readErrorBody(err.response);
    const status = err.response.status;
    // Die Reihenfolge ist nicht beliebig, sie ist die Abdeckung der realen
    // Antwortformen:
    //   error_description  - Microsoft Identity (AADSTS-Meldungen)
    //   errorMessage       - Minecraft Services, z. B. /authentication/login_with_xbox
    //   message            - Xbox Live
    //   XErr               - Xbox, als Zahl
    //
    // "errorMessage" fehlte hier und kostete den Servertext in JEDER Antwort
    // der Minecraft-Server. Die Meldung blieb dadurch bei "(HTTP 403)" ohne
    // jede Auskunft — genau das, was die Fehlersuche unmoeglich macht.
    const description = body?.error_description || body?.errorMessage || body?.message || body?.XErr || '';
    const code = findAadstsCode(description);

    // Bekannter AADSTS-Code: Deutung + Originaltext als Beweis.
    if (code && AADSTS_HINTS[code]) {
      return new Error(
        `Anmeldung von Microsoft abgelehnt (${code}).\n\n${AADSTS_HINTS[code]}\n\n`
        + `Arawort von Microsoft: ${String(description).slice(0, 300)}`
      );
    }

    // Xbox liefert nummerische XErr-Codes.
    if (body && body.XErr && XERR_HINTS[body.XErr]) {
      return new Error(`${LEXICON_DE[err.ts] || 'Xbox-Anmeldung fehlgeschlagen.'}\n\n${XERR_HINTS[body.XErr]}`);
    }

    // "Invalid app registration" ist ein eigener, gut dokumentierter Fall — und
    // er ist NICHT die fehlende Java-Edition. Er bedeutet: die App-Registrierung
    // darf den Dienst login_with_xbox nicht benutzen. Nach Microsoft-Angaben
    // ist XboxLive.signin dem Xbox Developer Program vorbehalten; eine selbst
    // angelegte App-Registrierung kommt dort nicht durch, egal welche
    // Einstellungen sie hat. Betroffen sind alle neuen Launcher (Februar und
    // Juli 2026 im Microsoft Q&A, beide Male mit derselben Fehlermeldung).
    //
    // Beide Faelle bekommen eigene Texte, weil sie gegensaetzliche
    // Handlungen erfordern: einmal kaufen, einmal einen Entwicklerzugang
    // beantragen. Zusammenfassen hiesse, eines davon zu verschweigen.
    if (/invalid app registration/i.test(String(description))) {
      return new Error(
        'Microsoft lehnt die App-Registrierung ab: "Invalid app registration".\n\n'
        + 'Wichtig: Das ist NICHT "du hast kein Minecraft". Die ersten drei\n'
        + 'Stufen der Anmeldung waren erfolgreich — OAuth, Xbox Live und XSTS\n'
        + 'haben dein Konto angenommen. Abgelehnt wird allein die Identitaet der\n'
        + 'App, und zwar beim letzten Schritt.\n\n'
        + 'Warum: Der Endpunkt login_with_xbox ist fuer den Dienst\n'
        + '"XboxLive.signin" reserviert. Laut Microsoft ist dieser Dienst dem\n'
        + 'Xbox Developer Program vorbehalten. Eine selbst angelegte\n'
        + 'Azure-App-Registrierung kommt dort nicht durch — unabhaengig von\n'
        + 'Kontotyp, Redirect-URI, Client-Secret oder Public-Client-Flag.\n'
        + 'Das ist keine Fehlkonfiguration, die man wegkonfigurieren kann.\n\n'
        + 'Das erklärt auch, warum die Fehlersuche hier so lange gedauert hat:\n'
        + 'Alle drei vorherigen Stufen sind gruen, die Registrierung ist\n'
        + 'nachweislich gueltig, und trotzdem scheitert der letzte Aufruf.\n\n'
        + 'Was tatsaechlich hilft:\n'
        + '  1. Xbox Developer Program / ID@xbox beitreten\n'
        + '     https://developer.microsoft.com/games/publish\n'
        + '     Dort wird die App fuer XboxLive.signin freigeschaltet. fuer\n'
        + '     ID@xbox ist die Teilnahme kostenlos, verlangt aber ein Spiel.\n'
        + '  2. Oder den offiziellen Minecraft-Launcher zum Anmelden nutzen\n'
        + '     und den eigenen Launcher weiter fuer alles andere.\n\n'
        + 'Was NICHT hilft: eine zweite App-Registrierung anlegen, ein\n'
        + 'Client-Secret erzeugen oder den Kontotyp aendern. Das wurde alles\n'
        + 'durchprobiert; die Fehlermeldung bleibt identisch.'
      );
    }

    // Schritt 4 von 4: Minecraft Services nimmt die Xbox-Identitaet nicht an.
    // Das ist der mit Abstand haeufigste Endpunkt-Fehler, und die Ursache ist
    // fast nie ein Programmfehler: 403 heisst hier "diese Xbox-Identitaet hat
    // keine Java-Edition-Berechtigung".
    //
    // Wichtig: bis hierhin sind vier Schritte gelaufen. Wer diese Meldung
    // sieht, hat also bereits bewiesen, dass Client-ID, OAuth, Xbox Live
    // und XSTS funktionieren. Das gehoert in die Meldung, weil "403" sonst
    // wie ein Fehler in diesem Projekt aussieht.
    if (err.ts === 'error.auth.minecraft.login') {
      const serverText = description
        ? `\n\nMinecraft sagt: ${String(description).slice(0, 300)}`
        : '';
      return new Error(
        'Die Xbox-Anmeldung war erfolgreich, aber die Minecraft-Server lehnen sie ab.\n\n'
        + 'Das bedeutet: Dein Konto ist bei Microsoft angemeldet, Xbox Live\n'
        + 'akzeptiert es, und trotzdem lehnt Minecraft die Identität ab.\n'
        + 'In fast allen Fällen fehlt dem Konto die Berechtigung für\n'
        + 'Minecraft: Java Edition. Das ist keine Sache, die man am Launcher\n'
        + 'oder an der Azure-App einstellen kann.\n\n'
        + 'So prüfst du das in einer Minute:\n'
        + '   https://www.minecraft.net/has-java\n'
        + '   Steht dort "Du besitzt Minecraft: Java Edition" — dann passt es.\n'
        + '   Steht dort etwas anderes, kauf es auf minecraft.net oder\n'
        + '   verschenke es unter minecraft.net/gift.\n\n'
        + 'Häufige Ursachen:\n'
        + '  • Nur die Bedrock-Version (Windows-Edition) gekauft. Die ist ein\n'
        + '    eigenes Produkt und zählt nicht.\n'
        + '  • Minecraft unter einem anderen Microsoft-Konto gekauft.\n'
        + '  • Die Steam-Version gekauft — die bringt kein Microsoft-Konto mit.\n'
        + '  • Ein Key von einer Drittanbieter-Seite; solche Keys sind oft nur\n'
        + '    Bedrock oder laufen ab.\n'
        + '  • Game Pass Ultimate enthält Java Edition — das ist ausreichend.'
        + serverText
      );
    }

    // Unbekannter Code, aber mit lesbarem Text: den Text zeigen, das ist mehr
    // wert als eine generische Meldung.
    if (description) {
      return new Error(
        `Anmeldung fehlgeschlagen (HTTP ${status}).\n\n`
        + `${LEXICON_DE[err.ts] || ''}\n\nMicrosoft sagt: ${String(description).slice(0, 300)}`
      );
    }

    // Letzter Fallback. Frueher stand hier nur "... (HTTP 403)" — ohne jeden
    // Hinweis darauf, welche Stufe der Kette betroffen ist und was zu tun ist.
    // Genau das ist dann die Meldung, die jemanden beim naechsten Versuch
    // weiter im Kreis fuehrt.
    const roh = body ? JSON.stringify(body).slice(0, 400) : '(Antwort koennte nicht gelesen werden)';
    return new Error(
      `${LEXICON_DE[err.ts] || 'Anmeldung fehlgeschlagen.'} (HTTP ${status})\n\n`
      + `Antwort der Minecraft-/Xbox-Server: ${roh}\n\n`
      + `Betroffene Stufe laut msmc: ${String(err.ts || '(unbekannt)')}\n\n`
      + `Weitere Hinweise: https://minecraft.help/en-us/question/microsoft-account`
    );
  }

  return new Error(`Anmeldung fehlgeschlagen: ${String(err)}`);
}

module.exports = {
  loginWithMicrosoft,
  refreshAccount,
  isAccountTokenValid,
  toPublicAccount,
  toLaunchAccount,
  resolveClientId,
  normalizeLoginError,
  DEFAULT_REDIRECT_URI,
  resetClientIdCache
};
