'use strict';
// VS Code support for GCL (decompiled GCX scripts of MGS4 / MGO2 / MGA).
// Diagnostics come from the real compiler (lib/gcltext.js), so a file without errors compiles.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const T = require('./lib/gcltext');
const P = require('./lib/project');

let diagnostics, output;
const analyses = new Map();          // uri -> analysis of the latest version
const lastGood = new Map();          // uri -> latest analysis that parsed completely
const timers = new Map();

// ---------------------------------------------------------------------------------------------------- names
const namesCache = new Map();        // "dict|cmds" -> { names, byHashAll, labelsByName, mtimes }

function findUp(dir, file, levels = 5) {
  for (let i = 0; i <= levels && dir; i++) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function resolveFile(setting, file, docDir) {
  const v = vscode.workspace.getConfiguration('gcl').get(setting);
  if (v && fs.existsSync(v)) return v;
  if (docDir) { const p = findUp(docDir, file); if (p) return p; }
  for (const f of vscode.workspace.workspaceFolders || []) {
    const p = path.join(f.uri.fsPath, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function namesFor(docDir) {
  const dict = resolveFile('dictionaryPath', 'dictionary.txt', docDir);
  const cmds = resolveFile('commandsPath', 'commands.txt', docDir);
  const key = (dict || '') + '|' + (cmds || '');
  const mt = (p) => { try { return p ? fs.statSync(p).mtimeMs : 0; } catch (e) { return 0; } };
  const stamp = mt(dict) + ':' + mt(cmds);
  let c = namesCache.get(key);
  if (!c || c.stamp !== stamp) {
    const names = P.loadNames(dict, cmds);
    const byHashAll = new Map();
    if (dict) for (const w of fs.readFileSync(dict, 'latin1').split(/\r?\n/)) {
      if (!w) continue;
      const h = T.strcode(w);
      if (!byHashAll.has(h)) byHashAll.set(h, []);
      const a = byHashAll.get(h); if (a.length < 6) a.push(w);
    }
    const labelsByName = new Map();
    for (const [h, n] of names.labels) labelsByName.set(n.toLowerCase(), [h, n]);
    c = { names, byHashAll, labelsByName, stamp, dict, cmds };
    namesCache.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------------- analysis
function kindOf(doc) { return path.basename(doc.uri.fsPath).toLowerCase() === 'resources.gcl' ? 'resources' : 'script'; }

function siblingText(doc, file) {
  const p = path.join(path.dirname(doc.uri.fsPath), file);
  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === p);
  if (open) return open.getText();
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// index -> { line, text } of a resources.gcl text
function resourceIndex(text) {
  const out = [];
  if (text === null) return null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(\d+)\s+([sv])\s*(.*?)\s*$/.exec(lines[i]);
    if (m) out[+m[1]] = { line: i, kind: m[2], text: m[3] };
  }
  return out;
}

function headerScan(text) {
  // top-level proc / main headers (decompiled scripts keep them at column 0) -> symbols, definitions
  const procs = new Map(); const order = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let m = /^proc((?:\s+\d+(?::\d+)?)+)/.exec(lines[i]);
    if (m) {
      const ids = []; const re = /(\d+)(?::(\d+))?/g; let x; let base = 4;
      const part = m[1];
      while ((x = re.exec(part))) ids.push({ id: +x[1], flags: +(x[2] || 0), col: base + x.index, len: x[0].length });
      order.push({ line: i, ids, main: false });
      for (const d of ids) procs.set(d.id, { line: i, col: d.col, len: d.len, flags: d.flags });
      continue;
    }
    if (/^main\b/.test(lines[i])) order.push({ line: i, ids: [], main: true });
  }
  for (let k = 0; k < order.length; k++) order[k].end = (k + 1 < order.length ? order[k + 1].line : lines.length) - 1;
  return { procs, order, lines };
}

function analyze(doc) {
  const text = doc.getText();
  const dir = path.dirname(doc.uri.fsPath);
  const N = namesFor(dir);
  const a = { version: doc.version, kind: kindOf(doc), refs: [], error: null, diags: [], N };
  if (a.kind === 'resources') {
    a.diags = lintResources(text, N);
    return a;
  }
  a.headers = headerScan(text);
  const resText = siblingText(doc, 'resources.gcl');
  a.resources = resourceIndex(resText);
  try {
    const g = T.compileText(text, '', N.names, new Uint8Array(0), { onNode: (kind, tok, info) => a.refs.push({ kind, tok, info }) });
    try { g.build(); } catch (e) { if (!/string longer/.test(e.message)) a.error = { message: e.message, tok: null }; }   // long strings are reported at their position
  } catch (e) {
    a.error = { message: e.message.replace(/^line \d+: /, ''), tok: e.line ? { line: e.line, col: e.col, len: e.len } : null };
  }
  a.diags = lintScript(a, doc);
  return a;
}

function severity(setting) {
  const v = vscode.workspace.getConfiguration('gcl').get(setting);
  return { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information }[v];
}

const rangeOf = (tok) => new vscode.Range(tok.line - 1, tok.col - 1, tok.line - 1, tok.col - 1 + Math.max(1, tok.len || (tok.s ? tok.s.length : 1)));

function lintScript(a, doc) {
  const out = [];
  const D = (tok, msg, sev, code) => { const d = new vscode.Diagnostic(rangeOf(tok), msg, sev); d.source = 'gcl'; if (code) d.code = code; out.push(d); };
  if (a.error) {
    const tok = a.error.tok || { line: 1, col: 1, len: 1 };
    D(tok, a.error.message, vscode.DiagnosticSeverity.Error, 'syntax');
  }
  const defined = a.headers.procs;
  const N = a.N;
  const cmdCount = new Map(), optCount = new Map();
  for (const r of a.refs) {
    if (r.kind === 'command') cmdCount.set(r.info, (cmdCount.get(r.info) || 0) + 1);
    if (r.kind === 'option') { const k = r.info.letter + ':' + r.info.code; optCount.set(k, (optCount.get(k) || 0) + 1); }
  }
  const sevLabel = severity('lint.labelNames'), sevCmd = severity('lint.unknownCommands'), sevOpt = severity('lint.unknownOptions');
  const builtins = new Set([T.KW_IF, T.KW_SWITCH]);
  // after a syntax error the parser may have swallowed the rest of the file: keep only what precedes the error
  const errLine = a.error && a.error.tok ? a.error.tok.line : (a.error ? 0 : Infinity);
  const heuristics = !a.error;
  for (const r of a.refs) {
    if (r.tok.line >= errLine) continue;
    const tok = { line: r.tok.line, col: r.tok.col, len: r.tok.s.length };
    if ((r.kind === 'call' || r.kind === 'procref') && !defined.has(r.info))
      D(tok, 'proc ' + r.info + ' is not defined in this script', vscode.DiagnosticSeverity.Error, 'undefined-proc');
    if (r.kind === 'res' && a.resources && r.info >= a.resources.length)
      D(tok, 'resource ' + r.info + ' does not exist (resources.gcl has ' + a.resources.length + ')', vscode.DiagnosticSeverity.Error, 'undefined-resource');
    if (r.kind === 'string' && r.info > 255)
      D(tok, 'string is ' + (r.info - 1) + ' bytes; GCL strings hold at most 254 (use a resource for longer text)', vscode.DiagnosticSeverity.Error, 'string-length');
    // bare names a person typed: the decompiler only prints dictionary words (whose hash is the stored value)
    const typed = /^[A-Za-z_]\w*$/.test(r.tok.s) && N.names.by.get(T.strcode(r.tok.s)) !== r.tok.s;
    if ((r.kind === 'word' || r.kind === 'command') && sevLabel !== undefined && /^[A-Za-z_]\w*$/.test(r.tok.s)) {
      const lab = N.labelsByName.get(r.tok.s.toLowerCase());
      if (lab && lab[0] !== T.strcode(r.tok.s)) {
        // a dictionary word may really mean its own hash (decompiled code prints them), so that case is only a hint
        const sev = typed ? sevLabel : vscode.DiagnosticSeverity.Information;
        const msg = typed
          ? '"' + r.tok.s + '" hashes to ' + hex6(T.strcode(r.tok.s)) + ', not to the ' + lab[1] + ' handler ' + hex6(lab[0]) + '. Labels are display names only; write [' + hex6(lab[0]) + '/' + lab[1] + '].'
          : '"' + r.tok.s + '" is the dictionary name of hash ' + hex6(T.strcode(r.tok.s)) + '; the ' + lab[1] + ' handler in commands.txt is ' + hex6(lab[0]) + '. If you meant the handler, write [' + hex6(lab[0]) + '/' + lab[1] + '].';
        const d = new vscode.Diagnostic(rangeOf(tok), msg, sev);
        d.source = 'gcl'; d.code = 'label-name'; d.fix = '[' + hex6(lab[0]) + '/' + lab[1] + ']';
        out.push(d);
      }
    }
    if (r.kind === 'command' && heuristics && sevCmd !== undefined && typed && !builtins.has(r.info) && !N.names.labels.has(r.info) && cmdCount.get(r.info) === 1)
      D(tok, 'command ' + hex6(r.info) + ' is not in commands.txt and is used nowhere else in this script', sevCmd, 'unknown-command');
    const typedOpt = r.kind === 'option' && /^-[A-Za-z][A-Za-z0-9_]+$/.test(r.tok.s) && N.names.by.get(T.strcode(r.tok.s.slice(1))) !== r.tok.s.slice(1);
    if (r.kind === 'option' && heuristics && sevOpt !== undefined && typedOpt && optCount.get(r.info.letter + ':' + r.info.code) === 1)
      D(tok, 'option ' + r.tok.s + ' is used nowhere else in this script (typo?)', sevOpt, 'unknown-option');
  }
  return out;
}

function lintResources(text, N) {
  const out = [];
  const lines = text.split('\n');
  let expect = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(\s*)(\S+)(\s+)(\S+)\s*(.*)$/.exec(line);
    const bad = (msg, from = 0, to = line.length) => { const d = new vscode.Diagnostic(new vscode.Range(i, from, i, Math.max(from + 1, to)), msg, vscode.DiagnosticSeverity.Error); d.source = 'gcl'; out.push(d); };
    if (!m) { bad('expected "index kind content"'); continue; }
    const idx = +m[2];
    if (idx !== expect) bad('expected index ' + expect + ' (resources must be numbered 0..N-1 in order)', m[1].length, m[1].length + m[2].length);
    expect = (isNaN(idx) ? expect : idx) + 1;
    const kind = m[4], rest = m[5];
    const restCol = line.length - rest.length;
    if (kind !== 's' && kind !== 'v') { bad('kind must be s (string) or v (value list)', m[1].length + m[2].length + m[3].length); continue; }
    try {
      if (rest.startsWith('hex:')) { if (!/^hex:(?:[0-9a-fA-F]{2})*$/.test(rest)) throw new Error('bad hex data'); }
      else if (kind === 's') {
        const v = new T.Parser(rest, N.names).value();
        if (v[0] !== 'str') throw new Error('a string resource needs a string ("text", e"text" or b"bytes")');
      } else if (T.compileValues(rest, N.names) === null) new T.Parser(rest, N.names).value();
    } catch (e) {
      const col = e.col ? restCol + e.col - 1 : restCol;
      bad(e.message.replace(/^line \d+: /, ''), col, e.len ? col + e.len : line.length);
    }
  }
  return out;
}

const hex6 = (h) => h.toString(16).padStart(6, '0');

function refresh(doc) {
  if (doc.languageId !== 'gcl') return;
  const a = analyze(doc);
  analyses.set(doc.uri.toString(), a);
  if (!a.error) lastGood.set(doc.uri.toString(), a);
  diagnostics.set(doc.uri, a.diags);
}

function schedule(doc, delay = 350) {
  if (doc.languageId !== 'gcl') return;
  const k = doc.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); refresh(doc); }, delay));
}

