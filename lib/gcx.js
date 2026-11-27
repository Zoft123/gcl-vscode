'use strict';
// GCX (compiled GCL) container and bytecode: lossless parse and rebuild. JavaScript port of gclc's gcx.py.
//
// Layout (header words little-endian):
//   u32 timestamp; u32 proc_table[] (offset | flags << 24, terminated by 0xFFFFFFFF); block header
//   { u32 proc_area, resource_table, string_data, font_data, seed } (offsets relative to the block), resource table,
//   string data (XOR-encrypted with an LCG when seed != 0), font data, proc area { u32 main_offset; procs;
//   at main_offset: u32 size, main block }.
// Bytecode (MGS4's GCL_GetNextValue): 0x00..0x0F literals, 0x10/0x20 variables, 0x30 expr, 0x40 argument,
//   0x50 option, 0x60 command, 0x70 proc call, 0x80 block, 0x90 local, 0xA0..0xBF operators, 0xC0.. small ints.
//
// Two dialects (FORMATS): MGS4 / MGO2 / MGA options carry a 3-byte strcode after the letter; MGS3 / MGO1 (PS2, and
// the PS3 HD port) options are the letter alone, as in MGS2's gclconv; their option nodes have code null. The HD port
// prefixes each file with the magic "LCGB". Everything else (container, sizes, values, commands) is the same.
// Peace Walker (PS3 HD) names its procs: after the proc table come one 24-bit name hash per entry (sorted, the table is
// in name order) and a second 0xFFFFFFFF; calls and PROCID literals hold that 3-byte name hash instead of the 2-byte
// proc number. Such nodes are marked: ['call', sw, hash, [nodes], short, 'hash'], ['lit', 8, hash, 'hash'].
//
// Nodes are arrays whose first item is the kind (same shapes as the Python tuples):
//   ['lit', type, value] ['str', Uint8Array] ['arr', code, index] ['end'] ['small', v] ['var', code, [idx]]
//   ['arg', n, Uint8Array raw] ['local', byte] ['op', byte] ['expr', sw, [nodes], short]
//   ['opt', sw, letter, code | null, [nodes], short] ['cmd', sw, code, asw, [args], [rest], short, args_short]
//   ['call', sw, proc, [nodes], short] ['block', sw, [nodes], short]
// The 12-byte vector literal (type 5) keeps its value as a BigInt.

class GcxError extends Error {}

// names from MGS2's gclconv.h: 1 SHORT, 2 BYTE, 3 CHAR, 4 BOOL, 5 VECTOR, 6 STRID, 8 PROCID, 9 INT, 10 SYMBOL, 14 STRRES
const LIT_SIZE = { 1: 2, 2: 1, 3: 1, 4: 1, 5: 12, 6: 3, 8: 2, 9: 4, 10: 4, 14: 2 };

const hex = (n) => '0x' + n.toString(16);

/** Script dialects. optionCode: options carry a 3-byte strcode after their letter. */
const FORMATS = {
  mgs4: { name: 'mgs4', optionCode: true },     // MGS4, MGO2, Metal Gear Arcade
  mgs3: { name: 'mgs3', optionCode: false },    // MGS3 / MGO1 (PS2), MGS3 HD (PS3)
  pw: { name: 'pw', optionCode: true, procHash: true },   // Peace Walker (PS3 HD): procs called by name hash
};
/** First bytes of MGS3 HD (PS3) scripts, before the usual GCX header. */
const HD_MAGIC = new Uint8Array([0x4C, 0x43, 0x47, 0x42]);   // "LCGB"
/** Header timestamps (compile dates) before 2007 are MGS3-era: PS2 0x4371BEDB (Nov 2005), HD 0x43D5..0x43E6 (2006);
 *  MGS4 / MGO2 are 0x47DE35CA and later (2008+). Used only to pick which dialect to try first. */
const MGS3_TIMESTAMP_BEFORE = 0x46000000;

function readSize(b, p) {
  const n = b[p] & 0xF;
  if (n === 13) return [b[p + 1], p + 2, 1];
  if (n === 14) return [b[p + 1] | b[p + 2] << 8, p + 3, 2];
  if (n === 15) return [b[p + 1] | b[p + 2] << 8 | b[p + 3] << 16, p + 4, 3];
  return [n, p + 1, 0];
}

function readShortSize(b, p) {
  const v = b[p];
  if (v & 0x80) return [(v << 8 & 0x7F00) | b[p + 1], p + 2, 1];
  return [v, p + 1, 0];
}

