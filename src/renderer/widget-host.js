// src/renderer/widget-host.js
// Laedt, rendert und versorgt die Widget-Kacheln in der Hauptansicht.
//
// Dieses Skript laeuft als ganz normale Seite im HAUPTframe. Es ist NICHT
// der Sandbox-Frame eines Widgets - dort gilt nichts von dem hier.
//
// ---------------------------------------------------------------------------
// Die Sicherheitsgrenze, in drei Saetzen
// ---------------------------------------------------------------------------
// 1. Jede Kachel ist ein <iframe sandbox="allow-scripts">. Bewusst OHNE
//    allow-same-origin. Mit diesem Attribut waere die Kachel ein Frame wie
//    die Hauptseite selbst, und ein heruntergeladenes Widget koennte das
//    ganze Fenster nachstellen. Ohne bekommt es eine undurchsichtige Herkunft.
// 2. Der Renderer laeuft mit contextIsolation. Es gibt in diesem Fenster
//    kein require und kein process. Ein Widget kann davon nichts erben, weil
//    es gar nicht dieses Fenster ist.
// 3. Daten gehen nur ueber postMessage, und nur die Felder, die der
//    Hauptprozess auf der Positivliste in widgets.js durchgelassen hat.
//    Es gibt kein Feld auf dieser Liste, das ein Token enthaelt.
//
// Der Absender wird nicht ueber event.origin geprueft, sondern ueber
// event.source: ein Frame mit undurchsichtiger Herkunft hat origin "null",
// eine Herkunftspruefung waere also wertlos. event.source dagegen laesst
// sich nicht fuehlen - nur das iframe selbst kann eine Nachricht schicken,
// deren source dieses iframe ist.
//
// ---------------------------------------------------------------------------
// Warum srcdoc und keine Datei-URL
// ---------------------------------------------------------------------------
// srcdoc statt src="file://.../widget.html": dann kann das Widget gar nicht
// erst versuchen, eine Datei zu laden. Es bekommt genau den Text, den der
// Hauptprozess fuer es gelesen hat, und sonst nichts. Eine Datei-URL muesste
// man erst gegen den Rest der Festplatte absichern (allowFileAccess, und
// webSecurity aufdrehen) - das faellt hier einfach weg.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Zustand
  // ---------------------------------------------------------------------
  const SPEICHER_KEY = 'widgetKacheln';
  const RAHMEN_MARKE = '__llWidgetId';

  /** Alle gefundenen Widgets: { id, titel, beschreibung, breite, quelle } */
  let verfuegbar = [];
  /** Die aktuell gebauten Kacheln: [{ id, breite }] */
  let kacheln = [];
  /** Der gefilterte Datenkoffer aus dem Hauptprozess. */
  let daten = null;
  /** true, wenn gerade der Bearbeiten-Modus laeuft. */
  let bearbeiten = false;
  /** Kachel-Element -> Widget-ID. */
  const rahmenZuId = new Map();
  /** Die Message-Listener werden genau einmal angehaengt. */
  let zuhoererBereits = false;

  const el = (id) => document.getElementById(id);
  const hatPreload = () => !!(window.launcher && window.launcher.widgets);

  // ---------------------------------------------------------------------
  // Kurzformen fuer die Preload-Kanaele. Ohne Preload (z.B. index.html
  // direkt im Browser geoeffnet) liefern sie einen leeren statt einen
  // Fehler - die Kachelreihe bleibt dann einfach leer, statt zu verschwinden.
  // ---------------------------------------------------------------------
  function ruf(kanal, ...args) {
    if (!hatPreload()) return Promise.resolve(null);
    try {
      return window.launcher.widgets[kanal](...args);
    } catch (err) {
      console.warn('widgets.' + kanal + ' fehlgeschlagen:', err);
      return Promise.resolve(null);
    }
  }

  // ---------------------------------------------------------------------
  // Theme an die Kacheln schicken
  // ---------------------------------------------------------------------
  // Die Widgets laufen in einem eigenen Dokument und kennen die CSS-Variablen
  // des Launchers nicht. Sie bekommen sie deshalb als --ll-*-Variablen
  // geschickt, und benutzen sie mit einem Fallback, falls gar nichts kommt.
  function themeFarben() {
    const standard = {
      '--ll-text-hi': '#fff',
      '--ll-text-lo': 'rgba(255,255,255,.62)',
      '--ll-accent': '#ffb86b'
    };
    if (!window.getComputedStyle) return standard;
    const stil = getComputedStyle(document.documentElement);
    const raus = {};
    for (const name of ['--text-hi', '--text-lo', '--accent']) {
      const wert = stil.getPropertyValue(name);
      if (wert && wert.trim()) raus['--ll-' + name.slice(2)] = wert.trim();
    }
    return Object.assign(standard, raus);
  }

  // ---------------------------------------------------------------------
  // Nachrichten an ein einzelnes Widget
  // ---------------------------------------------------------------------
  function sende(rahmen, typ, inhalt) {
    try {
      rahmen.contentWindow.postMessage(
        Object.assign({ quelle: 'liquid-launcher', typ: typ }, inhalt || {}),
        '*'
      );
    } catch (err) {
      // passiert, wenn der Frame gerade neu geladen wird - unkritisch
    }
  }

  function sendeAnAlle(typ, inhalt) {
    rahmenZuId.forEach((_id, rahmen) => sende(rahmen, typ, inhalt));
  }

  // ---------------------------------------------------------------------
  // Empfangene Nachrichten pruefen
  // ---------------------------------------------------------------------
  function zuhoerer() {
    if (zuhoererBereits) return;
    zuhoererBereits = true;
    window.addEventListener('message', (ev) => {
      // 1. Gehoert die Nachricht ueberhaupt zu einem unserer Frames?
      let treffer = null;
      rahmenZuId.forEach((_id, rahmen) => {
        if (treffer) return;
        try {
          if (rahmen.contentWindow === ev.source) treffer = rahmen;
        } catch (err) { /* Frame wurde entfernt */ }
      });
      if (!treffer) return;

      const d = ev.data;
      if (!d || typeof d !== 'object' || d.quelle !== 'liquid-launcher-widget') return;

      if (d.typ === 'anfrage') {
        // Das Widget will die Daten sofort - etwa, weil sein Skript erst
        // jetzt laeuft. Ohne das bliebe es auf "..." stehen.
        sende(treffer, 'daten', { daten: daten || {} });
        sende(treffer, 'theme', { daten: themeFarben() });
      } else if (d.typ === 'fehler') {
        zeigeFehler(treffer, d.nachricht || 'Unbekannter Fehler');
      }
    });
  }

  // ---------------------------------------------------------------------
  // Kacheln aufbauen
  // ---------------------------------------------------------------------
  function kachelEl(id, breite) {
    const div = document.createElement('div');
    div.className = 'stat-tile wdg-tile';
    div.dataset.wid = id;
    div.style.gridColumn = 'span ' + (breite >= 2 ? 2 : 1);
    div.draggable = bearbeiten;

    // Entfernen-Knopf. Er liegt im Kachel-Rahmen, nicht im iframe - ein
    // Knopf im Widget selbst waere fuer den Benutzer nicht erreichbar, ohne
    // an jedes Widget die Sonderregel "bietet einen Entfernen-Knopf an"
    // weiterzugeben.
    const knopf = document.createElement('button');
    knopf.className = 'wdg-entf';
    knopf.type = 'button';
    knopf.title = 'Diese Kachel entfernen';
    knopf.setAttribute('aria-label', 'Kachel entfernen');
    knopf.textContent = '×';
    knopf.addEventListener('click', (ev) => {
      ev.stopPropagation();
      entfernen(id);
    });
    div.appendChild(knopf);

    // Platzhalter, bis das HTML da ist. Zeigt bewusst den Titel, nicht nur
    // einen Balken: dann ist beim Start erkennbar, WELCHE Kachel laedt.
    const platzhalter = document.createElement('div');
    platzhalter.className = 'wdg-ladet';
    platzhalter.textContent = titelVon(id) || id;
    div.appendChild(platzhalter);

    return div;
  }

  function titelVon(id) {
    const w = verfuegbar.find((x) => x.id === id);
    return w ? w.titel : null;
  }

  function frameEin(div, id) {
    const rahmen = document.createElement('iframe');
    rahmen.className = 'wdg-frame';
    rahmen.title = titelVon(id) || id;
    // OHNE allow-same-origin. Siehe Kopf dieses Skripts.
    rahmen.setAttribute('sandbox', 'allow-scripts');
    rahmen.setAttribute('allowtransparency', 'true');
    rahmen.setAttribute(RAHMEN_MARKE, id);
    rahmen.addEventListener('load', () => {
      // Daten sofort schieben: manche Widgets fragen nicht aktiv nach, sondern
      // erwarten sie beim Start.
      sende(rahmen, 'theme', { daten: themeFarben() });
      sende(rahmen, 'daten', { daten: daten || {} });
    });
    rahmenZuId.set(rahmen, id);
    div.appendChild(rahmen);
    return rahmen;
  }

  function zeigeFehler(rahmen, nachricht) {
    const div = rahmen.parentElement;
    if (!div) return;
    // Der Knopf ist in der Kachel, nicht im Frame - sonst koennte er nicht
    // angeklickt werden.
    const box = div.querySelector('.wdg-fehler');
    if (box) box.remove();
    const divFehler = document.createElement('div');
    divFehler.className = 'wdg-fehler';
    divFehler.textContent = nachricht;
    div.appendChild(divFehler);
  }

  // ---------------------------------------------------------------------
  // Raster neu aufbauen
  // ---------------------------------------------------------------------
  function rendern() {
    const gitter = el('statGrid');
    if (!gitter) return;

    rahmenZuId.clear();
    gitter.innerHTML = '';

    if (!kacheln.length) {
      const leer = document.createElement('div');
      leer.className = 'wdg-leer' + (bearbeiten ? '' : ' wdg-leer-loud');
      leer.textContent = bearbeiten
        ? 'Keine Kacheln. In den Einstellungen unter "Widgets" hinzufügen.'
        : 'Keine Kacheln. Widgets lassen sich in den Einstellungen hinzufügen.';
      gitter.appendChild(leer);
      aktualisiereBearbeitenKnopf();
      return;
    }

    for (const k of kacheln) {
      const div = kachelEl(k.id, k.breite);
      gitter.appendChild(div);
      const rahmen = frameEin(div, k.id);
      ladeHtml(rahmen, k.id);
    }

    aktualisiereBearbeitenKnopf();
  }

  // HTML im Nachhinein in einen bereits gebauten Frame legen. Geht nicht
  // synchron, weil der Frame dafuer erstellt sein muss.
  function ladeHtml(rahmen, id) {
    ruf('html', id).then((r) => {
      const div = rahmen.parentElement;
      if (!div || !r) return;
      const platzhalter = div.querySelector('.wdg-ladet');
      if (platzhalter) platzhalter.remove();
      if (!r.ok) {
        zeigeFehler(rahmen, r.fehler || 'Konnte nicht geladen werden');
        return;
      }
      rahmen.setAttribute('srcdoc', r.html);
    });
  }

  // ---------------------------------------------------------------------
  // Daten nachladen
  // ---------------------------------------------------------------------
  function datenLaden(instanceId) {
    return ruf('daten', instanceId || '').then((d) => {
      daten = d || {};
      sendeAnAlle('daten', { daten: daten });
      return daten;
    });
  }

  // Die gerade gewaehlte Instanz mitteilen.
  //
  // Wichtig, und das war ein echter Fehler in der ersten Fassung: hier stand
  // `document.getElementById('statInstanceId')`, ein Element, das es in
  // index.html nie gab. Die Folge war nicht ein Absturz, sondern etwas
  // Schlechteres - die Abfrage lieferte '' , also bekamen die Kacheln einen
  // leeren Datenkoffer und zeigten "0 Welten" bei einer Instanz, die welche
  // hat. Im Fenster-Test fiel das als modAnzahl: 0 auf. Ein Absturz haette
  // man gesehen; eine falsche Zahl haette man leicht uebersehen.
  let instanzId = '';
  function instanzSetzen(id) {
    instanzId = typeof id === 'string' ? id : '';
    return datenLaden(instanzId);
  }

  // ---------------------------------------------------------------------
  // Kacheln aendern und speichern
  // ---------------------------------------------------------------------
  function speichern() {
    if (!window.launcher || !window.launcher.settings) return;
    const kopie = kacheln.map((k) => ({ id: k.id, breite: k.breite }));
    window.launcher.settings.set({ [SPEICHER_KEY]: kopie });
  }

  function einbauen(id) {
    if (kacheln.some((k) => k.id === id)) return false;
    const w = verfuegbar.find((x) => x.id === id);
    kacheln.push({ id: id, breite: w ? (w.breite || 1) : 1 });
    speichern();
    rendern();
    return true;
  }

  function entfernen(id) {
    const vorher = kacheln.length;
    kacheln = kacheln.filter((k) => k.id !== id);
    if (kacheln.length === vorher) return;
    speichern();
    rendern();
  }

  function verschieben(vonId, aufId) {
    if (vonId === aufId) return;
    const von = kacheln.findIndex((k) => k.id === vonId);
    const auf = kacheln.findIndex((k) => k.id === aufId);
    if (von < 0 || auf < 0) return;
    const [stueck] = kacheln.splice(von, 1);
    kacheln.splice(auf, 0, stueck);
    speichern();
    rendern();
  }

  // ---------------------------------------------------------------------
  // Bearbeiten-Modus
  // ---------------------------------------------------------------------
  function aktualisiereBearbeitenKnopf() {
    const knopf = el('statBearbeitenBtn');
    if (!knopf) return;
    knopf.classList.toggle('aktiv', bearbeiten);
    knopf.textContent = bearbeiten ? 'Fertig' : 'Anpassen';
    const karte = el('statCard');
    if (karte) karte.classList.toggle('wdg-im-edit', bearbeiten);
  }

  function bearbeitenSchalten(an) {
    bearbeiten = an === undefined ? !bearbeiten : !!an;
    const gitter = el('statGrid');
    if (gitter) gitter.classList.toggle('wdg-edit', bearbeiten);
    rendern();
  }

  // Ziehen und Ablegen. Nur im Bearbeiten-Modus aktiv - sonst wauscht beim
  // normalen Vorbeifahren am Fenster nichts mit.
  function verdrahtung() {
    const gitter = el('statGrid');
    if (!gitter) return;

    let gezogen = null;

    gitter.addEventListener('dragstart', (ev) => {
      if (!bearbeiten) return;
      const ziel = ev.target.closest('.wdg-tile');
      if (!ziel) return;
      gezogen = ziel.dataset.wid;
      ziel.classList.add('wdg-drag');
      ev.dataTransfer.effectAllowed = 'move';
      // Firefox braucht das, Chromium nicht - schadet nicht.
      try { ev.dataTransfer.setData('text/plain', gezogen); } catch (err) {}
    });

    gitter.addEventListener('dragend', () => {
      if (gezogen) {
        const ziel = gitter.querySelector('[data-wid="' + gezogen + '"]');
        if (ziel) ziel.classList.remove('wdg-drag');
      }
      gezogen = null;
      gitter.querySelectorAll('.wdg-dragover').forEach((n) => n.classList.remove('wdg-dragover'));
    });

    gitter.addEventListener('dragover', (ev) => {
      if (!bearbeiten || !gezogen) return;
      ev.preventDefault();
      const ziel = ev.target.closest('.wdg-tile');
      if (!ziel || ziel.dataset.wid === gezogen) return;
      gitter.querySelectorAll('.wdg-dragover').forEach((n) => n.classList.remove('wdg-dragover'));
      ziel.classList.add('wdg-dragover');
    });

    gitter.addEventListener('dragleave', (ev) => {
      const ziel = ev.target.closest('.wdg-dragover');
      if (ziel) ziel.classList.remove('wdg-dragover');
    });

    gitter.addEventListener('drop', (ev) => {
      if (!bearbeiten || !gezogen) return;
      ev.preventDefault();
      const ziel = ev.target.closest('.wdg-tile');
      const von = gezogen;
      gezogen = null;
      gitter.querySelectorAll('.wdg-dragover').forEach((n) => n.classList.remove('wdg-dragover'));
      if (ziel) verschieben(von, ziel.dataset.wid);
    });
  }

  // ---------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------
  const VORGABE = [
    { id: 'welten', breite: 1 },
    { id: 'mods', breite: 1 },
    { id: 'uhr', breite: 1 },
    { id: 'laufzeit', breite: 1 }
  ];

  async function starten() {
    zuhoerer();

    verfuegbar = (await ruf('list')) || [];
    // Das Argument von settings.get() ignorieren: die Kacheln kommen als
    // eigener Schluessel, damit der Block nicht im Theme-Menue landet.
    let gespeichert = null;
    if (window.launcher && window.launcher.settings) {
      try {
        const s = await window.launcher.settings.get();
        gespeichert = s && s[SPEICHER_KEY];
      } catch (err) { /* erster Start */ }
    }

    if (Array.isArray(gespeichert) && gespeichert.length) {
      // Unbekannte IDs werden uebersprungen statt das Raster zu sprengen -
      // zum Beispiel wenn ein eigenes Widget geloescht wurde.
      kacheln = gespeichert
        .filter((k) => k && typeof k.id === 'string')
        .map((k) => ({ id: k.id, breite: Number(k.breite) >= 2 ? 2 : 1 }));
    } else {
      kacheln = VORGABE.slice();
      speichern();
    }

    verdrahtung();

    const knopf = el('statBearbeitenBtn');
    if (knopf) knopf.addEventListener('click', () => bearbeitenSchalten());

    rendern();
    // Beim ersten Aufbau ist noch keine Instanz bekannt. Sobald index.html
    // eine gewaehlt hat, ruft es instanzSetzen() auf.
    datenLaden(instanzId);

    return { verfuegbar: verfuegbar, kacheln: kacheln };
  }

  // ---------------------------------------------------------------------
  // fuer index.html und die Tests
  // ---------------------------------------------------------------------
  // Die aktuellen Farben an alle Kacheln schicken. Wird nach einem Wechsel
  // des Farbschemas aufgerufen, sonst behaelt eine bereits offene Kachel die
  // Farben, mit denen sie geladen wurde.
  function themeSenden() {
    const farben = themeFarben();
    sendeAnAlle('theme', { daten: farben });
    return farben;
  }

  window.WidgetHost = {
    starten,
    rendern,
    einbauen,
    entfernen,
    verschieben,
    bearbeitenSchalten,
    datenLaden,
    instanzSetzen,
    themeFarben,
    themeSenden,
    // Nur zum Nachsehen in der Konsole
    _zustand: () => ({ verfuegbar, kacheln, daten, bearbeiten, instanzId })
  };
})();