function current(doc) {
  const k = doc.uri.toString();
  let a = analyses.get(k);
  if (!a || a.version !== doc.version) { refresh(doc); a = analyses.get(k); }
  return a;
}
function good(doc) { const a = current(doc); return a.error ? (lastGood.get(doc.uri.toString()) || a) : a; }

// ---------------------------------------------------------------------------------------------------- tokens at a position
const TOKEN_AT = /@proc\d+|p:proc\d+|\$res:\d+|\[[0-9a-fA-F]+(?:\/[^\]\s]*)?\](?:\[\d+\])?|-[A-Za-z][A-Za-z0-9_]*(?:\[[0-9a-fA-F]+\])?|%\([^)]*\)|\$[A-Za-z0-9_.@:]+|vec:-?\d+,-?\d+,-?\d+|-?\d+(?::\w+)?|0x[0-9a-fA-F]+(?::\w+)?|[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?/;

function tokenAt(doc, pos) {
  const r = doc.getWordRangeAtPosition(pos, TOKEN_AT);
  return r ? { range: r, text: doc.getText(r) } : null;
}

function procBodyPreview(doc, a, id, maxLines = 14) {
  const def = a.headers.procs.get(id);
  if (!def) return null;
  const block = a.headers.order.find(o => o.line === def.line);
  const end = block ? Math.min(block.end, def.line + maxLines) : def.line + maxLines;
  const lines = [];
  for (let i = def.line; i <= end && i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (block && block.end > end) lines.push('    ...');
  return lines.join('\n');
}

function procSummary(doc, a, id) {
  const def = a.headers.procs.get(id);
  if (!def) return '';
  for (let i = def.line + 1; i < Math.min(doc.lineCount, def.line + 6); i++) {
    const t = doc.lineAt(i).text.trim();
    if (t && t !== '}' && !t.startsWith('#')) return t.replace(/\s*\\$/, '');
  }
  return '';
}

const NUMKIND = { small: 'small integer (1 byte)', 2: 'u8 literal (2 bytes)', 1: 's16 literal (3 bytes)', 9: 's32 literal (5 bytes)', 10: 'u32 / symbol literal (5 bytes)' };
const ANN_HELP = {
  w: 'size field written N bytes wide (wider than needed); kept so the file rebuilds byte for byte',
  short: 'declared size is N byte(s) shorter than the contents (a quirk of the original compiler); keep it',
  aw: 'argument-size field written 2 bytes wide', ashort: 'argument list declared N byte(s) short (original compiler quirk)',
  noend: 'this list has no end marker in the original file', rpn: 'expression kept in raw stack (RPN) form'
};

// ---------------------------------------------------------------------------------------------------- providers
function hoverProvider() {
  return {
    provideHover(doc, pos) {
      const tk = tokenAt(doc, pos); if (!tk) return null;
      const s = tk.text; const a = good(doc); const N = a.N;
      const md = new vscode.MarkdownString(); md.supportHtml = false;
      let m;
      if ((m = /^(?:@proc|p:proc)(\d+)$/.exec(s)) && a.kind === 'script') {
        const id = +m[1];
        const prev = procBodyPreview(doc, a, id);
        if (!prev) return new vscode.Hover('**proc ' + id + '** is not defined in this script', tk.range);
        const calls = a.refs.filter(r => (r.kind === 'call' || r.kind === 'procref') && r.info === id).length;
        md.appendMarkdown('**proc ' + id + '** — referenced ' + calls + ' time' + (calls === 1 ? '' : 's') + (s.startsWith('p:') ? ' · passed by reference (GCL_PROCID)' : '') + '\n');
        md.appendCodeblock(prev, 'gcl');
        return new vscode.Hover(md, tk.range);
      }
      if ((m = /^\$res:(\d+)$/.exec(s))) {
        const res = a.resources || resourceIndex(siblingText(doc, 'resources.gcl'));
        const r = res && res[+m[1]];
        md.appendMarkdown('**resource ' + m[1] + '** ' + (r ? '(' + (r.kind === 's' ? 'string' : 'value list') + ')' : '— not found in resources.gcl') + '\n');
        if (r) md.appendCodeblock(r.text.length > 600 ? r.text.slice(0, 600) + ' …' : r.text, 'gcl');
        return new vscode.Hover(md, tk.range);
      }
      if ((m = /^%\(([^)]*)\)$/.exec(s))) {
        md.appendMarkdown('**encoding annotation**\n\n');
        for (const item of m[1].split(',').filter(Boolean)) { const [k, v] = item.split('='); md.appendMarkdown('- `' + item + '`: ' + (ANN_HELP[k] || '?').replace('N', v || '') + '\n'); }
        return new vscode.Hover(md, tk.range);
      }
      if ((m = /^-([A-Za-z])([A-Za-z0-9_]*)(?:\[([0-9a-fA-F]+)\])?$/.exec(s)) && !/^-\d/.test(s)) {
        const code = m[3] ? parseInt(m[3], 16) : T.strcode(m[1] + m[2]);
        md.appendMarkdown('**option** `' + s + '` — letter `' + m[1] + '`, code `' + hex6(code) + '`');
        const others = (N.byHashAll.get(code) || []).filter(w => w !== m[1] + m[2]).slice(0, 5);
        if (others.length) md.appendMarkdown('\n\nother dictionary names with this hash: ' + others.map(w => '`' + w + '`').join(', '));
        return new vscode.Hover(md, tk.range);
      }
      if ((m = /^\$(arr\.|tag\d+\.)?(\w+)@(\w+):([0-9a-fA-F]+)(?:\.b(\d+))?$/.exec(s))) {
        md.appendMarkdown('**variable** — type `' + m[2] + '`, region `' + m[3] + '` (' + ({ var: 'varbuf', link: 'linkvarbuf (saved)', local: 'localvarbuf (stage-local)' }[m[3]] || 'unknown') + '), offset `0x' + m[4] + '`' + (m[5] ? ', bit ' + m[5] : '') + (m[1] === 'arr.' ? ', indexed (followed by size and index)' : ''));
        return new vscode.Hover(md, tk.range);
      }
      if (s === '$status') return new vscode.Hover('**$status** — the result of the last command or expression (argument 0)', tk.range);
      if ((m = /^\$arg(\d+)/.exec(s))) return new vscode.Hover('**$arg' + m[1] + '** — argument ' + m[1] + ' of the current proc', tk.range);
      if ((m = /^\$local(\d+)$/.exec(s))) return new vscode.Hover('**$local' + m[1] + '** — proc-local variable ' + m[1], tk.range);
      if ((m = /^(-?\d+)(?::(\w+))?$/.exec(s))) {
        const v = +m[1];
        if (m[2]) return new vscode.Hover('**' + v + '** stored as `' + m[2] + '` (explicit type)', tk.range);
        const c = T.canonicalNumber(v);
        return new vscode.Hover('**' + v + '** → ' + (c[0] === 'small' ? NUMKIND.small : NUMKIND[c[1]]) + (v >= 0 && v <= 0xFFFFFF ? '  ·  hex `' + hex6(v) + '`' : ''), tk.range);
      }
      const hm = /^(?:\[([0-9a-fA-F]+)(?:\/([^\]]*))?\]|([A-Za-z_]\w*))(?:\[(\d+)\])?$/.exec(s);
      if (hm) {
        const h = hm[1] ? parseInt(hm[1], 16) : T.strcode(hm[3]);
        md.appendMarkdown('**hash** `' + hex6(h) + '`' + (hm[4] ? ' · array element ' + hm[4] : ''));
        const lab = N.names.labels.get(h);
        if (lab) md.appendMarkdown('\n\ncommands.txt: **' + lab + '**');
        if (hm[3]) { const L = N.labelsByName.get(hm[3].toLowerCase()); if (L && L[0] !== h) md.appendMarkdown('\n\n⚠ the ' + L[1] + ' handler is `' + hex6(L[0]) + '`; this word hashes to `' + hex6(h) + '`'); }
        const all = N.byHashAll.get(h); if (all) md.appendMarkdown('\n\ndictionary: ' + all.map(w => '`' + w + '`').join(', '));
        const uses = a.refs ? a.refs.filter(r => (r.kind === 'command' || r.kind === 'word') && r.info === h).length : 0;
        if (uses) md.appendMarkdown('\n\nused ' + uses + ' time' + (uses === 1 ? '' : 's') + ' in this script');
        return new vscode.Hover(md, tk.range);
      }
      return null;
    }
  };
}

