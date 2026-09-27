// src/main/nbt.js
// Minimaler NBT-Leser für Minecrafts level.dat.
//
// NBT ist das Binärformat, in dem Minecraft Welt-Metadaten speichert. Ein
// Launcher braucht es, um aus dem Ordnernamen "New World" und aus
// "gespielt am 14.03. um 20:11" sowie der installierten Version ein
// brauchbares Datum zu machen.
//
// NUR LESEN. Ein Schreiben ist hier nicht nötig und wäre auch nicht
// verantwortbar: level.dat gehört dem Spiel, und ein Fehler darin macht eine
// Welt unspielbar. Wenn diese Datei etwas kaputtmacht, ist das nicht
// rückgängig zu machen.
//
// Aufbau: eine Datei ist ein einzelner TAG_Compound. Jeder Tag hat eine
// Nummer, einen Namen (Länge als unsigned short) und einen Wert. Werte können
// verschachtelt sein, deshalb wird rekursiv gelesen.

const zlib = require('node:zlib');

const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12
};

/**
 * Fehler, wenn die Datei abgeschnitten oder kryptisch ist. Eine kaputte
 * level.dat darf nicht den ganzen Aufruf der Weltenliste umwerfen — der
 * Ordner existiert ja trotzdem, und ein leerer Name ist besser als kein
 * Eintrag.
 */
class NbtError extends Error {}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) {
      throw new NbtError(`NBT-Datei endet unerwartet nach ${this.buf.length} Bytes (wollte ${this.pos + n})`);
    }
  }
  int8() { this.need(1); return this.buf.readInt8(this.pos++); }
  uint8() { this.need(1); return this.buf.readUInt8(this.pos++); }
  int16() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  int32() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  int64() {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return Number(v); // Unix-Zeitstempel passen locker in die Number-Sicherheitsgrenze
  }
  float() { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  double() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  string() {
    const len = this.int16();
    // Eine negative Länge ist eindeutig Unsinn, und ohne diese Prüfung würde
    // Buffer.read mit einem negativen Offset werfen statt unsere Fehler zu
    // werfen — die Meldung wäre dann unbrauchbar.
    if (len < 0) throw new NbtError(`Negative Stringlänge: ${len}`);
    this.need(len);
    const v = this.buf.toString('utf-8', this.pos, this.pos + len);
    this.pos += len;
    return v;
  }
  payload(type) {
    switch (type) {
      case TAG.Byte: return this.int8();
      case TAG.Short: return this.int16();
      case TAG.Int: return this.int32();
      case TAG.Long: return this.int64();
      case TAG.Float: return this.float();
      case TAG.Double: return this.double();
      case TAG.ByteArray: {
        const len = this.int32();
        if (len < 0) throw new NbtError(`Negative ByteArray-Länge: ${len}`);
        this.need(len);
        const v = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return v;
      }
      case TAG.String: return this.string();
      case TAG.List: {
        const itemType = this.uint8();
        const len = this.int32();
        // Leere Liste darf itemType 0 (End) haben — das ist normal.
        if (len === 0) return [];
        if (itemType === TAG.End) throw new NbtError('TAG_List mit Inhalt, aber Elementtyp End');
        if (len < 0) throw new NbtError(`Negative Listenlänge: ${len}`);
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.payload(itemType));
        return out;
      }
      case TAG.Compound: return this.compound();
      case TAG.IntArray: {
        const len = this.int32();
        if (len < 0) throw new NbtError(`Negative IntArray-Länge: ${len}`);
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.int32());
        return out;
      }
      case TAG.LongArray: {
        const len = this.int32();
        if (len < 0) throw new NbtError(`Negative LongArray-Länge: ${len}`);
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.int64());
        return out;
      }
      default:
        throw new NbtError(`Unbekannter Tag-Typ: ${type} (Position ${this.pos})`);
    }
  }
  compound() {
    const out = {};
    for (;;) {
      const type = this.uint8();
      if (type === TAG.End) return out;
      const name = this.string();
      out[name] = this.payload(type);
    }
  }
}

/**
 * Liest eine level.dat. Handhabt gzip und unkomprimiertes NBT, weil
 * Minecraft beides schreibt.
 *
 * @returns {object|null} das Wurzel-Objekt, oder null wenn unlesbar
 */
function readNbt(filePath) {
  const fs = require('node:fs');
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    throw new NbtError(`level.dat nicht lesbar: ${err.message}`);
  }

  let buf = raw;
  // 0x1f8b ist die gzip-Magic. level.dat ist praktisch immer komprimiert,
  // aber ein Backup oder ein Tool kann auch Rohdaten hinterlassen.
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(raw);
    } catch (err) {
      throw new NbtError(`gzip-defekt: ${err.message}`);
    }
  }

  if (buf.length === 0) throw new NbtError('level.dat ist leer');

  const r = new Reader(buf);
  const rootType = r.uint8();
  if (rootType !== TAG.Compound) {
    throw new NbtError(`Wurzel ist Tag ${rootType}, erwartet wurde ein Compound (10)`);
  }
  r.string(); // Name der Wurzel, meist "" — wird nicht gebraucht
  return r.compound();
}

module.exports = { readNbt, NbtError, TAG };
