// test-ressourcenpakete-fenster.js
// Prueft die Ressourcenpakete durch die echte Oberflaeche: Menuepunkt, Ansicht,
// die Liste, den Schalter (er schreibt in options.txt), das Loeschen, den
// Wechsel des Modpacks, die Sprache und die beiden Sonderfaelle (doppelter
// Name, kaputtes .zip).
//
// Warum ein eigener Test: die Kette Renderer -> preload -> ipc-handlers ->
// resourcepacks.js laesst sich mit keinem der vorhandenen Tests nachweisen.
// test-ressourcenpakete.js prueft das Modul ohne Fenster, test-ipc-wiring.js
// die Kanaele ohne Renderer. Was hier schiefgehen kann und sonst niemand sieht:
// ein Tippfehler in einer Element-ID, eine Ansicht, die nicht aufgeht, ein
// Schalter, der die falsche Datei anfasst.
//
// Aufruf: electron.exe test-ressourcenpakete-fenster.js
// (mit node laeuft er nicht: er braucht ein echtes Fenster)
//
// Regel fuer diesen Test: Jede Pruefung schaut auf das, was auf dem Bildschirm
// steht - nicht darauf, ob eine Funktion existiert. Die packs:* Kanaele werden
// vom ECHTEN resourcepacks.js beantwortet und instances:* vom ECHTEN
// instances.js. Nur so prueft dieser Test die Oberflaeche gegen die echte
// Speicherlogik und nicht gegen eine Nachbildung davon.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');

const PROJ = __dirname;
const USER_DATA = path.join(os.tmpdir(), 'liquid-launcher-packtest');

// Immer sauber anfangen. Ohne das liegen instances/ und die options.txt aus
// dem vorigen Lauf da, und genau die Pruefungen hier, die einen leeren Ordner
// oder einen bestimmten Schalterzustand erwarten, schlagen grundlos fehl.
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
    probleme.push(text + (zusatz ? ' -> ' + zusatz : ''));
  }
}
function gleich(bezeichnung, ist, soll) {
  ok(JSON.stringify(ist) === JSON.stringify(soll), bezeichnung,
     'ist ' + JSON.stringify(ist) + ', erwartet ' + JSON.stringify(soll));
}
function gruppe(t) { Z.push(''); Z.push('--- ' + t + ' ---'); }

/** Legt einen entpackten Paketordner mit pack.mcmeta an. */
function paketOrdner(instanzId, name, packFormat, beschreibung) {
  const dir = path.join(USER_DATA, 'instances', instanzId, 'resourcepacks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.mcmeta'), JSON.stringify({
    pack: { pack_format: packFormat, description: beschreibung || '' }
  }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'pack.png'), Buffer.alloc(48, 3));
  return dir;
}

/** Eine options.txt mit einer Markierungszeile, damit sichtbar bleibt, ob das
 *  Umschalten etwas anderes als die resourcePacks-Zeile mitnimmt. */
function optionsVorlegen(instanzId) {
  fs.writeFileSync(
    path.join(USER_DATA, 'instances', instanzId, 'options.txt'),
    'version:3465\nfov:0.0\n# von Hand gepflegt\nlanguage:de_de\n',
    'utf-8'
  );
}
function optionsLesen(instanzId) {
  const datei = path.join(USER_DATA, 'instances', instanzId, 'options.txt');
  // Fehlt die Datei, gibt es nichts zu lesen — das ist ein Zustand und kein
  // Fehler: eine frische Instanz hat noch keine options.txt, und genau dann
  // darf auch kein Paket als aktiv gelten.
  return fs.existsSync(datei) ? fs.readFileSync(datei, 'utf-8') : null;
}

/** Die resourcePacks-Zeile, oder null, wenn es keine gibt. */
function packsZeile(instanzId) {
  const text = optionsLesen(instanzId);
  if (text === null) return null;
  return text.split(/\r?\n/).find(z => z.startsWith('resourcePacks:')) || null;
}

