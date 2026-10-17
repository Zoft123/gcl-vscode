#!/usr/bin/env node
'use strict';
// gcx: decompile GCX script files to editable GCL text, and compile GCL text back (byte-exact for unedited text).
//
//   gcx scenerio.gcx                     decompile next to the file (-> scenerio/ with script.gcl, resources.gcl)
//   gcx decompile scenerio.gcx [outdir]  same, choosing the folder
//   gcx compile projdir [out.gcx]        compile (re-encrypted when the project came from an encrypted MGO2 file)
//   gcx verify a.gcx [b.gcx ...]         decompile + compile in memory and compare bytes
// Options: --dict FILE, --labels FILE (commands.txt), --key stage/NAME (MGO2), --no-encrypt
const fs = require('fs');
const path = require('path');
const P = require('../lib/project');

// dictionary.txt / commands.txt: next to the input or up to four folders above it, then the current folder
function findDefault(name, start) {
  let dir = start ? path.resolve(start) : null;
  if (dir && fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (let i = 0; dir && i <= 4; i++) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  const p = path.join(process.cwd(), name);
  return fs.existsSync(p) ? p : null;
}

function main(argv) {
  const opts = { dict: null, labels: null, key: null, noEncrypt: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dict') opts.dict = argv[++i];
    else if (a === '--labels') opts.labels = argv[++i];
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--no-encrypt') opts.noEncrypt = true;
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
    else rest.push(a);
  }
  const start = rest.find(a => fs.existsSync(a)) || null;
  const names = P.loadNames(opts.dict || findDefault('dictionary.txt', start), opts.labels || findDefault('commands.txt', start));
  let [mode, ...args] = rest;
  if (mode && mode.toLowerCase().endsWith('.gcx') && fs.existsSync(mode)) { args = [mode]; mode = 'decompile'; }
  if (mode && fs.existsSync(mode) && fs.statSync(mode).isDirectory() && fs.existsSync(path.join(mode, 'script.gcl'))) { args = [mode]; mode = 'compile'; }
  if (mode === 'decompile') {
    const [src, out] = args;
    const dir = out || path.join(path.dirname(src), path.basename(src, path.extname(src)));
    const r = P.decompileToFolder(src, dir, names, opts.key);
    console.log('wrote ' + dir + ' (' + r.gcx.table.length + ' procs, ' + r.gcx.resources.length + ' resources' + (r.key ? ', decrypted with ' + r.key : '') + ')');
    return 0;
  }
  if (mode === 'compile') {
    const [dir, out] = args;
    const dest = out || path.join(path.dirname(path.resolve(dir)), path.basename(path.resolve(dir)) + '.gcx');
    const r = P.compileFolder(dir, names, opts);
    fs.writeFileSync(dest, r.bytes);
    console.log('wrote ' + dest + ' (' + r.bytes.length + ' bytes' + (r.key ? ', encrypted with ' + r.key : '') + ')');
    return 0;
  }
  if (mode === 'verify') {
    let bad = 0;
    for (const f of args) {
      try {
        const r = P.verify(f, names, opts.key);
        console.log((r.ok ? 'OK  ' : 'FAIL') + '  text round trip ' + r.textOk + ', binary ' + r.binaryOk + '  ' + f);
        if (!r.ok) bad++;
      } catch (e) { console.log('ERR   ' + e.message + '  ' + f); bad++; }
    }
    return bad ? 1 : 0;
  }
  console.error('usage: gcx <file.gcx> | gcx decompile <file.gcx> [outdir] | gcx compile <dir> [out.gcx] | gcx verify <file.gcx>...');
  return 2;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { console.error('error: ' + e.message); process.exitCode = 1; }
