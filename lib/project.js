'use strict';
// Project layer shared by the CLI and the VS Code extension: names, reading GCX files (MGO2 decryption included),
// writing / reading decompiled project folders (script.gcl, resources.gcl, font.bin).
const fs = require('fs');
const path = require('path');
const { Gcx, GcxError, bytesEqual } = require('./gcx');
const T = require('./gcltext');
const crypto = require('./mgo2crypt');

function loadNames(dictPath, labelsPath) {
  let words = [];
  if (dictPath && fs.existsSync(dictPath)) words = fs.readFileSync(dictPath, 'latin1').split(/\r?\n/);
  const labels = new Map();
  if (labelsPath && fs.existsSync(labelsPath)) {
    for (const l of fs.readFileSync(labelsPath, 'latin1').split(/\r?\n/)) {
      const m = /^\s*0x([0-9A-Fa-f]+)\s*->\s*(\S+)/.exec(l);
      if (m) labels.set(parseInt(m[1], 16), m[2]);
    }
  }
  return new T.Names(words, labels);
}

// "stage/<name>" from a path containing .../stage/<name>/<file>
function mgo2Key(p) {
  const m = /[\/\\](stage[\/\\][^\/\\]+)[\/\\][^\/\\]+$/.exec(p);
  return m ? m[1].replace(/\\/g, '/') : null;
}

// -> { gcx, key } ; key is the MGO2 key when the file was encrypted
function readGcx(file, key) {
  const data = new Uint8Array(fs.readFileSync(file));
  try { return { gcx: Gcx.parse(data), key: null, data }; }
  catch (e) {
    const k = key || mgo2Key(file);
    if (!k) throw e;
    const plain = crypto.decrypt(data, k);
    try { return { gcx: Gcx.parse(plain), key: k, data: plain }; }
    catch (e2) { throw new GcxError(e.message + ' (also tried MGO2 decryption with key ' + k + ')'); }
  }
}

function decompileToFolder(file, outDir, names, key) {
  const { gcx, key: k } = readGcx(file, key);
  let [script, res] = T.decompile(gcx, names);
  if (k) script = script.replace('\ngcx ', '\ngcx mgo2key=' + k + '\ngcx ');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'script.gcl'), script, 'utf8');
  fs.writeFileSync(path.join(outDir, 'resources.gcl'), res, 'utf8');
  if (gcx.font.length) fs.writeFileSync(path.join(outDir, 'font.bin'), gcx.font);
  return { gcx, key: k, outDir };
}

function readProject(dir) {
  const script = fs.readFileSync(path.join(dir, 'script.gcl'), 'utf8');
  const resPath = path.join(dir, 'resources.gcl');
  const res = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8') : '';
  const fp = path.join(dir, 'font.bin');
  const font = fs.existsSync(fp) ? new Uint8Array(fs.readFileSync(fp)) : new Uint8Array(0);
  return { script, res, font };
}

// -> { bytes, key, gcx }
function compileFolder(dir, names, opts = {}) {
  const { script, res, font } = readProject(dir);
  const g = T.compileText(script, res, names, font);
  let bytes = g.build();
  const key = opts.key || g.mgo2key || null;
  if (key && !opts.noEncrypt) bytes = crypto.encrypt(bytes, key);
  return { bytes, key: opts.noEncrypt ? null : key, gcx: g };
}

// decompile + compile in memory; -> { ok, textOk, binaryOk, procs, resources, key }
function verify(file, names, key) {
  const { gcx, key: k, data } = readGcx(file, key);
  const [script, res] = T.decompile(gcx, names);
  const g2 = T.compileText(script, res, names, gcx.font);
  const rebuilt = gcx.build();
  const textOk = bytesEqual(g2.build(), rebuilt);
  const binaryOk = bytesEqual(rebuilt, data);
  return { ok: textOk && binaryOk, textOk, binaryOk, procs: gcx.table.length, resources: gcx.resources.length, key: k };
}

module.exports = { loadNames, mgo2Key, readGcx, decompileToFolder, readProject, compileFolder, verify };
