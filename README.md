# GCL — Metal Gear GCX scripts for VS Code

**Decompile, edit and compile the `scenerio.gcx` scripts of Metal Gear Solid 4, Metal Gear Online 2 and Metal Gear
Arcade — with highlighting, autocomplete, linting and a byte-exact round trip.**

GCX files are the compiled form of GCL (Game Command Language), the TCL-like scripting language of the MGS4 engine.
Every stage has one: it spawns the actors, sets up the HUD, weapons and loadouts, defines the game rules and wires up
events. This extension turns a GCX file into readable GCL text, lets you edit it with full editor support, and
compiles it back into a file the game loads.

An unedited project compiles back to the original file **byte for byte**. Edited projects get every size, offset
and table rebuilt automatically.

---

## Installation

- **Marketplace:** search for **Metal Gear GCL** in the Extensions view (`Ctrl+Shift+X`), or run
  `ext install zoft123.metal-gear-gcl`.
- **From a `.vsix`:** download it from the [Releases](https://github.com/Zoft123/gcl-vscode/releases) page, then
  *Extensions view → … → Install from VSIX…*.

No other software is needed: the decompiler, the compiler and the name lists for hashes are all part of the
extension.

## Quick start

1. Right-click a `scenerio.gcx` in the Explorer and choose **Decompile GCX to GCL project**.
   A folder `scenerio/` is created next to it with `script.gcl` (the procs and main script) and `resources.gcl`
   (strings and data tables), and the script opens.
2. Edit. Errors and warnings appear as you type; hover anything to see what it is.
3. Press the **Compile** button in the editor title bar (or right-click the folder → **Compile GCL project to GCX**)
   and choose where to write the `.gcx`.

Metal Gear Online 2 stage files are encrypted. They are decrypted automatically when you decompile them (the key is
the `stage/<name>` folder in the file's path) and re-encrypted when you compile.

## Features

### Live diagnostics
Diagnostics come from the real compiler, so **a file with no errors compiles**. On top of syntax errors, the
extension checks for:

| Check | Example |
|---|---|
| Calls to procs that don't exist | `@proc999`, `-init_hud p:proc999` |
| Resources past the end of `resources.gcl` | `$res:99999` |
| Strings longer than the 254 bytes GCL allows | `print "…300 characters…"` |
| Names that look right but hash to something else | `chara NewSky …` — the word `NewSky` hashes to `8cda7b`, but the NewSky handler is `[ce2d24]` (one-click fix) |
| Typos in new option or command names | `-wp_di 3` when the script uses `-wp_id` everywhere else |
| Resource lines out of order or malformed | `resources.gcl` is checked line by line |

The guess-based checks only judge names a person typed. Decompiled code never trips them, and after a syntax error
only the error and the definite problems before it are shown.

### Autocomplete
- `@proc` and `p:proc` — every proc in the script, with a preview of its body.
- `-` after a command — the options used with that command in this script, ranked by how often they appear.
- Commands at the start of a statement — commands used in the script and every handler from `commands.txt`
  (typing `NewSk` inserts `[ce2d24/NewSky]`).
- `$res:` — resources with their text; `$` — `$status`, `$argN`, `$localN` and the variables used in the script.
- Snippets for `if`, `if / else`, `if / else if / else`, `switch`, `case`, `proc` and a rule check.

### Hover
Proc bodies, resource contents, hashes (handler label, dictionary names, use count), option codes, how a number will
be stored, variable layout (type, region, offset, bit), and what each `%(…)` encoding annotation means.

### Navigation
Go to definition and find references for procs (`@procN`, `p:procN`) and resources (`$res:N` jumps into
`resources.gcl`); an outline of all procs with the first statement of each.

### Names for hashes
GCL refers to commands, actor types, options and many values by 24-bit hashes. The extension ships with two
community name lists, so scripts read well from the first decompile:

- **`data/dictionary.txt`** — about 42,000 known strings. A hash is shown as a word (`chara`, `-wp_id`,
  `Rule_TDM`) only when that word really hashes to the stored value.
- **`data/commands.txt`** — handler names for about 270 command hashes, shown as labels: `[f576c7/COM_svGetRule]`.

To use newer or extended lists, put your own `dictionary.txt` / `commands.txt` next to the project (or up to four
folders above it), or set `gcl.dictionaryPath` / `gcl.commandsPath`. Names only change how hashes are displayed:
the compiled bytes never depend on them.

### Commands
| Command | Where |
|---|---|
| **GCL: Decompile GCX to GCL project** | Explorer context menu on `.gcx` files, command palette |
| **GCL: Compile GCL project to GCX** | editor title bar, Explorer context menu, command palette |
| **GCL: Verify GCX round trip** | Explorer context menu on `.gcx` files — decompiles and recompiles in memory and compares the bytes |
| **GCL: Reload dictionary and command names** | command palette |

## The GCL text format

```gcl
gcx timestamp=0x49d307e4 seed=0x00000000

proc 22 {
    command [5d0cc1] \
        -wp_id 7 \
        -num 80
}

proc 125 {
    if (4 == {
        command [f576c7/COM_svGetRule]
    }) {
        if ({
            command [5e8ea5]
        } & 2) {
            @proc121
            @proc22
        } else {
            @proc34
            @proc22
        }
    } else {
        @proc34
        @proc22
    }
}

main {
    ...
}
```

| Syntax | Meaning |
|---|---|
| `proc 3 7:1 { … }` | a proc; `@proc3` calls it. Ids are 1-based and must run 1..N without gaps; `7:1` = id 7 with flags 1 |
| `name args… -option values… \` | a command; a trailing `\` continues it on the next line |
| `if (…) { } else if (…) { } else { }` | control flow, as the original MGS source wrote it |
| `switch (…) { case X { } default { } }` | switch |
| `@proc12 1 2` | call proc 12 with arguments |
| `p:proc12` | pass proc 12 by reference (for example `-init_hud p:proc32`) |
| `word` / `[c2c7a0]` / `[ce2d24/NewSky]` | a 24-bit hash: a dictionary word, a raw hash, or a hash with a display label (labels are ignored when compiling) |
| `80`, `300:s32`, `5:u16` | numbers get the original compiler's encoding; a `:type` suffix keeps an explicit one |
| `"text"`, `e"テキスト"`, `b"\x00\x01"` | UTF-8 string, EUC-JP string, exact bytes |
| `$res:12` | resource 12 from `resources.gcl` |
| `$status`, `$arg1`, `$local0` | last result, proc argument, proc-local variable |
| `$s32@link:a9c`, `$bit@var:20.b3` | a game variable: type, region (`var`, `link`, `local`), offset, bit |
| `(($arg1 + 2) * 70000)` | an expression, fully parenthesised |
| `%(short=1)`, `%(w=1)`, `%(noend)` | quirks of the original compiler, kept so files rebuild byte for byte — leave them in place |

`resources.gcl` holds one resource per line: `index kind content`, where kind is `s` (a string) or `v` (a list of
values). Add new resources at the end with the next index and refer to them as `$res:N`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gcl.dictionaryPath` | *(bundled)* | your own `dictionary.txt`. Empty: one next to the project or up to four folders above it, then in the workspace folders, else the bundled list |
| `gcl.commandsPath` | *(bundled)* | your own `commands.txt` (`0xHASH -> Name`), searched the same way |
| `gcl.mgo2Key` | | MGO2 key (e.g. `stage/n001a`) for encrypted files whose path has no `stage/<name>` folder |
| `gcl.lint.labelNames` | `warning` | severity of the "name hashes to something else" check |
| `gcl.lint.unknownCommands` | `information` | severity of the unknown typed command check |
| `gcl.lint.unknownOptions` | `information` | severity of the unknown typed option check |
| `gcl.compile.output` | `ask` | `ask` for a destination each time, or `nextToProject` to write `<folder>.gcx` |


## Command line

The same engine runs in a terminal with Node.js 18 or later:

```sh
node bin/gcx.js scenerio.gcx              # decompile next to the file -> scenerio/
node bin/gcx.js decompile scenerio.gcx out/
node bin/gcx.js compile scenerio/ [out.gcx]
node bin/gcx.js verify a.gcx b.gcx …      # byte-exact round-trip check
```

Options: `--dict FILE`, `--labels FILE`, `--key stage/NAME`, `--no-encrypt`. Without `--dict` / `--labels` the
tool uses a `dictionary.txt` / `commands.txt` near the input file, else the bundled lists in `data/`.

## How it works

The GCX reader follows the game's own GCL interpreter: variable-length sizes, typed literals, variables, expressions
in stack form, options, commands, blocks and the proc table. The original compiler's choices are reproduced exactly
(number encodings, size-field widths, end markers), and the few places where it left unusual encodings carry a
`%(…)` annotation, so unedited text always compiles to the original bytes. MGO2 encryption is a 64-bit XOR chain
with an MD5-based checksum keyed by the stage folder.

## Development

```
extension.js            VS Code integration (diagnostics, completion, hover, navigation, commands)
lib/gcx.js              GCX container and bytecode: parse and rebuild
lib/gcltext.js          GCL text: decompiler (emitter), parser and compiler
lib/project.js          project folders, names, MGO2 decryption
lib/mgo2crypt.js        MGO2 stage-file encryption
bin/gcx.js              command-line tool
data/                   bundled name lists: dictionary.txt, commands.txt
syntaxes/, snippets/    grammar and snippets
test/                   provider tests against a mock of the VS Code API
build_vsix.py           packages the extension as a .vsix
```

- **Package:** `python3 build_vsix.py` writes `gcl-<version>.vsix` (no `vsce` or `npm install` needed).
- **Round-trip test:** `node bin/gcx.js verify path/to/*.gcx` — every file must report `OK`.
- **Provider tests:** decompile a script, then `node test/test-extension.js path/to/project` runs diagnostics,
  quick fixes, hovers, navigation and completion against it.
- **Run from source:** open this folder in VS Code and press `F5` to start an Extension Development Host.

## Roadmap

- Rename a proc id across the script (renumbering all `@procN` / `p:procN` references).
- Signature help for commands, learned from how each command is used.
- Semantic highlighting of hashes by kind (command, chara type, option).
- A built-in hex view of binary resources.
- Semantic checks for common commands (argument counts and types).

Issues and pull requests are welcome.

## Credits

- Format knowledge from the games' own GCL interpreter and the MGS2 `gclconv` sources.
- `dictionary.txt` and `commands.txt` are community name lists that started with Jayveer's
  [Gcx](https://github.com/Jayveer/Gcx) decompiler (MIT) and have been extended since.
- MGO2 decryption follows the method implemented by **HavenStudio2** of the MGO2 revival community (shared with
  [LA2 Studio](https://github.com/Zoft123/LA2_Studio)).

## Legal

This is an unofficial fan-made tool. It is not affiliated with, endorsed by or connected to Konami or Kojima
Productions. *Metal Gear*, *Metal Gear Solid*, *Metal Gear Online* and *Metal Gear Arcade* are trademarks of their
respective owners. The extension contains no game files: you need your own copies of the games' files. The bundled
name lists only map hashes to readable names.

## License

[MIT](LICENSE)
