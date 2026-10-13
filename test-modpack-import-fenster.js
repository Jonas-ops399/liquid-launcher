// test-modpack-import-fenster.js
// Prueft den Modpack-Import durch die echte Oberflaeche: die Import-Sektion
// im Anlege-Dialog, das Pruefen einer Datei, den Import selbst, die
// Modrinth-Suche, die ehrliche Ablehnung eines nicht startbaren Loaders
// (Quilt) und die Sprachumschaltung der neuen Beschriftungen.
//
// Aufruf: electron.exe test-modpack-import-fenster.js
// (mit node laeuft er nicht: er braucht ein echtes Fenster)
//
// Die Kanaele modpackQuellen:* sind bewusst STUBS, arbeiten aber mit dem
// ECHTEN Modul src/main/modpackImport.js und dem ECHTEN Speichermodul
// src/main/instances.js — derselben Logik, die auch der Hauptprozess
// benutzt. Getestet wird hier die Verdrahtung im Fenster (Sichtbarkeit,
// Klicks, Anzeige, Abschluss), nicht die Modullogik selbst: die steht
// schon in test-modpack-import.js.
//
// Regel fuer diesen Test wie im Modpack-Test: Jede Pruefung schaut auf das,
// was auf dem Bildschirm steht oder auf der Platte liegt — nicht darauf,
// ob eine Funktion existiert.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const { app, BrowserWindow, ipcMain } = require('electron');

const PROJ = __dirname;
const USER_DATA = path.join(os.tmpdir(), 'liquid-launcher-modpackimport-test');
const FIX = path.join(USER_DATA, 'fixtures');

// Immer sauber anfangen. Sonst haengt das Ergebnis davon ab, ob der Test
// vorher schon einmal gelaufen ist.
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(FIX, { recursive: true });

let pruefungen = 0;
const probleme = [];
const Z = [];

function ok(bedingung, text, zusatz) {
  pruefungen++;
  if (bedingung) {
    Z.push('  OK    ' + text);
  } else {
    Z.push('  FEHLT ' + text + (zusatz ? '   -> ' + zusatz : ''));
    probleme.push(text);
  }
}
function gleich(bezeichnung, ist, soll) {
  ok(JSON.stringify(ist) === JSON.stringify(soll), bezeichnung,
     'ist ' + JSON.stringify(ist) + ', erwartet ' + JSON.stringify(soll));
}
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); schreibe(); }

// ---------- Fixtures: echte Modpack-Dateien, wie sie Modrinth liefert ----------

const JAR_INHALT = Buffer.from('JAR-INHALT-BEISPIEL-MOD-0123456789');
const JAR_SHA1 = crypto.createHash('sha1').update(JAR_INHALT).digest('hex');

function baueMrpack(name, versionId, ziel) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId,
    name,
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    files: [
      { path: 'mods/beispielmod.jar', hashes: { sha1: JAR_SHA1 }, downloads: ['https://cdn.test/beispielmod.jar'], env: { client: 'required', server: 'unsupported' } },
      { path: 'resourcepacks/extra.zip', downloads: ['https://cdn.test/extra.zip'] }
    ]
  })));
  zip.addFile('overrides/config/settings.toml', Buffer.from('s="a"\n'));
  zip.addFile('overrides/config/extra.json', Buffer.from('{"quelle":"overrides"}'));
  zip.addFile('client-overrides/config/extra.json', Buffer.from('{"quelle":"client-gewonnen"}'));
  fs.writeFileSync(ziel, zip.toBuffer());
}

// Quilt-Pack: der Launcher kann quilt NICHT starten (instances.js kennt nur
// vanilla/fabric/forge). Der Import muss das vor dem Anlegen sagen.
function baueQuilt(ziel) {
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: '9.9.9',
    name: 'Quilt-Pack',
    dependencies: { minecraft: '1.21.4', 'quilt-loader': '0.24.0' },
    files: []
  })));
  fs.writeFileSync(ziel, zip.toBuffer());
}

