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
    list: invoke('instances:list'),
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
    setActive: invoke('skins:setActive')
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set')
  },
  windowControl: {
    getBounds: invoke('window:getBounds'),
    setSize: invoke('window:setSize'),
    setPosition: invoke('window:setPosition'),
    center: invoke('window:center'),
    resetSize: invoke('window:resetSize')
  }
});
