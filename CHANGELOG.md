# Changelog

## 0.1.7

- **Metal Gear Solid 3 / Metal Gear Online (MGS3 engine) scripts**: decompile and compile PS2 MGS3 Subsistence and
  MGO1 GCX files and the PS3 HD port's (which start with the magic `LCGB`). Their options are a letter only
  (`-W 4204`) instead of letter + name hash. The dialect is detected from the file and written to the project
  header (`gcx format=mgs3`, plus `magic=LCGB` for the HD port). Checked byte for byte on 75 PS2 files
  (MGS3 stages and slots, MGO1 stages) and all 612 HD-port files.
- **Select calls**: `@procN:select` (call id `0x8000 | N`; the game takes the variant of proc N whose select number
  matches its current selection). Previously printed as `@proc32788` and reported as an undefined proc; the old
  spelling still compiles.
- **Unary operators** (`-x`, `!x`, `~x`) now decompile as expressions in MGS4 / MGO2 scripts too, instead of
  `%(rpn)(…)`: the original compilers emit them with a dummy 0 left operand, which the compiler now also writes.
- **Long `if` / `switch` bodies** (argument lists over 127 bytes) now print as `if … else if … else` / `switch`
  instead of the raw `-i` / `-e` / `-c` / `-d` option form.
- Option hovers in MGS3 scripts describe letter-only options.
- Bundled `commands.txt`: 56 MGO1 command handlers traced in the MGO1 stage overlays (the actor each handler
  creates), e.g. `NewNetworkDummyPlayer`, `NewOnlineGameSupervisor`, `NewOnlineRadarMan`, the `New…Ricochet` set.
- Bundled `dictionary.txt`: 638 names. 229 from the MGS3 HD port's `manifest.txt` / `bp_assets.txt` asset lists
  (only names whose hash equals the listed file hash), 402 strings that MGS3 / MGO1 scripts contain in the same file
  as the hash they name, and 12 MGO1 binary strings that name MGO1 script hashes.

## 0.1.6

- Fixed name-file lookup: older dictionaries and command lists beside a GCX no longer hide names added by extension updates. Bundled names take priority and local files supplement missing names.
- Explicit custom name-file settings and CLI flags still override bundled names while keeping bundled fallbacks.
- Decompile logs show the name-file sources being used.
- Includes the exact command and dictionary files supplied for 0.1.5.

## 0.1.5

- Updated the bundled command and dictionary name lists only.

## 0.1.4

- Fixed: `-proc` (and any option named like a keyword) decompiled as `-p[39d643]`; it now prints as `-proc`. Keywords
  are still never used for bare names, where they would read as syntax.
- Bundled `dictionary.txt`: 171 option names recovered from the handler code of MGO2, MGS4 and Metal Gear Arcade
  (every unknown option hash in the MGO2 stage scripts was checked). Among them:
  - snowstorm (Icebound Inferno): the `min_` / `max_` pairs of `fog_alpha`, `fog_color`, `wind_ratio`, `glare_*`,
    `colFil_*`, `fog_before_*`, `cloudsky_*`, `gas_alpha`, `ball_alpha`, `before_fog_alpha` and more; `cam_shake_scale`
  - cloud sky `cloud_way`, `cloud_reptime`; prim lights `uv_scroll_tex`, `uv_scroll_param`, `far_fade_dist`, `add_blend`
  - power lines `mdnname`, `sklname0`-`sklname6`, `cnpdirname`, `denmass`, `denspringk`, `denwind`, `denrand`,
    `denairK` and their numbered `den1`/`den2`/`den3` forms
  - doors `door_model`, `door_motion`, `door_coll`, `body_coll`, `prop_pnt`; glass `mesh_frame`, `mesh_glass`;
    materials `splash_effect`, `hole_effect`; `portal`, `shadow_buffer_mode`, `noblock`, `whiteout`, `lef`,
    `proc_cursor`, `proc_start`, `proc_end`, `height_range`
  - supervisor gun locks `penalty_die`, `penalty_max`, `FFLock_sec`, `GOP_sec`, `GOP_FFLock_sec`, `Liquid_GOP_sec`;
    elude `dist_xz`, `fall_height_range`, `dir_range`, `catch_*`; camera `trAck`, `PstStand`, `PstSquat`, `PstCrawl`
  - a few are best guesses that fit the hash but are not confirmed by code: `normal_blend`, `depth_blend`,
    `recoil_effect`, `camera_rot_x_range`, `rain`, `errcode`, `loop_se`, `ir_dark`, `proc_wall`, `no_rear`,
    `refraction_rate`, `halo_rate`.

## 0.1.3

- Fixed: options whose names contain a capital letter (`-goalA`, `-flatBattle`, `-respPenalty`, `-timeMax`, `-propM`,
  ...) decompiled as `-A[a911c7]` even when the name was known, and a hand-written one compiled with the wrong
  letter. The game stores such options under the name's first capital letter (otherwise its first character): that
  letter is what handlers look up with `GCL_GetOption`. Checked against every option of the MGO2 stage scripts whose
  name is known. When several dictionary names share a hash, the stored letter now picks the right one.
- Bundled `dictionary.txt`: `middle_gray`, `max_ave_lum`, `min_ave_lum`, `force_ave_lum`, `force_ave_lum_blend` and
  its misspelt twin `force_ave_lum_bledn` (both accepted by the exposure handler), `ae_type`, `upperthreshold`
  (glare) and `gauss_bloom`; plus the names collected since 0.1.2.

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
