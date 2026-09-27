// test-auth-errors.js
// Testet, ob ein fehlgeschlagener Login eine BENUTZERFÜHRLICHE Meldung
// erzeugt — und nicht "undefined" oder "Failed to login to Microsoft account".
//
// Das ist hier nicht nur Kosmetik: an diesem Text entscheidet sich, ob jemand
// in fünf Minuten oder in fünf Stunden herausfindet, ob die falsche Client-ID,
// der falsche Redirect-URI oder der falsche Account-Typ eingetragen ist.
//
// Der Test füttert normalizeLoginError() exakt die Formen, die msmc 5.0.5
// tatsächlich wirft (nachgelesen in node_modules/msmc/dist/cjs):
//   * String-Codes aus xAuth()   — XSTS-Fehler
//   * { response, ts }          — aus errorResponse() bei HTTP-Fehlern
//   * echte Error               — aus dem eigenen Code
//
//   node test-auth-errors.js

const auth = require('./src/main/auth');

const problems = [];
function check(condition, message) {
  console.log(`  ${condition ? 'OK  ' : 'FEHLT'} ${message}`);
  if (!condition) problems.push(message);
}

/**
 * Baut ein Objekt, das sich wie eine node-fetch-Response verhält — inklusive
 * des Einmal-Leseverhaltens, weil genau daran der echte Code hängt.
 */