function le(b, p, k) {
  let v = 0;
  for (let i = k - 1; i >= 0; i--) v = v * 256 + b[p + i];
  return v;
}

function parseValue(b, p, fmt = FORMATS.mgs4) {
  if (p >= b.length) throw new GcxError('read past end at ' + hex(p));
  const t = b[p], hi = t & 0xF0;
  if (t >= 0xC0) return [['small', (t & 0x3F) - 1], p + 1];
  if (hi === 0) {
    p += 1;
    if (t === 0) return [['end'], p];
    if (t === 7) { const n = b[p]; return [['str', b.slice(p + 1, p + 1 + n)], p + 1 + n]; }
    if (t === 13) return [['arr', b[p] | b[p + 1] << 8 | b[p + 2] << 16, b[p + 3]], p + 4];
    if (t === 8 && fmt.procHash) return [['lit', 8, b[p] | b[p + 1] << 8 | b[p + 2] << 16, 'hash'], p + 3];
    if (LIT_SIZE[t] !== undefined) {
      const k = LIT_SIZE[t];
      if (t === 5) {
        let v = 0n;
        for (let i = k - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[p + i]);
        return [['lit', 5, v], p + k];
      }
      let v = le(b, p, k);
      if (t === 1 && v & 0x8000) v -= 0x10000;
      if (t === 9 && v >= 0x80000000) v -= 0x100000000;
      return [['lit', t, v], p + k];
    }
    throw new GcxError('unknown literal type ' + hex(t) + ' at ' + hex(p - 1));
  }
  if (hi === 0x10 || hi === 0x20) {
    const code = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    p += 4;
    const idx = [];
    if (hi === 0x20) for (let i = 0; i < 2; i++) { const r = parseValue(b, p, fmt); idx.push(r[0]); p = r[1]; }
    return [['var', code, idx], p];
  }
  if (hi === 0x40) {
    if ((t & 0xF) === 15) return [['arg', b[p + 1] + 15, b.slice(p, p + 2)], p + 2];
    return [['arg', t & 0xF, b.slice(p, p + 1)], p + 1];
  }
  if (hi === 0x90) return [['local', t], p + 1];
  if (t >= 0xA0 && t < 0xC0) return [['op', t], p + 1];
  const [size, q, sw] = readSize(b, p);
  const end = q + size;
  if (end > b.length) throw new GcxError('block past end at ' + hex(p));
  if (hi === 0x30) { const [body, short, e] = parseBody(b, q, end, fmt); return [['expr', sw, body, short], e]; }
  if (hi === 0x50) {
    if (!fmt.optionCode) { const [body, short, e] = parseBody(b, q + 1, end, fmt); return [['opt', sw, b[q], null, body, short], e]; }
    const [body, short, e] = parseBody(b, q + 4, end, fmt);
    return [['opt', sw, b[q], b[q + 1] | b[q + 2] << 8 | b[q + 3] << 16, body, short], e];
  }
  if (hi === 0x60) {
    const code = b[q] | b[q + 1] << 8 | b[q + 2] << 16;
    const [an, r, asw] = readShortSize(b, q + 3);
    const [args, ashort, r2] = parseBody(b, r, r + an, fmt);
    const [body, short, e] = parseBody(b, r2, end, fmt);
    return [['cmd', sw, code, asw, args, body, short, ashort], e];
  }
  if (hi === 0x70) {
    if (fmt.procHash) { const [body, short, e] = parseBody(b, q + 3, end, fmt); return [['call', sw, b[q] | b[q + 1] << 8 | b[q + 2] << 16, body, short, 'hash'], e]; }
    const [body, short, e] = parseBody(b, q + 2, end, fmt); return [['call', sw, b[q] | b[q + 1] << 8, body, short], e];
  }
  if (hi === 0x80) { const [body, short, e] = parseBody(b, q, end, fmt); return [['block', sw, body, short], e]; }
  throw new GcxError('unknown tag ' + hex(t) + ' at ' + hex(p));
}

function parseSeq(b, p, end, fmt = FORMATS.mgs4) {
  const out = [];
  while (p < end) { const r = parseValue(b, p, fmt); out.push(r[0]); p = r[1]; }
  if (p !== end) throw new GcxError('sequence overran its block (' + hex(p) + ' > ' + hex(end) + ')');
  return out;
}