function definitionProvider() {
  return {
    provideDefinition(doc, pos) {
      const tk = tokenAt(doc, pos); if (!tk) return null;
      let m;
      if ((m = /^(?:@proc|p:proc)(\d+)$/.exec(tk.text)) && kindOf(doc) === 'script') {
        const def = good(doc).headers.procs.get(+m[1]);
        return def ? new vscode.Location(doc.uri, new vscode.Range(def.line, def.col, def.line, def.col + def.len)) : null;
      }
      if ((m = /^\$res:(\d+)$/.exec(tk.text))) {
        const p = path.join(path.dirname(doc.uri.fsPath), 'resources.gcl');
        const res = resourceIndex(siblingText(doc, 'resources.gcl'));
        const r = res && res[+m[1]];
        return r ? new vscode.Location(vscode.Uri.file(p), new vscode.Position(r.line, 0)) : null;
      }
      return null;
    }
  };
}

function referenceProvider() {
  return {
    provideReferences(doc, pos, ctx) {
      if (kindOf(doc) !== 'script') return null;
      const tk = tokenAt(doc, pos); if (!tk) return null;
      const a = good(doc);
      let id = null, m;
      if ((m = /^(?:@proc|p:proc)(\d+)$/.exec(tk.text))) id = +m[1];
      else if (/^\d+$/.test(tk.text) && /^proc\b/.test(doc.lineAt(pos.line).text)) id = +tk.text;
      if (id === null) return null;
      const out = a.refs.filter(r => (r.kind === 'call' || r.kind === 'procref') && r.info === id)
        .map(r => new vscode.Location(doc.uri, rangeOf({ line: r.tok.line, col: r.tok.col, len: r.tok.s.length })));
      const def = a.headers.procs.get(id);
      if (def && ctx.includeDeclaration) out.unshift(new vscode.Location(doc.uri, new vscode.Range(def.line, def.col, def.line, def.col + def.len)));
      return out;
    }
  };
}