(async () => {
  await app.whenReady();

  const fenster = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(PROJ, 'src', 'main', 'preload.js'), contextIsolation: true }
  });

  const { ipcMain } = require('electron');
  const inst = require('./src/main/instances');
  const rp = require('./src/main/resourcepacks');
  const Daten = USER_DATA;

  // Zwei echte Modpacks. "alpha" ist zuerst dran und damit vorgewaehlt; "beta"
  // ist der, in den spaeter gewechselt wird.
  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
    fs.mkdirSync(path.join(Daten, 'instances', id), { recursive: true });
    fs.writeFileSync(path.join(Daten, 'instances', id, 'instance.json'), JSON.stringify({
      id, name, version: '1.21.4', modloader: 'fabric', iconUrl: null,
      createdAt: '2026-10-01T00:00:00.000Z'
    }, null, 2), 'utf-8');
  }

  const instanzOrdner = (id) => path.join(Daten, 'instances', id);

  const antworten = {
    'instances:list': () => inst.listen(Daten),
    'instances:versions': () => ([{ id: '1.21.4', typ: 'release', zeit: 0 }]),
    'packs:list': (_e, id) => rp.listPacks(instanzOrdner(id)),
    'packs:setActive': (_e, id, packId, an) => rp.setPackAktiv(instanzOrdner(id), packId, an),
    'packs:remove': (_e, id, packId) => rp.removePack(instanzOrdner(id), packId),
    // Der echte Dateidialog laesst sich nicht oeffnen. Geprueft wird hier nur,
    // dass der Knopf ueberhaupt einen Kanal aufruft und danach neu zeichnet.
    'packs:importLocal': () => null,
    'mods:listInstalled': () => [],
    'mods:search': () => ([]),
    'mods:remove': () => true,
    'mods:install': () => true,
    'mods:importLocal': () => null,
    'worlds:list': () => ({ welten: [], fehler: null }),
    'worlds:delete': () => ({ ok: true }),
    'servers:list': () => [],
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
    'skins:getActive': () => null
  };
  Object.entries(antworten).forEach(([kanal, fn]) => ipcMain.handle(kanal, fn));

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
  const warte = (ms) => new Promise(r => setTimeout(r, ms || 350));

  // Fehler aus der Oberflaeche duerfen nicht still verschwinden.
  const protokoll = [];
  fenster.webContents.on('console-message', (_e, _lvl, text) => {
    if (/error|Error|exception/i.test(text)) protokoll.push(text);
  });

  await fenster.loadFile(path.join(PROJ, 'src', 'renderer', 'index.html'));
  await warte(1200);

  // Ein Sicht-Schnappschuss des Panels als JSON: Name, Beschreibung, Schalter.
  const panel = () => js(`(function(){
    const liste = document.getElementById('packList');
    const zeilen = [...liste.querySelectorAll('.mod-row')].map(r => ({
      name: r.querySelector('.mod-name').textContent,
      desc: r.querySelector('.mod-desc').textContent,
      icon: r.querySelector('.mod-icon').textContent,
      schalter: r.querySelector('.settings-schalter')
        ? r.querySelector('.settings-schalter').getAttribute('aria-checked') : null,
      schalterLabel: r.querySelector('.settings-schalter')
        ? r.querySelector('.settings-schalter').getAttribute('aria-label') : null,
      schalterTitel: r.querySelector('.settings-schalter')
        ? r.querySelector('.settings-schalter').title : null,
      loeschen: r.querySelector('.mod-action.remove').textContent,
      hinweis: r.querySelector('.mod-info').title || ''
    }));
    return JSON.stringify({
      ansichtOffen: getComputedStyle(document.getElementById('viewResourcePacks')).display !== 'none',
      shellView: document.getElementById('shellEl').getAttribute('data-view'),
      titel: document.querySelector('#viewResourcePacks .mods-title').textContent,
      unterZeile: document.getElementById('packsSubtitle').textContent,
      hinweis: document.querySelector('#viewResourcePacks p.mods-subtitle').textContent,
      zaehler: document.getElementById('packsCount').textContent,
      importText: document.querySelector('#importPackBtn span').textContent,
      leerText: liste.querySelector('.mods-empty') ? liste.querySelector('.mods-empty').textContent : null,
      zeilen: zeilen
    });
  })()`).then(JSON.parse);

  // =====================================================================
  gruppe('1. Der Menuepunkt ist eine Ansicht, kein Bild');
  // =====================================================================
  // Der Punkt stand schon da, trug aber kein data-view. Ohne das Attribut
  // greift der Klick-Handler gar nicht, und der Punkt waere eine Attrappe.
  const nav = JSON.parse(await js(`(function(){
    const item = document.querySelector('.nav-item[data-view="resourcepacks"]');
    if(!item) return JSON.stringify({da:false});
    const vorher = document.getElementById('shellEl').getAttribute('data-view');
    item.click();
    return JSON.stringify({
      da: true, titel: item.getAttribute('title'),
      vorher: vorher, nachher: document.getElementById('shellEl').getAttribute('data-view'),
      aktiv: item.classList.contains('active')
    });
  })()`));
  await warte();
  ok(nav.da === true, 'es gibt einen Menuepunkt mit data-view="resourcepacks"');
  ok(nav.nachher === 'resourcepacks', 'der Klick schaltet die Ansicht um', 'shellEl: ' + nav.nachher);
  ok(nav.aktiv === true, 'und der Punkt gilt als aktiver');

  let p = await panel();
  ok(p.ansichtOffen === true, 'die Ansicht ist wirklich sichtbar');
  ok(/Ressourcenpakete/i.test(p.titel), 'der Titel steht in der Ansicht: "' + p.titel + '"');
  ok(/Alpha/.test(p.unterZeile), 'die Zeile darunter nennt die Instanz: "' + p.unterZeile + '"');
  ok(/options\.txt/i.test(p.hinweis),
     'der Hinweis sagt, dass der Schalter erst beim naechsten Start gilt', p.hinweis);

  // =====================================================================
  gruppe('2. Leerer Ordner');
  // =====================================================================
  gleich('der Zaehler steht auf 0', p.zaehler, '0');
  ok(p.leerText && /Ressourcenpakete/i.test(p.leerText),
     'und die Liste sagt, dass noch keins da ist', p.leerText);
  gleich('keine Zeile', p.zeilen.length, 0);

  // =====================================================================
  gruppe('3. Ein entpackter Paketordner aus dem Pack-Ordner');
  // =====================================================================
  // So sieht ein echter Bestand aus: der Benutzer hat den Ordner von Hand in
  // resourcepacks/ gelegt. Die Anzeige darf nicht davon abhaengen, dass der
  // Launcher das Paket selbst kopiert hat.
  paketOrdner('alpha', 'AlphaPaket', 15, 'Testpaket');
  optionsVorlegen('alpha');
  await js('packsNeuZeichnen(true)');
  await warte();
  p = await panel();
  gleich('eine Zeile', p.zeilen.length, 1);
  gleich('der Zaehler steht auf 1', p.zaehler, '1');
  gleich('der Name ist der Ordnername', p.zeilen[0].name, 'AlphaPaket');
  ok(/Minecraft 1\.20\u20131\.20\.1/.test(p.zeilen[0].desc),
     'pack.mcmeta wurde gelesen und der Version zugeordnet', p.zeilen[0].desc);
  ok(/Entpackter Ordner/.test(p.zeilen[0].desc),
     'und die Zeile sagt, dass es ein Ordner ist', p.zeilen[0].desc);
  ok(/\d+(\.\d)?\s?B$|KB|MB/.test(p.zeilen[0].desc), 'die Groesse steht dabei', p.zeilen[0].desc);
  gleich('der Schalter steht aus', p.zeilen[0].schalter, 'false');
  ok(/einschalten/i.test(p.zeilen[0].schalterLabel || ''),
     'und sein Label nennt die Handlung, nicht den Zustand', p.zeilen[0].schalterLabel);

  // =====================================================================
  gruppe('4. Der Schalter schreibt options.txt - und sonst nichts');
  // =====================================================================
  await js('document.querySelector(\'#packList .settings-schalter\').click()');
  await warte();
  gleich('options.txt bekommt den Paketnamen',
    packsZeile('alpha'), 'resourcePacks:["vanilla","file/AlphaPaket"]');
  const nachEin = optionsLesen('alpha');
  ok(nachEin.includes('# von Hand gepflegt'),
     'die fremde Zeile mit dem Kommentar ist noch da', JSON.stringify(nachEin));
  ok(nachEin.includes('language:de_de') && nachEin.includes('fov:0.0'),
     'und die anderen Optionen auch');
  ok(nachEin.split(/\r?\n/).filter(z => z.trim()).length === 5,
     'es kam genau eine Zeile dazu, keine Leerzeile',
     JSON.stringify(nachEin.split(/\r?\n/)));
  p = await panel();
  gleich('der Schalter steht jetzt an', p.zeilen[0].schalter, 'true');
  ok(/ausschalten/i.test(p.zeilen[0].schalterLabel || ''),
     'und bietet jetzt das Ausschalten an', p.zeilen[0].schalterLabel);

  // Und wieder aus.
  await js('document.querySelector(\'#packList .settings-schalter\').click()');
  await warte();
  gleich('beim Ausschalten bleibt nur vanilla', packsZeile('alpha'), 'resourcePacks:["vanilla"]');
  p = await panel();
  gleich('der Schalter steht wieder aus', p.zeilen[0].schalter, 'false');

  // =====================================================================
  gruppe('5. Import-Knopf');
  // =====================================================================
  // Der Dateidialog laesst sich hier nicht oeffnen; geprueft wird, dass der Knopf
  // den Kanal benutzt und die Liste danach neu zeichnet.
  const importiert = JSON.parse(await js(`(function(){
    const knopf = document.getElementById('importPackBtn');
    const vorher = knopf.title;
    knopf.click();
    return JSON.stringify({ vorher: vorher });
  })()`));
  await warte();
  ok(importiert.vorher === '',
     'der Knopf ist nach einem abgebrochenen Dialog ohne Antworttext', JSON.stringify(importiert));
  p = await panel();
  gleich('die Liste steht noch da', p.zeilen.length, 1);
  ok(/Eigene \.zip/i.test(p.importText), 'der Knopf heisst "Eigene .zip hinzuefuegen": "' + p.importText + '"');

  // =====================================================================
  gruppe('6. Loeschen');
  // =====================================================================
  await js('document.querySelector(\'#packList .settings-schalter\').click()');
  await warte();
  await js('document.querySelector(\'#packList .mod-action.remove\').click()');
  await warte(500);
  p = await panel();
  gleich('die Zeile ist weg', p.zeilen.length, 0);
  gleich('der Zaehler steht wieder auf 0', p.zaehler, '0');
  ok(!fs.existsSync(path.join(instanzOrdner('alpha'), 'resourcepacks', 'AlphaPaket')),
     'und der Ordner auf der Platte auch');
  gleich('options.txt zeigt nicht mehr auf das geloeschte Paket',
    packsZeile('alpha'), 'resourcePacks:["vanilla"]');

  // =====================================================================
  gruppe('7. Wechsel des Modpacks');
  // =====================================================================
  // Ohne den Aufruf packsNachInstanzWechseln() stuende hier weiter die Liste
  // des vorherigen Modpacks, und "Loeschen" traefe den Ordner der alten
  // Instanz. Genau der Fehler, den es bei den Mods gab.
  paketOrdner('beta', 'BetaPaket', 21, 'Nur in Beta');
  await js(`(function(){
    const punkte = document.querySelectorAll('#instanceDropdown .instance-option');
    for(const p of punkte){ if(p.textContent.indexOf('Beta') >= 0){ p.click(); return true; } }
    return false;
  })()`);
  await warte(600);
  const nachWechsel = await panel();
  gleich('die Liste zeigt jetzt Beta', nachWechsel.zeilen.length, 1);
  gleich('und zwar BetaPaket', nachWechsel.zeilen[0].name, 'BetaPaket');
  ok(/Minecraft 1\.21\.4/.test(nachWechsel.zeilen[0].desc),
     'mit der Version aus Beta', nachWechsel.zeilen[0].desc);
  ok(/Beta/.test(nachWechsel.unterZeile) && !/Alpha/.test(nachWechsel.unterZeile),
   'die Zeile darunter nennt Beta: "' + nachWechsel.unterZeile + '"');
  ok(!packsZeile('beta'), 'Beta hat keine options.txt - die Liste meldet also nichts als aktiv');
  gleich('und nichts ist eingeschaltet', nachWechsel.zeilen[0].schalter, 'false');

  // Der Schalter in Beta darf Alpha nicht anfasst.
  await js('document.querySelector(\'#packList .settings-schalter\').click()');
  await warte();
  gleich('der Schalter schreibt in Beta', packsZeile('beta'), 'resourcePacks:["vanilla","file/BetaPaket"]');

  // =====================================================================
  gruppe('8. Sprache');
  // =====================================================================
  // Die Zeilen sind dynamisch erzeugter Text. Ohne Neuzeichnen beim
  // Sprachwechsel bliebe hier Deutsch stehen, waehrend der Titel schon
  // englisch waere.
  await js('setLanguage("en")');
  await warte(600);
  p = await panel();
  ok(/Resource packs/i.test(p.titel), 'der Titel ist englisch: "' + p.titel + '"');
  ok(/Add your own \.zip/i.test(p.importText), 'der Import-Knopf ist englisch: "' + p.importText + '"');
  ok(/Unpacked folder/i.test(p.zeilen[0].desc),
     'die Paketzeile ist englisch: "' + p.zeilen[0].desc + '"');
  ok(/Turn off in game/i.test(p.zeilen[0].schalterLabel || ''),
     'das Schalter-Label ist englisch: "' + p.zeilen[0].schalterLabel + '"');
  ok(/options\.txt/i.test(p.hinweis) && /next start/i.test(p.hinweis),
     'der Hinweis ist englisch: "' + p.hinweis + '"');
  ok(/For instance/i.test(p.unterZeile), 'die Instanzzeile ist englisch: "' + p.unterZeile + '"');

  await js('setLanguage("es")');
  await warte(600);
  p = await panel();
  ok(/Paquetes de recursos/i.test(p.titel), 'und auf Spanisch: "' + p.titel + '"');
  ok(/Carpeta descomprimida/i.test(p.zeilen[0].desc),
     'die Paketzeile ist spanisch: "' + p.zeilen[0].desc + '"');
  await js('setLanguage("fr")');
  await warte(600);
  p = await panel();
  ok(/Packs de ressources/i.test(p.titel), 'und auf Franzoesisch: "' + p.titel + '"');
  ok(/Dossier d/.test(p.zeilen[0].desc), 'die Paketzeile ist franzoesisch: "' + p.zeilen[0].desc + '"');
  await js('setLanguage("de")');
  await warte(500);

  // =====================================================================
  gruppe('9. Zwei Formen mit demselben Namen');
  // =====================================================================
  // "Doppel" als .zip und als Ordner. Minecraft laedt eines von beiden, und
  // welches, steht in keiner Datei. Beide muessen sichtbar bleiben und der
  // Schalter muss sagen, dass er beide trifft.
  paketOrdner('beta', 'Doppel', 15, '');
  fs.writeFileSync(path.join(instanzOrdner('beta'), 'resourcepacks', 'Doppel.zip'), 'PK\u0003\u0004kein echtes zip');
  await js('packsNeuZeichnen(true)');
  await warte();
  p = await panel();
  gleich('beide Zeilen stehen da', p.zeilen.filter(z => z.name === 'Doppel').length, 2);
  const mitWarnung = p.zeilen.filter(z => /doppelt/i.test(z.desc));
  gleich('und beide sind als Konflikt markiert', mitWarnung.length, 2);
  ok(/Schalter trifft beide|switch hits both/i.test(mitWarnung[0].hinweis || ''),
     'der Zeilenhinweis erklaert es: "' + mitWarnung[0].hinweis + '"');
  // Der Schalterzustand kommt aus options.txt und haengt am NAMEN, nicht an der
  // Stelle in der Liste: "Doppel" steht dort nicht, "BetaPaket" (aus Gruppe 7)
  // schon. Waere er an die Zeile gebunden, wuerde jetzt irgendein Paket an
  // stehen.
  gleich('beide "Doppel"-Zeilen stehen aus, weil options.txt den Namen nicht nennt',
    mitWarnung.map(z => z.schalter).sort().join(','), 'false,false');
  const betaZeile = p.zeilen.find(z => z.name === 'BetaPaket');
  gleich('waehrend BetaPaket weiter an steht', betaZeile && betaZeile.schalter, 'true');

  // =====================================================================
  gruppe('10. Ein kaputtes .zip bleibt sichtbar');
  // =====================================================================
  // Wuerde der Hauptprozess es einfach weglassen, fragte sich der Benutzer, wo
  // sein Paket geblieben ist.
  await js('packsNeuZeichnen(true)');
  await warte();
  const doppelZeile = (await panel()).zeilen.filter(z => z.name === 'Doppel')
    .find(z => /ZIP/i.test(z.desc));
  ok(!!doppelZeile, 'die .zip-Zeile steht noch da');
  ok(/nicht lesbar|unreadable/i.test(doppelZeile.desc),
     'und wird als kaputt bezeichnet: "' + doppelZeile.desc + '"');

  // =====================================================================
  gruppe('11. Der Haupt-Prozess kann nicht antworten');
  // =====================================================================
  // Der Kanal wird abgemeldet, der Aufruf fliegt also wirklich. Zwei Dinge
  // muessen stimmen: die Liste darf nicht "0 Pakete" behaupten (das waere
  // gelogen - es wurde nichts gelesen), und es darf keine unbehandelte
  // Ablehnung in die Konsole schlagen. Genau das war vorher der Fall und hat
  // test-modpacks-fenster.js fehlschlagen lassen.
  ipcMain.removeHandler('packs:list');
  await js('packsNeuZeichnen(true)');
  await warte();
  p = await panel();
  ok(p.leerText && /konnten nicht gelesen werden/i.test(p.leerText),
     'statt "keine Pakete" steht ein eigener Satz', String(p.leerText));
  ok(!/Noch keine Ressourcenpakete/i.test(p.leerText || ''),
     'und behauptet nicht, es sei leer', String(p.leerText));
  gleich('der Zaehler steht auf 0', p.zaehler, '0');
  // Noch einmal probieren: der Merkmal-Zustand muss zurueckgesetzt sein, sonst
  // bliebe der Fehlertext bis zum naechsten Modpackwechsel stehen.
  ipcMain.handle('packs:list', (_e, id) => rp.listPacks(instanzOrdner(id)));
  await js('packsNeuZeichnen(true)');
  await warte();
  // Drei Eintraege: BetaPaket, Doppel/ und Doppel.zip aus den Gruppen 7 und 9.
  p = await panel();
  ok(p.zeilen.length === 3, 'nach dem Wiedereinrichten der Kanaele kommen die Zeilen zurueck',
     'Zeilen: ' + p.zeilen.length);
  ok(!p.leerText, 'und der Fehlertext ist verschwunden');

  // =====================================================================
  gruppe('12. Nichts davon hat einen Fehler in die Oberflaeche geschickt');
  // =====================================================================
  // Steht bewusst hinter Gruppe 11: das beweist, dass auch der gescheiterte
  // Aufruf still bleibt.
  ok(protokoll.length === 0, 'keine Fehlermeldung der Konsole', protokoll.join(' | '));

  Z.push('');
  if (probleme.length) {
    Z.push('❌ ' + probleme.length + ' von ' + pruefungen + ' Pruefungen fehlgeschlagen');
  } else {
    Z.push('✅ Alle ' + pruefungen + ' Pruefungen bestanden.');
    Z.push('   Die Pakete kommen aus dem resourcepacks-Ordner, der Schalter schreibt');
    Z.push('   genau eine Zeile in options.txt, und der Wechsel des Modpacks');
    Z.push('   zeigt die Pakete des neuen an.');
  }
  schreibe();
  app.exit(probleme.length ? 1 : 0);
})().catch((err) => {
  Z.push('');
  Z.push('ABBRUCH: ' + String(err && err.message || err));
  schreibe();
  console.error('Test ist abgebrochen:', err);
  app.exit(2);
});

/** Protokoll in die Datei UND auf die Konsole. Zwei Ziele, weil die Konsole
 *  bei Fenstertests unter Windows gern abgeschnitten wird und die Datei leer
 *  bleibt, wenn der Prozess vorher stirbt. */
function schreibe(){
  const ausgabe = path.join(os.tmpdir(), 'opencode', 'packs-fenster.txt');
  fs.mkdirSync(path.dirname(ausgabe), { recursive: true });
  try {
    fs.writeFileSync(ausgabe, Z.join('\n'), 'utf-8');
  } catch (err) { /* Datei nicht zu schreiben ist kein Testfehler */ }
  console.log(Z.join('\n'));
}