// test-skin-ganzkoerper.js  (laeuft unter reinem Node: node test-skin-ganzkoerper.js)
// Vertrag der Ganzkoerper-Skin-Anzeige: die Seitenleiste oeffnet direkt die
// Ganzkoerper-Figur, Auswahl und Entfernen sitzen dort, und die zweite Ebene
// (Hut, Jacke, Aermel, Hose) wird gebaut. Den Kopf an den drei Stellen
// (Seitenleiste, Profilkarte, Kontoliste) prueft test-startseite.js.
const fs = require('node:fs'), path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, 'src', 'renderer', 'index.html'), 'utf-8');
let n = 0, bad = 0;
const ok = (c, t) => { n++; if (!c) { bad++; console.log('  FEHLT', t); } };

ok(!/id="kopfDialog"|id="kopfWuerfel"|kopf-3d|kf-front/.test(HTML), 'Kopf-Dialog und Wuerfel sind entfernt');
ok(!/id="profileFace"|class="profile-face"/.test(HTML), 'Kopfbild in der Profilkarte ist entfernt');
ok(!/skinVollBtn/.test(HTML), 'kein Umweg ueber "Ganzkoerper ansehen" mehr');
ok(/avatarFeld\?\.addEventListener\('click', \(\) => skinVollOeffnen\(\)\)/.test(HTML), 'Seitenleisten-Feld oeffnet direkt die Ganzkoerper-Ansicht');
const voll = (HTML.match(/<div class="skin-voll" id="skinVollDialog"[\s\S]*?\n  <\/div>\n/) || [''])[0];
ok(voll.includes('id="skinWaehlenBtn"') && voll.includes('id="skinVergessenBtn"') && voll.includes('id="skinMeldung"'), 'Auswahl, Entfernen und Meldung liegen in der Ganzkoerper-Ansicht');
const teile = (HTML.match(/const SKIN_TEILE = \[[\s\S]*?\n  \];/) || [''])[0];
ok((teile.match(/ebene2:true/g) || []).length === 6, 'sechs Teile der zweiten Ebene (Hut, Jacke, 2 Aermel, 2 Hosenbeine)');
for (const [name, front] of [['kopf-2', '40,8'], ['koerper-2', '20,36'], ['arm-rechts-2', '44,36'], ['arm-links-2', '52,52'], ['bein-rechts-2', '4,36'], ['bein-links-2', '4,52']]) {
  ok(new RegExp("name:'" + name + "'[^\\n]*front:\\[" + front + "\\]").test(teile), 'Texturposition ' + name + ' front [' + front + ']');
}
ok(/\.sk-ov \.sk-fl\{[^}]*background-color:transparent/.test(HTML), 'zweite Ebene ist durchsichtig, wo der Skin leer ist');
ok(/skinHoehe\.h === 32/.test(HTML), 'altes 64x32-Format wird erkannt');
ok(/signature/.test('signature') && /sk-fl\{ backface-visibility:hidden/.test(HTML), 'Rueckseiten der Flaechen sind ausgeblendet');
console.log(`\n${n} Checks, ${bad} Fehler`);
process.exit(bad ? 1 : 0);