// the last item may run past the declared end (the original compiler declares a few switch cases / ifs one byte short)
function parseBody(b, p, end, fmt) {
  const out = [];
  while (p < end) { const r = parseValue(b, p, fmt); out.push(r[0]); p = r[1]; }
  return [out, p - end, p];
}

// ---------------------------------------------------------------------------------------------------- build
class Buf {
  constructor() { this.a = new Uint8Array(256); this.n = 0; }
  need(k) { if (this.n + k > this.a.length) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const x = new Uint8Array(m); x.set(this.a.subarray(0, this.n)); this.a = x; } }
  byte(v) { this.need(1); this.a[this.n++] = v & 0xFF; }
  bytes(u) { this.need(u.length); this.a.set(u, this.n); this.n += u.length; }
  le(v, k) { this.need(k); for (let i = 0; i < k; i++) { this.a[this.n++] = v & 0xFF; v = Math.floor(v / 256); } }
  u32(v) { this.le(v >>> 0, 4); }
  out() { return this.a.slice(0, this.n); }
}

const need = (n) => n <= 12 ? 0 : n < 0x100 ? 1 : n < 0x10000 ? 2 : 3;

function putSize(out, n, sw, tag) {
  if (n < 0) throw new GcxError('negative block size');
  sw = Math.max(sw, need(n));
  if (sw === 0) { out.byte(tag | n); return; }
  out.byte(tag | (12 + sw)); out.le(n, sw);
}

function putShortSize(out, n, asw) {
  if (n > 0x7FFF) throw new GcxError('command argument list too long (' + n + ' bytes)');
  if (asw || n > 0x7F) { out.byte(0x80 | n >> 8); out.byte(n & 0xFF); } else out.byte(n);
}

function buildValue(v) { const o = new Buf(); writeValue(o, v); return o.out(); }
function buildSeq(vs) { const o = new Buf(); for (const v of vs) writeValue(o, v); return o.out(); }

function writeValue(o, v) {
  const k = v[0];
  switch (k) {
    case 'small': o.byte(0xC0 | (v[1] + 1)); return;
    case 'end': o.byte(0); return;
    case 'str':
      if (v[1].length > 255) throw new GcxError('string longer than 254 bytes');
      o.byte(7); o.byte(v[1].length); o.bytes(v[1]); return;
    case 'arr': o.byte(13); o.le(v[1], 3); o.byte(v[2]); return;
    case 'lit': {
      const n = LIT_SIZE[v[1]];
      if (n === undefined) throw new GcxError('unknown literal type ' + v[1]);
      o.byte(v[1]);
      if (v[1] === 8 && v[3] === 'hash') { o.le(v[2] & 0xFFFFFF, 3); return; }      // Peace Walker proc name hash
      if (v[1] === 5) { let x = BigInt.asUintN(96, BigInt(v[2])); for (let i = 0; i < 12; i++) { o.byte(Number(x & 0xFFn)); x >>= 8n; } return; }
      let x = v[2];
      const mod = 2 ** (8 * n);
      x = ((x % mod) + mod) % mod;
      o.le(x, n); return;
    }
    case 'var': {
      const c = v[1] >>> 0;
      o.byte(c >>> 24); o.byte(c >>> 16); o.byte(c >>> 8); o.byte(c);
      for (const i of v[2]) writeValue(o, i);
      return;
    }
    case 'arg': o.bytes(v[2]); return;
    case 'local': case 'op': o.byte(v[1]); return;
    case 'expr': { const body = buildSeq(v[2]); putSize(o, body.length - v[3], v[1], 0x30); o.bytes(body); return; }
    case 'opt': {
      const b = new Buf(); b.byte(v[2]); if (v[3] !== null) b.le(v[3], 3); for (const x of v[4]) writeValue(b, x);
      const body = b.out(); putSize(o, body.length - v[5], v[1], 0x50); o.bytes(body); return;
    }
    case 'cmd': {
      const args = buildSeq(v[4]);
      const b = new Buf(); b.le(v[2], 3); putShortSize(b, args.length - v[7], v[3]); b.bytes(args);
      for (const x of v[5]) writeValue(b, x);
      const body = b.out(); putSize(o, body.length - v[6], v[1], 0x60); o.bytes(body); return;
    }
    case 'call': {
      const b = new Buf(); if (v[5] === 'hash') b.le(v[2] & 0xFFFFFF, 3); else b.le(v[2] & 0xFFFF, 2); for (const x of v[3]) writeValue(b, x);
      const body = b.out(); putSize(o, body.length - v[4], v[1], 0x70); o.bytes(body); return;
    }
    case 'block': { const body = buildSeq(v[2]); putSize(o, body.length - v[3], v[1], 0x80); o.bytes(body); return; }
  }
  throw new GcxError('unknown node ' + k);
}