function symbolProvider() {
  return {
    provideDocumentSymbols(doc) {
      if (kindOf(doc) !== 'script') return [];
      const a = good(doc);
      return a.headers.order.map(o => {
        const name = o.main ? 'main' : 'proc ' + o.ids.map(d => d.id + (d.flags ? ':' + d.flags : '')).join(' ');
        const detail = o.main ? '' : procSummary(doc, a, o.ids[0].id);
        const end = Math.max(o.line, o.end);
        const range = new vscode.Range(o.line, 0, end, doc.lineAt(Math.min(end, doc.lineCount - 1)).text.length);
        return new vscode.DocumentSymbol(name, detail, o.main ? vscode.SymbolKind.Module : vscode.SymbolKind.Function, range, new vscode.Range(o.line, 0, o.line, doc.lineAt(o.line).text.length));
      });
    }
  };
}

function statementHead(doc, pos) {
  // first token of the statement that contains pos (statements continue over lines ending in "\")
  let line = pos.line;
  while (line > 0 && /\\\s*$/.test(doc.lineAt(line - 1).text)) line--;
  const m = /^\s*(?:%\([^)]*\))?(\S+)/.exec(line === pos.line ? doc.lineAt(line).text.slice(0, pos.character) : doc.lineAt(line).text);
  return m ? m[1] : null;
}

