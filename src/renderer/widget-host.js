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
  /**
   * Dasselbe fuer die Bedienelemente, aus demselben Grund.
   *
   * starten() wird mehrfach gerufen: beim Laden zweimal (index.html ruft es
   * einmal direkt und einmal ueber die "Neu laden"-Strecke auf) und bei
   * jedem Klick auf "Neu laden" noch einmal. Ohne diese Sperre haengt
   * jeder Aufruf neue Listener an dieselben zwei Elemente, und die
   * verdoppeln sich mit jedem Mal.
   *
   * Sichtbar war das am Knopf "Anpassen": bearbeitenSchalten() ist ein
   * Umschalter, kein Schalter. Zwei Listener auf einem Klick sind zweimal
   * umgeschaltet — der Zustand bleibt, wie er war, und der Knopf tut gar
   * nichts. Beim Laden zweimal aufgerufen war er ab dem ersten Start tot;
   * nach einem Neuladen mit drei Listenern konnte der Zustand sogar
   * kippen, je nachdem, wie oft vorher geladen wurde.
   */
  let verdrahtetBereits = false;

  const el = (id) => document.getElementById(id);
  const hatPreload = () => !!(window.launcher && window.launcher.widgets);

  // ---------------------------------------------------------------------
  // Uebersetzte Texte
  // ---------------------------------------------------------------------
  // Dieses Skript wird VOR dem grossen Skript in index.html geladen und kann
  // dessen t() nicht aufrufen. Die fertigen Strings kommen deshalb von dort:
  // ueber setzeTexte() (und zusaetzlich als window.__wdgTexte, falls der
  // Aufruf das Skript noch nicht erreicht hat). Faellt beides aus, bleibt der
  // deutsche Text stehen - die Kachel soll nie leer beschriftet sein.
  let texte = null;
  function aktuelleTexte() {
    return texte || window.__wdgTexte || {};
  }
  // Liefert den uebersetzten String oder den mitgegebenen deutschen Fallback.
  function wtxt(schluessel, fallback, vars) {
    let s = aktuelleTexte()[schluessel];
    if (typeof s !== 'string' || !s) return fallback;
    if (vars) {
      for (const k of Object.keys(vars)) s = s.replace('{' + k + '}', vars[k]);
    }
    return s;
  }
  function setzeTexte(neu) {
    texte = (neu && typeof neu === 'object') ? neu : null;
    // Beschriftungen, die im Hauptfenster stehen (Knopf), sofort anpassen.
    aktualisiereBearbeitenKnopf();
    // Den Kacheln die neuen Texte nachschieben. Sie zeichnen daraufhin mit
    // d.texte neu - ein kompletter Neuaufbau der Frames waere unnoetig und
    // wuerde jedes Widget-Skript neu starten.
    sendeAnAlle('daten', { daten: daten || {} });
  }

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
  //
  // Die Schrift gehoert aus demselben Grund hierher und nicht nur in das
  // Hauptfenster: eine Kachel ist ein eigenes Dokument. Schriftwaechter,
  // Zeilenabstaende, Seitenraender und Rahmen werden ueber die Dokumentgrenze
  // hinweg NICHT geerbt - eine Kachel erbt von gar nichts ausser dem, was
  // :root des iframe selbst vorgibt. Ohne diese Zeile bliebe die Uhr in der
  // Standardschrift stehen, waehrend der ganze Rest des Launchers in der
  // eingestellten Schrift stuende.
  //
  // Die eingestellte Schrift ist ein kompletter font-family-Stapel, kein
  // Familienname - siehe --font-ui in index.html. Deshalb wird sie unter dem
  // Namen --ll-font durchgereicht und von den Widgets mit
  // font-family: var(--ll-font, inherit) benutzt.
  //
  // Dasselbe gilt fuer --ll-fs: der Textgroessen-Faktor. Ohne ihn waere die
  // Uhr bei 125% kleiner als der Rest des Launchers, obwohl der Faktor
  // ausdruecklich fuer "alles" gedacht ist.
  const THEME_STANDARD = {
    '--ll-text-hi': '#fff',
    '--ll-text-lo': 'rgba(255,255,255,.62)',
    '--ll-accent': '#ffb86b',
    '--ll-fs': '1'
  };

  // Welche CSS-Variable des Launchers als welche --ll-*-Variable weitergeht.
  // Als Liste, nicht als drei Zeilen: sonst wird beim Erweitern leicht eine
  // Farbe nur im Fenster geaendert und nicht bei den Kacheln - genau die
  // Art stiller Inkonsistenz, die man auf einem Bild nicht sieht.
  const THEME_QUELLE = [
    ['--text-hi', '--ll-text-hi'],
    ['--text-lo', '--ll-text-lo'],
    ['--accent', '--ll-accent'],
    ['--font-ui', '--ll-font'],
    ['--fs', '--ll-fs']
  ];

  function themeStile() {
    const raus = Object.assign({}, THEME_STANDARD);
    if (!window.getComputedStyle) return raus;
    const stil = getComputedStyle(document.documentElement);
    for (const [von, nach] of THEME_QUELLE) {
      const wert = stil.getPropertyValue(von);
      if (wert && wert.trim()) raus[nach] = wert.trim();
    }
    return raus;
  }

  // Alter Name, noch benutzt (index.html ruft window.WidgetHost.themeFarben()
  // nicht, aber aeltere Widgets und die README beschreiben die Nachricht so).
  const themeFarben = themeStile;

  // ---------------------------------------------------------------------
  // Nachrichten an ein einzelnes Widget
  // ---------------------------------------------------------------------
  function sende(rahmen, typ, inhalt) {
    try {
      const zusammen = Object.assign({ quelle: 'liquid-launcher', typ: typ }, inhalt || {});
      // Bei Daten immer die uebersetzten Texte mitgeben. Ein Widget kann so
      // seine Beschriftungen in der eingestellten Sprache zeichnen, ohne die
      // Sprachdatei des Launchers zu kennen.
      if (typ === 'daten' && !zusammen.texte) zusammen.texte = aktuelleTexte();
      rahmen.contentWindow.postMessage(zusammen, '*');
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
        zeigeFehler(treffer, d.nachricht || wtxt('widget_unknown_error', 'Unbekannter Fehler'));
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
    knopf.title = wtxt('widget_remove', 'Diese Kachel entfernen');
    knopf.setAttribute('aria-label', wtxt('widget_remove', 'Diese Kachel entfernen'));
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
        ? wtxt('widget_empty_edit', 'Keine Kacheln. In den Einstellungen unter "Widgets" hinzufügen.')
        : wtxt('widget_empty', 'Keine Kacheln. Widgets lassen sich in den Einstellungen hinzufügen.');
      gitter.appendChild(leer);
      aktualisiereBearbeitenKnopf();
      return;
    }

    let i = 0;
    for (const k of kacheln) {
      const div = kachelEl(k.id, k.breite);
      // Laufende Nummer fuer die gestaffelte Einblendung (--wdg-i). Die
      // Verzoegerung selbst steht im CSS; hier steht nur, WELCHE Kachel
      // dran ist. Ohne die Nummer wuerden alle gleichzeitig erscheinen.
      div.style.setProperty('--wdg-i', String(i++));
      gitter.appendChild(div);
      const rahmen = frameEin(div, k.id);
      ladeHtml(rahmen, k.id);
    }

    aktualisiereBearbeitenKnopf();
    if (!bearbeiten) kachelnAnimieren();
  }

  // Laesst die Kacheln gestaffelt von unten einblenden. Der Kniff ist das
  // Entfernen und (nach erzwungenem Neuzeichnen) Wiederanlegen der Klasse:
  // eine CSS-Animation laeuft nur einmal, und beim Wechsel zurueck auf die
  // Startseite soll sie erneut laufen. Im Bearbeiten-Modus bewusst NICHT -
  // sonst huepft das Raster bei jeder Umsortierung neu auf.
  function kachelnAnimieren() {
    const gitter = el('statGrid');
    if (!gitter) return;
    gitter.classList.remove('wdg-auf');
    // offsetWidth lesen erzwingt einen Reflow; sonst fasst der Browser das
    // Entfernen und Hinzufuegen im selben Frame zusammen und nichts passiert.
    void gitter.offsetWidth;
    gitter.classList.add('wdg-auf');
  }

  // HTML im Nachhinein in einen bereits gebauten Frame legen. Geht nicht
  // synchron, weil der Frame dafuer erstellt sein muss.
  function ladeHtml(rahmen, id) {
    ruf('html', id).then((r) => {
      const div = rahmen.parentElement;
      if (!div || !r) return;
      const platzhalter = div.querySelector('.wdg-ladet');
      if (!r.ok) {
        if (platzhalter) platzhalter.remove();
        zeigeFehler(rahmen, r.fehler || wtxt('widget_load_failed', 'Konnte nicht geladen werden'));
        return;
      }
      // Platzhalter und Inhalt tauschen weich: erst wenn der Frame wirklich
      // gezeichnet ist, blendet er ein und der Titel aus. Vorher sprang der
      // Inhalt hart in die schon sichtbare leere Kachel (Doppel-Pop).
      rahmen.addEventListener('load', () => {
        rahmen.classList.add('bereit');
        if (platzhalter) {
          platzhalter.classList.add('weg');
          setTimeout(() => platzhalter.remove(), 400);
        }
      }, { once: true });
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
  // Frische Systemwerte (Phase D4)
  // ---------------------------------------------------------------------
  // CPU-Auslastung, freier RAM, freier Datenträger-Platz und laufende
  // Spiel-Prozesse aendern sich, waehrend der Launcher offen ist. Sie
  // kommen nicht mit widgets:daten - das wuerde beim Polling jedes Mal den
  // ganzen Koffer neu lesen, inklusive Welten-NBT und mods-Ordner.
  //
  // Deshalb ein eigener, leichter Kanal. Er wird alle paar Sekunden
  // abgefragt und nur gemergt: die langsam waechsenden Felder (Welten,
  // Mods, Groessen) bleiben im Koffer stehen, den widgets:daten geliefert
  // hat.
  //
  // Hintergrund-Fenster werden uebersprungen (document.hidden): was niemand
  // sieht, muss niemand messen.
  const FRISCH_MS = 4000;
  let frischTakt = null;

  function datenFrisch() {
    return ruf('systemdaten').then((frisch) => {
      if (!frisch || typeof frisch !== 'object') return daten;
      daten = Object.assign({}, daten || {}, frisch);
      sendeAnAlle('daten', { daten: daten });
      return daten;
    });
  }

  // Genau einmal timer legen - sonst waechst mit jedem starten() ein
  // zweiter Takt, und die Messungen verdoppeln sich still.
  function frischStarten() {
    if (frischTakt !== null) return;
    frischTakt = setInterval(() => {
      if (document.hidden) return;
      datenFrisch();
    }, FRISCH_MS);
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
    knopf.textContent = bearbeiten ? wtxt('widget_done', 'Fertig') : wtxt('widget_customize', 'Anpassen');
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
    // Siehe verdrahtetBereits: die Listener duerfen nur einmal dran.
    if (verdrahtetBereits) return;
    const gitter = el('statGrid');
    if (!gitter) return;
    verdrahtetBereits = true;

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

    // Ebenfalls genau einmal. Ohne diese Sperre wird der Umschalter bei
    // jedem weiteren starten() ein Listener reicher und der Knopf
    // arbeitet dann entweder gar nicht oder beim Tastendruck zweimal.
    const knopf = el('statBearbeitenBtn');
    if (knopf && !knopf.dataset.wdgVerdrahtet) {
      knopf.dataset.wdgVerdrahtet = '1';
      knopf.addEventListener('click', () => bearbeitenSchalten());
    }

    rendern();
    // Beim ersten Aufbau ist noch keine Instanz bekannt. Sobald index.html
    // eine gewaehlt hat, ruft es instanzSetzen() auf.
    datenLaden(instanzId);
    // Der Takt fuer die sich haendelnden Systemwerte (D4).
    frischStarten();

    return { verfuegbar: verfuegbar, kacheln: kacheln };
  }

  // ---------------------------------------------------------------------
  // fuer index.html und die Tests
  // ---------------------------------------------------------------------
  // Die aktuellen Farben und die eingestellte Schrift an alle Kacheln
  // schicken. Wird nach einem Wechsel des Farbschemas oder der Schrift
  // aufgerufen, sonst behaelt eine bereits offene Kachel die Werte, mit denen
  // sie geladen wurde.
  function themeSenden() {
    const stile = themeStile();
    sendeAnAlle('theme', { daten: stile });
    return stile;
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
    // Leichte Systemwerte neu holen und an alle Kacheln schicken (D4).
    datenFrisch,
    themeStile,
    themeFarben,
    themeSenden,
    // Uebersetzte Texte vom Hauptfenster uebernehmen (siehe setzeTexte()).
    setzeTexte,
    // Gestaffelte Einblendung der Kacheln erneut abspielen (z.B. beim
    // Zurueckwechseln auf die Startseite).
    kachelnAnimieren,
    // Nur zum Nachsehen in der Konsole
    _zustand: () => ({ verfuegbar, kacheln, daten, bearbeiten, instanzId })
  };
})();
