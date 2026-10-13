// test-modpacks-fenster.js
// Prueft die Modpack-Verwaltung durch die echte Oberflaeche: die Kacheln im
// Dropdown, den Dialog, das Nachfragen bei einem Altbestand und das, was beim
// Wechsel mit den Mods passiert.
//
// Warum ein eigener Test und keine Ergaenzung in test-einstellungen-fenster.js:
// Hier geht es um Verhalten beim Wechsel und um endgueltiges Loeschen. Beides
// ist in einem Fenster sichtbar, aber ein Fehler darin faellt sonst zwischen
// 205 anderen Pruefungen unter.
//
// Aufruf: electron.exe test-modpacks-fenster.js
// (mit node laeuft er nicht: er braucht ein echtes Fenster)
//
// Regel fuer diesen Test: Jede Pruefung schaut auf das, was auf dem Bildschirm
// steht — nicht darauf, ob eine Funktion existiert. "instances:create gibt ein
// Obekt zurueck" ist keine Wirkung; "der Name steht danach in der Liste" ist
// eine. Wo eine Pruefung eine Absicht beschreibt und keine Tatsache, steht
// der Grund dahinter.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');

const PROJ = __dirname;
const USER_DATA = path.join(os.tmpdir(), 'liquid-launcher-modpacktest');

// Immer sauber anfangen. Sonst haengt das Ergebnis davon ab, ob der Test
// vorher schon einmal gelaufen ist: instances/ und die Mod-Ordner liegen sonst
// aus dem vorigen Lauf da, und genau die Tests hier, die ein leeres Verzeichnis
// erwarten, schlagen grundlos fehl.
fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });

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
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); }

