'use strict';
// GCL text <-> GCX node trees. JavaScript port of gclc's gcltext.py (same text format, same output).
//
//   proc 3 7:1 { ... }        procs 3 and 7 (flags 1) are this body; @proc3 calls it (ids are 1-based)
//   main { ... }
//   command args... -option values...      (\ continues a line)
//   if (..) { } else if (..) { } else { }   switch (..) { case X { } default { } }
// Values: numbers (canonical encoding; 5:u16 / 5:s32 ... keep explicit types), names / [hash] / [hash/Label],
// name[3], "utf-8" e"euc-jp" b"bytes", $res:N, $status, $argN, $localN, $TYPE@REGION:OFF[.bN], p:procN, vec:a,b,c,
// { block }, ( expr ), ; (end marker), @procN(args), !( statement ), . value, %(...) encoding annotations.

const { buildSeq, parseSeq, LIT_SIZE } = require('./gcx');

const OPS = { 1: '-', 2: '!', 3: '~', 4: '+', 5: '-', 6: '*', 7: '/', 8: '%', 9: '<<', 10: '>>', 11: '==', 12: '!=',
  13: '<', 14: '<=', 15: '>', 16: '>=', 17: '|', 18: '&', 19: '^', 20: '||', 21: '&&', 22: '=' };
const UNARY = new Set([1, 2, 3]);
const BINOP = {}; for (const [k, v] of Object.entries(OPS)) if (!UNARY.has(+k)) BINOP[v] = +k;
const UNOP = { '-': 1, '!': 2, '~': 3 };
const VTYPE = { 1: 's16', 2: 'u8', 3: 'u8b', 4: 'bit', 6: 'h32', 8: 'u24', 9: 's32' };
const VTYPE_R = {}; for (const [k, v] of Object.entries(VTYPE)) VTYPE_R[v] = +k;
const REGION = { 0: 'var', 8: 'link', 1: 'local' };
const REGION_R = {}; for (const [k, v] of Object.entries(REGION)) REGION_R[v] = +k;
const LTYPE = { 1: 's16', 2: 'u8', 3: 'char', 4: 'bool', 8: 'u16', 9: 's32', 10: 'sym' };
const LTYPE_R = {}; for (const [k, v] of Object.entries(LTYPE)) LTYPE_R[v] = +k;
Object.assign(LTYPE_R, { u8b: 3, u8c: 4, u32: 10 });                 // older gclc spellings
const KW_IF = 0xD86, KW_SWITCH = 0xA65DB5;                            // strcode('if'), strcode('switch')
const OPT_I = 0x69, OPT_E = 0x65, OPT_C = 0x63, OPT_D = 0x64;           // i / e / c / d with code strcode(letter)
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set(['proc', 'main', 'gcx', 'pad']);

function strcode(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) {
    const c = typeof s === 'string' ? s.charCodeAt(i) & 0xFF : s[i];
    x = ((x >>> 19) | (x << 5)) & 0xFFFFFF;
    x = (x + c) & 0xFFFFFF;
  }
  return x || 1;
}

function canonicalNumber(v) {
  if (v >= -1 && v <= 62) return ['small', v];
  if (v >= 0 && v <= 255) return ['lit', 2, v];
  if (v >= -0x8000 && v <= 0x7FFF) return ['lit', 1, v];
  if (v >= -0x80000000 && v <= 0x7FFFFFFF) return ['lit', 9, v];
  return ['lit', 10, ((v % 0x100000000) + 0x100000000) % 0x100000000];
}

const h6 = (h) => h.toString(16).padStart(6, '0');
const h2 = (b) => b.toString(16).padStart(2, '0');
const toHex = (u) => Array.from(u, h2).join('');
function fromHex(s) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new ParseError('bad hex data');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
  return out;
}

class Names {
  // hash -> printable name (only names whose strcode is the hash), hash -> label (e.g. handler names)
  constructor(words = [], labels = new Map()) {
    this.by = new Map();
    for (const w of words) if (IDENT.test(w) && !KEYWORDS.has(w) && !/^[0-9]/.test(w)) { const h = strcode(w); if (!this.by.has(h)) this.by.set(h, w); }
    this.labels = labels;
  }
  word(h) {
    const n = this.by.get(h);
    return n ? n : '[' + h6(h) + (this.labels.has(h) ? '/' + this.labels.get(h) : '') + ']';
  }
  option(letter, code) {
    const c = letter > 32 && letter < 127 ? String.fromCharCode(letter) : null;
    if (c && /[A-Za-z]/.test(c)) {
      if (strcode(c) === code) return '-' + c;
      const n = this.by.get(code);
      if (n && n[0] === c) return '-' + n;
      return '-' + c + '[' + h6(code) + ']';
    }
    return '-\\x' + h2(letter) + '[' + h6(code) + ']';
  }
}

