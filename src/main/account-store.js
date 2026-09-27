// src/main/account-store.js
// Persistiert die angemeldeten Microsoft-Accounts.
//
// WARUM EIGENE DATEI STATT electron-store: electron-store speichert Klartext.
// Ein Minecraft-accessToken ist ein vollwertiger Login-Credential — damit
// koennte jeder, der die Datei aus einem Backup, einem Cloud-Sync oder einem
// Schadsoftware-Scan bekommt, den Account uebernehmen. Deshalb wird nur der
// unkritische Teil (Name, UUID, Skin-URL) als JSON abgelegt; accessToken und
// refreshToken kommen verschluesselt hinein.
//
// Unter Windows nutzt Electron dafuer DPAPI (Data Protection API). Der
// Schluessel haengt am Windows-Benutzerkonto und an der Maschine: eine
// kopierte accounts.json laesst sich auf einem anderen Rechner nicht
// entschluesseln.
//
// Auf Linux/Mac ist safeStorage ebenfalls verfuegbar, aber dort braucht es
// zwingend einen Keyring (macOS: Keychain, Linux: Secret Service / kwallet).
// Fehlt der, wird bewusst NICHT auf Klartext zurueckgefallen — siehe unten.

const fs = require('node:fs');
const path = require('node:path');

const FILE_VERSION = 1;

class AccountStore {
  /**
   * @param {string} userDataDir  wo accounts.json liegt
   * @param {object} safeStorage  Electron-Modul safeStorage (injectbar zum Testen)
   */
  constructor(userDataDir, safeStorage) {
    this.userDataDir = userDataDir;
    this.safeStorage = safeStorage;
    this.filePath = path.join(userDataDir, 'accounts.json');
    this.state = { version: FILE_VERSION, activeAccountId: null, accounts: [] };
    this.loaded = false;
  }

  // ---------- Verschlüsselung ----------

  get canEncrypt() {
    try {
      return !!this.safeStorage && this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Verschluesselt die geheimen Felder eines Accounts.
   * @returns {string|null} Base64-Blob oder null, wenn nicht verschluesselbar
   */
  _encryptSecrets(account) {
    if (!this.canEncrypt) return null;
    const payload = JSON.stringify({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken
    });
    // encryptString erwartet einen Buffer und gibt einen Buffer zurueck.
    return this.safeStorage.encryptString(payload).toString('base64');
  }

  _decryptSecrets(blob) {
    if (!blob) return null;
    try {
      if (!this.canEncrypt) return null;
      const json = this.safeStorage.decryptString(Buffer.from(blob, 'base64'));
      return JSON.parse(json);
    } catch {
      // Klartext in der Datei? Dann als Altlast akzeptieren.
      try {
        return JSON.parse(Buffer.from(blob, 'base64').toString('utf-8'));
      } catch { return null; }
    }
  }

  // ---------- Laden / Speichern ----------

  load() {
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) {
      this.state = { version: FILE_VERSION, activeAccountId: null, accounts: [] };
      return this.list();
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const accounts = (raw.accounts || []).map(entry => {
        const secrets = this._decryptSecrets(entry.secrets);
        return {
          // Offentliche Felder
          id: entry.id,
          username: entry.username,
          uuid: entry.uuid,
          avatarUrl: entry.avatarUrl,
          skinUrl: entry.skinUrl,
          xuid: entry.xuid || null,
          isDemo: !!entry.isDemo,
          expiresAt: entry.expiresAt || 0,
          // Geheime Felder (bleiben im Haupt-Prozess)
          accessToken: secrets?.accessToken || null,
          refreshToken: secrets?.refreshToken || null,
          // Markierung: true, wenn der Token nicht mehr entschluesselt werden
          // konnte und eine neue Anmeldung noetig ist.
          needsRelogin: !secrets?.accessToken
        };
      });

      this.state = {
        version: FILE_VERSION,
        activeAccountId: raw.activeAccountId || null,
        accounts
      };
    } catch (err) {
      // Kaputte Datei ist kein Grund, den Launcher nicht zu starten. Wir
      // benennen sie aber, damit sie nicht stillschweigend ueberschrieben wird
      // und der Nutzer sie pruefen kann.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.kaputt-${Date.now()}`);
        console.error(`[accounts] accounts.json war unlesbar (${err.message}) — als .kaputt-<zeitstempel> gesichert, starte mit leerer Account-Liste.`);
      } catch { /* dann eben doch ueberschreiben */ }
      this.state = { version: FILE_VERSION, activeAccountId: null, accounts: [] };
    }

    return this.list();
  }

