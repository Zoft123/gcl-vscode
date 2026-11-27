// Run: node test/test-mgs3.js   (no game files needed)
// MGS3 / MGO1 dialect (letter-only options, "LCGB" HD magic, format detection) and the dialect-independent
// expression / if fixes: unary operators take a dummy 0 left operand; long if bodies keep the else sugar.
'use strict';
const assert = require('assert');
const { Gcx, bytesEqual, FORMATS } = require('../lib/gcx');
const T = require('../lib/gcltext');

const names = new T.Names([], new Map());
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  ' + name); };

const longBody = Array.from({ length: 40 }, (_, i) => '        ($s32@var:' + (0x100 + 4 * i).toString(16) + ' = ' + (1000 + i) + ')').join('\n');
const script = (header) => `${header}

proc 1 {
    if ($arg1 <= 20) {
${longBody}
    } else if ($arg1 <= 30) {
        command [123456] -W 4204 -F (! ($s32@link:8 & 1024))
    } else {
        ($s32@var:200 = (- $arg1))
    }
}

main {
    @proc1 5
    switch ($s32@var:10) {
        case 1 {
            command [abcdef] -g "s066a" -d 0 0 220 200
        }
        default {
            ($s32@var:20 = (~ 3))
        }
    }
}
`;

function roundTrip(text, opts) {
  const g = T.compileText(text, '', names);
  const bytes = g.build();
  const back = Gcx.parse(bytes, opts);
  assert.ok(bytesEqual(back.build(), bytes), 'binary round trip');
  const [text2] = T.decompile(back, names);
  assert.ok(bytesEqual(T.compileText(text2, '', names).build(), bytes), 'text round trip');
  return { g, bytes, back, text2 };
}

test('MGS3 script: letter-only options compile and round-trip', () => {
  const { g, bytes, back, text2 } = roundTrip(script('gcx format=mgs3 timestamp=0x4371bedb seed=0x00000000'));
  assert.strictEqual(g.format, 'mgs3');
  assert.strictEqual(back.format, 'mgs3', 'detected from the 2005 timestamp');
  assert.ok(/^gcx format=mgs3 /m.test(text2));
  assert.ok(/-W 4204[\s\\]+-F \(! \(\$s32@link:8 & 1024\)\)/.test(text2), 'options print as letters, unary prints as (! x)');
  // the option is the tag byte, its letter and the value (no 3-byte hash): ... 0x5? 'W' ...
  const w = bytes.indexOf(0x57);
  assert.ok(w > 0 && (bytes[w - 1] & 0xF0) === 0x50 && bytes[w + 1] !== 0x57, 'letter directly after the option tag');
});

test('MGS4 script: same text with option hashes, detected as mgs4', () => {
  const { back, text2 } = roundTrip(script('gcx timestamp=0x49d307e4 seed=0x00000000'));
  assert.strictEqual(back.format, 'mgs4');
  assert.ok(!/format=/.test(text2.split('\n')[1]));
  assert.ok(/-W 4204/.test(text2));
});

test('MGS3 HD: LCGB magic kept, detected without relying on the timestamp', () => {
  const { bytes, back, text2 } = roundTrip(script('gcx format=mgs3 magic=LCGB timestamp=0x49d307e4 seed=0x00000000'));
  assert.deepStrictEqual(Array.from(bytes.subarray(0, 4)), [0x4C, 0x43, 0x47, 0x42]);
  assert.strictEqual(back.format, 'mgs3');
  assert.ok(/^gcx format=mgs3 magic=LCGB /m.test(text2));
});

test('detection falls back to the other dialect when the timestamp guess fails', () => {
  const bytes = T.compileText(script('gcx format=mgs3 timestamp=0x49d307e4 seed=0x00000000'), '', names).build();
  const g = Gcx.parse(bytes);            // 2009 timestamp: mgs4 is tried first and fails on the letter-only options
  assert.strictEqual(g.format, 'mgs3');
  assert.ok(bytesEqual(g.build(), bytes));
  assert.throws(() => Gcx.parse(bytes, { format: 'mgs4' }));
});

test('unary operators compile with a dummy 0 left operand', () => {
  const g = T.compileText('gcx timestamp=0x49d307e4 seed=0x00000000\nmain {\n    ($s32@var:0 = (! $s32@var:4))\n}\n', '', names);
  const expr = g.main[2][0][2];          // [var, 0, var, !, =, end-of-expression]
  assert.deepStrictEqual(expr.map(x => x[0] === 'op' ? 'op' + x[1].toString(16) : x[0] === 'small' ? 's' + x[1] : x[0]),
    ['var', 's0', 'var', 'opa2', 'opb6', 'opa0']);
});

test('MGS3 rejects MGS4-style option names', () => {
  assert.throws(() => T.compileText('gcx format=mgs3 timestamp=0x4371bedb seed=0x00000000\nmain {\n    command [123456] -name 1\n}\n', '', names),
    /single letter/);
});

test('format must be known before the procs', () => {
  assert.throws(() => T.compileText('main {\n}\ngcx format=mgs3\n', '', names), /before the procs/);
  assert.ok(FORMATS.mgs3 && FORMATS.mgs4);
});

test('select calls: @procN:select is id 0x8000 | N; the older @proc32788 spelling still compiles', () => {
  const src = (call) => 'gcx format=mgs3 timestamp=0x4371bedb seed=0x00000000\nproc 1 2:16 {\n}\nproc 3 {\n}\nmain {\n    ' + call + '\n}\n';
  const { g, text2 } = roundTrip(src('@proc2:select'));
  assert.strictEqual(g.main[2][0][2], 0x8002);
  assert.ok(/@proc2:select/.test(text2));
  const old = T.compileText(src('@proc32770'), '', names).build();
  assert.ok(bytesEqual(old, g.build()));
});

console.log(passed + ' tests passed');