// ---------------------------------------------------------------------------------------------------- strings
const UTF8 = new TextDecoder('utf-8', { fatal: true });
let EUC_DEC = null, EUC_ENC = null;
function eucTables() {
  if (EUC_ENC) return;
  try { EUC_DEC = new TextDecoder('euc-jp', { fatal: true }); } catch (e) { EUC_DEC = null; EUC_ENC = new Map(); return; }
  EUC_ENC = new Map();
  const add = (bytes) => {
    let s; try { s = EUC_DEC.decode(Uint8Array.from(bytes)); } catch (e) { return; }
    if ([...s].length === 1 && !EUC_ENC.has(s)) EUC_ENC.set(s, bytes);
  };
  for (let a = 0xA1; a <= 0xFE; a++) for (let b = 0xA1; b <= 0xFE; b++) add([a, b]);
  for (let b = 0xA1; b <= 0xDF; b++) add([0x8E, b]);
  for (let a = 0xA1; a <= 0xFE; a++) for (let b = 0xA1; b <= 0xFE; b++) add([0x8F, a, b]);
}
function eucEncode(s) {
  eucTables();
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); continue; }
    const b = EUC_ENC.get(ch);
    if (!b) return null;
    out.push(...b);
  }
  return Uint8Array.from(out);
}
function eucDecode(b) { eucTables(); if (!EUC_DEC) return null; try { return EUC_DEC.decode(b); } catch (e) { return null; } }

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
const printable = (s) => { for (const ch of s) { if (ch < ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') return false; } return true; };

function strText(b) {
  if (b.length && b[b.length - 1] === 0) {
    const body = b.subarray(0, b.length - 1);
    if (!body.includes(0)) {
      let s = null; try { s = UTF8.decode(body); } catch (e) { s = null; }
      if (s !== null && printable(s)) return '"' + esc(s) + '"';
      s = eucDecode(body);
      if (s !== null && printable(s)) { const r = eucEncode(s); if (r && r.length === body.length && r.every((x, i) => x === body[i])) return 'e"' + esc(s) + '"'; }
    }
  }
  let o = 'b"';
  for (const c of b) o += (c >= 32 && c < 127 && c !== 34 && c !== 92) ? String.fromCharCode(c) : '\\x' + h2(c);
  return o + '"';
}

function unescape(s, enc) {
  const out = [];
  const put = (str) => {
    if (enc === 'latin1') { for (const ch of str) { const c = ch.codePointAt(0); if (c > 255) throw new ParseError('b"" strings take bytes; use \\x escapes'); out.push(c); } }
    else if (enc === 'euc-jp') { const r = eucEncode(str); if (!r) throw new ParseError('character not in EUC-JP: ' + str); out.push(...r); }
    else out.push(...new TextEncoder().encode(str));
  };
  let i = 0, run = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      put(run); run = '';
      const n = s[i + 1];
      if (n === 'x') { out.push(parseInt(s.substr(i + 2, 2), 16)); i += 4; continue; }
      const m = { n: 10, t: 9, r: 13, '\\': 92, '"': 34 }[n];
      if (m === undefined) throw new ParseError('unknown escape \\' + n);
      out.push(m); i += 2; continue;
    }
    run += c; i++;
  }
  put(run);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------------- sizes
const need = (n) => n <= 12 ? 0 : n < 0x100 ? 1 : n < 0x10000 ? 2 : 3;
const LEN = new WeakMap();      // node -> encoded length (cached; nodes are not mutated after construction)
function nodeLen(v) {
  let L = LEN.get(v);
  if (L !== undefined) return L;
  const k = v[0];
  const sum = (a) => { let s = 0; for (const x of a) s += nodeLen(x); return s; };
  switch (k) {
    case 'small': case 'end': case 'local': case 'op': L = 1; break;
    case 'str': L = 2 + v[1].length; break;
    case 'arr': L = 5; break;
    case 'lit': L = 1 + LIT_SIZE[v[1]]; break;
    case 'var': L = 4 + sum(v[2]); break;
    case 'arg': L = v[2].length; break;
    default: {
      const body = bodyLen(v);
      const sh = shortOf(v);
      L = 1 + Math.max(v[1], need(body - sh)) + body;
    }
  }
  LEN.set(v, L);
  return L;
}
function argsLen(v) { let s = 0; for (const x of v[4]) s += nodeLen(x); return s; }
function bodyLen(v) {
  const sum = (a) => { let s = 0; for (const x of a) s += nodeLen(x); return s; };
  switch (v[0]) {
    case 'expr': case 'block': return sum(v[2]);
    case 'opt': return 4 + sum(v[4]);
    case 'call': return 2 + sum(v[3]);
    case 'cmd': { const al = argsLen(v); return 3 + ((v[3] || al - v[7] > 0x7F) ? 2 : 1) + al + sum(v[5]); }
  }
  throw new Error('not a container: ' + v[0]);
}
function shortOf(v) { return { expr: v[3], opt: v[5], cmd: v[6], call: v[4], block: v[3] }[v[0]]; }

// ---------------------------------------------------------------------------------------------------- emitter
const stripEnd = (seq) => (seq.length && seq[seq.length - 1][0] === 'end') ? seq.slice(0, -1) : seq;
function balancedOuter(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') { d--; if (d === 0 && i !== s.length - 1) return false; }
  }
  return true;
}
const rawEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

class Emitter {
  constructor(names, indent = '    ') { this.n = names; this.ind = indent; }

  ann(v, bodySeq) {
    const a = [];
    const declared = bodyLen(v) - shortOf(v);
    if (v[1] !== need(declared)) a.push('w=' + v[1]);
    if (shortOf(v)) a.push('short=' + shortOf(v));
    if (v[0] === 'cmd') {
      if (v[3] && argsLen(v) - v[7] <= 0x7F) a.push('aw=1');
      if (v[7]) a.push('ashort=' + v[7]);
    }
    if (bodySeq !== undefined) { const ends = bodySeq.length > 0 && bodySeq[bodySeq.length - 1][0] === 'end'; if (!ends) a.push('noend'); }
    return a.length ? '%(' + a.join(',') + ')' : '';
  }

  value(v, depth) {
    const k = v[0];
    if (k === 'small') return String(v[1]);
    if (k === 'lit') {
      const t = v[1], x = v[2];
      if (t === 6) return this.n.word(x);
      if (t === 14) return '$res:' + x;
      if (t === 8) return 'p:proc' + x;
      if (t === 5) {
        const sg = (u) => Number(BigInt.asIntN(32, u));
        return 'vec:' + sg(x & 0xFFFFFFFFn) + ',' + sg((x >> 32n) & 0xFFFFFFFFn) + ',' + sg((x >> 64n) & 0xFFFFFFFFn);
      }
      const c = canonicalNumber(x);
      if (c[0] === v[0] && c[1] === v[1] && (c.length < 3 || c[2] === v[2])) return String(x);
      return x + ':' + LTYPE[t];
    }
    if (k === 'end') return ';';
    if (k === 'str') return strText(v[1]);
    if (k === 'arr') return this.n.word(v[1]) + '[' + v[2] + ']';
    if (k === 'arg') {
      const n = v[1];
      const canon = n < 15 ? [0x40 | n] : [0x4F, n - 15];
      const isCanon = rawEq(Array.from(v[2]), canon);
      if (n === 0 && isCanon) return '$status';
      return isCanon ? '$arg' + n : '$arg' + n + ':raw' + toHex(v[2]);
    }
    if (k === 'local') return '$local' + (v[1] & 0xF);
    if (k === 'var') return this.var(v, depth);
    if (k === 'op') return 'op:' + h2(v[1]);
    if (k === 'block') return this.ann(v, v[2]) + this.block(v[2], depth);
    if (k === 'expr') return this.ann(v) + this.expr(v[2], depth);
    if (k === 'call') return this.ann(v, v[3]) + '@proc' + v[2] + '(' + this.values(stripEnd(v[3]), depth) + ')';
    if (k === 'cmd') return '!(' + this.statement(v, depth).trim() + ')';
    if (k === 'opt') return '!(' + this.option(v, depth) + ')';
    throw new Error('unknown node ' + k);
  }

  values(seq, depth) { return seq.map(x => this.value(x, depth)).join(' '); }

  var(v, depth) {
    const code = v[1] >>> 0;
    const tag = code >>> 28, typ = code >>> 24 & 0xF, region = code >>> 20 & 0xF, bit = code >>> 16 & 0xF, off = code & 0xFFFF;
    let s = '$' + (tag === 2 ? 'arr.' : tag === 1 ? '' : 'tag' + tag + '.') + (VTYPE[typ] || 't' + typ) + '@' +
      (REGION[region] !== undefined ? REGION[region] : 'r' + region) + ':' + off.toString(16);
    if (bit) s += '.b' + bit;
    if (v[2].length) s += ' ' + this.values(v[2], depth);
    return s;
  }

  expr(seq, depth) {
    const st = [];
    let ok = seq.length > 0 && seq[seq.length - 1][0] === 'op' && seq[seq.length - 1][1] === 0xA0;
    if (ok) {
      for (const x of seq.slice(0, -1)) {
        if (x[0] === 'op') {
          const o = x[1] & 0x1F;
          if (x[1] > 0xB6 || o === 0 || OPS[o] === undefined) { ok = false; break; }
          if (UNARY.has(o)) { if (!st.length) { ok = false; break; } st.push('(' + OPS[o] + ' ' + st.pop() + ')'); }
          else { if (st.length < 2) { ok = false; break; } const b = st.pop(), a = st.pop(); st.push('(' + a + ' ' + OPS[o] + ' ' + b + ')'); }
        } else {
          let t = this.value(x, depth);
          if (x[0] === 'expr') t = '$' + t;
          st.push(t);
        }
      }
      ok = ok && st.length === 1;
    }
    if (ok) { const s = st[0]; return (s.startsWith('(') && balancedOuter(s)) ? s : '(' + s + ')'; }
    return '%(rpn)(' + seq.map(x => x[0] === 'op' ? 'op:' + h2(x[1]) : this.value(x, depth)).join(' ') + ')';
  }

  option(v, depth) {
    const vals = this.values(v[4], depth);
    return this.ann(v) + this.n.option(v[2], v[3]) + (vals ? ' ' + vals : '');
  }

  sugar(v, depth) {
    const pad = this.ind.repeat(depth);
    const opts = stripEnd(v[5]);
    if (opts.some(o => o[0] !== 'opt')) return null;
    const head = this.ann(v, v[5]);
    if (v[2] === KW_IF) {
      const args = v[4];
      if (args.length !== 2 || args[0][0] !== 'expr' || args[1][0] !== 'block' || v[3] || v[7]) return null;
      let out = pad + head + 'if ' + this.value(args[0], depth) + ' ' + this.value(args[1], depth);
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i], a = this.ann(o);
        if (o[2] === 0x69 && o[3] === OPT_I && o[4].length === 2 && o[4][0][0] === 'expr' && o[4][1][0] === 'block')
          out += ' ' + a + 'else if ' + this.value(o[4][0], depth) + ' ' + this.value(o[4][1], depth);
        else if (o[2] === 0x65 && o[3] === OPT_E && o[4].length === 1 && o[4][0][0] === 'block' && i === opts.length - 1)
          out += ' ' + a + 'else ' + this.value(o[4][0], depth);
        else return null;
      }
      return out;
    }
    if (v[2] === KW_SWITCH) {
      if (v[4].length !== 1 || v[3] || v[7]) return null;
      const lines = [pad + head + 'switch ' + this.value(v[4][0], depth) + ' {'];
      for (const o of opts) {
        const a = this.ann(o);
        if (o[2] === 0x63 && o[3] === OPT_C && o[4].length === 2 && o[4][1][0] === 'block')
          lines.push(pad + this.ind + a + 'case ' + this.value(o[4][0], depth + 1) + ' ' + this.value(o[4][1], depth + 1));
        else if (o[2] === 0x64 && o[3] === OPT_D && o[4].length === 1 && o[4][0][0] === 'block')
          lines.push(pad + this.ind + a + 'default ' + this.value(o[4][0], depth + 1));
        else return null;
      }
      return lines.join('\n') + '\n' + pad + '}';
    }
    return null;
  }

  statement(v, depth) {
    const pad = this.ind.repeat(depth);
    const k = v[0];
    if (k === 'cmd') {
      const sg = this.sugar(v, depth);
      if (sg !== null) return sg;
      const head = this.ann(v, v[5]) + this.n.word(v[2]);
      const args = this.values(v[4], depth + 1);
      const line = pad + head + (args ? ' ' + args : '');
      const parts = stripEnd(v[5]).map(o => o[0] === 'opt' ? this.option(o, depth + 1) : '!= ' + this.value(o, depth + 1));
      if (!parts.length) return line;
      return line + ' \\\n' + parts.map(p => pad + this.ind + p).join(' \\\n');
    }
    if (k === 'call') {
      const args = this.values(stripEnd(v[3]), depth + 1);
      return pad + this.ann(v, v[3]) + '@proc' + v[2] + (args ? ' ' + args : '');
    }
    if (k === 'expr') return pad + this.ann(v) + this.expr(v[2], depth);
    if (k === 'end') return pad + ';';
    return pad + '. ' + this.value(v, depth);
  }

  block(seq, depth) {
    const body = stripEnd(seq);
    if (!body.length) return '{}';
    return '{\n' + body.map(x => this.statement(x, depth + 1)).join('\n') + '\n' + this.ind.repeat(depth) + '}';
  }
}