  _save() {
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // Beim Speichern brauchen wir die Verschluesselung. Ist sie nicht
    // verfuegbar, speichern wir das Token gar nicht — ein Token im Klartext
    // auf der Platte waere schlimmer als gar kein gespeicherter Account.
    if (!this.canEncrypt) {
      // Metadaten werden trotzdem gespeichert — der Nutzer soll den Account
      // weiterhin in der Liste sehen (mit needsRelogin), nur eben ohne Token.
      // (Ein frueherer Versuch hat die Accounts ganz uebersprungen, wodurch
      // sie aus der UI verschwunden sind.)
      const written = this.state.accounts.map(a => ({
        id: a.id, username: a.username, uuid: a.uuid,
        avatarUrl: a.avatarUrl, skinUrl: a.skinUrl,
        xuid: a.xuid, isDemo: a.isDemo, expiresAt: a.expiresAt,
        secrets: null
      }));

      fs.writeFileSync(this.filePath, JSON.stringify({
        version: FILE_VERSION,
        activeAccountId: this.state.activeAccountId,
        accounts: written
      }, null, 2), 'utf-8');

      if (this.state.accounts.some(a => a.accessToken)) {
        console.error(
          '[accounts] WARNUNG: Kein verschlüsselter Speicher verfügbar ' +
          '(safeStorage meldet keine Verfügbarkeit). Der Account wurde NICHT ' +
          'dauerhaft gespeichert — beim nächsten Start ist er neu anzumelden. ' +
          'Unter Windows sollte das nicht auftreten; falls doch, ist der ' +
          'Windows-Benutzerkonto-Schlüsseldienst (DPAPI) nicht verfügbar.'
        );
      }
      return;
    }

    const written = this.state.accounts.map(a => ({
      id: a.id,
      username: a.username,
      uuid: a.uuid,
      avatarUrl: a.avatarUrl,
      skinUrl: a.skinUrl,
      xuid: a.xuid,
      isDemo: a.isDemo,
      expiresAt: a.expiresAt,
      secrets: a.accessToken ? this._encryptSecrets(a) : null
    }));

    // Erst in eine Temp-Datei schreiben, dann umbenennen. Sonst bricht ein
    // Stromausfall mitten im Schreiben die einzige Kopie der Tokens weg.
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      version: FILE_VERSION,
      activeAccountId: this.state.activeAccountId,
      accounts: written
    }, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  // ---------- Zugriff ----------

  /** Öffentliche Accounts (ohne Tokens) — das, was ans UI geht. */
  list() {
    return this.state.accounts.map(a => ({
      id: a.id,
      username: a.username,
      uuid: a.uuid,
      avatarUrl: a.avatarUrl,
      skinUrl: a.skinUrl,
      xuid: a.xuid,
      isDemo: a.isDemo,
      expiresAt: a.expiresAt,
      needsRelogin: !!a.needsRelogin
    }));
  }

  /** Gespeicherter Account inkl. Tokens — nur im Haupt-Prozess verwenden. */
  get(id) {
    return this.state.accounts.find(a => a.id === id) || null;
  }

  getActive() {
    if (!this.state.activeAccountId) return null;
    return this.get(this.state.activeAccountId);
  }

  setActive(id) {
    if (id !== null && !this.get(id)) return false;
    this.state.activeAccountId = id;
    this._save();
    return true;
  }

  /** Legt einen Account an oder aktualisiert ihn (gleiche UUID = gleicher Account). */
  upsert(account) {
    const existing = this.state.accounts.findIndex(a => a.id === account.id);
    if (existing >= 0) {
      this.state.accounts[existing] = { ...this.state.accounts[existing], ...account, needsRelogin: false };
    } else {
      this.state.accounts.push({ ...account, needsRelogin: false });
    }
    // Der erste angemeldete Account wird automatisch aktiv — das spart dem
    // Nutzer einen Klick und ist das, was jeder Launcher tut.
    if (!this.state.activeAccountId) this.state.activeAccountId = account.id;
    this._save();
    return account;
  }

  remove(id) {
    const before = this.state.accounts.length;
    this.state.accounts = this.state.accounts.filter(a => a.id !== id);
    if (this.state.accounts.length === before) return false;

    if (this.state.activeAccountId === id) {
      this.state.activeAccountId = this.state.accounts[0]?.id || null;
    }
    this._save();
    return true;
  }

  get count() {
    return this.state.accounts.length;
  }
}

module.exports = { AccountStore, FILE_VERSION };
