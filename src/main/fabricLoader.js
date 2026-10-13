/**
 * Fabric-Loader-Unterstuetzung.
 *
 * Warum es diese Datei gibt:
 *
 * Bis hierher kannte der Startcode nur Vanilla. Eine Instanz durfte zwar
 * `modloader: "fabric"` tragen, der Loader wurde beim Start aber weder geladen
 * noch in die Befehlszeile uebersetzt. Das Log sagte das sogar ehrlich
 * ("der Modloader ... wird noch nicht geladen"), und alle Fabric-Mods im
 * `mods`-Ordner blieben damit ohne Wirkung - das Spiel startete als Vanilla
 * und ignorierte sie komplett.
 *
 * Dieses Modul holt den Installationsplan (das "Profil") von
 * meta.fabricmc.net und VERSCHMILZT ihn mit der Vanilla-version.json. Das
 * Ergebnis hat wieder die Form einer version.json - nur mit der
 * Fabric-MainClass, den Fabric-Libraries und den zusaetzlichen Argumenten.
 * downloader.js kann deshalb unveraendert damit weiterarbeiten: Classpath,
 * Natives, Assets und Argumentbau bleiben derselbe Weg.
 *
 * Die Fabric-Libraries stehen im Profil im MAVEN-Format (Name + Repository-
 * Basis-URL), nicht im Mojang-Format mit `downloads.artifact`. Beim
 * Verschmelzen werden sie auf die Mojang-Form normalisiert, damit
 * downloader.js sie ohne Sonderfall laden und auf die Classpath legen kann.
 *
 * Bewusst KEIN require('electron'): dieses Modul laeuft unter reinem Node
 * (test-fabric-loader.js). Es holt nur JSON; das Schreiben in die
 * Versionsordner macht weiterhin downloader.js.
 *
 * Schreibweise der Kommentare: ae/oe/ue - siehe die uebrigen Dateien in
 * src/main.
 */

const https = require('node:https');

const META_BASIS = 'https://meta.fabricmc.net';
const USER_AGENT = 'liquid-launcher/0.1 (privates Hobby-Projekt)';

// ==================== Maven-Format ====================
// Eine Maven-Koordinate sieht so aus:
//     org.ow2.asm:asm:9.10.1
//     net.fabricmc:fabric-loader:0.19.5
//     org.lwjgl:lwjgl:3.3.3:natives-windows      (mit Classifier)
//     com.example:lib:1.0:all@zip                (Classifier + Dateiendung)
//
// Der Classpath-Pfad ergibt sich daraus zu
//   <repo>/<gruppe-mit-slashes>/<artefakt>/<version>/<artefakt>-<version>[-<classifier>].<ext>
// Genau diese Form erwartet die Libraries-Ablage von Minecraft.

/**
 * Zerlegt einen Maven-Namen in seine Bestandteile.
 *
 * @returns {{gruppe:string,artefakt:string,version:string,klassifikator:string|null,
 *            erweiterung:string,dateiName:string,pfad:string}|null}
 *          null, wenn der Name kein gueltiger Maven-Name ist.
 */
function mavenNameZerlegen(name) {
  if (typeof name !== 'string' || !name) return null;

  // Dateiendung hinter "@" (z. B. "1.0:all@zip"). Ohne Angabe ist es jar.
  const at = name.indexOf('@');
  const erweiterung = at >= 0 ? name.slice(at + 1) : 'jar';
  const rest = at >= 0 ? name.slice(0, at) : name;
  if (!/^[A-Za-z0-9._-]+$/.test(erweiterung)) return null;

  const teile = rest.split(':');
  if (teile.length < 3) return null;
  const [gruppe, artefakt, version, klassifikator] = teile;
  if (!gruppe || !artefakt || !version) return null;
  // Gruppe/Artefakt/Version muessen wie Maven-Koordinaten aussehen. Damit
  // fallen kaputte Profil-Eintraege auf, statt als halbe Pfade auf der Platte
  // zu landen.
  if (!/^[A-Za-z0-9._-]+$/.test(gruppe)) return null;
  if (!/^[A-Za-z0-9._+-]+$/.test(artefakt)) return null;
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) return null;

  const dateiName = klassifikator
    ? `${artefakt}-${version}-${klassifikator}.${erweiterung}`
    : `${artefakt}-${version}.${erweiterung}`;

  return {
    gruppe,
    artefakt,
    version,
    klassifikator: klassifikator || null,
    erweiterung,
    dateiName,
    pfad: `${gruppe.replace(/\./g, '/')}/${artefakt}/${version}/${dateiName}`
  };
}