function fakeResponse(status, body, { html = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let gelesen = false;
  return {
    ok: false,
    status,
    text() {
      if (gelesen) throw new Error('Response body was already read');
      gelesen = true;
      return Promise.resolve(text);
    },
    json() { return Promise.resolve(JSON.parse(text)); }
  };
}

(async () => {

  // ---- 1. Das Grundproblem: msmc wirft kein Error -------------------------
  console.log('=== 1. Fehlerformen, die msmc wirklich produziert ===');

  // Genau so wirft errorResponse() in node_modules/msmc/dist/cjs/util/lexicon.js
  const msmcFehler = { response: fakeResponse(400, { error: 'invalid_client' }), ts: 'error.auth.microsoft' };
  check(!(msmcFehler instanceof Error), 'msmc-Fehler ist tatsaechlich KEIN Error (der Grund fuer diesen Test)');
  check(msmcFehler.message === undefined, 'msmcFehler hat kein .message -> "undefined" waere alles was der Nutzer sieht');

  const e1 = await auth.normalizeLoginError(msmcFehler);
  check(e1 instanceof Error, 'wird zu einem echten Error mit .message');
  check(!!e1.message && !e1.message.includes('undefined'),
    'Meldung enthaelt kein "undefined": ' + JSON.stringify(e1.message.slice(0, 70)));

  // ---- 2. Falscher Redirect-URI: der häufigste Fehler --------------------
  console.log('\n=== 2. AADSTS50011 (Redirect-URI passt nicht) ===');
  const e2 = await auth.normalizeLoginError({
    response: fakeResponse(400, {
      error: 'invalid_request',
      error_description: 'AADSTS50011: The redirect URI \'https://login.live.com/oauth20_desktop.srf\' specified in the request does not match the redirect URIs configured for the application.'
    }),
    ts: 'error.auth.microsoft'
  });
  check(e2.message.includes('AADSTS50011'), 'der AADSTS-Code steht in der Meldung');
  check(e2.message.includes('oauth20_desktop.srf'),
    'die Meldung nennt den noetigen Redirect-URI');
  check(e2.message.includes('Microsoft') || e2.message.includes('Microsoft sagt'),
    'das Originalwort von Microsoft bleibt als Beweis erhalten');
  console.log('      -> ' + e2.message.split('\n')[0]);
  console.log('      -> ' + e2.message.split('\n')[2]);

  // ---- 3. Falscher Account-Typ ------------------------------------------
  console.log('\n=== 3. AADSTS50020 / 9002326 (falscher Account-Typ) ===');
  const e3 = await auth.normalizeLoginError({
    response: fakeResponse(400, {
      error: 'invalid_client',
      error_description: 'AADSTS50020: AADSTS50020: The provided request body must contain the parameter client_secret or client_assertion.'
    }),
    ts: 'error.auth.microsoft'
  });
  check(e3.message.includes('AADSTS50020'), 'AADSTS50020 wird erkannt');
  check(e3.message.includes('client_secret') || e3.message.includes('Personal'),
    'die Meldung erklaert, was zu tun ist');

  // ---- 4. Xbox-Fehler als Zifferncode ------------------------------------
  console.log('\n=== 4. Xbox XErr als Zahl (Kindkonto / kein Xbox-Profil) ===');
  const e4 = await auth.normalizeLoginError('error.auth.xsts.child');
  check(e4.message.includes('Kindkonto'), 'Kindkonto-Hinweis aus dem XSTS-Code');
  check(e4.message.includes('Familie'), 'mit konkreter Loesung');

  const e4b = await auth.normalizeLoginError({
    response: fakeResponse(401, { XErr: 2148916233, Message: '...' }),
    ts: 'error.auth.xsts'
  });
  check(e4b.message.includes('xbox.com'), 'XErr 2148916233 wird zu einer konkreten Anleitung');

  // ---- 5. Fenster geschlossen: das ist KEIN Fehler ----------------------
  console.log('\n=== 5. Login-Fenster vom Nutzer geschlossen ===');
  const e5 = await auth.normalizeLoginError('error.gui.closed');
  check(e5.message.includes('abgebrochen'),
    'wird als "abgebrochen" gemeldet, nicht als Fehler mit Schildwarnung');

  // ---- 6. Kein Minecraft ------------------------------------------------
  console.log('\n=== 6. Konto ohne Minecraft ===');
  const e6 = await auth.normalizeLoginError({
    response: fakeResponse(403, { errorMessage: '...' }),
    ts: 'error.auth.minecraft.profile'
  });
  check(e6.message.includes('minecraft.net'), 'verweist auf die Kaufseite statt auf einen kryptischen Fehler');

  // ---- 7. HTML-Antwort (z.B. ADFS-Seite) --------------------------------
  console.log('\n=== 7. HTML statt JSON (nicht 200 Zeilen in die Meldung stopfen) ===');
  const e7 = await auth.normalizeLoginError({
    response: fakeResponse(200, '<html>' + 'x'.repeat(5000) + '</html>', { html: true }),
    ts: 'error.auth.microsoft'
  });
  check(e7.message.length < 700, `Meldung bleibt lesbar (${e7.message.length} Zeichen statt ~5000)`);

  // ---- 8. Eigene Errors kommen unverändert durch ------------------------
  console.log('\n=== 8. Eigene Fehler bleiben unveraendert ===');
  const eigener = new Error('Keine Azure-Client-ID hinterlegt');
  check(await auth.normalizeLoginError(eigener) === eigener,
    'ein bereits sauberer Error wird nicht umgebaut');

  // ---- 9. AADSTS-Code wird auch austen links erkannt -------------------
  console.log('\n=== 9. Der AADSTS-Code steckt nicht immer am Anfang ===');
  const e9 = await auth.normalizeLoginError({
    response: fakeResponse(400, {
      error_description: 'Error: AADSTS7000218: No client secret or client assertion is present in the request.'
    }),
    ts: 'error.auth.microsoft'
  });
  check(e9.message.includes('AADSTS7000218'), 'AADSTS7000218 auch mit Praefix erkannt');
  check(e9.message.includes('Public Client') || e9.message.includes('Desktop'),
    'mit passender Handlungsanweisung');

  // ---- 10. Stufe 4 von 4: Minecraft nimmt die Xbox-Identitaet nicht -------
  // Das ist der Fehler, der tatsaechlich aufgetreten ist, und er fiel vorher
  // auf "Minecraft-Server haben die Xbox-Anmeldung abgelehnt. (HTTP 403)" —
  // ohne jeden Hinweis. Genau solche Meldungen kosten Stunden.
  console.log('\n=== 10. Minecraft lehnt ab, nachdem Xbox Live geklappt hat ===');
  const e10 = await auth.normalizeLoginError({
    response: fakeResponse(403, {}),
    ts: 'error.auth.minecraft.login'
  });
  check(e10.message.includes('has-java') || e10.message.includes('minecraft.net/has-java'),
    'nennt die offizielle Pruefseite fuer Java-Edition-Besitz');
  check(e10.message.includes('Java Edition'),
    'sagt ausdruecklich, dass Java Edition fehlen koennte');
  check(e10.message.includes('Bedrock'),
    'nennt die haeufigste Ursache (nur Bedrock gekauft)');
  check(e10.message.includes('Steam'),
    'nennt die zweithaeufigste Ursache (Steam-Version)');
  check(!/^\s*$/.test(e10.message.split('\n')[0]),
    'die erste Zeile ist nicht leer — der Nutzer sieht sofort, worum es geht');
  check(!/^\s*Minecraft-Server haben.*\(HTTP 403\)\s*$/.test(e10.message.trim()),
    'die alte, nutzlose Ein-Zeilen-Meldung ist nicht mehr moeglich');
  check(e10.message.split('\n').length > 8,
    `die Meldung ist ausfuehrlich (${e10.message.split('\n').length} Zeilen statt 1)`);

  // "Invalid app registration" ist ein GANZ ANDERER Fall und verlangt eine
  // gegensaetzliche Handlung: nicht kaufen, sondern einen Entwicklerzugang
  // beantragen. Beide Texte zu vermischen hiesse, eines davon zu verschweigen.
  console.log('\n=== 11. Invalid app registration (kein Kaufproblem!) ===');
  const e11 = await auth.normalizeLoginError({
    response: fakeResponse(403, { errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information' }),
    ts: 'error.auth.minecraft.login'
  });
  check(e11.message.includes('Invalid app registration'),
    'nennt die exakte Serverfehlermeldung');
  check(/NICHT\s+"du hast kein Minecraft"/.test(e11.message),
    'stellt ausdruecklich klar: das ist KEIN Kaufproblem');
  check(e11.message.includes('developer.microsoft.com'),
    'verweist auf den Weg, der tatsaechlich hilft (Xbox Developer Program)');
  check(e11.message.includes('OAuth'),
    'sagt, dass die ersten drei Stufen erfolgreich waren');
  check(!e11.message.includes('has-java'),
    'verweist NICHT auf die Kaufseite — das waere hier die falsche Beratung');
  check(e11.message.includes('Client-Secret'),
    'sagt ausdruecklich, was nicht hilft');

  // Mit Servertext: der muss auftauchen, sonst weiss niemand, was wirklich los war.
  const e10b = await auth.normalizeLoginError({
    response: fakeResponse(403, { errorMessage: 'User does not own the game' }),
    ts: 'error.auth.minecraft.login'
  });
  check(e10b.message.includes('User does not own the game'),
    'der Text der Minecraft-Server wird mit ausgegeben');

  // Und: die Meldung darf nicht behaupten, es liege an der App.
  check(e10.message.includes('Xbox'),
    'erklaert, dass die Xbox-Anmeldung vorher erfolgreich war');


  console.log('\n' + '='.repeat(64));
  if (problems.length) {
    console.log('❌ Probleme:');
    problems.forEach(p => console.log('   - ' + p));
    process.exitCode = 1;
  } else {
    console.log('✅ Jede msmc-Fehlerform ergibt eine Meldung, mit der man');
    console.log('   arbeiten kann — kein "undefined", kein "Failed to login".');
  }
})();