// ---------------------------------------------------------------------------------------------------- tokenizer
class ParseError extends Error {
  constructor(msg, tok) {
    super(msg);
    if (tok) { this.line = tok.line; this.col = tok.col; this.len = Math.max(1, tok.s.length); this.offset = tok.off; }
  }
}

const TOKEN = /([ \t]+|\\\r?\n)|(#[^\n]*)|(\r?\n)|([eb]?"(?:[^"\\\n]|\\.)*")|(%\([^)]*\))|([{}()])|([^\s{}()"]+)/y;
const KINDS = [null, 'ws', 'comment', 'nl', 'str', 'ann', 'punct', 'word'];

function tokenize(text) {
  const out = [];
  let line = 1, lineStart = 0, pos = 0;
  TOKEN.lastIndex = 0;
  while (pos < text.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (!m) {
      const tok = { k: 'bad', s: text.substr(pos, 1), line, col: pos - lineStart + 1, off: pos };
      throw new ParseError('line ' + line + ': unexpected ' + JSON.stringify(text.substr(pos, 10)), tok);
    }
    let kind = 0; for (let i = 1; i < KINDS.length; i++) if (m[i] !== undefined) { kind = i; break; }
    const k = KINDS[kind], s = m[0];
    const tok = { k, s, line, col: pos - lineStart + 1, off: pos };
    if (k === 'ws') { if (s.includes('\n')) { line++; lineStart = pos + s.length; } }
    else if (k === 'nl') { out.push(tok); line++; lineStart = pos + s.length; }
    else if (k !== 'comment') out.push(tok);
    pos += s.length;
  }
  out.push({ k: 'eof', s: '', line, col: pos - lineStart + 1, off: pos });
  return out;
}

// ---------------------------------------------------------------------------------------------------- parser
class Parser {
  constructor(text, names, opts = {}) {
    this.t = tokenize(text); this.i = 0; this.names = names;
    this.onNode = opts.onNode || null;          // (kind, token, info) callback for editors (symbols, references)
  }
  peek(skipNl = false) { let j = this.i; while (skipNl && this.t[j].k === 'nl') j++; return this.t[j]; }
  next() { return this.t[this.i++]; }
  expect(kind, s) {
    const tok = this.next();
    if (tok.k !== kind || (s !== undefined && tok.s !== s))
      throw new ParseError('line ' + tok.line + ': expected ' + (s || kind) + ', got ' + JSON.stringify(tok.s || tok.k), tok);
    return tok;
  }
  skipNl() { while (this.t[this.i].k === 'nl') this.i++; }
  err(msg, tok) { tok = tok || this.t[this.i]; throw new ParseError('line ' + tok.line + ': ' + msg, tok); }
  note(kind, tok, info) { if (this.onNode) this.onNode(kind, tok, info); }

  ann() {
    const a = {};
    if (this.peek().k === 'ann') {
      const tok = this.next();
      for (const item of tok.s.slice(2, -1).split(',').filter(Boolean)) {
        const [k, v] = item.split('=');
        a[k.trim()] = v !== undefined ? parseInt(v, 10) : true;
        if (v !== undefined && isNaN(a[k.trim()])) this.err('bad annotation ' + item, tok);
      }
    }
    return a;
  }

  hashword(s) {
    const m = /^\[([0-9a-fA-F]+)(?:\/[^\]]*)?\]$/.exec(s);
    if (m) return parseInt(m[1], 16) & 0xFFFFFF;
    if (IDENT.test(s)) return strcode(s);
    return null;
  }

  value(a) {
    a = a !== undefined ? a : this.ann();
    const tok = this.peek();
    const { k, s } = tok;
    if (k === 'punct' && s === '{') return this.block(a);
    if (k === 'punct' && s === '(') {
      if (a.rpn) {
        this.next(); const items = [];
        while (!(this.peek().k === 'punct' && this.peek().s === ')')) {
          const t = this.peek();
          if (t.k === 'eof') this.err('unterminated expression');
          if (t.k === 'word' && t.s.startsWith('op:')) { this.next(); items.push(['op', parseInt(t.s.slice(3), 16)]); }
          else items.push(this.value());
        }
        this.next();
        return this.wrap('expr', a, items);
      }
      return this.wrap('expr', a, this.exprTop());
    }
    if (k === 'str') {
      this.next();
      let b;
      try {
        if (s.startsWith('b')) b = unescape(s.slice(2, -1), 'latin1');
        else if (s.startsWith('e')) b = concat(unescape(s.slice(2, -1), 'euc-jp'), [0]);
        else b = concat(unescape(s.slice(1, -1), 'utf-8'), [0]);
      } catch (e) { this.err(e.message, tok); }
      this.note('string', tok, b.length);
      return ['str', b];
    }
    if (k !== 'word') this.err('expected a value, got ' + JSON.stringify(s || k));
    this.next();
    if (s === ';') return ['end'];
    if (s === '!') {
      this.expect('punct', '(');
      const st = this.isOption(this.peek()) ? this.option() : this.statement();
      this.expect('punct', ')');
      return st;
    }
    let m = /^(-?\d+)(?::(\w+))?$/.exec(s);
    if (m) {
      const v = parseInt(m[1], 10), t = m[2];
      if (!t) return canonicalNumber(v);
      if (t === 'small') return ['small', v];
      if (LTYPE_R[t] === undefined) this.err('unknown number type :' + t, tok);
      return ['lit', LTYPE_R[t], v];
    }
    if (s.startsWith('0x') && /^0x[0-9a-fA-F]+(:\w+)?$/.test(s)) {
      const [x, t] = s.split(':'); const v = parseInt(x, 16);
      if (t && LTYPE_R[t] === undefined) this.err('unknown number type :' + t, tok);
      return t ? ['lit', LTYPE_R[t], v] : canonicalNumber(v);
    }
    m = /^p:(?:proc)?(\d+)$/.exec(s);
    if (m) { this.note('procref', tok, +m[1]); return ['lit', 8, +m[1]]; }
    m = /^vec:(-?\d+),(-?\d+),(-?\d+)$/.exec(s);
    if (m) {
      const [a_, b_, c_] = m.slice(1).map(x => BigInt.asUintN(32, BigInt(x)));
      return ['lit', 5, a_ | (b_ << 32n) | (c_ << 64n)];
    }
    if (s === '$status') return ['arg', 0, Uint8Array.of(0x40)];
    if (s.startsWith('$')) return this.dollar(s, tok);
    if (s.startsWith('@proc')) {
      m = /^@proc(\d+)$/.exec(s);
      if (!m) this.err('bad call ' + s, tok);
      this.note('call', tok, +m[1]);
      this.expect('punct', '(');
      const vals = this.valuesUntil(')');
      this.expect('punct', ')');
      return this.wrap('call', a, +m[1], a.noend ? vals : vals.concat([['end']]));
    }
    if (s.startsWith('op:')) return ['op', parseInt(s.slice(3), 16)];
    m = /^(.*)\[(\d+)\]$/.exec(s);
    if (m && this.hashword(m[1]) !== null) return ['arr', this.hashword(m[1]), +m[2]];
    const h = this.hashword(s);
    if (h !== null) { this.note('word', tok, h); return ['lit', 6, h]; }
    this.err('cannot read value ' + JSON.stringify(s), tok);
  }

  valuesUntil(closer) {
    const out = [];
    for (;;) {
      const t = this.peek(true);
      if (t.k === 'punct' && t.s === closer) { this.skipNl(); return out; }
      if (t.k === 'eof') this.err('missing ' + closer);
      this.skipNl();
      out.push(this.value());
    }
  }

  dollar(s, tok) {
    let m = /^\$res:(\d+)$/.exec(s);
    if (m) { this.note('res', tok, +m[1]); return ['lit', 14, +m[1]]; }
    m = /^\$arg(\d+)(?::raw([0-9a-f]+))?$/.exec(s);
    if (m) {
      const n = +m[1];
      const raw = m[2] ? fromHex(m[2]) : Uint8Array.from(n < 15 ? [0x40 | n] : [0x4F, n - 15]);
      return ['arg', n, raw];
    }
    m = /^\$local(\d+)$/.exec(s);
    if (m) return ['local', 0x90 | +m[1]];
    m = /^\$(arr\.|tag(\d+)\.)?(\w+)@(\w+):([0-9a-fA-F]+)(?:\.b(\d+))?$/.exec(s);
    if (m) {
      const tag = m[1] === 'arr.' ? 2 : m[2] ? +m[2] : 1;
      const typ = VTYPE_R[m[3]] !== undefined ? VTYPE_R[m[3]] : parseInt(m[3].slice(1), 10);
      const reg = REGION_R[m[4]] !== undefined ? REGION_R[m[4]] : parseInt(m[4].slice(1), 10);
      if (isNaN(typ) || isNaN(reg)) this.err('bad variable ' + s, tok);
      const code = ((tag << 28) | (typ << 24) | (reg << 20) | ((+(m[6] || 0)) << 16) | parseInt(m[5], 16)) >>> 0;
      const idx = tag === 2 ? [this.value(), this.value()] : [];
      return ['var', code, idx];
    }
    this.err('unknown $ value ' + JSON.stringify(s), tok);
  }

  wrap(kind, a, ...rest) {
    const sw = a.w || 0, short = a.short || 0;
    if (kind === 'expr') return ['expr', sw, rest[0], short];
    if (kind === 'block') return ['block', sw, rest[0], short];
    if (kind === 'call') return ['call', sw, rest[0], rest[1], short];
    throw new Error(kind);
  }

  exprTop() {
    this.expect('punct', '(');
    const items = this.exprInner();
    this.expect('punct', ')');
    return items.concat([['op', 0xA0]]);
  }

  exprInner() {
    const t = this.peek();
    if (t.k === 'word' && UNOP[t.s] !== undefined && !/^-\d/.test(t.s)) {
      this.next();
      return this.operand().concat([['op', 0xA0 | UNOP[t.s]]]);
    }
    const left = this.operand();
    const o = this.peek();
    if (o.k === 'word' && BINOP[o.s] !== undefined) {
      this.next();
      const right = this.operand();
      return left.concat(right, [['op', 0xA0 | BINOP[o.s]]]);
    }
    return left;
  }

  operand() {
    const t = this.peek();
    if (t.k === 'punct' && t.s === '(') { this.next(); const x = this.exprInner(); this.expect('punct', ')'); return x; }
    if (t.k === 'word' && t.s === '$') { this.next(); const a = this.ann(); return [this.wrap('expr', a, this.exprTop())]; }
    return [this.value()];
  }

  block(a) {
    const open = this.expect('punct', '{');
    const seq = this.statements('}');
    if (this.peek().k !== 'punct' || this.peek().s !== '}') this.err('missing } for the { on line ' + open.line, open);
    this.next();
    if (!a.noend) seq.push(['end']);
    return this.wrap('block', a, seq);
  }

  statements(closer) {
    const out = [];
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if ((closer && t.k === 'punct' && t.s === closer) || t.k === 'eof') return out;
      out.push(this.statement());
    }
  }

  endOfStatement() { const t = this.peek(); return t.k === 'nl' || t.k === 'eof' || (t.k === 'punct' && (t.s === '}' || t.s === ')')); }

  statement() {
    const a = this.ann();
    const t = this.peek();
    if (t.k === 'word' && t.s === ';') { this.next(); return ['end']; }
    if (t.k === 'word' && t.s === '.') { this.next(); return this.value(); }
    if (t.k === 'punct' && t.s === '(') return this.value(a);
    if (t.k === 'word' && /^@proc\d+$/.test(t.s)) {
      this.next();
      this.note('call', t, +t.s.slice(5));
      const vals = [];
      while (!this.endOfStatement()) vals.push(this.value());
      if (!a.noend) vals.push(['end']);
      return ['call', a.w || 0, +t.s.slice(5), vals, a.short || 0];
    }
    if (t.k !== 'word') this.err('expected a statement, got ' + JSON.stringify(t.s || t.k));
    return this.command(a);
  }

  isOption(t) {
    if (t.k === 'word') return /^-(?:[A-Za-z]|\\x[0-9a-f]{2})/.test(t.s);
    if (t.k === 'ann') { const n = this.t[this.i + 1]; return n.k === 'word' && n.s.startsWith('-') && !/^-\d/.test(n.s); }
    return false;
  }

  kwAhead(...words) {
    const j = this.i + (this.t[this.i].k === 'ann' ? 1 : 0);
    return this.t[j].k === 'word' && words.includes(this.t[j].s);
  }

  command(a) {
    const tok = this.next();
    const code = this.hashword(tok.s);
    if (code === null) this.err('bad command name ' + JSON.stringify(tok.s), tok);
    this.note('command', tok, code);
    const args = [], rest = [];
    const done = () => {
      if (!a.noend) rest.push(['end']);
      return ['cmd', a.w || 0, code, a.aw || 0, args, rest, a.short || 0, a.ashort || 0];
    };
    if (code === KW_SWITCH && tok.s === 'switch') {
      args.push(this.value());
      if (this.peek().k === 'punct' && this.peek().s === '{') {
        const open = this.next();
        for (;;) {
          this.skipNl();
          if (this.peek().k === 'punct' && this.peek().s === '}') { this.next(); break; }
          if (this.peek().k === 'eof') this.err('missing } for the switch on line ' + open.line, open);
          const oa = this.ann();
          const kw = this.next();
          let vals, letter, oc;
          if (kw.s === 'case') { vals = [this.value(), this.value()]; letter = 0x63; oc = OPT_C; }
          else if (kw.s === 'default') { vals = [this.value()]; letter = 0x64; oc = OPT_D; }
          else this.err('expected case or default, got ' + JSON.stringify(kw.s), kw);
          rest.push(['opt', oa.w || 0, letter, oc, vals, oa.short || 0]);
        }
        return done();
      }
    }
    const isIf = code === KW_IF && tok.s === 'if';
    while (!this.endOfStatement() && !this.isOption(this.peek())) {
      if (isIf && this.kwAhead('else')) break;
      args.push(this.value());
    }
    if (isIf) {
      while (this.kwAhead('else')) {
        const oa = this.ann(); this.next();
        let vals, letter, oc;
        if (this.peek().k === 'word' && this.peek().s === 'if') { this.next(); vals = [this.value(), this.value()]; letter = 0x69; oc = OPT_I; }
        else { vals = [this.value()]; letter = 0x65; oc = OPT_E; }
        rest.push(['opt', oa.w || 0, letter, oc, vals, oa.short || 0]);
      }
    }
    while (!this.endOfStatement()) {
      if (this.peek().k === 'word' && this.peek().s === '!=') { this.next(); rest.push(this.value()); continue; }
      rest.push(this.option(code));
    }
    return done();
  }

  option(cmdCode) {
    const a = this.ann();
    const tok = this.next();
    const s = tok.s;
    let letter, code;
    let m = /^-(?:\\x([0-9a-f]{2})|([A-Za-z]))\[([0-9a-fA-F]+)\]$/.exec(s);
    if (m) { letter = m[1] ? parseInt(m[1], 16) : m[2].charCodeAt(0); code = parseInt(m[3], 16) & 0xFFFFFF; }
    else if (/^-[A-Za-z][A-Za-z0-9_]*$/.test(s)) { letter = s.charCodeAt(1); code = strcode(s.slice(1)); }
    else this.err('bad option ' + JSON.stringify(s), tok);
    this.note('option', tok, { letter, code, cmd: cmdCode });
    const vals = [];
    while (!this.endOfStatement() && !this.isOption(this.peek())) vals.push(this.value());
    return ['opt', a.w || 0, letter, code, vals, a.short || 0];
  }
}

