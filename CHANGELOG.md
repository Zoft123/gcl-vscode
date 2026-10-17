# Changelog

## 0.1.0

First release.

- Decompile `.gcx` scripts (MGS4, MGO2, MGA) to GCL projects and compile them back; byte-exact round trip for
  unedited projects. MGO2 stage files are decrypted and re-encrypted automatically.
- Live diagnostics from the compiler, plus checks for undefined procs, missing resources, over-long strings,
  label names that hash to something else (with a quick fix) and typos in new option / command names.
- Autocomplete for procs, options, commands, resources, variables and control-flow snippets.
- Hovers, go to definition, find references and a proc outline.
- Syntax highlighting for scripts and resource files.
- Bundled `dictionary.txt` and `commands.txt` name lists (a user's own copies take priority).
- `bin/gcx.js` command-line tool with the same engine.