/**
 * Vollstaendige Download-URL einer Maven-Library. Die Basis-URL ist das
 * Repository (z. B. "https://maven.fabricmc.net/"); der Rest ist das
 * Maven-Layout. Ein fehlender oder ueberzaehliger Schraegstrich ist egal.
 */
function mavenUrl(basis, name) {
  const z = mavenNameZerlegen(name);
  if (!z || typeof basis !== 'string' || !basis) return null;
  const b = basis.endsWith('/') ? basis : `${basis}/`;
  return b + z.pfad;
}

/**
 * Eine Fabric-Library auf die Mojang-Form bringen.
 *
 * Fabric liefert `{ name, url, sha1?, size? }` im Maven-Format. downloader.js
 * erwartet aber `downloads.artifact` mit `url`, `path` (und optional
 * `sha1`/`size`). Fehlt `sha1` (kommt bei intermediary und fabric-loader vor),
 * wird sie einfach weggelassen - downloadFileWithSha1 laedt dann ohne
 * Pruefsumme, aber der Pfad ist trotzdem deterministisch.
 *
 * Libraries, die schon `downloads.artifact` haben, bleiben unangetastet.
 * Undatiert wird nie: das Original wird nicht veraendert.
 */
function normalisiereLoaderBibliothek(lib) {
  if (!lib || typeof lib !== 'object') return lib;

  const hatMojangForm = !!(lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url);
  if (hatMojangForm) return lib;
  if (typeof lib.url !== 'string' || !lib.url) return lib;

  const z = mavenNameZerlegen(lib.name);
  if (!z) return lib;

  const artifact = {
    url: mavenUrl(lib.url, lib.name),
    path: z.pfad
  };
  if (typeof lib.sha1 === 'string' && lib.sha1) artifact.sha1 = lib.sha1;
  if (typeof lib.size === 'number') artifact.size = lib.size;

  return {
    ...lib,
    downloads: { ...(lib.downloads || {}), artifact }
  };
}

/**
 * Schluessel zum Erkennen doppelter Libraries beim Verschmelzen. Die Version
 * gehoert NICHT dazu: bringt Fabric eine neuere Fassung derselben Library mit
 * (z. B. asm), soll genau EINE auf dem Classpath landen, nicht beide.
 * Ein Classifier (4. Namensteil) gehoert dagegen zum Schluessel, weil
 * natives-windows etwas anderes ist als die Basis-Library.
 */
function bibliothekSchluessel(lib) {
  if (!lib || typeof lib.name !== 'string') return null;
  const teile = lib.name.split(':');
  if (teile.length < 2) return null;
  const basis = `${teile[0]}:${teile[1]}`;
  return teile.length > 3 && teile[3] ? `${basis}:${teile[3]}` : basis;
}

/**
 * Vanilla-version.json und Fabric-Profil verschmelzen.
 *
 * Die id bleibt die der VANILLA-Version. Alle Pfade der Startkette
 * (Versionsordner, client.jar, libraries, natives, Assets) haengen an ihr;
 * mit der Profil-id wuerde der Classpath auf einen leeren Ordner zeigen und
 * das Spiel sofort mit ClassNotFoundException aussteigen.
 *
 * Die Reihenfolge der Libraries entspricht der Reihenfolge auf dem Classpath.
 * Deshalb gewinnt bei doppeltem group:artifact der SPAETERE Eintrag - das sind
 * die Fabric-Libraries. So landet z. B. nur Fabric's neueres ASM im Classpath,
 * nicht zusaetzlich die alte Vanilla-Version davor.
 *
 * Beide Eingaben werden nicht veraendert.
 */