function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

// ---------------------------------------------------------------------------------------------------- projects
const HEADER_KEYS = { extra_header: 'extraHeader', proc_pad: 'procPad', trailer: 'trailer' };

function decompile(g, names) {
  const e = new Emitter(names);
  const out = ['# GCL decompiled by gclc. Compile with: gclc.py compile <this folder> out.gcx',
    'gcx timestamp=0x' + (g.timestamp >>> 0).toString(16).padStart(8, '0') + ' seed=0x' + (g.seed >>> 0).toString(16).padStart(8, '0')];
  for (const [key, prop] of Object.entries(HEADER_KEYS)) if (g[prop].length) out.push('gcx ' + key + '=' + toHex(g[prop]));
  const refs = new Map();
  g.table.forEach(([flags, slot], i) => {
    if (!refs.has(slot)) refs.set(slot, []);
    refs.get(slot).push(String(i + 1) + (flags ? ':' + flags : ''));
  });
  g.slots.forEach(([gap, node], si) => {
    out.push('');
    if (gap.length) out.push('pad ' + toHex(gap));
    out.push('proc ' + (refs.get(si) || []).join(' ') + ' ' + e.ann(node, node[2]) + e.block(node[2], 0));
  });
  out.push('');
  out.push('main ' + e.ann(g.main, g.main[2]) + e.block(g.main[2], 0));
  const res = ['# resources: index, kind (s = string resource, v = value list), content',
    '# strings: "utf-8" e"euc-jp" b"exact bytes"; value lists end with an implicit end marker'];
  g.resources.forEach(([flag, b], i) => {
    const kind = flag ? 's' : 'v';
    let txt = null;
    if (!flag && b.length && b[b.length - 1] === 0) {
      try {
        const seq = parseSeq(b, 0, b.length);
        if (seq.length && seq[seq.length - 1][0] === 'end' && !seq.slice(0, -1).some(x => x[0] === 'end')) {
          txt = e.values(seq.slice(0, -1), 0);
          const back = txt.includes('\n') ? null : compileValues(txt, names);
          if (!back || !rawEq(Array.from(back), Array.from(b))) txt = null;
        }
      } catch (err) { txt = null; }
    }
    if (txt === null) txt = flag ? strText(b) : 'hex:' + toHex(b);
    res.push(i + ' ' + kind + ' ' + txt);
  });
  return [out.join('\n') + '\n', res.join('\n') + '\n'];
}