function completionProvider() {
  const K = vscode.CompletionItemKind;
  return {
    provideCompletionItems(doc, pos) {
      const a = good(doc); const N = a.N;
      const before = doc.lineAt(pos.line).text.slice(0, pos.character);
      const items = [];
      const item = (label, kind, detail, insert, filter, sort) => {
        const it = new vscode.CompletionItem(label, kind);
        if (detail) it.detail = detail;
        if (insert !== undefined) it.insertText = insert;
        if (filter) it.filterText = filter;
        if (sort) it.sortText = sort;
        items.push(it); return it;
      };
      let m;
      if (a.kind === 'script' && (m = /(@proc|p:proc|@|p:)(\d*)$/.exec(before))) {
        const prefix = m[1].startsWith('@') ? '@proc' : 'p:proc';
        const start = pos.translate(0, -m[0].length);
        for (const [id] of [...a.headers.procs].sort((x, y) => x[0] - y[0])) {
          const it = item(prefix + id, K.Function, procSummary(doc, a, id), prefix + id, prefix + id, String(id).padStart(6, '0'));
          it.range = new vscode.Range(start, pos);
          const prev = procBodyPreview(doc, a, id, 8);
          if (prev) it.documentation = new vscode.MarkdownString().appendCodeblock(prev, 'gcl');
        }
        return items;
      }
      if ((m = /\$res:(\d*)$/.exec(before))) {
        const res = a.resources || resourceIndex(siblingText(doc, 'resources.gcl')) || [];
        const start = pos.translate(0, -m[0].length);
        let n = 0;
        for (let i = 0; i < res.length && n < 400; i++) {
          if (!res[i] || (m[1] && !String(i).startsWith(m[1]))) continue;
          const it = item('$res:' + i, K.Constant, res[i].text.slice(0, 80), '$res:' + i, '$res:' + i, String(i).padStart(7, '0'));
          it.range = new vscode.Range(start, pos); n++;
        }
        return items;
      }
      if ((m = /\$([\w.@:]*)$/.exec(before))) {
        const start = pos.translate(0, -m[0].length);
        const add = (t, d) => { const it = item(t, K.Variable, d, t, t); it.range = new vscode.Range(start, pos); };
        add('$status', 'result of the last command / expression');
        for (let i = 1; i <= 8; i++) add('$arg' + i, 'proc argument ' + i);
        for (let i = 0; i <= 7; i++) add('$local' + i, 'proc-local variable');
        add('$res:', 'string / value resource');
        const seen = new Set();
        for (const mm of doc.getText().matchAll(/\$(?:arr\.)?\w+@\w+:[0-9a-fA-F]+(?:\.b\d+)?/g)) { if (!seen.has(mm[0]) && seen.size < 300) { seen.add(mm[0]); add(mm[0], 'variable used in this script'); } }
        return items;
      }
      if ((m = /(?:^|\s)(-[A-Za-z0-9_]*)$/.exec(before)) && a.kind === 'script') {
        const head = statementHead(doc, pos);
        const code = head ? (/^\[([0-9a-fA-F]+)/.exec(head) ? parseInt(/^\[([0-9a-fA-F]+)/.exec(head)[1], 16) : T.strcode(head)) : null;
        const start = pos.translate(0, -m[1].length);
        const counts = new Map(), forCmd = new Set();
        for (const r of a.refs) if (r.kind === 'option') {
          counts.set(r.tok.s, (counts.get(r.tok.s) || 0) + 1);
          if (r.info.cmd === code) forCmd.add(r.tok.s);
        }
        for (const [o, n] of [...counts].sort((x, y) => y[1] - x[1])) {
          const mine = forCmd.has(o);
          const it = item(o, K.Property, (mine ? 'used with this command' : 'used in this script') + ' · ' + n + '×', o, o, (mine ? '0' : '1') + String(100000 - n).padStart(6, '0'));
          it.range = new vscode.Range(start, pos);
        }
        return items;
      }
      if (a.kind === 'script' && /^\s*(?:%\([^)]*\))?[A-Za-z_\[]?[\w\/\]]*$/.test(before)) {
        // start of a statement: keywords, calls, commands
        const start = pos.translate(0, -(/[A-Za-z_\[][\w\/\]]*$/.exec(before) || [''])[0].length);
        for (const kw of ['if', 'else', 'switch', 'case', 'default']) { const it = item(kw, K.Keyword, 'control flow'); it.range = new vscode.Range(start, pos); }
        const counts = new Map();
        for (const r of a.refs) if (r.kind === 'command') counts.set(r.tok.s, (counts.get(r.tok.s) || 0) + 1);
        for (const [c, n] of [...counts].sort((x, y) => y[1] - x[1]).slice(0, 400)) {
          const lab = /\/([^\]]+)\]$/.exec(c);
          const it = item(c, K.Function, 'command used ' + n + '× in this script', c, lab ? lab[1] + ' ' + c : c, '1' + String(100000 - n).padStart(6, '0'));
          it.range = new vscode.Range(start, pos);
        }
        for (const [h, lab] of N.names.labels) {
          const text = '[' + hex6(h) + '/' + lab + ']';
          if (counts.has(text)) continue;
          const it = item(lab, K.Function, text + ' · commands.txt', text, lab, '2' + lab);
          it.range = new vscode.Range(start, pos);
        }
        return items;
      }
      return null;
    }
  };
}

