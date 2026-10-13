// src/main/preload.js
// Läuft in einem isolierten Kontext (contextIsolation: true). Das UI bekommt
// NUR das hier explizit exponierte window.launcher-Objekt — keinen Zugriff
// auf require(), fs, child_process, etc.
//
// Kanal-Namen hier müssen 1:1 zu den ipcMain.handle(...)-Registrierungen in
// src/main/ passen (siehe ipc-handlers.js für den aktuellen Stand: instances.*
// ist bereits als lauffähiger Stub verdrahtet, alles andere wartet noch auf
// die Backend-Implementierung, siehe TODOs dort).

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    // Gibt eine Unsubscribe-Funktion zurück, damit das UI sauber aufräumen kann.
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('launcher', {
  auth: {
    listAccounts: invoke('auth:listAccounts'),
    // Oeffnet das Microsoft-Anmeldefenster. Wirft im Renderer, wenn keine
    // Azure-Client-ID hinterlegt ist — die Meldung steht dann in err.message
    // und enthaelt die Anleitung, wie man sie eintraegt.
    addAccount: invoke('auth:addAccount'),
    removeAccount: invoke('auth:removeAccount'),
    setActiveAccount: invoke('auth:setActiveAccount'),
    getActiveAccount: invoke('auth:getActiveAccount'),
    needsRelogin: invoke('auth:needsRelogin'),
    // Azure-Client-ID. Ein Public-Client-Parameter, kein Geheimnis — darf
    // deshalb im UI stehen und wird im Klartext gespeichert. get liefert
    // { clientId, redirectUri, configured }.
    getClientId: invoke('auth:getClientId'),
    setClientId: invoke('auth:setClientId'),
    // Fortschritt der Anmeldung als Text, damit das UI nicht wie ein Hänger
    // aussieht. Wird mit '' abgeschlossen.
    onStatus: subscribe('auth:status')
  },
  worlds: {
    // Spielstände einer Instanz. list liefert ein Array mit name, version,
    // lastPlayed, sizeBytes, iconPath, gameTypeName, hardcore, cheats, broken.
    // 'id' ist der Ordnername unter saves/ und wird für Quick Play gebraucht.
    list: invoke('worlds:list'),
    // Endgültig. Der Haupt-Prozess verweigert es, solange die Instanz läuft.
    remove: invoke('worlds:delete')
  },
  instances: {
    // Modpacks. Die Liste kommt aus %APPDATA%/instances — es gibt keine
    // festen Eintraege mehr im Code (siehe instances.js).
    //
    // `versions` liefert echte Versionen aus dem Mojang-Manifest fuer den
    // Dialog "Neues Modpack". `remove` weigert sich, solange das Modpack
    // laeuft — die Pruefung sitzt im Hauptprozess und laesst sich von hier
    // aus nicht umgehen.
    list: invoke('instances:list'),
    create: invoke('instances:create'),
    rename: invoke('instances:rename'),
    setTechnik: invoke('instances:setTechnik'),
    duplicate: invoke('instances:duplicate'),
    remove: invoke('instances:remove'),
    versions: invoke('instances:versions'),
    launch: invoke('instances:launch'),
    stop: invoke('instances:stop'),
    onStatusChange: subscribe('instances:statusChange'),
    onLog: subscribe('instances:log')
  },
  mods: {
    search: invoke('mods:search'),
    install: invoke('mods:install'),
    update: invoke('mods:update'),
    remove: invoke('mods:remove'),
    listInstalled: invoke('mods:listInstalled'),
    importLocal: invoke('mods:importLocal') // öffnet nativen Datei-Dialog, kopiert .jar in den App-Ordner
  },
  // Ressourcenpakete der gewaehlten Instanz.
  //
  // Anders als bei den Mods gibt es hier keine Suche und keinen Download:
  // ein Paket ist eine Datei (oder ein Ordner) im resourcepacks/-Ordner, und
  // der Schalter schreibt genau eine Zeile in options.txt.
  //
  // `list` liefert { packs, konflikte } — kein reines Array, weil ein Paket
  // auch doppelt vorliegen kann (Foo.zip und Foo/) und das eine Meldung
  // braucht, statt stillschweigend eines der beiden zu bevorzugen.
  packs: {
    list: invoke('packs:list'),
    setActive: invoke('packs:setActive'),
    remove: invoke('packs:remove'),
    importLocal: invoke('packs:importLocal') // oeffnet den Dateidialog, kopiert .zip in resourcepacks/
  },
  servers: {
    list: invoke('servers:list'),
    add: invoke('servers:add'),
    remove: invoke('servers:remove'),
    // Echter Server-Ping im Haupt-Prozess: MOTD, Spielerzahl, Version,
    // Latenz. Wirft bei einem nicht erreichbaren Server NICHT — die Antwort
    // kommt immer mit `online: false` und einem lesbaren `error` zurück.
    ping: invoke('servers:ping')
  },
  // Startoptionen der gewaehlten Instanz: RAM und Aufloesung.
  //
  // `set` WIRFT nicht bei einer falschen Eingabe, sondern antwortet mit
  // `fehler` im Ergebnis und laesst die gespeicherten Werte unveraendert.
  // Grund: die Eingabefelder werden beim Tippen geprueft, nicht erst beim
  // Speichern — ein Reject wuerde hier als unbehandelte Ablehnung im
  // Renderer landen, waehrend der Benutzer noch tippt.
  instanceSettings: {
    get: invoke('instanceSettings:get'),
    set: invoke('instanceSettings:set')
  },
  skins: {
    getActive: invoke('skins:getActive'),
    upload: invoke('skins:upload'),
    vergessen: invoke('skins:vergessen'),
    setActive: invoke('skins:setActive')
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set')
  },
  // Modpack-Import: .mrpack (Modrinth) und CurseForge-Zips.
  //
  // `pruefen` oeffnet den Dateidialog und liefert eine Zusammenfassung
  // (format, name, version, minecraft, modloader, dateien, overrides) —
  // `importieren` braucht danach nur noch den Instanznamen und importiert
  // die GEWAEHLTE Datei. Der Renderer uebergibt bewusst keinen Pfad.
  //
  // `sucheModrinth` / `importiereModrinth` finden und laden das neueste
  // .mrpack eines Projekts. `sucheCurseForge` antwortet ohne hinterlegten
  // API-Schluessel immer mit { fehler: '...' } und ist deshalb kein
  // vollwertiger Weg — die Datei-Importseite funktioniert ohne Schluessel.
  modpackQuellen: {
    pruefen: invoke('modpackQuellen:pruefen'),
    importieren: invoke('modpackQuellen:importieren'),
    sucheModrinth: invoke('modpackQuellen:sucheModrinth'),
    importiereModrinth: invoke('modpackQuellen:importiereModrinth'),
    sucheCurseForge: invoke('modpackQuellen:sucheCurseForge')
  },
  windowControl: {
    getBounds: invoke('window:getBounds'),
    setSize: invoke('window:setSize'),
    setPosition: invoke('window:setPosition'),
    center: invoke('window:center'),
    resetSize: invoke('window:resetSize')
  },
  // Screenshot der Launcher-Oberflaeche (Schnellzugriff auf der Startseite).
  // Der Hauptprozess zeichnet das Fenster und legt das PNG unter
  // %APPDATA%/Liquid Launcher/screenshots/ ab. Der Renderer bekommt nur den
  // Dateinamen zurueck - kein fs und keine Bilddaten, er kann die Datei also
  // nicht selbst schreiben oder lesen.
  screenshots: {
    capture: invoke('screenshot:capture'),
    openFolder: invoke('screenshot:openFolder')
  },
  // Widgets.
  //
  // Wichtig zum Verstehen der Sicherheitslage: diese vier Funktionen sind
  // NICHT das, was ein Widget aufrufen kann. Sie laufen im Hauptframe, wo
  // auch `auth` steht. Ein Widget sitzt in einem sandboxed iframe, hat
  // dort kein `window.launcher` und kann daher keinen dieser Kanaele
  // erreichen - es bekommt Daten ausschliesslich ueber postMessage vom
  // Renderer, und die kommen durch filtereDatenFuerWidget() im
  // Hauptprozess. Vergleiche README, Abschnitt "Widgets".
  widgets: {
    list: invoke('widgets:list'),            // verfuegbare Widgets
    html: invoke('widgets:html'),            // HTML eines Widgets
    daten: invoke('widgets:daten'),          // der gefilterte Datenkoffer
    // Leichter Kanal fuer die oft messbaren Werte (CPU, RAM, Datentraeger,
    // laufende Spiel-Prozesse). Der Host fragt ihn im Takt ab, siehe
    // widget-host.js datenFrisch().
    systemdaten: invoke('widgets:systemdaten'),
    openFolder: invoke('widgets:openFolder') // Ordner fuer eigene Widgets
  },
  // Eigene Schriftdatei fuer die Oberflaeche.
  //
  // `waehlen` oeffnet den nativen Dateidialog und kopiert die Datei nach
  // %APPDATA%\Liquid Launcher\schrift\. `lesen` liefert die Bytes als
  // Data-URI fuer @font-face. Der Renderer bekommt bewusst keinen Pfad und
  // kein fs: er kann die Datei weder selbst suchen noch selbst lesen, nur
  // anzeigen.
  fonts: {
    choose: invoke('schriften:waehlen'),
    read: invoke('schriften:lesen'),
    forget: invoke('schriften:vergessen')
  }
});
