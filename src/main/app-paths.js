/**
 * Der userData-Ordner — einmal berechnet, nirgends festgeschrieben.
 *
 * Warum es diese Datei gibt:
 *
 * Electron nimmt fuer app.getPath('userData') den OrdnerNamen aus
 * package.json, und zwar den Wert "productName", NICHT "name". Bei diesem
 * Projekt ist das der Unterschied zwischen
 *
 *     Roaming\liquid-launcher     (name)
 *     Roaming\Liquid Launcher     (productName, mit Leerzeichen)
 *
 * Das ist kein theoretischer Unterschied, sondern ein echter Fehler, der
 * passiert ist: config.json wurde in den ersten Ordner geschrieben, der
 * Launcher las aus dem zweiten und meldete "keine Client-ID hinterlegt".
 * Noch schlimmer: der Test, der das pruefen sollte, benutzte denselben
 * falschen Ordner — dadurch stimmten Test und Datei ueberein und beide
 * widersprachen der echten App. Ein gruener Test, der das Falsche
 * bestaetigt.
 *
 * Deshalb: Der Ordnername wird hier einmal aus package.json gelesen und
 * von allen benutzt, die nicht selbst ein Fenster offen haben
 * (setup-client-id.js, test-auth.js, test-ms-registration.js).
 *
 * Muss unter reinem Node laufen — also KEIN require('electron') hier.
 * Electron selbst benutzt natuerlich app.getPath('userData'); die beiden
 * Wege muessen dasselbe ergeben, sonst genau dieser Fehler noch einmal.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let zwischenspeicher = null;

/**
 * Den Ordnernamen ermitteln, den Electron fuer userData verwenden wird.
 * Liest package.json direkt, statt electron zu brauchen.
 */
function appDirName() {
  if (zwischenspeicher) return zwischenspeicher;

  let name = null;
  try {
    // __dirname ist <projekt>/src/main, das package.json liegt zwei Ebenen
    // hoeher. Der Weg ueber require.resolve ist robust gegen Verschieben.
    const pkgPfad = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPfad, 'utf-8'));
    // Reihenfolge wie Electron: productName hat Vorrang vor name.
    name = (pkg.productName || pkg.name || '').trim();
  } catch {
    // package.json nicht lesbar: auf den Namen zurueckfallen, den dieses
    // Projekt immer hatte. Lieber falsch als gar nicht — die Aufrufer
    // melden den Ordner, man kann ihn von Hand korrigieren.
    name = 'Liquid Launcher';
  }

  zwischenspeicher = name;
  return name;
}

/**
 * Das Basisverzeichnis fuer Electron-"userData" je Betriebssystem.
 * Kein electron-Import, damit es auch unter node funktioniert.
 */
function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Der vollstaendige userData-Pfad — derselbe, den app.getPath('userData')
 * im Hauptprozess liefert.
 */
function userDataDir() {
  return path.join(appDataDir(), appDirName());
}

/**
 * Nur zum Pruefen: gegen app.getPath('userData') vergleichen.
 * Ein Test, der beides nebeneinanderstellt, faellt sofort auf, wenn
 * package.json und Electron doch unterschiedlich vorgehen.
 */
function vergleicheMitElectron(userDataVonElectron) {
  const erwartet = userDataDir();
  return {
    erwartet,
    tatsaechlich: userDataVonElectron,
    gleich: erwartet === userDataVonElectron
  };
}

module.exports = {
  appDirName,
  appDataDir,
  userDataDir,
  vergleicheMitElectron
};
