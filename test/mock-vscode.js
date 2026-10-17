// Minimal stand-in for the vscode API, enough to unit-test extension.js providers in Node.
class Position { constructor(l, c) { this.line = l; this.character = c; } translate(dl, dc) { return new Position(this.line + dl, this.character + dc); } }
class Range { constructor(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } }
class Selection extends Range {}
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class MarkdownString { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s, l) { this.value += '\n```' + (l || '') + '\n' + s + '\n```\n'; return this; } }
class Hover { constructor(c, r) { this.contents = c; this.range = r; } }
class Location { constructor(uri, r) { this.uri = uri; this.range = r; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class DocumentSymbol { constructor(name, detail, kind, range, sel) { Object.assign(this, { name, detail, kind, range, sel }); } }
class CodeAction { constructor(t, k) { this.title = t; this.kind = k; } }
class WorkspaceEdit { constructor() { this.edits = []; } replace(u, r, t) { this.edits.push([u, r, t]); } }
const cfg = { 'lint.labelNames': 'warning', 'lint.unknownCommands': 'information', 'lint.unknownOptions': 'information', 'compile.output': 'nextToProject', dictionaryPath: '', commandsPath: '', mgo2Key: '' };
const docs = [];
module.exports = {
  Position, Range, Selection, Diagnostic, MarkdownString, Hover, Location, CompletionItem, DocumentSymbol, CodeAction, WorkspaceEdit,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CompletionItemKind: new Proxy({}, { get: (_, k) => k }), SymbolKind: new Proxy({}, { get: (_, k) => k }),
  CodeActionKind: { QuickFix: 'quickfix' }, TextEditorRevealType: {},
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }) },
  workspace: { getConfiguration: () => ({ get: (k) => cfg[k] }), textDocuments: docs, workspaceFolders: [] },
  window: {}, languages: {}, commands: {},
  _docs: docs,
};
