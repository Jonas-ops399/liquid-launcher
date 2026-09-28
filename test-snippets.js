// test-snippets.js
//   node test-snippets.js
//
// Zieht JEDEN js(`...`-Block aus den Fenster-Tests und prueft ihn einzeln mit
// node --check.
//
// Warum es das ueberhaupt braucht: `node --check` auf der Testdatei selbst
// findet einen fehlenden schliessenden Backtick NICHT. Der Backtick
// schliesst den Template-String, und alles danach - einschliesslich des
// Aufrufs und des schliessenden `))` - wird stillschweigend zu Text im
// String. Die Datei ist gueltiges JavaScript und tut nicht, was da steht.
//
// Der Fehler taucht dann erst zur Laufzeit drueben im Renderer auf, als
// "Uncaught SyntaxError: missing ) after argument list" - und zwar OHNE
// Zeilennummer vom echten Code, weil die Meldung fuer das injizierte
// Fragment gilt, nicht fuer index.html. Genau so hat das in diesem Projekt
// gedauert: die Klammerbilanz des Fragments war ausgeglichen, der Backtick
// an Zeile 516 war vorhanden, und trotzdem fehlte eine Klammer am Ende.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DATEIEN = ['test-einstellungen-fenster.js', 'test-widgets-fenster.js'];
const ORDNER = path.join(os.tmpdir(), 'll-snippets');

let schlecht = 0;

for (const d of DATEIEN) {
  if (!fs.existsSync(d)) {
    console.log(d + ': nicht vorhanden - uebersprungen');
    continue;
  }
  const s = fs.readFileSync(d, 'utf8');
  const treffer = [...s.matchAll(/js\(`/g)];
  console.log(d + ': ' + treffer.length + ' js(`-Aufrufe');

  fs.mkdirSync(ORDNER, { recursive: true });
  treffer.forEach((m, i) => {
    const von = m.index + m[0].length;
    const bis = s.indexOf('`', von);
    const zeile = s.slice(0, von).split('\n').length;
    if (bis < 0) {
      console.log('  #' + i + ' ab Zeile ' + zeile +
        ': KEIN schliessender Backtick - ab hier ist alles nur noch Text');
      schlecht++;
      return;
    }
    const code = s.slice(von, bis);
    const f = path.join(ORDNER, d.replace(/\W/g, '_') + '-' + i + '.js');
    fs.writeFileSync(f, code, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      console.log('  #' + i + ' ab Zeile ' + zeile + ': OK (' +
        code.split('\n').length + ' Zeilen)');
    } catch (e) {
      schlecht++;
      const meldung = String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ');
      console.log('  #' + i + ' ab Zeile ' + zeile + ': FEHLER  ' + meldung);
    }
  });
}

console.log(schlecht === 0
  ? '\nAlle injizierten Snippets sind gueltig.'
  : '\n' + schlecht + ' kaputt.');
process.exitCode = schlecht ? 1 : 0;