function verschmelze(vanilla, profil) {
  if (!vanilla || typeof vanilla !== 'object') {
    throw new Error('verschmelze(): die Vanilla-version.json fehlt.');
  }
  if (!profil || typeof profil !== 'object') {
    throw new Error('verschmelze(): das Fabric-Profil fehlt.');
  }

  const libraries = [];
  const positionen = new Map();
  const aufnehmen = (lib) => {
    const schluessel = bibliothekSchluessel(lib);
    if (schluessel && positionen.has(schluessel)) {
      libraries[positionen.get(schluessel)] = lib;
      return;
    }
    if (schluessel) positionen.set(schluessel, libraries.length);
    libraries.push(lib);
  };

  for (const lib of (Array.isArray(vanilla.libraries) ? vanilla.libraries : [])) aufnehmen(lib);
  for (const lib of (Array.isArray(profil.libraries) ? profil.libraries : [])) {
    aufnehmen(normalisiereLoaderBibliothek(lib));
  }

  const vArgs = vanilla.arguments && typeof vanilla.arguments === 'object' ? vanilla.arguments : {};
  const pArgs = profil.arguments && typeof profil.arguments === 'object' ? profil.arguments : {};
  const zusammen = (a, b) => [
    ...(Array.isArray(a) ? a : []),
    ...(Array.isArray(b) ? b : [])
  ];

  return {
    ...vanilla,
    id: vanilla.id,
    // Nur zur Anzeige und fuer Log-Zeilen: woher die Ergaenzungen stammen.
    profilId: typeof profil.id === 'string' ? profil.id : null,
    mainClass: typeof profil.mainClass === 'string' && profil.mainClass
      ? profil.mainClass
      : vanilla.mainClass,
    libraries,
    arguments: {
      ...vArgs,
      jvm: zusammen(vArgs.jvm, pArgs.jvm),
      game: zusammen(vArgs.game, pArgs.game)
    }
  };
}

// ---------- Loader-Version waehlen ----------

/**
 * Die Kandidatenliste von meta.fabricmc.net in eine flache Form bringen:
 * [{ version, stable }]. Unbrauchbare Eintraege fliegen raus.
 */
function loaderKandidaten(metaJson) {
  if (!Array.isArray(metaJson)) return [];
  return metaJson
    .filter((e) => e && e.loader && typeof e.loader.version === 'string' && e.loader.version)
    .map((e) => ({ version: e.loader.version, stable: e.loader.stable === true }));
}

/**
 * Aus der Meta-Antwort eine Loader-Version waehlen.
 *
 * Ohne Wunsch die neueste stabile (Mojang-Standard: stabile Versionen zuerst
 * in der Liste). Mit Wunsch genau die - und wenn es sie fuer diese
 * Minecraft-Version nicht gibt, wird das gesagt statt still etwas anderes zu
 * nehmen: eine erfundene Version erzeugt sonst erst beim Download einen
 * schwer zu deutenden Fehler.
 */
function waehleLoaderVersion(metaJson, gewuenscht) {
  const kandidaten = loaderKandidaten(metaJson);
  if (!kandidaten.length) {
    throw new Error('meta.fabricmc.net liefert keine Fabric-Loader-Versionen.');
  }
  const wunsch = gewuenscht == null ? '' : String(gewuenscht).trim();
  if (wunsch) {
    const treffer = kandidaten.find((k) => k.version === wunsch);
    if (!treffer) {
      throw new Error(`Fabric Loader ${wunsch} gibt es fuer diese Minecraft-Version nicht.`);
    }
    return treffer.version;
  }
  const stabil = kandidaten.find((k) => k.stable);
  return (stabil || kandidaten[0]).version;
}

// ---------- Netzwerk ----------

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fuer ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Antwort von ${url} ist kein gueltiges JSON (${err.message}).`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => reject(new Error(`Zeitueberschreitung beim Laden von ${url}.`)));
  });
}

function holeLoaderListe(gameVersion) {
  return httpsGetJson(`${META_BASIS}/v2/versions/loader/${encodeURIComponent(gameVersion)}`);
}

function holeProfil(gameVersion, loaderVersion) {
  return httpsGetJson(
    `${META_BASIS}/v2/versions/loader/${encodeURIComponent(gameVersion)}` +
    `/${encodeURIComponent(loaderVersion)}/profile/json`
  );
}

/**
 * Bequemer Weg fuer den Aufrufer: Liste holen UND waehlen. Ohne Wunsch die
 * neueste stabile Version.
 */
async function empfohleneLoaderVersion(gameVersion, gewuenscht) {
  const liste = await holeLoaderListe(gameVersion);
  return waehleLoaderVersion(liste, gewuenscht);
}

module.exports = {
  META_BASIS,
  mavenNameZerlegen,
  mavenUrl,
  normalisiereLoaderBibliothek,
  bibliothekSchluessel,
  verschmelze,
  loaderKandidaten,
  waehleLoaderVersion,
  httpsGetJson,
  holeLoaderListe,
  holeProfil,
  empfohleneLoaderVersion
};