const MRPACK = path.join(FIX, 'testpaket.mrpack');
baueMrpack('Test-Paket Alpha', '3.2.1', MRPACK);
const MRPACK2 = path.join(FIX, 'modrinth-fund.mrpack');
baueMrpack('Modrinth-Fund Alpha', '4.5.6', MRPACK2);
const QUILT = path.join(FIX, 'quilt.mrpack');
baueQuilt(QUILT);

// ladeDatei-Attrappe: schreibt Dummy-Inhalt, keine Netzwerkrufe. Genau wie
// im Modul-Test — der Download-Vorgang selbst (fetch, SHA1-Pruefung) ist
// dort mit stubbed fetch geprueft.
function ladeDummy(url, sha1Soll, zielPfad) {
  fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
  fs.writeFileSync(zielPfad, Buffer.from('dummy-' + path.basename(zielPfad)));
}

(async () => {
  await app.whenReady();

  const fenster = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(PROJ, 'src', 'main', 'preload.js'), contextIsolation: true }
  });
  fenster.webContents.on('ipc-message', () => {});

  const inst = require('./src/main/instances');
  const modpackImport = require('./src/main/modpackImport');
  const Daten = USER_DATA;

  // ---- Stubs fuer die Kanaele, die das Fenster sonst beim Hauptprozess
  //      erfragt. Die Import-Kanaele rechnen mit dem ECHTEN Modul.
  let gewaehlteDatei = null;   // was "pruefen" zuletzt gelesen hat
  let pruefenAbbrechen = false;

  // Derselbe Vor-Weg wie in ipc-handlers.js: Loader pruefen, Instanz anlegen,
  // installieren. Der Renderer sieht daraus nur ok/fehler und die Instanz.
  function importAusInfo(info, name) {
    if (info && info.format === null) {
      return { ok: false, fehler: (info.fehler || 'Kein Modpack erkannt.') };
    }
    if (!info || !info.minecraft) {
      return {
        ok: false,
        fehler: 'Das Modpack nennt keine Minecraft-Version — ohne sie laesst sich keine Instanz anlegen.'
      };
    }
    if (!modpackImport.STARTER_LOADER.includes(info.modloader)) {
      return {
        ok: false,
        fehler: `Dieses Modpack verlangt den Modloader "${info.modloader || 'unbekannt'}". ` +
          `Der Launcher kann nur ${modpackImport.STARTER_LOADER.join(', ')} starten.`
      };
    }
    const instanz = inst.anlegen(Daten, {
      name: (name && String(name).trim()) || info.name || 'Importiertes Modpack',
      version: info.minecraft,
      modloader: info.modloader === 'vanilla' ? 'vanilla' : info.modloader
    });
    const zielDir = inst.instanceDir(Daten, instanz.id);
    return { ok: true, instanz, zielDir };
  }

  const antworten = {
    'instances:list': () => inst.listen(Daten),
    'instances:create': (_e, a) => inst.anlegen(Daten, a),
    'instances:rename': (_e, id, n) => inst.umbenennen(Daten, id, n),
    'instances:setTechnik': (_e, id, a) => inst.technikSetzen(Daten, id, a),
    'instances:duplicate': (_e, id, n) => inst.duplizieren(Daten, id, n),
    'instances:remove': (_e, id) => inst.entfernen(Daten, id),
    'instances:versions': () => ([
      { id: '1.21.4', typ: 'release', zeit: 0 },
      { id: '1.20.1', typ: 'release', zeit: 0 }
    ]),
    // Der Import-Kanal: derselbe Ablauf wie im Hauptprozess, nur ohne
    // Dateidialog und ohne Netz (ladeDummy statt fetch).
    'modpackQuellen:pruefen': () => {
      if (pruefenAbbrechen) return null;
      return modpackImport.modpackAusDatei(gewaehlteDatei);
    },
    'modpackQuellen:importieren': async (_e, name) => {
      const pfad = gewaehlteDatei;
      gewaehlteDatei = null; // ein Import gilt nur einmal, wie im echten Prozess
      if (!pfad) {
        throw new Error('Keine Modpack-Datei gewaehlt. Erst "Modpack importieren" und eine Datei aussuchen.');
      }
      const info = modpackImport.modpackAusDatei(pfad);
      const geruest = importAusInfo(info, name);
      if (!geruest.ok) return geruest;
      const ergebnis = info.format === 'mrpack'
        ? await modpackImport.installiereMrpack(geruest.zielDir, pfad, ladeDummy, {})
        : await modpackImport.installiereCurseForge(geruest.zielDir, pfad, null, ladeDummy, { unterordner: 'mods' });
      if (ergebnis.abgelehnt) {
        try { inst.entfernen(Daten, geruest.instanz.id); } catch { /* s.o. */ }
        return { ok: false, fehler: [...ergebnis.fehler] };
      }
      return {
        ok: true,
        instanz: geruest.instanz,
        format: info.format,
        modpack: { name: info.name, version: info.version, minecraft: info.minecraft, modloader: info.modloader },
        ergebnis
      };
    },
    'modpackQuellen:sucheModrinth': () => ([
      { id: 'proj-alpha', name: 'Modrinth-Fund Alpha', version: '1.20.1', downloads: 1234 },
      { id: 'proj-beta', name: 'Modrinth-Fund Beta', version: '1.21.4', downloads: 567 }
    ]),
    'modpackQuellen:importiereModrinth': async () => {
      // Das neueste .mrpack eines Projekts ist lokal die Attrappe MRPACK2.
      const info = modpackImport.modpackAusDatei(MRPACK2);
      const geruest = importAusInfo(info);
      if (!geruest.ok) return geruest;
      const ergebnis = await modpackImport.installiereMrpack(geruest.zielDir, MRPACK2, ladeDummy, {});
      if (ergebnis.abgelehnt) {
        try { inst.entfernen(Daten, geruest.instanz.id); } catch { /* s.o. */ }
        return { ok: false, fehler: [...ergebnis.fehler] };
      }
      return {
        ok: true,
        instanz: geruest.instanz,
        format: 'mrpack',
        modpack: { name: info.name, version: info.version, minecraft: info.minecraft, modloader: info.modloader },
        ergebnis
      };
    },
    'modpackQuellen:sucheCurseForge': () => ({ fehler: 'Für die CurseForge-Suche wird ein API-Schlüssel benötigt.' })
  };
  Object.entries(antworten).forEach(([kanal, fn]) => {
    ipcMain.handle(kanal, fn);
  });

  const restStubs = {
    'mods:listInstalled': (_e, id) => {
      const dir = path.join(Daten, 'instances', id, 'mods');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jar'))
        .map(f => ({ id: path.basename(f, '.jar'), name: path.basename(f, '.jar'), source: 'local' }));
    },
    'mods:remove': () => true,
    'mods:search': () => ([]),
    'mods:install': () => true,
    'mods:importLocal': () => null,
    'worlds:list': () => ({ welten: [], fehler: null }),
    'worlds:delete': () => ({ ok: true }),
    'servers:list': () => [],
    'servers:add': () => true,
    'servers:remove': () => true,
    'servers:ping': () => ({ online: false }),
    'settings:get': () => ({}),
    'settings:set': () => true,
    'instanceSettings:get': () => ({}),
    'instanceSettings:set': () => true,
    'widgets:list': () => [],
    'widgets:daten': () => ({}),
    'widgets:html': () => '',
    'widgets:systemdaten': () => ({}),    'auth:listAccounts': () => [],
    'auth:getActiveAccount': () => null,
    'auth:needsRelogin': () => false,
    'auth:getClientId': () => ({ clientId: '', redirectUri: '', configured: false }),
    'schriften:lesen': () => null,
    'schriften:waehlen': () => null,
    'schriften:vergessen': () => true,
    'skins:getActive': () => null,
    'skins:setActive': () => true,
    'skins:upload': () => null,
    'skins:vergessen': () => true,
    // setLanguage() zeichnet die Paketliste neu — der Kanal muss antworten.
    'packs:list': () => ({ pakete: [], fehler: null }),
    'packs:importLocal': () => null,
    'packs:setActive': () => true,
    'packs:remove': () => true
  };
  Object.entries(restStubs).forEach(([kanal, fn]) => {
    ipcMain.handle(kanal, fn);
  });

  // Schritt-fuer-Schritt-Protokoll (siehe test-modpacks-fenster.js). Zusaetzlich
  // ein Timeout pro Aufruf: ein haengen gebliebenes executeJavaScript wuerde
  // sonst das Fenster ewig offen halten, ohne dass die Log-Datei weitergeschrieben
  // wird. Mit dem Wettlauf wird aus jedem Haenger ein sichtbarer Schritt.
  let schritt = 0;
  const js = async (code) => {
    schritt++;
    zwischen('  >> Schritt ' + schritt + ' laeuft: ' + code.replace(/\s+/g, ' ').slice(0, 140));
    try {
      return await Promise.race([
        fenster.webContents.executeJavaScript(code, true),
        new Promise((_, ab) => setTimeout(() => ab(new Error('Timeout nach 20 s')), 20000))
      ]);
    } catch (err) {
      const marke = 'ABBRUCH bei Schritt ' + schritt + ': ' + String(err && err.message || err);
      Z.push('');
      Z.push('!!! ' + marke);
      Z.push('    Code: ' + code.replace(/\s+/g, ' ').slice(0, 300));
      throw new Error(marke);
    }
  };

  const protokoll = [];
  fenster.webContents.on('console-message', (_e, _lvl, text) => {
    if (/error|Error|exception/i.test(text)) protokoll.push(text);
  });

  await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  const warte = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- Helfer im Fenster ----------
  const oeffneNeuesModpack = () => js(`(function(){
    document.getElementById('versionPill').click();
    var b = document.querySelector('#instanceDropdown .instance-neu');
    if (b) b.click();
    return !!b;
  })()`);
  const importZustand = () => js(`JSON.stringify(window.__modpackImportZustand())`);

  // =====================================================================
  gruppe('1. Die Import-Sektion im Anlege-Dialog');
  // =====================================================================
  ok(await oeffneNeuesModpack() === true, 'der Knopf "Neues Modpack" ist da und oeffnet den Dialog');
  await warte(400);

  const zustand1 = JSON.parse(await importZustand());
  Z.push('    ' + JSON.stringify(zustand1));
  ok(zustand1.sichtbar === true, 'die Import-Sektion ist im Anlege-Dialog sichtbar');
  ok(zustand1.vorgemerkt === false, 'und frisch zurueckgesetzt — kein Rest aus einem frueheren Lauf');
  const markup = JSON.parse(await js(`(function(){
    function el(id){ return document.getElementById(id); }
    var fehlt = ['instDialogImport','instImportDatei','instImportInfo','instImportSuche',
                 'instImportSuchKnopf','instImportStatus','instImportTreffer',
                 'instImportFehler','instImportStarten']
                .filter(function(id){ return !el(id); });
    return JSON.stringify({
      fehlendeElemente: fehlt,
      titel: (document.querySelector('#instDialogImport .inst-import-kopf span')||{}).textContent || '',
      knopf: (el('instImportDatei')||{}).textContent || '',
      platzhalter: (el('instImportSuche')||{}).placeholder || ''
    });
  })()`));
  Z.push('    ' + JSON.stringify(markup));
  gleich('alle Import-Elemente sind im HTML vorhanden', markup.fehlendeElemente, []);
  ok(markup.titel === 'Modpack importieren', 'der Sektionstitel ist uebersetzt: "' + markup.titel + '"');
  ok(/wählen|Datei/i.test(markup.knopf), 'der Datei-Knopf trägt seine Beschriftung: "' + markup.knopf + '"');
  ok(markup.platzhalter.length > 0, 'das Suchfeld hat einen Platzhalter');

  // Abbrechen (Dialog zu) — die Sektion muss beim naechsten Oeffnen wieder
  // sauber sein, aber das prueft Gruppe 2 implizit mit.
  await js(`document.getElementById('instDialogAbbrechen').click(); true`);
  await warte(200);

  // =====================================================================
  gruppe('2. Datei pruefen');
  // =====================================================================
  await oeffneNeuesModpack();
  await warte(400);

  // Abgebrochener Dateidialog: pruefen() liefert null, es darf sich nichts
  // aendern — kein Info-Text, kein Start-Knopf, keine Vormerkung.
  pruefenAbbrechen = true;
  await js(`document.getElementById('instImportDatei').click(); true`);
  await warte(300);
  let z = JSON.parse(await importZustand());
  Z.push('    nach Abbrechen: ' + JSON.stringify(z));
  ok(z.vorgemerkt === false, 'ein abgebrochener Dateidialog merkt nichts vor');
  const nachAbbrechen = JSON.parse(await js(`(function(){
    return JSON.stringify({
      infoVersteckt: document.getElementById('instImportInfo').hidden,
      startVersteckt: document.getElementById('instImportStarten').hidden
    });
  })()`));
  ok(nachAbbrechen.infoVersteckt === true, 'und zeigt keine Zusammenfassung');
  ok(nachAbbrechen.startVersteckt === true, 'und keinen Import-Knopf');

  // Jetzt eine echte Datei waehlen (der Stub liest das Fixture).
  pruefenAbbrechen = false;
  gewaehlteDatei = MRPACK;
  await js(`document.getElementById('instImportDatei').click(); true`);
  await warte(300);
  z = JSON.parse(await importZustand());
  ok(z.vorgemerkt === true, 'eine gepruefte Datei ist vorgemerkt');
  const info = JSON.parse(await js(`(function(){
    return JSON.stringify({
      text: document.getElementById('instImportInfo').textContent,
      versteckt: document.getElementById('instImportInfo').hidden,
      name: document.getElementById('instDialogName').value,
      startDa: !document.getElementById('instImportStarten').hidden
    });
  })()`));
  Z.push('    ' + JSON.stringify(info));
  ok(info.versteckt === false, 'die Zusammenfassung wird angezeigt');
  ok(/Test-Paket Alpha/.test(info.text), 'sie nennt den Namen: ' + info.text);
  ok(/1\.20\.1/.test(info.text), 'und die Minecraft-Version');
  ok(/MRPACK/.test(info.text), 'und das Format');
  ok(info.name === 'Test-Paket Alpha', 'der Instanzname ist mit dem Packnamen vorbelegt');
  ok(info.startDa === true, 'der Import-Knopf erscheint erst nach dem Pruefen');

  // =====================================================================
  gruppe('3. Import ueber die Oberflaeche');
  // =====================================================================
  // Den Namen im Feld aendern: der Name des Nutzers gewinnt gegen den
  // Packnamen (Entscheidung aus dem Modul-Test).
  await js(`(function(){
    document.getElementById('instDialogName').value = 'Mein Import';
    document.getElementById('instImportStarten').click();
    return true;
  })()`);
  await warte(900);

  const nachImport = JSON.parse(await js(`(function(){
    return JSON.stringify({
      dialogOffen: !document.getElementById('instDialog').hidden,
      kacheln: (function(){
        document.getElementById('versionPill').click();
        return Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){ return e.textContent.trim(); });
      })(),
      pill: document.getElementById('versionPillText').textContent
    });
  })()`));
  Z.push('    ' + JSON.stringify(nachImport));
  ok(nachImport.dialogOffen === false, 'nach dem Import ist der Dialog zu');
  ok(nachImport.kacheln.some(x => /Mein Import/.test(x)), 'der neue Name steht in der Liste');
  ok(/1\.20\.1/.test(nachImport.pill), 'die Auswahl steht auf der importierten Instanz: "' + nachImport.pill + '"');

  // Auf der Platte nachsehen: die Instanz, die heruntergeladenen Mods und
  // die Overrides muessen wirklich liegen.
  const instDir = path.join(Daten, 'instances', 'mein-import');
  ok(fs.existsSync(path.join(instDir, 'instance.json')), 'instance.json liegt im Instanzordner');
  const meta = JSON.parse(fs.readFileSync(path.join(instDir, 'instance.json'), 'utf-8'));
  gleich('version ist die SPIELversion (1.20.1)', meta.version, '1.20.1');
  gleich('modloader ist fabric', meta.modloader, 'fabric');
  gleich('der Name ist der vom Nutzer gewaehlte', meta.name, 'Mein Import');
  ok(fs.existsSync(path.join(instDir, 'mods', 'beispielmod.jar')),
     'der Mod aus dem Pack wurde heruntergeladen');
  ok(fs.existsSync(path.join(instDir, 'resourcepacks', 'extra.zip')),
     'auch das Ressourcenpaket aus dem Pack wurde geladen');
  ok(fs.existsSync(path.join(instDir, 'config', 'settings.toml')),
     'die overrides/ wurden in die Instanz geschrieben');
  const extra = fs.readFileSync(path.join(instDir, 'config', 'extra.json'), 'utf-8');
  gleich('client-overrides schlaegt overrides (gemessene Reihenfolge)', extra, '{"quelle":"client-gewonnen"}');

  // =====================================================================
  gruppe('4. Quilt wird ehrlich abgelehnt');
  // =====================================================================
  await oeffneNeuesModpack();
  await warte(400);
  gewaehlteDatei = QUILT;
  await js(`document.getElementById('instImportDatei').click(); true`);
  await warte(300);
  const quiltInfo = JSON.parse(await js(`(function(){
    return JSON.stringify({
      text: document.getElementById('instImportInfo').textContent,
      vorgemerkt: JSON.parse(JSON.stringify(window.__modpackImportZustand())).vorgemerkt
    });
  })()`));
  Z.push('    ' + JSON.stringify(quiltInfo));
  ok(/Quilt-Pack/.test(quiltInfo.text), 'auch ein nicht startbares Pack wird gelesen und angezeigt');

  await js(`document.getElementById('instImportStarten').click(); true`);
  await warte(600);
  const quiltFehler = JSON.parse(await js(`(function(){
    return JSON.stringify({
      fehler: document.getElementById('instImportFehler').textContent,
      sichtbar: !document.getElementById('instImportFehler').hidden,
      dialogOffen: !document.getElementById('instDialog').hidden
    });
  })()`));
  Z.push('    ' + JSON.stringify(quiltFehler));
  ok(quiltFehler.sichtbar === true, 'die Ablehnung wird angezeigt statt still zu verschwinden');
  ok(/verlangt den Modloader "quilt"/.test(quiltFehler.fehler),
     'die Meldung nennt den Loader: ' + quiltFehler.fehler.slice(0, 80));
  ok(quiltFehler.dialogOffen === true, 'der Dialog bleibt offen — das Modpack kann umbenannt oder von Hand angelegt werden');
  ok(!fs.existsSync(path.join(Daten, 'instances', 'quilt-pack')),
     'und es wurde kein Geisterordner angelegt');

  // Der Import ist ein Einmal-Weg (Selection wird verbraucht): ein zweiter
  // Klick auf denselben Knopf muss der Wahrheit entsprechen und melden,
  // dass keine Datei mehr gewaehlt ist.
  await js(`document.getElementById('instImportStarten').click(); true`);
  await warte(500);
  const zweiterKlick = await js(`document.getElementById('instImportFehler').textContent`);
  Z.push('    zweiter Klick: ' + zweiterKlick.slice(0, 120));
  ok(/Keine Modpack-Datei gewaehlt/.test(zweiterKlick),
     'der zweite Klick lügt nicht: die gewaehlte Datei ist verbraucht — ' + zweiterKlick.slice(0, 60));

  await js(`document.getElementById('instDialogAbbrechen').click(); true`);
  await warte(200);

  // =====================================================================
  gruppe('5. Modrinth-Suche und Import');
  // =====================================================================
  await oeffneNeuesModpack();
  await warte(400);
  await js(`(function(){
    document.getElementById('instImportSuche').value = 'Alpha';
    document.getElementById('instImportSuchKnopf').click();
    return true;
  })()`);
  await warte(400);
  const treffer = JSON.parse(await js(`(function(){
    var zeilen = Array.from(document.querySelectorAll('#instImportTreffer .inst-import-treffer-knopf'));
    return JSON.stringify({
      versteckt: document.getElementById('instImportTreffer').hidden,
      anzahl: zeilen.length,
      texte: zeilen.map(function(e){ return e.textContent; }),
      status: document.getElementById('instImportStatus').textContent
    });
  })()`));
  Z.push('    ' + JSON.stringify(treffer));
  ok(treffer.versteckt === false, 'die Trefferliste erscheint');
  gleich('zwei Treffer aus dem Stub', treffer.anzahl, 2);
  ok(treffer.texte[0] && /Modrinth-Fund Alpha/.test(treffer.texte[0]),
     'der erste Treffer nennt Name, Version und Downloads: ' + (treffer.texte[0] || '(leer)'));
  ok(/Version 1\.20\.1/.test(treffer.texte[0] || ''), 'und die Spielversion');

  // Klick auf den ersten Treffer importiert das zugehoerige Pack.
  await js(`document.querySelectorAll('#instImportTreffer .inst-import-treffer-knopf')[0].click(); true`);
  await warte(900);
  const nachModrinth = JSON.parse(await js(`(function(){
    return JSON.stringify({
      dialogOffen: !document.getElementById('instDialog').hidden,
      kacheln: (function(){
        document.getElementById('versionPill').click();
        return Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){ return e.textContent.trim(); });
      })(),
      pill: document.getElementById('versionPillText').textContent
    });
  })()`));
  Z.push('    ' + JSON.stringify(nachModrinth));
  ok(nachModrinth.dialogOffen === false, 'nach dem Modrinth-Import ist der Dialog zu');
  ok(nachModrinth.kacheln.some(x => /Modrinth-Fund Alpha/.test(x)),
     'das importierte Pack steht in der Liste');
  const modrinthDir = path.join(Daten, 'instances', 'modrinth-fund-alpha');
  ok(fs.existsSync(path.join(modrinthDir, 'mods', 'beispielmod.jar')),
     'und die Mods liegen wirklich im neuen Instanzordner');

  // =====================================================================
  gruppe('6. Die Sektion bleibt den anderen Dialogen fern');
  // =====================================================================
  // Umbenennen, Duplizieren und Loeschen haben mit Import nichts zu tun —
  // die Sektion darf dort nicht auftauchen (sie gehoert nur zum Anlegen).
  const aktionPruefen = async (index, bezeichnung) => {
    await js(`(function(){
      document.getElementById('versionPill').click();
      var option = document.querySelector('#instanceDropdown .instance-option');
      option.click();
      return true;
    })()`);
    await warte(250);
    await js(`(function(){
      document.getElementById('versionPill').click();
      var option = document.querySelector('#instanceDropdown .instance-option');
      option.querySelectorAll('.inst-aktion')[${index}].click();
      return true;
    })()`);
    await warte(300);
    const sicht = JSON.parse(await importZustand());
    const offen = JSON.parse(await js(`JSON.stringify({ offen: !document.getElementById('instDialog').hidden })`));
    Z.push('    ' + bezeichnung + ': sichtbar=' + sicht.sichtbar + ', offen=' + offen.offen);
    ok(offen.offen === true, bezeichnung + ' oeffnet einen Dialog');
    ok(sicht.sichtbar === false, 'und die Import-Sektion ist dabei unsichtbar (' + bezeichnung + ')');
    await js(`document.getElementById('instDialogAbbrechen').click(); true`);
    await warte(250);
  };
  await aktionPruefen(0, 'Umbenennen');
  await aktionPruefen(1, 'Duplizieren');
  await aktionPruefen(2, 'Entfernen');

  // =====================================================================
  gruppe('7. Die Beschriftungen der Sektion in vier Sprachen');
  // =====================================================================
  await oeffneNeuesModpack();
  await warte(400);
  const sprachKlick = async (name) => {
    await js(`(function(){
      var btns = Array.from(document.querySelectorAll('#langRow .lang-btn'));
      var treffer = btns.filter(function(b){ return b.textContent === '${name}'; })[0];
      if (treffer) treffer.click();
      return !!treffer;
    })()`);
    await warte(300);
  };
  const sprachText = async () => JSON.parse(await js(`(function(){
    return JSON.stringify({
      titel: (document.querySelector('#instDialogImport .inst-import-kopf span')||{}).textContent || '',
      datei: document.getElementById('instImportDatei').textContent,
      platzhalter: document.getElementById('instImportSuche').placeholder,
      sucheLabel: (document.querySelector('#instImportSuche').closest('.inst-feld').querySelector('span')||{}).textContent || ''
    });
  })()`));

  let s = await sprachText();
  Z.push('    de: ' + JSON.stringify(s));
  gleich('de: Sektionstitel', s.titel, 'Modpack importieren');

  await sprachKlick('English');
  s = await sprachText();
  Z.push('    en: ' + JSON.stringify(s));
  gleich('en: Sektionstitel', s.titel, 'Import modpack');
  gleich('en: Datei-Knopf', s.datei, 'Choose modpack file …');
  gleich('en: Such-Platzhalter', s.platzhalter, 'Search modpack name on Modrinth …');

  await sprachKlick('Español');
  s = await sprachText();
  Z.push('    es: ' + JSON.stringify(s));
  gleich('es: Sektionstitel', s.titel, 'Importar modpack');
  gleich('es: Datei-Knopf', s.datei, 'Elegir archivo de modpack …');

  await sprachKlick('Français');
  s = await sprachText();
  Z.push('    fr: ' + JSON.stringify(s));
  gleich('fr: Sektionstitel', s.titel, 'Importer un modpack');
  gleich('fr: Datei-Knopf', s.datei, 'Choisir un fichier de modpack …');

  await sprachKlick('Deutsch');
  s = await sprachText();
  Z.push('    de (zurueck): ' + JSON.stringify(s));
  gleich('zurueck zu de: Sektionstitel', s.titel, 'Modpack importieren');
  await js(`document.getElementById('instDialogAbbrechen').click(); true`);
  await warte(200);

  // =====================================================================
  gruppe('8. Keine Ausnahme in der Oberflaeche');
  // =====================================================================
  const echteFehler = protokoll.filter(t => !/Security Warning|CSP|Insecure/i.test(t));
  ok(echteFehler.length === 0, 'keine Ausnahme in der Oberflaeche',
     echteFehler.slice(0, 3).join(' | '));

  // =====================================================================
  Z.unshift('');
  Z.unshift('Modpack-Import (echte Oberflaeche, echtes Modul)');
  Z.push('');
  Z.push('='.repeat(70));
  if (probleme.length) {
    Z.push(`${probleme.length} von ${pruefungen} PRUEFUNGEN FEHLGESCHLAGEN:`);
    probleme.forEach(p => Z.push('  - ' + p));
  } else {
    Z.push(`ALLE ${pruefungen} PRUEFUNGEN BESTANDEN`);
  }
  Z.push('='.repeat(70));
  schreibe();
  fenster.destroy();
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  app.exit(probleme.length ? 1 : 0);
})().catch((err) => {
  Z.push('');
  Z.push('ABBRUCH: ' + String(err && err.message || err));
  schreibe();
  console.error('Test ist abgebrochen:', err);
  app.exit(2);
});