function codeActionProvider() {
  return {
    provideCodeActions(doc, range, ctx) {
      const out = [];
      for (const d of ctx.diagnostics) {
        if (d.code === 'label-name' && d.fix) {
          const act = new vscode.CodeAction('Replace with ' + d.fix, vscode.CodeActionKind.QuickFix);
          act.edit = new vscode.WorkspaceEdit(); act.edit.replace(doc.uri, d.range, d.fix);
          act.diagnostics = [d]; act.isPreferred = true; out.push(act);
        }
      }
      return out;
    }
  };
}

// ---------------------------------------------------------------------------------------------------- commands
function log(msg) { output.appendLine(msg); }

async function cmdDecompile(uri) {
  if (!uri || !uri.fsPath.toLowerCase().endsWith('.gcx')) {
    const pick = await vscode.window.showOpenDialog({ filters: { 'GCX scripts': ['gcx'] }, canSelectMany: false, title: 'Decompile GCX' });
    if (!pick) return; uri = pick[0];
  }
  const src = uri.fsPath;
  let outDir = path.join(path.dirname(src), path.basename(src, path.extname(src)));
  if (fs.existsSync(path.join(outDir, 'script.gcl'))) {
    const c = await vscode.window.showWarningMessage(path.basename(outDir) + '/ already has a decompiled project.', { modal: true }, 'Overwrite', 'Choose folder…');
    if (!c) return;
    if (c !== 'Overwrite') {
      const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Folder for the GCL project' });
      if (!f) return; outDir = f[0].fsPath;
    }
  }
  const N = namesFor(path.dirname(src));
  try {
    const key = vscode.workspace.getConfiguration('gcl').get('mgo2Key') || undefined;
    const r = P.decompileToFolder(src, outDir, N.names, key);
    log('decompiled ' + src + ' -> ' + outDir + ' (' + r.gcx.table.length + ' procs, ' + r.gcx.resources.length + ' resources' + (r.key ? ', MGO2 key ' + r.key : '') + ')');
    const doc = await vscode.workspace.openTextDocument(path.join(outDir, 'script.gcl'));
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('Decompiled: ' + r.gcx.table.length + ' procs, ' + r.gcx.resources.length + ' resources' + (r.key ? ' (decrypted with ' + r.key + ')' : '') + '.');
  } catch (e) { vscode.window.showErrorMessage('Decompile failed: ' + e.message); log('decompile failed: ' + e.stack); }
}

