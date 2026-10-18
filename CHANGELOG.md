# Changelog

## 0.1.2

- Fixed: a command whose options are followed by a bare value (`!= v`) could not be recompiled
  ("cannot read value '!='"). Seen in edited MGO2 stage scripts.
- Bundled `dictionary.txt`: 121 more names (104 command parameters such as `-se_exchg`, `-model_pos`, `-equip`,
  `-hit_rate`, plus `MAIN_TITLE`, `SUB_TITLE_CP0001`, MGA chara names and a few others), all strings found in the
  game executables.
- Bundled `commands.txt`: labels for the MGO2 weapon-select commands: `WpMng_SetWeaponList` (d7cbe5),
  `WpMng_AddWeapon` (986321), `WpMng_SetCustom` (538fd2), `WpMng_AddBullet` (2a363c), `ItemMng_SetItemList`
  (0f4b64). These are descriptive names chosen from what the handlers do; no original names survive.

## 0.1.1

- Encryption follows the disc / PSN title ID in the path: `USRDIR/o` (MGO2) is always encrypted, `USRDIR/mgs`
  (MGS4) is encrypted on the PSN releases (NPUB31633, NPEB02182, NPJB00698) and plain on the Blu-ray discs. The
  compile destination is checked the same way.

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