/** Fortschrittsmarke: schreibt NUR in die Datei, fasst Z nicht an. Eine
 *  haengen gebliebene executeJavaScript-Antwort wird so trotzdem sichtbar —
 *  die Datei zeigt den letzten gestarteten Schritt. Der abschliessende
 *  schreibe() ueberschreibt die Marken mit dem sauberen Protokoll. */
function zwischen(marke){
  const ausgabe = path.join(os.tmpdir(), 'opencode', 'modpack-import-fenster.txt');
  fs.mkdirSync(path.dirname(ausgabe), { recursive: true });
  try {
    const alt = (() => { try { return fs.readFileSync(ausgabe, 'utf-8'); } catch { return ''; } })();
    fs.writeFileSync(ausgabe, alt + '\n' + marke, 'utf-8');
  } catch (err) { /* Datei nicht zu schreiben ist kein Testfehler */ }
}

/** Protokoll in die Datei UND auf die Konsole. */
function schreibe(){
  const ausgabe = path.join(os.tmpdir(), 'opencode', 'modpack-import-fenster.txt');
  fs.mkdirSync(path.dirname(ausgabe), { recursive: true });
  try {
    fs.writeFileSync(ausgabe, Z.join('\n'), 'utf-8');
  } catch (err) { /* Datei nicht zu schreiben ist kein Testfehler */ }
  console.log(Z.join('\n'));
}