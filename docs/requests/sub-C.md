# Requests from sub-C (gp2-7.11c, sub $C000-$DFFF)

Copyright 2026 by Moshix

1. **index.html MODULES**: run `node tools/gen-index.mjs` to list the new
   files `src/game/sub/gp2_7.js` and `src/game/sub/gp2_7_paths.js`
   (`test/unit/index-html.test.mjs` fails until then, for every porter's
   new files, not only these).
2. **sub/index.js** (integration): import `./gp2_7.js` like the other
   chip modules. It registers nothing (the chip has no code), so the
   import is only for uniformity.
3. **romdata mask**: when code/data separation is switched on, keep the
   whole of $C000-$DFFF readable as data. `gp2_7_paths.js` (tests and
   docs only) reads the 30 bytes of `$F0` back-pointers and the copyright
   text, which the ROM itself never reads, so a mask built from the
   coverage `dataRead` alone would make it throw.
4. **Annotations**: `reference/annotations/proposed/sub-C.json` names
   the 46 path streams `path_XXXX` (this replaces the generated
   `dat_C000`, `dat_C0E9`, `dat_DADC`, `dat_DD44`; no JS code uses those
   names), types each stream and its 3-byte command as data with a
   comment, and marks the second copyright string at $DEFB as text.
