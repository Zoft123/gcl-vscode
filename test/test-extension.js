// Run: node test/test-extension.js <project dir with script.gcl>   (uses a mock vscode module)
const Module = require('module');
const path = require('path');
const fs = require('fs');
const mock = require('./mock-vscode');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === 'vscode' ? path.join(__dirname, 'mock-vscode.js') : orig.call(this, req, ...a); };
const ext = require('../extension.js');

function makeDoc(file, text, version = 1) {
  const lines = text.split('\n');
  return {
    uri: { fsPath: file, toString: () => 'file://' + file }, languageId: 'gcl', version, getText: (r) => {
      if (!r) return text;
      return lines[r.start.line].slice(r.start.character, r.end.character);
    },
    lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }),
    getWordRangeAtPosition(pos, re) {
      const line = lines[pos.line]; const g = new RegExp(re.source, 'g'); let m;
      while ((m = g.exec(line))) { if (m.index <= pos.character && pos.character <= m.index + m[0].length) return new mock.Range(pos.line, m.index, pos.line, m.index + m[0].length); if (!m[0].length) g.lastIndex++; }
      return undefined;
    }
  };
}
// capture providers
const P = {};
mock.languages = {
  createDiagnosticCollection: () => ({ set: (u, d) => { P.diags = d; }, delete() {}, dispose() {} }),
  registerHoverProvider: (s, p) => (P.hover = p, {}), registerDefinitionProvider: (s, p) => (P.def = p, {}),
  registerReferenceProvider: (s, p) => (P.refs = p, {}), registerDocumentSymbolProvider: (s, p) => (P.sym = p, {}),
  registerCompletionItemProvider: (s, p) => (P.comp = p, {}), registerCodeActionsProvider: (s, p) => (P.fix = p, {}),
};
mock.window = { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) };
mock.commands = { registerCommand: () => ({}) };
mock.workspace.onDidOpenTextDocument = mock.workspace.onDidChangeTextDocument = mock.workspace.onDidCloseTextDocument = mock.workspace.onDidChangeConfiguration = () => ({});
ext.activate({ subscriptions: [], workspaceState: { get() {}, update() {} } });
const vscodeMod = require('vscode');

const dir = process.argv[2];
const file = path.join(dir, 'script.gcl');
const text = fs.readFileSync(file, 'utf8');
const show = (label, ds) => {
  const by = {}; for (const d of ds) by[d.severity] = (by[d.severity] || 0) + 1;
  console.log(label, 'errors', by[0] || 0, 'warnings', by[1] || 0, 'info', by[2] || 0);
  for (const d of ds.slice(0, 8)) console.log('   L' + (d.range.start.line + 1) + ':' + (d.range.start.character + 1) + '  ' + d.message);
};
// 1. clean file
let t0 = Date.now();
let doc = makeDoc(file, text); mock._docs.length = 0; mock._docs.push(doc);
const a0 = require('../extension.js');
P.sym.provideDocumentSymbols(doc);      // forces analysis
console.log('analysis of', text.split('\n').length, 'lines:', Date.now() - t0, 'ms');
show('clean file:', P.diags || []);
// 2. broken edits
const L = text.split('\n');
const i125 = L.findIndex(l => /^proc 125 /.test(l));
const broken = L.slice();
broken.splice(i125 + 1, 0, '    @proc999', '    chara NewSky [ab40ab] \\', '        -model n004a_sky_d', '    command [5d0cc1] -wp_di 3 -num $res:9999999', '    print "' + 'x'.repeat(300) + '"');
doc = makeDoc(file, broken.join('\n'), 2); mock._docs[0] = doc;
P.sym.provideDocumentSymbols(doc);
show('broken edits:', P.diags);
const fixes = P.fix.provideCodeActions(doc, null, { diagnostics: P.diags });
console.log('   quick fixes:', fixes.map(f => f.title));
const unclosed = L.slice(); unclosed.splice(i125 + 1, 0, '    if (1 == 1) {');
doc = makeDoc(file, unclosed.join('\n'), 3); mock._docs[0] = doc;
P.sym.provideDocumentSymbols(doc);
show('unclosed brace:', P.diags);
// 3. hovers on the clean file
doc = makeDoc(file, text, 4); mock._docs[0] = doc;
const find = (re) => { for (let i = 0; i < L.length; i++) { const m = re.exec(L[i]); if (m) return new mock.Position(i, m.index + 1); } };
for (const [name, re] of [['@proc22', /@proc22\b/], ['$res:0', /\$res:0\b/], ['[f576c7/COM_svGetRule]', /\[f576c7/], ['-wp_id', /-wp_id/], ['p:proc32', /p:proc32/], ['80 (number)', /-num 80/]]) {
  let pos = find(re); if (name.startsWith('80')) pos = pos.translate(0, 5);
  const h = P.hover.provideHover(doc, pos);
  const v = h ? (h.contents.value || h.contents) : '(none)';
  console.log('hover', name, '->', String(v).split('\n').slice(0, 3).join(' | ').slice(0, 150));
}
// 4. definition + references + symbols
const d = P.def.provideDefinition(doc, find(/@proc22\b/));
console.log('definition of @proc22 -> line', d && d.range.start.line + 1, ':', L[d.range.start.line].slice(0, 20));
const refs = P.refs.provideReferences(doc, find(/@proc22\b/), { includeDeclaration: true });
console.log('references to proc 22:', refs.length);
const syms = P.sym.provideDocumentSymbols(doc);
console.log('outline symbols:', syms.length, syms.slice(-3).map(s => s.name + ' — ' + s.detail.slice(0, 40)));
// 5. completions
const compAt = (lineText) => { const t2 = L.slice(); t2.splice(i125 + 1, 0, lineText); const dd = makeDoc(file, t2.join('\n'), 5); mock._docs[0] = dd; return P.comp.provideCompletionItems(dd, new mock.Position(i125 + 1, lineText.length)) || []; };
let c = compAt('    @proc2'); console.log('complete "@proc2":', c.length, 'items, e.g.', c.slice(20, 23).map(x => x.label + ' — ' + (x.detail || '').slice(0, 40)));
c = compAt('    command [5d0cc1] -'); console.log('complete "-" after [5d0cc1]:', c.slice(0, 4).map(x => x.label + ' (' + x.detail + ')'));
c = compAt('    NewSk'); console.log('complete statement start "NewSk":', c.length, 'items; matching:', c.filter(x => (x.filterText || x.label).toLowerCase().includes('newsk')).map(x => x.label + ' -> ' + x.insertText).slice(0, 3));
c = compAt('    command [5d0cc1] -num $res:12'); console.log('complete "$res:12":', c.slice(0, 3).map(x => x.label + ' ' + (x.detail || '').slice(0, 30)));
