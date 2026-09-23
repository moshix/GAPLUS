# Requests from main-C (main CPU gp2-3b.8c, $C000-$DFFF)

Copyright 2026 by Moshix

## 1. IRQ exits without RTI (integration)

`irq_main` ($C000) has two exits that are JMPs, not RTI: `$C016 lbne
service_mode` and `$C0A8 jmp attract_loop` (coin during the demo). It
records them with `requestJump` and returns. `JsAgent.runTo` treats the
return as RTI and clears `iMask`; on the 6809 CC.I stays set until the
code jumped to clears it. For attract_loop that is 5 cycles (`sta
$7400` before its `andcc #$EF`) and nothing can be pending then, so it
is harmless; for service_mode ($B6F6, gp2-4) please check what it
expects. Suggestion: if `pendingJump(m) !== null` when the handler
returns, leave `iMask` set and let the driver take the jump.

## 2. Cycle accounting (integration, lead)

Every routine of gp2-3b charges its exact 6809 cycles with `m.charge`
(verified against the oracle in the tests), so `JsAgent.cost` never
needs the measured medians for this chip. The boot (gp2-2b) keeps its
own `clock.js` burn clock instead and charges nothing. If the lead
wants one mechanism, `burn(m, n)` could also call `m.charge(n)`, so
that `m.charged[0]` is the main CPU's single account.

## 3. Proposed names

`reference/annotations/proposed/main-C.json`.
