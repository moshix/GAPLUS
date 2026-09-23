# Requests from sub-E (gp2-6.11b, sub $E000-$FFFF)

Copyright 2026 by Moshix

1. **Done** (integration round 2): markers, sub/index.js, index.html.
   Round 2 adds no new file (the timed bus helpers live in
   `gp2_6_state.js`), so index.html needs no change.
2. **Listing (lead)**: merge `reference/annotations/proposed/sub-E.json`.
   `sub_E8B0` ($E8B0) stores A (`sta <$D8`) where its siblings store B:
   likely a ROM bug worth a listing comment.
3. **Scheduler (integration)**: the sub is now cycle-exact and SYNCs
   every shared access. The first lockstep difference (frame 252,
   `attract_timer`) comes from the slice grid, not the sub: in frame
   236 the sub writes `$10AF = $11` at 4,830 on both sides, but the
   port's slices start at 4,121 + 256k (the board's at 76.8 + 256k), so
   the main handler's poll sees it at 4,889 instead of 4,941. Two causes
   seen: (a) `ioCatchUp` delivering the I/O run early drops its slice
   cut (`ioCut = Infinity`), which MAME keeps (the timer still fires and
   cuts the slice); (b) the main handler starts 9-25 cycles after vblank
   in the port, 0-5 on the board. Details: docs/modules/sub-E.md,
   "Lockstep".