function lcgXor(data, seed) {
  const out = new Uint8Array(data);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 0x7D2B89DD) + 0xCF9) >>> 0;
    out[i] ^= (s >>> 15) & 0xFF;
  }
  return out;
}

/** Peace Walker layout: after the proc table, one sorted 24-bit name hash per entry and a second terminator. */
function hasProcNames(d) {
  if (d.length < 12) return false;
  let o = 4, n = 0;
  while (o + 4 <= d.length && u32At(d, o) !== 0xFFFFFFFF) { o += 4; n++; if (n > 0x40000) return false; }
  o += 4;
  if (o + 4 * n + 4 > d.length) return false;
  for (let i = 0; i < n; i++) {
    const h = u32At(d, o + 4 * i);
    if (h > 0xFFFFFF || (i && h <= u32At(d, o + 4 * i - 4))) return false;
  }
  return u32At(d, o + 4 * n) === 0xFFFFFFFF;
}

const u32At = (d, o) => {
  if (o + 4 > d.length) throw new GcxError('file too short (offset ' + hex(o) + ')');
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
};

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------- container
// fields: format ('mgs4' | 'mgs3' | 'pw'), procNames (Peace Walker: one name hash per table entry), magic (Uint8Array: "LCGB" on MGS3 HD files, else empty), timestamp, seed,
// extraHeader, procPad, trailer, font (Uint8Array); slots [[gap, block]] (procs in physical
// order); table [[flags, slot]] (the proc table; @procN runs entry N-1); main (block); resources [[flag, bytes]];
// resRaw [offsets, data] when the original resource layout was not sequential.
class Gcx {
  constructor() {
    this.format = 'mgs4'; this.magic = new Uint8Array(0); this.procNames = null;
    this.timestamp = 0; this.seed = 0;
    this.extraHeader = new Uint8Array(0); this.procPad = new Uint8Array(0); this.trailer = new Uint8Array(0);
    this.font = new Uint8Array(0); this.slots = []; this.table = []; this.main = null; this.resources = []; this.resRaw = null;
  }

  /** Parse a GCX. opts.format ('mgs4' | 'mgs3') forces a dialect; otherwise it is detected: the HD magic means MGS3,
   *  else the header timestamp picks the first dialect to try, and the other one is tried if that fails. */
  static parse(data, opts = {}) {
    let magic = new Uint8Array(0);
    if (data.length >= 4 && bytesEqual(data.subarray(0, 4), HD_MAGIC)) { magic = data.slice(0, 4); data = data.subarray(4); }
    if (opts.format) {
      if (!FORMATS[opts.format]) throw new GcxError('unknown script format ' + JSON.stringify(opts.format));
      return Gcx.parseAs(data, FORMATS[opts.format], magic);
    }
    if (!magic.length && hasProcNames(data)) return Gcx.parseAs(data, FORMATS.pw, magic);
    const first = magic.length || u32At(data, 0) < MGS3_TIMESTAMP_BEFORE ? FORMATS.mgs3 : FORMATS.mgs4;
    const second = first === FORMATS.mgs3 ? FORMATS.mgs4 : FORMATS.mgs3;
    try { return Gcx.parseAs(data, first, magic); }
    catch (e) {
      if (!(e instanceof GcxError)) throw e;
      try { return Gcx.parseAs(data, second, magic); } catch (e2) { throw e; }
    }
  }

