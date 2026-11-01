'use strict';
// Regression: test the real Decompile command with stale nearby files and explicit overrides.
// Optional argument: an existing GCX/project pair to exercise its actual file lookup path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const P = require('../lib/project');
const T = require('../lib/gcltext');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcl-name-sources-'));
const dict = path.join(root, 'data', 'dictionary.txt');
const labels = path.join(root, 'data', 'commands.txt');
const staleDict = path.join(temp, 'dictionary.txt');
const staleLabels = path.join(temp, 'commands.txt');
fs.writeFileSync(staleDict, 'gecko_sight_range050_alp\nLegacyFixtureWord\n');
fs.writeFileSync(staleLabels, '0x4342cb -> StaleMultiplier\n0x123456 -> LegacyFixtureCommand\n');
const bundle = P.loadNames(dict, labels);
const defaults = P.loadNamesSources([dict, staleDict], [labels, staleLabels]);
assert.equal(defaults.labels.get(0x4342cb), 'DP_SetMultiplier');
assert.equal(defaults.labels.get(0x123456), 'LegacyFixtureCommand');
assert.equal(defaults.by.get(T.strcode('LegacyFixtureWord')), 'LegacyFixtureWord');
assert.equal(defaults.by.get(0xa64a2e), bundle.by.get(0xa64a2e));
const customLabels = path.join(temp, 'custom-commands.txt');
fs.writeFileSync(customLabels, '0x4342cb -> PreferredFixtureMultiplier\n');
const custom = P.loadNamesSources([staleDict, dict], [customLabels, labels]);
assert.equal(custom.labels.get(0x4342cb), 'PreferredFixtureMultiplier');
assert.equal(custom.labels.get(0x5d0cc1), 'WpMng_SetAmmoCount');
assert.equal(custom.by.get(0xa64a2e), 'gecko_sight_range050_alp');
let source = process.argv[2];
if (!source) {
  source = path.join(temp, 'stage', 'n001a', 'scenerio.gcx');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const script = 'gcx timestamp=0x0 seed=0x0\nmain {\ncommand [4ef1f0]\ncommand [5d0cc1]\ncommand [afe7f0]\ncommand [4342cb]\nprint [a64a2e]\n}\n';
  fs.writeFileSync(source, T.compileText(script, '', bundle).build());
  fs.copyFileSync(staleDict, path.join(path.dirname(source), 'dictionary.txt'));
  fs.copyFileSync(staleLabels, path.join(path.dirname(source), 'commands.txt'));
  fs.mkdirSync(path.join(path.dirname(source), 'scenerio'));
  fs.writeFileSync(path.join(path.dirname(source), 'scenerio', 'script.gcl'), '# existing project\n');
}
assert(fs.existsSync(source));
assert(fs.existsSync(path.join(path.dirname(source), 'scenerio', 'script.gcl')), 'Existing project required so output can be redirected safely');
const output = path.join(temp, 'decompiled');
const mock = require('./mock-vscode');
const config = { dictionaryPath: '', commandsPath: '', mgo2Key: '' };
const commands = new Map();
const logs = [];
const errors = [];
mock.workspace.getConfiguration = () => ({ get: key => config[key] });
mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(path.dirname(source)) }];
mock.workspace.onDidChangeConfiguration = mock.workspace.onDidOpenTextDocument = mock.workspace.onDidChangeTextDocument = mock.workspace.onDidCloseTextDocument = () => ({ dispose() {} });
mock.workspace.openTextDocument = async file => ({ uri: mock.Uri.file(file), languageId: 'gcl', getText: () => fs.readFileSync(file, 'utf8') });
mock.commands.registerCommand = (name, fn) => (commands.set(name, fn), { dispose() {} });
mock.languages = new Proxy({}, { get: (_, key) => key === 'createDiagnosticCollection' ? () => ({ set() {}, delete() {}, dispose() {} }) : () => ({ dispose() {} }) });
mock.window = {
  createOutputChannel: () => ({ appendLine: line => logs.push(line), show() {}, dispose() {} }),
  showWarningMessage: async () => 'Choose folder…',
  showOpenDialog: async () => [mock.Uri.file(output)],
  showTextDocument: async () => {},
  showInformationMessage: () => {},
  showErrorMessage: message => errors.push(message)
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) { return request === 'vscode' ? require.resolve('./mock-vscode') : resolve.call(this, request, ...args); };
const originalDecompile = P.decompileToFolder;
P.decompileToFolder = (file, dir, ...args) => {
  assert.equal(dir, output, 'Test must never overwrite the real project');
  return originalDecompile(file, dir, ...args);
};
const expected = [[0x4ef1f0, 'ComNetPlayerSetArgs'], [0x5d0cc1, 'WpMng_SetAmmoCount'], [0xafe7f0, 'DP_SetActionPoint'], [0x4342cb, 'DP_SetMultiplier']];
(async () => {
  try {
    require('../extension').activate({ subscriptions: [] });
    await commands.get('gcl.decompile')(mock.Uri.file(source));
    assert.deepEqual(errors, []);
    const script = fs.readFileSync(path.join(output, 'script.gcl'), 'utf8');
    for (const [hash, label] of expected) assert(script.includes('[' + hash.toString(16) + '/' + label + ']'), label);
    assert(script.includes(bundle.by.get(0xa64a2e)), 'New bundled dictionary word must be emitted');
    const built = P.compileFolder(output, defaults);
    assert(Buffer.from(built.gcx.build()).equals(Buffer.from(P.readGcx(source).data)), 'Actual command output must compile to the original GCX bytes');
    if (process.env.GCL_REVIEW_OUTPUT) {
      fs.mkdirSync(process.env.GCL_REVIEW_OUTPUT, { recursive: true });
      for (const name of fs.readdirSync(output)) fs.copyFileSync(path.join(output, name), path.join(process.env.GCL_REVIEW_OUTPUT, name));
      fs.writeFileSync(path.join(process.env.GCL_REVIEW_OUTPUT, 'name-sources.log'), logs.join('\n') + '\n');
    }
    const cliOutput = path.join(temp, 'cli-output');
    let cli = spawnSync(process.execPath, [path.join(root, 'bin', 'gcx.js'), 'decompile', source, cliOutput], { cwd: temp, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    let text = fs.readFileSync(path.join(cliOutput, 'script.gcl'), 'utf8');
    for (const [hash, label] of expected) assert(text.includes('[' + hash.toString(16) + '/' + label + ']'), 'CLI ' + label);
    cli = spawnSync(process.execPath, [path.join(root, 'bin', 'gcx.js'), 'decompile', source, path.join(temp, 'cli-custom'), '--labels', customLabels], { cwd: temp, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    text = fs.readFileSync(path.join(temp, 'cli-custom', 'script.gcl'), 'utf8');
    assert(text.includes('[4342cb/PreferredFixtureMultiplier]'));
    assert(text.includes('[5d0cc1/WpMng_SetAmmoCount]'));
    config.commandsPath = customLabels;
    await commands.get('gcl.decompile')(mock.Uri.file(source));
    text = fs.readFileSync(path.join(output, 'script.gcl'), 'utf8');
    assert(text.includes('[4342cb/PreferredFixtureMultiplier]'));
    assert(text.includes('[5d0cc1/WpMng_SetAmmoCount]'));
    console.log('PASS: real Decompile command, stale local files, bundled dictionary words, all four labels, explicit overrides, CLI, and byte-exact recompilation.');
    console.log('GCX: ' + source);
  } finally {
    P.decompileToFolder = originalDecompile;
    Module._resolveFilename = resolve;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