(async () => {
  await app.whenReady();

  const fenster = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(PROJ, 'src', 'main', 'preload.js'), contextIsolation: true }
  });
  // Der Renderer ruft ueber dieses Konto Daten ab. Hier steht kein echtes
  // Electron-Backend zur Verfuegung (der Test laeuft ohne registerIpcHandlers),
  // also wird instances:* direkt auf der Platte beantwortet — mit DEMSELBEN
  // Modul, das auch der echte Hauptprozess benutzt. Das ist der Punkt: der
  // Test prueft die Oberflaeche gegen die echte Speicherlogik, nicht gegen
  // eine Nachbildung davon.
  fenster.webContents.on('ipc-message', () => {});
  const { ipcMain } = require('electron');
  const inst = require('./src/main/instances');
  const Daten = USER_DATA;

  const antworten = {
    'instances:list': () => inst.listen(Daten),
    'instances:create': (_e, a) => inst.anlegen(Daten, a),
    'instances:rename': (_e, id, n) => inst.umbenennen(Daten, id, n),
    'instances:setTechnik': (_e, id, a) => inst.technikSetzen(Daten, id, a),
    'instances:duplicate': (_e, id, n) => inst.duplizieren(Daten, id, n),
    'instances:remove': (_e, id) => inst.entfernen(Daten, id),
    // Kein Netz in diesem Test. Die echte Fassung fragt das Mojang-Manifest
    // ab; hier reichen zwei echte Versionen, um zu zeigen, dass die Liste
    // gefuellt wird und der Wert durchgereicht wird.
    'instances:versions': () => ([
      { id: '1.21.4', typ: 'release', zeit: 0 },
      { id: '1.20.1', typ: 'release', zeit: 0 }
    ])
  };
  Object.entries(antworten).forEach(([kanal, fn]) => {
    ipcMain.handle(kanal, fn);
  });
  // Die Mods-Liste antwortet mit dem, was wirklich im Ordner liegt. Nur so
  // laesst sich pruefen, dass die Anzeige dem Wechsel folgt: ein Mod im
  // Ordner A, das im Ordner B fehlt, muss nach dem Wechsel verschwunden sein.
  ipcMain.handle('mods:listInstalled', (_e, id) => {
    const dir = path.join(Daten, 'instances', id, 'mods');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jar'))
      .map(f => ({ id: path.basename(f, '.jar'), name: path.basename(f, '.jar'), source: 'local' }));
  });
  ipcMain.handle('mods:remove', (_e, id, modId) => {
    const p = path.join(Daten, 'instances', id, 'mods', modId + '.jar');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  });
  ipcMain.handle('mods:search', () => ([]));
  ipcMain.handle('mods:install', () => true);
  ipcMain.handle('mods:importLocal', () => null);
  ipcMain.handle('worlds:list', () => ({ welten: [], fehler: null }));
  ipcMain.handle('worlds:delete', () => ({ ok: true }));
  ipcMain.handle('servers:list', () => []);
  ipcMain.handle('servers:ping', () => ({ online: false }));
  ipcMain.handle('settings:get', () => ({}));
  ipcMain.handle('settings:set', () => true);
  ipcMain.handle('instanceSettings:get', () => ({}));
  ipcMain.handle('instanceSettings:set', () => true);
  ipcMain.handle('widgets:list', () => []);
  ipcMain.handle('widgets:daten', () => ({}));
  ipcMain.handle('widgets:html', () => '');
  ipcMain.handle('widgets:systemdaten', () => ({}));
  ipcMain.handle('auth:listAccounts', () => []);
  ipcMain.handle('auth:getActiveAccount', () => null);
  ipcMain.handle('auth:needsRelogin', () => false);
  ipcMain.handle('auth:getClientId', () => ({ clientId: '', redirectUri: '', configured: false }));
  ipcMain.handle('schriften:lesen', () => null);
  ipcMain.handle('skins:getActive', () => null);

  // Schritt-fuer-Schritt-Protokoll: wenn executeJavaScript fehlschlaegt,
  // nennt die Meldung nur "Script failed to execute". Ohne diese Marken
  // weiss man nicht, welcher der rund 30 Aufrufe es war — und ein Test, der
  // sagt "irgendwo ist etwas kaputt", hilft beim Beheben nicht.
  let schritt = 0;
  const js = async (code) => {
    schritt++;
    try {
      return await fenster.webContents.executeJavaScript(code, true);
    } catch (err) {
      const marke = 'ABBRUCH bei Schritt ' + schritt + ': ' + String(err && err.message || err);
      Z.push('');
      Z.push('!!! ' + marke);
      Z.push('    Code: ' + code.replace(/\s+/g, ' ').slice(0, 300));
      throw new Error(marke);
    }
  };

  // Protokoll des Fensters auffangen, damit eine Ausnahme in der Oberflaeche
  // nicht still verschwindet. Genau dafuer gibt es diese Liste: ein Fehler
  // in einem Klick-Handler waere sonst nur daran zu erkennen, dass nichts
  // passiert.
  const protokoll = [];
  fenster.webContents.on('console-message', (_e, _lvl, text) => {
    if (/error|Error|exception/i.test(text)) protokoll.push(text);
  });

  // Ein Ordner, der schon da war, BEVOR der Launcher startet: Mods, eine
  // Welt, aber keine instance.json. Genau so sieht ein echter Altbestand
  // aus — und genau der konnte vorher weder starten noch sich selbst
  // reparieren. Er wird hier VOR dem Laden des Fensters angelegt, weil es
  // darauf ankommt, dass der Start den Dialog von sich aus oeffnet. Ein
  // Ordner, den der Test erst nach dem Start hinstellt, wuerde diesen Weg
  // gar nicht pruefen.
  const altbestand = path.join(Daten, 'instances', 'altbestand');
  fs.mkdirSync(path.join(altbestand, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(altbestand, 'saves', 'Alte Welt'), { recursive: true });
  fs.writeFileSync(path.join(altbestand, 'saves', 'Alte Welt', 'level.dat'), 'x');
  fs.writeFileSync(path.join(altbestand, 'mods', 'sodium.jar'), 'x');
  fs.writeFileSync(path.join(altbestand, 'mods-meta.json'), JSON.stringify({
    sodium: { id: 'sodium', name: 'Sodium', source: 'modrinth', filename: 'sodium.jar', loader: 'fabric', gameVersion: '1.21.4' }
  }));

  await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  // =====================================================================
  gruppe('1. Altbestand ohne instance.json');
  // =====================================================================
  // Ein Ordner, der schon vor dem Start da war. Er laesst sich nicht starten,
  // weil die Version fehlt — obwohl sie sich aus mods-meta.json ableiten
  // laesst. Der Launcher soll das beim Start von sich aus ansprechen UND
  // einen Weg anbieten, falls man abbreckt. Beides wird hier geprueft.
  const beimStart = JSON.parse(await js(`(function(){
    return JSON.stringify({
      dialogOffen: !document.getElementById('instDialog').hidden,
      titel: document.getElementById('instDialogTitel').textContent,
      name: document.getElementById('instDialogName').value,
      version: document.getElementById('instDialogVersion').value,
      loader: document.getElementById('instDialogLoader').value,
      okText: document.getElementById('instDialogOk').textContent,
      technikDa: !document.getElementById('instDialogFeldTechnik').hidden
    });
  })()`));
  Z.push('    ' + JSON.stringify(beimStart));
  ok(beimStart.dialogOffen === true, 'der Start fragt selbst nach — sonst laeuft ein Altbestand nie');
  ok(/einordnen|einrichten|setup|configurar|configurer/i.test(beimStart.titel),
     'der Dialog sagt, was er tut: "' + beimStart.titel + '"');
  ok(beimStart.technikDa === true, 'und fragt nach der Technik');
  gleich('die aus mods-meta.json abgeleitete Version steht drin', beimStart.version, '1.21.4');
  gleich('ebenso der Modloader', beimStart.loader, 'fabric');
  ok(/speichern|save|guardar|enregistrer/i.test(beimStart.okText),
     'der Knopf lautet wie eine Handlung: "' + beimStart.okText + '"');

  // Abbrecken. Und jetzt der Weg zurueck — ohne den war ein Altbestand
  // ein Sackgassen-Modpack: nicht startbar und nicht reparierbar.
  await js(`document.getElementById('instDialogAbbrechen').click(); true`);
  await new Promise(r => setTimeout(r, 300));
  ok(!fs.existsSync(path.join(altbestand, 'instance.json')),
     'Abbrecken schreibt nichts — es ist ein Nachfragen, kein Zwang');

  const knoepfe = JSON.parse(await js(`(function(){
    document.getElementById('versionPill').click();
    var k = document.querySelectorAll('#instanceDropdown .instance-option')[0];
    var a = Array.from(k.querySelectorAll('.inst-aktion'));
    return JSON.stringify({
      anzahl: a.length,
      beschriftungen: a.map(function(e){ return e.textContent.trim(); }),
      ersterIstNachtrag: a.length > 0 && a[0].className.indexOf('nachtrag') !== -1,
      tipp: a.length > 0 ? a[0].title : ''
    });
  })()`));
  Z.push('    ' + JSON.stringify(knoepfe));
  gleich('der Altbestand hat einen Knopf mehr als ein fertiges Modpack', knoepfe.anzahl, 4);
  ok(knoepfe.ersterIstNachtrag === true, 'und der erste ist als Nachtrag erkennbar, nicht als loeschen');
  ok(!!knoepfe.beschriftungen[0] && knoepfe.beschriftungen[0] !== beimStart.okText,
     'er heisst "' + knoepfe.beschriftungen[0] + '" und nicht wie der Dialog-Knopf ("' +
     beimStart.okText + '") — in der Liste waere "Speichern" eine Handlung ohne Objekt');
  ok(knoepfe.tipp.length > 10, 'und sein Hinweis sagt, warum er noetig ist', knoepfe.tipp);

  await js(`(function(){
    var k = document.querySelectorAll('#instanceDropdown .instance-option')[0];
    k.querySelectorAll('.inst-aktion')[0].click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 400));
  const wiederOffen = await js(`(function(){
    return JSON.stringify({
      offen: !document.getElementById('instDialog').hidden,
      titel: document.getElementById('instDialogTitel').textContent,
      version: document.getElementById('instDialogVersion').value,
      technikDa: !document.getElementById('instDialogFeldTechnik').hidden
    });
  })()`);
  Z.push('    ' + wiederOffen);
  const w = JSON.parse(wiederOffen);
  ok(w.offen === true, 'der Knopf oeffnet ueberhaupt einen Dialog');
  // WICHTIG: "es geht ein Dialog auf" waere zu wenig. Ohne den Nachtrag-Knopf
  // sitzt an dieser Stelle der erste Knopf der Zeile, also "Umbenennen" — und
  // der geht auch auf, zeigt die Version und macht genau den gleichen Eindruck.
  // Geprueft wird deshalb der TITEL: nur beim Einordnen geht es um die Technik,
  // beim Umbenennen nicht.
  ok(/einordnen|einrichten|setup|configurar|configurer/i.test(w.titel),
     'und zwar den zum Einordnen — nach dem Abbruch gibt es einen Weg zurueck: "' + w.titel + '"');
  ok(w.technikDa === true, 'mit den Technik-Feldern offen');
  gleich('mit der bekannten Version vorbelegt', w.version, '1.21.4');

  await js(`document.getElementById('instDialogOk').click(); true`);
  await new Promise(r => setTimeout(r, 900));
  ok(fs.existsSync(path.join(altbestand, 'instance.json')), 'Speichern legt die instance.json an');
  const gespeichert = JSON.parse(await js(`(function(){
    return JSON.stringify({
      dialogOffen: !document.getElementById('instDialog').hidden,
      anzahl: (function(){
        document.getElementById('versionPill').click();
        return document.querySelectorAll('#instanceDropdown .instance-option')[0].querySelectorAll('.inst-aktion').length;
      })()
    });
  })()`));
  Z.push('    ' + JSON.stringify(gespeichert));
  ok(gespeichert.dialogOffen === false,
     'der Dialog kommt nicht von selbst wieder — sonst kaeme er bei jedem spaeterlichen Nachladen der Liste zurueck');
  gleich('und der Nachtrag-Knopf ist wieder verschwunden', gespeichert.anzahl, 3);

  // Ein fertiges Modpack ist auch wieder loeschbar — und danach ist die
  // Platte leer, was die naechste Gruppe ohne Zutun prueft.
  await js(`(function(){
    var k = document.querySelectorAll('#instanceDropdown .instance-option')[0];
    k.querySelectorAll('.inst-aktion')[2].click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  await js(`document.getElementById('instDialogOk').click(); true`);
  await new Promise(r => setTimeout(r, 800));
  ok(!fs.existsSync(altbestand), 'der Altbestand laesst sich wieder entfernen');
  ok(!inst.listen(Daten).length, 'danach ist die Liste wirklich leer');

  // =====================================================================
  gruppe('2. Leerzustand');
  // =====================================================================
  // Es gibt auf der Platte nichts. Das ist der Zustand, in dem ein frisch
  // installierter Launcher steckt, und der vorher nur darstellbar war, indem
  // man vier erfundene Modpacks fest einprogrammiert hat.
  const leer = JSON.parse(await js(`(function(){
    return JSON.stringify({
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length,
      neuKnopf: !!document.querySelector('#instanceDropdown .instance-neu'),
      hinweis: !!document.querySelector('#instanceDropdown .instance-leer'),
      pill: (document.getElementById('versionPillText')||{}).textContent || ''
    });
  })()`));
  Z.push('    ' + JSON.stringify(leer));
  gleich('keine Modpack-Kacheln', leer.kacheln, 0);
  ok(leer.neuKnopf === true, 'der Knopf "Neues Modpack" ist da — sonst gibt es aus dem Leerzustand keinen Weg heraus');
  ok(leer.hinweis === true, 'der Leerzustand sagt, was fehlt');
  ok(/Modpack/i.test(leer.pill), 'die Kapsel oben sagt "Kein Modpack" statt "undefined"', leer.pill);

  // =====================================================================
  gruppe('3. Anlegen ueber die Oberflaeche');
  // =====================================================================
  // Der ganze Weg ueber den Klick: Dropdown, Knopf, Dialog, OK. Kein
  // window.launcher.instances.create() von aussen, denn genau diese
  // Verdrahtung ist das, was noch nie existiert hat.
  await js(`(function(){
    document.getElementById('versionPill').click();
    document.querySelector('#instanceDropdown .instance-neu').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 400));

  const offen = JSON.parse(await js(`(function(){
    function el(id){ return document.getElementById(id); }
    var fehlt = ['instDialog','instDialogTitel','instDialogFehler','instDialogName',
                 'instDialogVersion','instDialogLoader','instDialogFeldTechnik',
                 'instDialogOk','instDialogAbbrechen']
                .filter(function(id){ return !el(id); });
    return JSON.stringify({
      fehlendeElemente: fehlt,
      dialogDa: !!el('instDialog'),
      sichtbar: el('instDialog') ? !el('instDialog').hidden : false,
      titel: (el('instDialogTitel')||{}).textContent || '',
      technikFeld: el('instDialogFeldTechnik') ? !el('instDialogFeldTechnik').hidden : null,
      versionen: el('instDialogVersion') ? el('instDialogVersion').options.length : null,
      loader: el('instDialogLoader') ? el('instDialogLoader').options.length : null,
      loaderWert: el('instDialogLoader') ? el('instDialogLoader').value : null,
      okAktion: (function(){
        // Der OK-Knopf muss eine Aktion haben. Ohne sie geht das Fenster auf
        // und schliesst wieder, ohne dass etwas passiert — das war der
        // erste Fehler hier.
        return typeof window.__instDialogBereit === 'function' ? window.__instDialogBereit() : 'unbekannt';
      })()
    });
  })()`));
  Z.push('    ' + JSON.stringify(offen));
  gleich('alle Dialog-Elemente sind im HTML vorhanden', offen.fehlendeElemente, []);
  Z.push('    ' + JSON.stringify(offen));
  ok(offen.sichtbar === true, 'der Dialog geht auf');
  ok(offen.technikFeld === true, 'beim Anlegen werden Version und Modloader gefragt');
  ok(offen.versionen > 0, 'die Versionsliste ist gefuellt — nicht leer und nicht erfunden', String(offen.versionen));
  ok(offen.loader >= 3, 'es gibt mindestens die drei Loader zur Wahl', String(offen.loader));
  ok(offen.okAktion === true, 'der OK-Knopf hat eine Aktion — sonst geht das Fenster auf und wieder zu, ohne dass etwas passiert', String(offen.okAktion));
  ok(offen.titel !== 'Modpack', 'der Dialog traegt seinen Titel, nicht den Platzhalter aus dem HTML: "' + offen.titel + '"');

  // Falsche Eingabe: leere Version ist nicht moeglich (Liste), aber ein Name
  // aus Steuerzeichen muss abgewiesen werden, und die Meldung muss im Dialog
  // stehen statt ihn zu schliessen.
  await js(`(function(){
    document.getElementById('instDialogName').value = '   ';
    document.getElementById('instDialogOk').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 400));
  const leerName = JSON.parse(await js(`(function(){
    return JSON.stringify({
      nochOffen: !document.getElementById('instDialog').hidden,
      fehler: (document.getElementById('instDialogFehler')||{}).textContent || '',
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length
    });
  })()`));
  Z.push('    ' + JSON.stringify(leerName));
  ok(leerName.nochOffen === true, 'ein leerer Name schliesst den Dialog nicht');
  ok(leerName.fehler.length > 0, 'der Fehler steht im Dialog: ' + leerName.fehler.slice(0, 60));
  gleich('und es wurde nichts angelegt', leerName.kacheln, 0);

  // Jetzt mit echten Werten.
  await js(`(function(){
    document.getElementById('instDialogName').value = 'Mein Pack';
    document.getElementById('instDialogVersion').value = '1.21.4';
    document.getElementById('instDialogLoader').value = 'fabric';
    document.getElementById('instDialogOk').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const angelegt = JSON.parse(await js(`(function(){
    document.getElementById('versionPill').click();
    return JSON.stringify({
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length,
      text: Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){return e.textContent.trim();}),
      unterzeile: Array.from(document.querySelectorAll('#instanceDropdown .instance-option .m')).map(function(e){return e.textContent.trim();}),
      verwaltung: document.querySelectorAll('#instanceDropdown .instance-verwaltung').length,
      aktionen: document.querySelectorAll('#instanceDropdown .inst-aktion').length
    });
  })()`));
  Z.push('    ' + JSON.stringify(angelegt));
  gleich('genau eine Kachel', angelegt.kacheln, 1);
  ok(/Mein Pack/.test(angelegt.text[0] || ''), 'der Name steht in der Liste: ' + (angelegt.text[0] || '(leer)'));
  ok(/1\.21\.4/.test(angelegt.unterzeile[0] || ''), 'Version und Modloader stehen dabei');
  // Der Zeitpunkt ist das, was vorher erfunden war.
  ok(/noch nie gespielt/i.test(angelegt.unterzeile[0] || ''),
     'ein nie gespieltes Modpack sagt das auch — nicht "vor 2 Stunden"', angelegt.unterzeile[0]);
  gleich('eine Verwaltungszeile pro Kachel', angelegt.verwaltung, 1);
  gleich('drei Aktionen (umbenennen, duplizieren, loeschen)', angelegt.aktionen, 3);

  // Auf der Platte nachsehen: das Modpack muss wirklich existieren, mit allem,
  // was der Start braucht.
  const platte = path.join(Daten, 'instances', 'mein-pack');
  ok(fs.existsSync(path.join(platte, 'instance.json')), 'instance.json liegt im Ordner');
  ok(fs.existsSync(path.join(platte, 'mods')), 'der mods-Ordner ist angelegt');
  ok(fs.existsSync(path.join(platte, 'saves')), 'der saves-Ordner ist angelegt');
  const meta = JSON.parse(fs.readFileSync(path.join(platte, 'instance.json'), 'utf-8'));
  gleich('Version steht in der Datei', meta.version, '1.21.4');
  gleich('Modloader steht in der Datei', meta.modloader, 'fabric');

  // =====================================================================
  gruppe('4. Umbenennen');
  // =====================================================================
  await js(`(function(){
    document.querySelectorAll('#instanceDropdown .instance-option')[0].click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 200));
  await js(`(function(){
    document.getElementById('versionPill').click();
    var k = document.querySelectorAll('#instanceDropdown .inst-aktion')[0];
    k.click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));

  const renameDialog = JSON.parse(await js(`(function(){
    return JSON.stringify({
      nochOffen: !document.getElementById('instDialog').hidden,
      name: document.getElementById('instDialogName').value,
      technikFeld: !document.getElementById('instDialogFeldTechnik').hidden,
      okAktion: window.__instDialogBereit()
    });
  })()`));
  Z.push('    ' + JSON.stringify(renameDialog));
  ok(renameDialog.nochOffen === true, 'der Umbenennen-Dialog geht auf');
  ok(renameDialog.name === 'Mein Pack', 'der aktuelle Name steht drin', renameDialog.name);
  ok(renameDialog.technikFeld === false, 'beim Umbenennen wird nicht nach der Version gefragt — die aendert sich nicht');
  ok(renameDialog.okAktion === true, 'auch hier hat OK eine Aktion');

  await js(`(function(){
    document.getElementById('instDialogName').value = 'Mein Pack 2';
    document.getElementById('instDialogOk').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const umbenannt = JSON.parse(await js(`(function(){
    document.getElementById('versionPill').click();
    return JSON.stringify({
      text: Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){return e.textContent.trim();})
    });
  })()`));
  Z.push('    ' + JSON.stringify(umbenannt));
  ok(/Mein Pack 2/.test(umbenannt.text[0] || ''), 'der neue Name steht in der Liste: ' + (umbenannt.text[0] || '(leer)'));
  // Der Ordnername bleibt: die ID ist der Pfad. Aendern ihn, wuerden Welten
  // und Mods von einem anderen Ort gelesen.
  ok(fs.existsSync(path.join(Daten, 'instances', 'mein-pack', 'instance.json')),
     'der Ordner heisst weiterhin "mein-pack" — die ID ist der Pfad');
  const meta2 = JSON.parse(fs.readFileSync(path.join(Daten, 'instances', 'mein-pack', 'instance.json'), 'utf-8'));
  gleich('...und die Version ist beim Umbenennen erhalten geblieben', meta2.version, '1.21.4');

  // =====================================================================
  gruppe('5. Duplizieren');
  // =====================================================================
  // Der Mod muss mitwandern. Ohne ihn waere die Kopie leer und der Zweck
  // des Duplizierens — dieselben Mods ausprobieren — verfehlt.
  fs.writeFileSync(path.join(platte, 'mods', 'beispiel.jar'), 'x');

  await js(`(function(){
    document.getElementById('versionPill').click();
    document.querySelectorAll('#instanceDropdown .inst-aktion')[1].click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  const dupName = await js(`document.getElementById('instDialogName').value`);
  ok(/Mein Pack 2/.test(dupName), 'der Dialog schlaegt einen Namen vor: ' + dupName);
  await js(`(function(){
    document.getElementById('instDialogName').value = 'Testlauf';
    document.getElementById('instDialogOk').click();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const kopie = JSON.parse(await js(`(function(){
    document.getElementById('versionPill').click();
    return JSON.stringify({
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length,
      text: Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){return e.textContent.trim();})
    });
  })()`));
  Z.push('    ' + JSON.stringify(kopie));
  gleich('zwei Kacheln', kopie.kacheln, 2);
  ok(kopie.text.some(x => /Testlauf/.test(x)), 'die Kopie steht in der Liste');
  ok(fs.existsSync(path.join(Daten, 'instances', 'testlauf', 'mods', 'beispiel.jar')),
     'der Mod ist in der Kopie — sonst waere das Duplizieren sinnlos');

  // =====================================================================
  gruppe('6. Die Modsliste folgt der Auswahl');
  // =====================================================================
// Ordner. Geprueft wird deshalb beides getrennt — die Anzeige UND der
  // loeschende Klick, weil nur der zweite davon Daten vernichtet.
  //
  // Die Reihenfolge hier ist nicht beliebig, und ein erster Versuch war
  // falsch: es muss ZUERST ein Modpack mit wirklich geladener Modsliste
  // geben, und DANN wird gewechselt. Wer direkt nach dem Anlegen wechselt,
  // sieht eine LEERE Liste statt einer veralteten — und "der fremde Mod steht
  // nicht drin" ist dann gegen eine leere Liste erfuellt, ohne dass
  // irgendetwas geprueft wurde. Genau so hat diese Gruppe zuerst
  // ausgesehen und ist trotzdem gruen gewesen, waehrend der Fehler weiter
  // bestand. Ein gruener Test, der das Falsche beweist, ist schlimmer als
  // ein roter.
  //
  // Eigene Modnamen je Modpack, sonst laesst sich ein Veralten nicht von
  // "gleicher Inhalt" unterscheiden.
  fs.writeFileSync(path.join(platte, 'mods', 'nur-in-original.jar'), 'x');
  fs.writeFileSync(path.join(Daten, 'instances', 'testlauf', 'mods', 'nur-in-kopie.jar'), 'x');

  // Schritt 1: das Original waehlen und die Liste wirklich laden lassen.
  // Erst dann ist ueberhaupt etwas da, was veralten kann.
  const vorWechsel = await js(`(async function(){
    document.getElementById('versionPill').click();
    var kacheln = document.querySelectorAll('#instanceDropdown .instance-option');
    for (var i = 0; i < kacheln.length; i++) {
      if (/Mein Pack 2/.test(kacheln[i].querySelector('.n').textContent)) { kacheln[i].click(); break; }
    }
    await new Promise(function(r){ setTimeout(r, 700); });
    return JSON.stringify(Array.from(document.querySelectorAll('#modInstalledList .mod-name')).map(function(e){return e.textContent.trim();}));
  })()`);
  Z.push('    vor dem Wechsel: ' + vorWechsel);
  const listeVorher = JSON.parse(vorWechsel);
  ok(listeVorher.some(m => /nur-in-original/.test(m)),
     'die Liste des zuerst gewaehlten Modpacks ist gefuellt — sonst prueft der Wechsel nichts',
     JSON.stringify(listeVorher));

  // Schritt 2: auf die Kopie wechseln. Jetzt muss die Liste mitwechseln.
  const modsNachWechsel = await js(`(async function(){
    document.getElementById('versionPill').click();
    var kacheln = document.querySelectorAll('#instanceDropdown .instance-option');
    for (var i = 0; i < kacheln.length; i++) {
      if (/Testlauf/.test(kacheln[i].querySelector('.n').textContent)) { kacheln[i].click(); break; }
    }
    await new Promise(function(r){ setTimeout(r, 700); });
    return JSON.stringify(Array.from(document.querySelectorAll('#modInstalledList .mod-name')).map(function(e){return e.textContent.trim();}));
  })()`);
  Z.push('    nach dem Wechsel: ' + modsNachWechsel);
  const modsListe = JSON.parse(modsNachWechsel);
  ok(modsListe.length > 0, 'nach dem Wechsel steht ueberhaupt etwas in der Liste', JSON.stringify(modsListe));
  ok(modsListe.some(m => /nur-in-kopie/.test(m)),
     'der Mod des NEU gewaehlten Modpacks steht in der Liste: ' + JSON.stringify(modsListe));
  ok(!modsListe.some(m => /nur-in-original/.test(m)),
     'der Mod des VORHER gewaehlten Modpacks steht NICHT mehr darin — das war der Fehler',
     JSON.stringify(modsListe));

  // Und jetzt der loeschende Klick. Bleibt die Liste zurueck, loescht dieser
  // Klick aus dem falschen Ordner — der eigentlich schaedliche Teil.
  const entfernt = await js(`(async function(){
    var knoepfe = Array.from(document.querySelectorAll('#modInstalledList .mod-action'));
    if (!knoepfe.length) return 'kein Knopf';
    knoepfe[0].click();
    await new Promise(function(r){ setTimeout(r, 700); });
    return 'geklickt';
  })()`);
  Z.push('    entfernt: ' + entfernt);
  ok(entfernt === 'geklickt', 'es gab ueberhaupt einen Entfernen-Knopf', entfernt);
  // Der geklickte Knopf gehoert zur ERSTEN Zeile, und die ist "beispiel".
  // Die gibt es absichtlich in BEIDEN Modpacks — durch das Duplizieren.
  // Damit ist der Weg, den der Klick nimmt, eindeutig: bei einem Fehler
  // loescht er die Datei im falschen Ordner, und genau dieselbe Datei im
  // richtigen bleibt liegen. Ohne diese Ueberschneidung wuerde ein Loeschen
  // aus dem falschen Modpack hier gar nicht auffallen.
  ok(!fs.existsSync(path.join(Daten, 'instances', 'testlauf', 'mods', 'beispiel.jar')),
     'der geklickte Mod ist im GEWAEHLTEN Modpack wirklich weg');
  ok(fs.existsSync(path.join(platte, 'mods', 'beispiel.jar')),
     'dieselbe Datei im ANDEREN Modpack ist unberuehrt — sonst hat der Klick in die falsche Instanz geloescht');
  ok(fs.existsSync(path.join(platte, 'mods', 'nur-in-original.jar')),
     'und der Mod, der es nur dort gibt, ist ebenfalls unberuehrt');

  // =====================================================================
  gruppe('7. Loeschen');
  // =====================================================================
  await js(`(function(){
    document.getElementById('versionPill').click();
    var kacheln = document.querySelectorAll('#instanceDropdown .instance-option');
    for (var i = 0; i < kacheln.length; i++) {
      if (/Testlauf/.test(kacheln[i].querySelector('.n').textContent)) { kacheln[i].click(); break; }
    }
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  await js(`(function(){
    document.getElementById('versionPill').click();
    var kacheln = document.querySelectorAll('#instanceDropdown .instance-option');
    for (var i = 0; i < kacheln.length; i++) {
      if (/Testlauf/.test(kacheln[i].querySelector('.n').textContent)) {
        kacheln[i].querySelectorAll('.inst-aktion')[2].click();
        break;
      }
    }
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));

  const delDialog = JSON.parse(await js(`(function(){
    return JSON.stringify({
      nochOffen: !document.getElementById('instDialog').hidden,
      titel: (document.getElementById('instDialogTitel')||{}).textContent || '',
      okText: (document.getElementById('instDialogOk')||{}).textContent || '',
      nurLesbar: document.getElementById('instDialogName').readOnly,
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length
    });
  })()`));
  Z.push('    ' + JSON.stringify(delDialog));
  ok(delDialog.nochOffen === true, 'das Loeschen fragt nach — es ist endgueltig');
  ok(/Wirklich|for real|vraiment|realmente/i.test(delDialog.okText),
     'der Knopf sagt, dass es ernst ist: "' + delDialog.okText + '"');
  gleich('und es ist noch nicht passiert', delDialog.kacheln, 2);

  // Abbrechen loescht nichts.
  await js(`document.getElementById('instDialogAbbrechen').click(); true`);
  await new Promise(r => setTimeout(r, 300));
  ok(fs.existsSync(path.join(Daten, 'instances', 'testlauf')),
     'Abbrechen loescht nichts');

  // Und jetzt wirklich.
  await js(`(function(){
    document.getElementById('versionPill').click();
    var kacheln = document.querySelectorAll('#instanceDropdown .instance-option');
    for (var i = 0; i < kacheln.length; i++) {
      if (/Testlauf/.test(kacheln[i].querySelector('.n').textContent)) {
        kacheln[i].querySelectorAll('.inst-aktion')[2].click();
        break;
      }
    }
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  await js(`document.getElementById('instDialogOk').click(); true`);
  await new Promise(r => setTimeout(r, 800));

  const nachLoeschen = JSON.parse(await js(`(function(){
    document.getElementById('versionPill').click();
    return JSON.stringify({
      kacheln: document.querySelectorAll('#instanceDropdown .instance-option').length,
      text: Array.from(document.querySelectorAll('#instanceDropdown .instance-option .n')).map(function(e){return e.textContent.trim();})
    });
  })()`));
  Z.push('    ' + JSON.stringify(nachLoeschen));
  gleich('eine Kachel weniger', nachLoeschen.kacheln, 1);
  ok(!nachLoeschen.text.some(x => /Testlauf/.test(x)), 'das geloeschte Modpack ist aus der Liste weg');
  ok(!fs.existsSync(path.join(Daten, 'instances', 'testlauf')), 'und sein Ordner existiert nicht mehr');

  // =====================================================================
  gruppe('8. Laeuft gerade');
  // =====================================================================
  // Der Loeschen-Knopf wird gesperrt, wenn das Modpack laeuft. Nicht nur, weil
  // es unsinnig waere, sondern weil waehrend des Spiels in denselben Ordner
  // geschrieben wird.
  // Das Spiel zu starten waere hier zu viel Aufwand und wuerde 500 MB
  // ziehen. Stattdessen die NACHRICHT schicken, die der Hauptprozess bei
  // einem laufenden Spiel auch schickt — genau der Weg, den der Renderer
  // sonst sieht. Getestet wird die Reaktion der Oberflaeche, nicht das
  // Starten.
  fenster.webContents.send('instances:statusChange', { instanceId: 'mein-pack', status: 'running' });
  await new Promise(r => setTimeout(r, 500));

  const gesperrt = await js(`(function(){
    document.getElementById('versionPill').click();
    var k = document.querySelectorAll('#instanceDropdown .instance-option')[0];
    var b = k.querySelectorAll('.inst-aktion')[2];
    return JSON.stringify({ disabled: !!b.disabled, titel: b.title });
  })()`);
  Z.push('    ' + gesperrt);
  const g = JSON.parse(gesperrt);
  ok(g.disabled === true, 'der Loeschen-Knopf ist gesperrt, solange das Modpack laeuft');
  ok(/beenden|stop/i.test(g.titel), 'und er sagt, warum: ' + g.titel);

  // =====================================================================
  gruppe('9. Keine Ausnahme in der Oberflaeche');
  // =====================================================================
  // Jeder der obigen Klickwege laeuft durch echte Handler. Eine Ausnahme
  // darin waere still: die Liste bliebe stehen und man wuerde es fuer
  // "nichts passiert" halten.
  const echteFehler = protokoll.filter(t => !/Security Warning|CSP|Insecure/i.test(t));
  ok(echteFehler.length === 0, 'keine Ausnahme in der Oberflaeche',
     echteFehler.slice(0, 3).join(' | '));

  // =====================================================================
  Z.unshift('');
  Z.unshift('Modpack-Verwaltung (echte Oberflaeche, echter Speicher)');
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
  // Auch beim Abbruch das Protokoll schreiben. Sonst steht nach einem
  // Fehler nur "abgebrochen" auf der Konsole und man muss erraten, an
  // welcher Stelle der Oberflaeche es passiert ist.
  Z.push('');
  Z.push('ABBRUCH: ' + String(err && err.message || err));
  schreibe();
  console.error('Test ist abgebrochen:', err);
  app.exit(2);
});

/** Protokoll in die Datei UND auf die Konsole. Zwei Ziele, weil die Konsole
 *  bei Fenstertests unter Windows gern abgeschnitten wird und die Datei
 *  leer bleibt, wenn der Prozess vorher stirbt. */
function schreibe(){
  const ausgabe = path.join(os.tmpdir(), 'opencode', 'modpack-fenster.txt');
  fs.mkdirSync(path.dirname(ausgabe), { recursive: true });
  try {
    fs.writeFileSync(ausgabe, Z.join('\n'), 'utf-8');
  } catch (err) { /* Datei nicht zu schreiben ist kein Testfehler */ }
  console.log(Z.join('\n'));
}