  static parseAs(data, fmt, magic = new Uint8Array(0)) {
    const g = new Gcx();
    g.format = fmt.name; g.magic = magic;
    g.timestamp = u32At(data, 0);
    const table = [];
    let o = 4;
    while (u32At(data, o) !== 0xFFFFFFFF) {
      table.push(u32At(data, o)); o += 4;
      if (o > 0x100000) throw new GcxError('no proc table terminator');
    }
    let blk = o + 4;
    if (fmt.procHash) {                      // Peace Walker: name hash per entry, then a second terminator
      g.procNames = table.map((_, i) => u32At(data, blk + 4 * i));
      blk += 4 * table.length;
      if (u32At(data, blk) !== 0xFFFFFFFF) throw new GcxError('no proc name table terminator');
      blk += 4;
    }
    const [procArea, resTab, strData, font, seed] = [0, 1, 2, 3, 4].map(i => u32At(data, blk + 4 * i));
    if (!(resTab <= strData && strData <= font && font <= procArea && blk + procArea < data.length))
      throw new GcxError('bad block header (encrypted file?)');
    g.seed = seed;
    g.extraHeader = data.slice(blk + 20, blk + resTab);
    let sd = data.slice(blk + strData, blk + font);
    if (seed) sd = lcgXor(sd, seed);
    const offs = [];
    for (let i = 0; i < Math.floor((strData - resTab) / 4); i++) offs.push(u32At(data, blk + resTab + 4 * i));
    const plain = offs.map(x => x & 0x7FFFFFFF);
    let sequential = plain.length === 0 || plain[0] === 0;
    for (let i = 1; i < plain.length && sequential; i++) if (plain[i] < plain[i - 1]) sequential = false;
    const bounds = [...new Set(plain)].sort((a, b) => a - b);
    bounds.push(sd.length);
    const nxt = new Map();
    for (let i = 0; i + 1 < bounds.length; i++) nxt.set(bounds[i], bounds[i + 1]);
    g.resources = offs.map(x => { const a = x & 0x7FFFFFFF; return [x >>> 31, sd.slice(a, nxt.get(a))]; });
    if (!sequential) g.resRaw = [offs, sd];
    g.font = data.slice(blk + font, blk + procArea);
    const pa = blk + procArea;
    const mainOff = u32At(data, pa);
    const pb = pa + 4;
    const starts = [...new Set(table.map(t => t & 0xFFFFFF))].sort((a, b) => a - b);
    let pos = 0;
    for (const a of starts) {
      if (a < pos) throw new GcxError('overlapping procs');
      const [v, end] = parseValue(data, pb + a, fmt);
      if (v[0] !== 'block') throw new GcxError('proc is not a block');
      g.slots.push([data.slice(pb + pos, pb + a), v]); pos = end - pb;
    }
    const slotOf = new Map(starts.map((a, i) => [a, i]));
    g.table = table.map(t => [t >>> 24, slotOf.get(t & 0xFFFFFF)]);
    if (mainOff < pos) throw new GcxError('main script overlaps procs');
    g.procPad = data.slice(pb + pos, pb + mainOff);
    const m = pb + mainOff;
    const [main, mend] = parseValue(data, m + 4, fmt);
    g.main = main;
    g.trailer = data.slice(mend);
    return g;
  }

  build() {
    const body = new Buf(); const at = [];
    for (const [gap, node] of this.slots) { body.bytes(gap); at.push(body.n); writeValue(body, node); }
    const table = this.table.map(([flags, slot]) => (at[slot] | flags << 24) >>> 0);
    body.bytes(this.procPad);
    const main = buildValue(this.main);
    const bodyBytes = body.out();
    let offs, sd;
    if (this.resRaw) { [offs, sd] = this.resRaw; }
    else {
      const s = new Buf(); offs = [];
      for (const [flag, b] of this.resources) { offs.push((s.n | flag << 31) >>> 0); s.bytes(b); }
      sd = s.out();
    }
    if (this.seed) sd = lcgXor(sd, this.seed);
    const resTab = 20 + this.extraHeader.length;
    const strData = resTab + 4 * offs.length;
    const font = strData + sd.length;
    const procOff = font + this.font.length;
    const out = new Buf();
    out.bytes(this.magic);
    out.u32(this.timestamp);
    for (const t of table) out.u32(t);
    out.u32(0xFFFFFFFF);
    if (this.procNames) { for (const h of this.procNames) out.u32(h); out.u32(0xFFFFFFFF); }
    for (const x of [procOff, resTab, strData, font, this.seed]) out.u32(x);
    out.bytes(this.extraHeader);
    for (const x of offs) out.u32(x);
    out.bytes(sd); out.bytes(this.font);
    out.u32(bodyBytes.length); out.bytes(bodyBytes); out.u32(main.length); out.bytes(main); out.bytes(this.trailer);
    return out.out();
  }
}

module.exports = { Gcx, GcxError, parseValue, parseSeq, buildValue, buildSeq, lcgXor, bytesEqual, LIT_SIZE, FORMATS, HD_MAGIC };