function compileValues(txt, names) {
  try {
    const q = new Parser(txt, names); const vals = [];
    while (q.peek().k !== 'eof') vals.push(q.value());
    return buildSeq(vals.concat([['end']]));
  } catch (e) { return null; }
}

// Parse a project. Returns a Gcx (from ./gcx). opts.onNode gets (kind, token, info) for every reference / definition.
function compileText(script, resources, names, font = new Uint8Array(0), opts = {}) {
  const { Gcx } = require('./gcx');
  const g = new Gcx();
  g.font = font;
  const table = new Map();
  const p = new Parser(script, names, opts);
  let gap = new Uint8Array(0);
  for (;;) {
    p.skipNl();
    const t = p.peek();
    if (t.k === 'eof') break;
    const wt = p.next(); const word = wt.s;
    if (word === 'gcx') {
      while (!p.endOfStatement()) {
        const kv = p.next();
        const [k, v] = kv.s.split('=');
        if (k === 'timestamp' || k === 'seed') g[k] = parseInt(v, 16) >>> 0;
        else if (HEADER_KEYS[k]) { try { g[HEADER_KEYS[k]] = fromHex(v); } catch (e) { p.err(e.message, kv); } }
        else if (k === 'mgo2key') g.mgo2key = v;
        else p.err('unknown gcx setting ' + JSON.stringify(k), kv);
      }
      continue;
    }
    if (word === 'pad') { const pt = p.next(); try { gap = fromHex(pt.s); } catch (e) { p.err(e.message, pt); } continue; }
    if (word === 'proc') {
      const ids = [];
      while (p.peek().k === 'word') {
        const it = p.next();
        const m = /^(\d+)(?::(\d+))?$/.exec(it.s);
        if (!m) p.err('proc ids look like 12 or 12:1 (id:flags), got ' + JSON.stringify(it.s), it);
        ids.push([+m[1], +(m[2] || 0), it]);
      }
      if (!ids.length) p.err('proc needs at least one id', wt);
      const a = p.ann();
      const node = p.block(a);
      const si = g.slots.length;
      g.slots.push([gap, node]); gap = new Uint8Array(0);
      for (const [i, f, it] of ids) {
        if (table.has(i)) p.err('proc ' + i + ' is defined twice', it);
        table.set(i, [f, si]);
        p.note('procdef', it, i);
      }
      continue;
    }
    if (word === 'main') { const a = p.ann(); g.main = p.block(a); p.note('main', wt, null); continue; }
    p.err('expected gcx / proc / main, got ' + JSON.stringify(word), wt);
  }
  if (!g.main) throw new ParseError('the script has no main { } block');
  const ids = [...table.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) if (ids[i] !== i + 1) throw new ParseError('proc ids must be 1..N without gaps (@procN calls proc N); proc ' + (i + 1) + ' is missing');
  g.table = ids.map(i => table.get(i));
  g.resources = [];
  const lines = resources.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    const tokAt = { line: ln + 1, col: 1, s: line, off: 0 };
    if (!m) throw new ParseError('resources line ' + (ln + 1) + ': expected "index kind content"', tokAt);
    const [, idx, kind, rest] = m;
    if (+idx !== g.resources.length) throw new ParseError('resources line ' + (ln + 1) + ': expected index ' + g.resources.length, tokAt);
    let b;
    if (rest.startsWith('hex:')) b = fromHex(rest.slice(4));
    else if (kind === 's') {
      try { const v = new Parser(rest, names).value(); if (v[0] !== 'str') throw new ParseError('expected a string'); b = v[1]; }
      catch (e) { throw new ParseError('resources line ' + (ln + 1) + ': ' + e.message.replace(/^line \d+: /, ''), tokAt); }
    } else {
      b = compileValues(rest, names);
      if (b === null) {
        try { new Parser(rest, names).value(); } catch (e) { throw new ParseError('resources line ' + (ln + 1) + ': ' + e.message.replace(/^line \d+: /, ''), tokAt); }
        throw new ParseError('resources line ' + (ln + 1) + ': cannot compile', tokAt);
      }
    }
    g.resources.push([kind === 's' ? 1 : 0, b]);
  }
  return g;
}

module.exports = { Names, Emitter, Parser, ParseError, tokenize, decompile, compileText, compileValues, strcode,
  canonicalNumber, KW_IF, KW_SWITCH };