function projectDir(uri) {
  if (uri) {
    const p = uri.fsPath;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    return path.dirname(p);
  }
  const ed = vscode.window.activeTextEditor;
  return ed ? path.dirname(ed.document.uri.fsPath) : null;
}

async function cmdCompile(uri) {
  const dir = projectDir(uri);
  if (!dir || !fs.existsSync(path.join(dir, 'script.gcl'))) { vscode.window.showErrorMessage('No script.gcl in ' + (dir || 'the current folder') + '.'); return; }
  for (const d of vscode.workspace.textDocuments) if (d.isDirty && path.dirname(d.uri.fsPath) === dir) await d.save();
  const N = namesFor(dir);
  let r;
  try { r = P.compileFolder(dir, N.names, {}); }
  catch (e) {
    const where = e.line ? ' (line ' + e.line + ')' : '';
    const file = /^resources line/.test(e.message) ? 'resources.gcl' : 'script.gcl';
    log('compile failed: ' + e.message);
    const go = await vscode.window.showErrorMessage('Compile failed' + where + ': ' + e.message.replace(/^line \d+: /, ''), 'Show');
    if (go && e.line) {
      const doc = await vscode.workspace.openTextDocument(path.join(dir, file));
      const ed = await vscode.window.showTextDocument(doc);
      const p = new vscode.Position(e.line - 1, Math.max(0, (e.col || 1) - 1));
      ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
    }
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gcl').get('compile.output');
  const def = path.join(path.dirname(dir), path.basename(dir) + '.gcx');
  let dest = def;
  if (cfg === 'ask') {
    const memo = ctxState.get('gcl.out:' + dir);
    const s = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(memo || def), filters: { 'GCX scripts': ['gcx'] }, title: 'Write compiled GCX' });
    if (!s) return; dest = s.fsPath; ctxState.update('gcl.out:' + dir, dest);
  }
  fs.writeFileSync(dest, r.bytes);
  log('compiled ' + dir + ' -> ' + dest + ' (' + r.bytes.length + ' bytes' + (r.key ? ', encrypted with ' + r.key : '') + ')');
  vscode.window.showInformationMessage('Compiled ' + path.basename(dest) + ' (' + r.bytes.length.toLocaleString() + ' bytes' + (r.key ? ', encrypted with ' + r.key : '') + ').');
}

async function cmdVerify(uri) {
  let files = uri ? [uri] : await vscode.window.showOpenDialog({ filters: { 'GCX scripts': ['gcx'] }, canSelectMany: true, title: 'Verify GCX round trip' });
  if (!files) return;
  output.show(true);
  let bad = 0;
  for (const f of files) {
    try {
      const N = namesFor(path.dirname(f.fsPath));
      const key = vscode.workspace.getConfiguration('gcl').get('mgo2Key') || undefined;
      const r = P.verify(f.fsPath, N.names, key);
      log((r.ok ? 'OK    ' : 'FAIL  ') + f.fsPath + '  (' + r.procs + ' procs, ' + r.resources + ' resources; text round trip ' + r.textOk + ', binary ' + r.binaryOk + (r.key ? ', MGO2 ' + r.key : '') + ')');
      if (!r.ok) bad++;
    } catch (e) { log('ERROR ' + f.fsPath + ': ' + e.message); bad++; }
  }
  vscode.window.showInformationMessage(bad ? bad + ' of ' + files.length + ' file(s) failed — see the GCL output.' : 'All ' + files.length + ' file(s) round-trip byte for byte.');
}

let ctxState;

function activate(context) {
  ctxState = context.workspaceState;
  diagnostics = vscode.languages.createDiagnosticCollection('gcl');
  output = vscode.window.createOutputChannel('GCL');
  const sel = { language: 'gcl' };
  context.subscriptions.push(
    diagnostics, output,
    vscode.commands.registerCommand('gcl.decompile', cmdDecompile),
    vscode.commands.registerCommand('gcl.compile', cmdCompile),
    vscode.commands.registerCommand('gcl.verify', cmdVerify),
    vscode.commands.registerCommand('gcl.reloadNames', () => { namesCache.clear(); vscode.workspace.textDocuments.forEach(d => refresh(d)); vscode.window.showInformationMessage('GCL names reloaded.'); }),
    vscode.languages.registerHoverProvider(sel, hoverProvider()),
    vscode.languages.registerDefinitionProvider(sel, definitionProvider()),
    vscode.languages.registerReferenceProvider(sel, referenceProvider()),
    vscode.languages.registerDocumentSymbolProvider(sel, symbolProvider()),
    vscode.languages.registerCompletionItemProvider(sel, completionProvider(), '@', '$', '-', ':', '['),
    vscode.languages.registerCodeActionsProvider(sel, codeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidOpenTextDocument(d => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument(e => {
      schedule(e.document);
      // a changed resources.gcl changes the $res checks of its script.gcl
      if (kindOf(e.document) === 'resources') {
        const sp = path.join(path.dirname(e.document.uri.fsPath), 'script.gcl');
        const sd = vscode.workspace.textDocuments.find(d => d.uri.fsPath === sp); if (sd) schedule(sd, 800);
      }
    }),
    vscode.workspace.onDidCloseTextDocument(d => { diagnostics.delete(d.uri); analyses.delete(d.uri.toString()); lastGood.delete(d.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gcl')) { namesCache.clear(); vscode.workspace.textDocuments.forEach(d => schedule(d, 0)); } })
  );
  vscode.workspace.textDocuments.forEach(d => schedule(d, 0));
}

function deactivate() {}

module.exports = { activate, deactivate };
