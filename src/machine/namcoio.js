// Copyright 2026 by Moshix
/**
 * Gaplus custom I/O chips: the 56XX at $6800-$680F, the 58XX at
 * $6810-$681F and the 62XX at $6820-$682F (main CPU addresses).
 *
 * A faithful port of MAME's high-level model (reference/mame/namco/
 * namcoio.cpp for the 56XX/58XX, gaplus_m.cpp for the 62XX), not of the
 * MB88xx firmware, which MAME does not run either. docs/hardware.md
 * section 5 is the summary this file implements.
 *
 * How the chips work, as MAME models them:
 *
 *  - Each 56XX/58XX owns 16 nibbles of RAM. The CPU writes a command into
 *    nibble 8 and its arguments into 9-15; once per frame, 50 us after the
 *    vblank interrupt, the chip runs `customio_run()`, which acts on the
 *    command and writes its results into nibbles 0-7. The CPU reads a
 *    nibble back as $F0 | value (the RAM is 4 bits wide).
 *  - FRESET (main CPU writes to $9000-$9FFF) holds both chips in reset:
 *    the frame run is skipped while the line is asserted, and asserting it
 *    re-initialises the coin/credit counters (but not the nibble RAM).
 *  - The 62XX is not emulated at all by MAME: its 16 bytes are plain 8-bit
 *    RAM with a few reads overridden by fixed values, and a write of $0F or
 *    more to $6829 starts the "bang" (explosion) sample.
 *
 * Timing is the host's job and is explicit here: at each vblank instant
 * the host calls {@link GaplusIo#vblank} (which decides, from the reset
 * lines at that instant, which chips will run), and
 * {@link IO_RUN_DELAY_CYCLES} CPU cycles later it calls
 * {@link GaplusIo#update}, which performs the runs. The browser port, which
 * has no sub-frame clock, calls update() right after vblank() and BEFORE
 * the main IRQ handler: the handler's reads that can see the run's
 * results (`LDD $6800` at $C01A, cycles 79-80; `LDA $6802` at $C055) all
 * come after cycle 76.8 in MAME (docs/porting-guide.md section 6.1; the
 * one exception is the SW1:6 operator-stats read of $6805 at $FCE8).
 *
 * The module is shared by the browser port and by the test oracle board,
 * so it is deterministic, has no browser or Node dependencies, and every
 * piece of state is covered by getState()/setState().
 */

/** MAME: `namcoio_run_timer->adjust(attotime::from_usec(50))`. */
export const IO_RUN_DELAY_US = 50;

/**
 * 50 us at the 1.536 MHz CPU clock = 76.8 CPU cycles. MAME's 6809 stops
 * mid-instruction at the timer, so a bus access in cycle index vblank + 76
 * or later sees the run's results and one in cycle vblank + 75 or earlier
 * does not. The oracle board reproduces that exactly (Board.ioCatchUp
 * runs the pending update before the first main-CPU access to
 * $6800-$681F past the deadline, or at the deadline otherwise).
 */
export const IO_RUN_DELAY_CYCLES = (IO_RUN_DELAY_US * 1536000) / 1e6;

// --------------------------------------------------------------- inputs

/**
 * Factory DIP settings for `gaplus` (docs/hardware.md section 8): every
 * switch OFF, so every 4-bit port reads $F. As MAME port values (active
 * low: a 0 bit is a switch that is ON).
 *
 *   DSWA_HIGH $F: coin A 1C1C, 3 lives
 *   DSWA_LOW  $F: coin B 1C1C, SW1:6 off, demo sounds on
 *   DSWB_LOW  $F: bonus 50k/150k/every 150k, round advance off
 *   DSWB_HIGH $F: difficulty 0 (standard), service mode off (gapluso)
 */
export const DEFAULT_DIPS = Object.freeze({
  DSWA_HIGH: 0x0f,
  DSWA_LOW: 0x0f,
  DSWB_LOW: 0x0f,
  DSWB_HIGH: 0x0f,
});

/**
 * 62XX input IN2 default (gapluso ports): bit 2 = 1 upright cabinet, the
 * other three bits unused/unknown and pulled high.
 */
export const DEFAULT_IN2 = 0x0f;

/**
 * The DIP switch fields, as `[port, mask, shift]`. Values are the port
 * values of docs/hardware.md section 8 (active low), e.g. lives 3 = $C.
 * @type {Readonly<Record<string, readonly [DipPort, number, number]>>}
 */
export const DIP_FIELDS = Object.freeze({
  coinA: ['DSWA_HIGH', 0x03, 0],        // 0=3C1C 1=2C1C 3=1C1C 2=1C2C
  lives: ['DSWA_HIGH', 0x0c, 0],        // $8=2 $C=3 $4=4 $0=5
  coinB: ['DSWA_LOW', 0x03, 0],         // as coin A
  sw1_6: ['DSWA_LOW', 0x04, 0],         // "unused", read at $FCDF
  demoSounds: ['DSWA_LOW', 0x08, 0],    // $0 off, $8 on
  bonus: ['DSWB_LOW', 0x07, 0],         // 7 = 50k/150k/every 150k
  roundAdvance: ['DSWB_LOW', 0x08, 0],  // $8 off, $0 on
  difficulty: ['DSWB_HIGH', 0x07, 0],   // 7 = standard ... 0 = hardest
  serviceMode: ['DSWB_HIGH', 0x08, 0],  // $8 off, $0 on (SW2:1)
});

/** @typedef {'DSWA_HIGH'|'DSWA_LOW'|'DSWB_LOW'|'DSWB_HIGH'} DipPort */

/**
 * One joystick. `true` = pushed.
 * @typedef {object} Stick
 * @property {boolean} up
 * @property {boolean} right
 * @property {boolean} down
 * @property {boolean} left
 */

/**
 * Everything the player and the operator can change, in plain terms.
 * The host mutates it in place; the chips sample it when they run.
 * `true` means pressed / held. DIPs and IN2 are MAME port values.
 * @typedef {object} InputState
 * @property {boolean} coin1    COINS b0
 * @property {boolean} coin2    COINS b1
 * @property {boolean} service  COINS b3 (service coin, adds a credit)
 * @property {boolean} start1   BUTTONS b2
 * @property {boolean} start2   BUTTONS b3
 * @property {boolean} fire1    BUTTONS b0
 * @property {boolean} fire2    BUTTONS b1 (cocktail)
 * @property {Stick} p1         P1 port
 * @property {Stick} p2         P2 port (cocktail)
 * @property {Record<DipPort, number>} dips  4-bit port values
 * @property {number} in2       62XX IN2 port value (4 bits)
 */

/** @returns {Stick} */
const stick = () => ({ up: false, right: false, down: false, left: false });

/**
 * A fresh input state: nothing pressed, factory DIPs.
 * @returns {InputState}
 */
export function createInputState() {
  return {
    coin1: false,
    coin2: false,
    service: false,
    start1: false,
    start2: false,
    fire1: false,
    fire2: false,
    p1: stick(),
    p2: stick(),
    dips: { ...DEFAULT_DIPS },
    in2: DEFAULT_IN2,
  };
}

/**
 * Set a DIP field by value (the port value of the field, unshifted as in
 * docs/hardware.md, e.g. `setDip(inp, 'lives', 0x8)` for 2 lives).
 * @param {InputState} inp @param {keyof typeof DIP_FIELDS} name
 * @param {number} value
 */
export function setDip(inp, name, value) {
  const [port, mask] = DIP_FIELDS[name];
  inp.dips[port] = (inp.dips[port] & ~mask & 0x0f) | (value & mask);
}

/**
 * Joystick port value (active low), as MAME's PORT_8WAY delivers it:
 * a contradictory pair (up+down, left+right) is removed entirely, which
 * is MAME's default without `-joystick_contradictory`.
 * @param {Stick} s @returns {number}
 */
export function stickPort(s) {
  let up = s.up;
  let down = s.down;
  let left = s.left;
  let right = s.right;
  if (up && down) { up = false; down = false; }
  if (left && right) { left = false; right = false; }
  // Bits: b0 up, b1 right, b2 down, b3 left; 0 = pushed.
  const on = (up ? 1 : 0) | (right ? 2 : 0) | (down ? 4 : 0) | (left ? 8 : 0);
  return ~on & 0x0f;
}

/**
 * All MAME input ports of the `gapluso` configuration, active low.
 * @param {InputState} inp
 * @returns {{ COINS: number, P1: number, P2: number, BUTTONS: number,
 *   DSWA_HIGH: number, DSWA_LOW: number, DSWB_LOW: number,
 *   DSWB_HIGH: number, IN2: number }}
 */
export function inputPorts(inp) {
  const coins = (inp.coin1 ? 1 : 0) | (inp.coin2 ? 2 : 0) | (inp.service ? 8 : 0);
  const buttons = (inp.fire1 ? 1 : 0) | (inp.fire2 ? 2 : 0)
    | (inp.start1 ? 4 : 0) | (inp.start2 ? 8 : 0);
  return {
    COINS: ~coins & 0x0f,
    P1: stickPort(inp.p1),
    P2: stickPort(inp.p2),
    BUTTONS: ~buttons & 0x0f,
    DSWA_HIGH: inp.dips.DSWA_HIGH & 0x0f,
    DSWA_LOW: inp.dips.DSWA_LOW & 0x0f,
    DSWB_LOW: inp.dips.DSWB_LOW & 0x0f,
    DSWB_HIGH: inp.dips.DSWB_HIGH & 0x0f,
    IN2: inp.in2 & 0x0f,
  };
}

// ---------------------------------------------------------- 56XX / 58XX

/**
 * Snapshot of one 56XX/58XX (MAME's save_item list).
 * @typedef {object} NamcoIoState
 * @property {number[]} ram          16 nibbles
 * @property {number} reset          1 while the reset line is asserted
 * @property {number} lastcoins      edge detector for COINS (int32)
 * @property {number} lastbuttons    edge detector for BUTTONS (int32)
 * @property {number} credits
 * @property {number[]} coins        coins inserted towards the next credit
 * @property {number[]} coinsPerCred
 * @property {number[]} credsPerCoin
 * @property {number} inCount
 */

/**
 * Behaviour shared by the 56XX and 58XX (MAME `namcoio_device`).
 * Subclasses supply {@link NamcoIo#run}.
 */
export class NamcoIo {
  /**
   * @param {Array<() => number>} inCb four input ports (pins 38-41, 22-25,
   *   26-29, 30-33), each returning the active-low port value
   * @param {Array<(v: number) => void>} [outCb] two output ports (lamps;
   *   not connected in `gapluso`)
   */
  constructor(inCb, outCb = []) {
    /** 16 nibbles; the CPU sees $F0 | ram[n]. */
    this.ram = new Uint8Array(16);
    this.inCb = inCb;
    this.outCb = outCb;
    // MAME's member initialisers: everything 0 at power-on. lastcoins and
    // lastbuttons are never reset afterwards.
    this.reset = 0;
    this.lastcoins = 0;
    this.lastbuttons = 0;
    this.credits = 0;
    this.coins = [0, 0];
    this.coinsPerCred = [0, 0];
    this.credsPerCoin = [0, 0];
    this.inCount = 0;
    this.deviceReset();
  }

  /** @param {number} n @returns {number} input port n, as the chip reads it */
  in(n) { return this.inCb[n](); }

  /** @param {number} n @param {number} v */
  out(n, v) { this.outCb[n]?.(v); }

  /**
   * MAME `device_reset` (power-on and machine reset): clear the nibble RAM
   * and, unless the reset line is being held, pulse it -- which resets the
   * coin/credit counters.
   */
  deviceReset() {
    this.ram.fill(0);
    if (!this.reset) {
      this.setResetLine(true);
      this.setResetLine(false);
    }
  }

  /**
   * CPU read of nibble `offset`. The RAM is 4 bits wide and the high
   * nibble reads as 1s (MAME: "Pac & Pal requires the | 0xf0").
   * @param {number} offset 0-15 @returns {number}
   */
  read(offset) { return 0xf0 | this.ram[offset & 0x0f]; }

  /** CPU write: only the low nibble is stored. @param {number} offset @param {number} data */
  write(offset, data) { this.ram[offset & 0x0f] = data & 0x0f; }

  /** `IORAM_READ`. @param {number} n @returns {number} */
  rd(n) { return this.ram[n] & 0x0f; }

  /** `IORAM_WRITE`: C int to 4 bits (works for negatives, e.g. ~n). */
  wr(/** @type {number} */ n, /** @type {number} */ v) { this.ram[n] = v & 0x0f; }

  /**
   * MAME `set_reset_line`. Asserting (not releasing) the line resets the
   * coin logic; the nibble RAM is left alone.
   * @param {boolean} assert
   */
  setResetLine(assert) {
    this.reset = assert ? 1 : 0;
    if (assert) {
      this.credits = 0;
      this.coins[0] = 0;
      this.coinsPerCred[0] = 1;
      this.credsPerCoin[0] = 1;
      this.coins[1] = 0;
      this.coinsPerCred[1] = 1;
      this.credsPerCoin[1] = 1;
      this.inCount = 0;
    }
  }

  /** @returns {number} 1 while held in reset */
  readResetLine() { return this.reset; }

  /**
   * MAME `handle_coins(swap)`: coin and start processing, run once per
   * frame by the 56XX in mode 4 (swap = 0) and the 58XX in mode 3
   * (swap = 2, which exchanges nibbles 0<->2 and 1<->3 of the credit
   * outputs).
   *
   * Edge detection keeps the complemented port of the previous run in
   * `lastcoins`/`lastbuttons` exactly as MAME does (a full int, so the
   * bits above 3 are 1s); only bits 0-3 are ever tested.
   * @param {number} swap
   */
  handleCoins(swap) {
    let creditAdd = 0;
    let creditSub = 0;

    // Coins: port A (pins 38-41). val = 1 where a switch is closed.
    let val = ~this.in(0);
    let toggled = val ^ this.lastcoins;
    this.lastcoins = val;

    // Each coin chute counts coins towards its "coins per credit" (low 3
    // bits). Bit 3 of coinsPerCred set means "1 coin gives 1 credit now,
    // the rest when the count is complete": the completing coin then adds
    // one credit less.
    for (let i = 0; i < 2; i += 1) {
      if (val & toggled & (1 << i)) {
        this.coins[i] += 1;
        if (this.coins[i] >= (this.coinsPerCred[i] & 7)) {
          creditAdd = this.credsPerCoin[i] - (this.coinsPerCred[i] >> 3);
          this.coins[i] -= this.coinsPerCred[i] & 7;
        } else if (this.coinsPerCred[i] & 8) {
          creditAdd = 1;
        }
      }
    }
    // Service coin. Note: every source *assigns* creditAdd, so of several
    // coins on the same run only the last one counts (as in MAME).
    if (val & toggled & 0x08) creditAdd = 1;

    // Buttons: port D (pins 30-33).
    val = ~this.in(3);
    toggled = val ^ this.lastbuttons;
    this.lastbuttons = val;

    // Start buttons take credits only while the game allows it (nibble 9
    // written as 0). Start 1 wins over start 2 on the same run.
    if (this.rd(9) === 0) {
      if (val & toggled & 0x04) {
        if (this.credits >= 1) creditSub = 1;
      } else if (val & toggled & 0x08) {
        if (this.credits >= 2) creditSub = 2;
      }
    }

    this.credits += creditAdd - creditSub;
    // BCD credits. No cap: 100+ credits give a tens digit above 9 (masked
    // to 4 bits). Math.trunc and % reproduce C's int division.
    this.wr(0 ^ swap, Math.trunc(this.credits / 10));
    this.wr(1 ^ swap, this.credits % 10);
    // Handshake nibbles: set here, cleared by the CPU.
    if (creditAdd) this.wr(2 ^ swap, creditAdd);
    if (creditSub) this.wr(3 ^ swap, creditSub);
    this.wr(4, ~this.in(1));
    // Nibble 5: b3 start 1 held, b2 start 1 edge, b1 fire 1 held,
    // b0 fire 1 edge ("normal and impulse").
    this.wr(5, ((val & 0x05) << 1) | (val & toggled & 0x05));
    this.wr(6, ~this.in(2));
    // Nibble 7: b3 start 2 held, b2 start 2 edge, b1 fire 2 held,
    // b0 fire 2 edge.
    this.wr(7, (val & 0x0a) | ((val & toggled & 0x0a) >> 1));
  }

  /**
   * Mode 2 (both chips): initialise coinage from nibbles 9-12.
   */
  initCoinage() {
    this.coinsPerCred[0] = this.rd(9);
    this.credsPerCoin[0] = this.rd(10);
    this.coinsPerCred[1] = this.rd(11);
    this.credsPerCoin[1] = this.rd(12);
  }

  /**
   * Modes 56XX/9 and 58XX/4: read all four ports twice, with output pin 13
   * low (even nibbles) and then high (odd nibbles). Pin 13 selects the
   * half of a DIP bank on some boards; on Gaplus it is not connected, so
   * both halves read the same.
   */
  dipRead() {
    this.out(0, 0);
    this.wr(0, ~this.in(0));
    this.wr(2, ~this.in(1));
    this.wr(4, ~this.in(2));
    this.wr(6, ~this.in(3));
    this.out(0, 1);
    this.wr(1, ~this.in(0));
    this.wr(3, ~this.in(1));
    this.wr(5, ~this.in(2));
    this.wr(7, ~this.in(3));
  }

  /** The per-frame run (`customio_run`). Overridden. */
  run() { throw new Error('NamcoIo.run: abstract'); }

  /** @returns {NamcoIoState} */
  getState() {
    return {
      ram: Array.from(this.ram),
      reset: this.reset,
      lastcoins: this.lastcoins,
      lastbuttons: this.lastbuttons,
      credits: this.credits,
      coins: [...this.coins],
      coinsPerCred: [...this.coinsPerCred],
      credsPerCoin: [...this.credsPerCoin],
      inCount: this.inCount,
    };
  }

  /** @param {NamcoIoState} s */
  setState(s) {
    this.ram.set(s.ram);
    this.reset = s.reset;
    this.lastcoins = s.lastcoins;
    this.lastbuttons = s.lastbuttons;
    this.credits = s.credits;
    this.coins = [...s.coins];
    this.coinsPerCred = [...s.coinsPerCred];
    this.credsPerCoin = [...s.credsPerCoin];
    this.inCount = s.inCount;
  }
}

/** The 56XX (MAME `namco56xx_device::customio_run`). */
export class Namco56xx extends NamcoIo {
  /**
   * Run the command in nibble 8. Gaplus uses 8 -> 0 -> 1 -> 2 -> 4.
   */
  run() {
    switch (this.rd(8)) {
      case 0: // nop
        break;
      case 1: // read switch inputs; drive the lamp outputs
        this.wr(0, ~this.in(0));
        this.wr(1, ~this.in(1));
        this.wr(2, ~this.in(2));
        this.wr(3, ~this.in(3));
        this.out(0, this.rd(9));
        this.out(1, this.rd(10));
        break;
      case 2: // initialise coinage settings
        this.initCoinage();
        break;
      case 4: // coin mode: credits, starts, joysticks (Gaplus gameplay)
        this.handleCoins(0);
        break;
      case 7: // boot-up check (Libble Rabble only)
        this.wr(2, 0xe);
        this.wr(7, 0x6);
        break;
      case 8: { // boot-up check: sum of nibbles 9-15 into 0-1
        let sum = 0;
        for (let i = 9; i < 16; i += 1) sum += this.rd(i);
        this.wr(0, sum >> 4);
        this.wr(1, sum & 0xf);
        break;
      }
      case 9: // read DIP switches and inputs, pin 13 low then high
        this.dipRead();
        break;
      default: // MAME logs "unknown I/O mode" and does nothing
        break;
    }
  }
}

/**
 * The 7-bit LFSR step of the 58XX boot check.
 * MAME: `#define NEXT(n) ((((n) & 1) ? (n) ^ 0x90 : (n)) >> 1)`.
 * @param {number} n @returns {number}
 */
const lfsrNext = (n) => ((n & 1) ? n ^ 0x90 : n) >> 1;

/** The 58XX (MAME `namco58xx_device::customio_run`). */
export class Namco58xx extends NamcoIo {
  /**
   * Run the command in nibble 8. Gaplus uses 0 -> 5 -> 0 -> 4.
   */
  run() {
    switch (this.rd(8)) {
      case 0: // nop
        break;
      case 1: // read switch inputs into 4-7; drive the outputs
        this.wr(4, ~this.in(0));
        this.wr(5, ~this.in(1));
        this.wr(6, ~this.in(2));
        this.wr(7, ~this.in(3));
        this.out(0, this.rd(9));
        this.out(1, this.rd(10));
        break;
      case 2: // initialise coinage settings
        this.initCoinage();
        break;
      case 3: // coin mode, credit nibbles swapped
        this.handleCoins(2);
        break;
      case 4: // read DIP switches (Gaplus: all four DIP nibbles, twice)
        this.dipRead();
        break;
      case 5:
        this.bootCheck();
        break;
      default: // MAME logs "unknown I/O mode" and does nothing
        break;
    }
  }

  /**
   * Mode 5, the boot-up check: MAME's reconstruction of the chip's answer
   * as XORs of the argument nibbles, selected by a 7-bit LFSR seeded from
   * nibbles 9-10. "The first nibble of the result however is uncertain.
   * It is usually 0, but in some cases it toggles between 0 and F. We use
   * a kludge to give Gaplus the F it expects": Gaplus writes F to 9-15 and
   * checks $6810/$6811 = F,F.
   */
  bootCheck() {
    // Seed: step the LFSR (nibble9*16 + nibble10) & $7F times from $22.
    let n = (this.rd(9) * 16 + this.rd(10)) & 0x7f;
    let seed = 0x22;
    for (let i = 0; i < n; i += 1) seed = lfsrNext(seed);

    // Result nibble i (1-7): XOR of the complemented arguments whose LFSR
    // tap is 1. The LFSR advances once per result nibble (`seed = rng`
    // after the first tap) and six more times inside it. The argument
    // order 11, 10, 9, 15, 14, 13, 12 is MAME's.
    const order = [11, 10, 9, 15, 14, 13, 12];
    for (let i = 1; i < 8; i += 1) {
      n = 0;
      let rng = seed;
      for (let k = 0; k < 7; k += 1) {
        if (rng & 1) n ^= ~this.rd(order[k]);
        rng = lfsrNext(rng);
        if (k === 0) seed = rng; // save state for next nibble
      }
      this.wr(i, ~n);
    }
    this.wr(0, 0x0);
    // kludge for gaplus
    if (this.rd(9) === 0xf) this.wr(0, 0xf);
  }
}

// ----------------------------------------------------------------- 62XX

/**
 * Snapshot of the 62XX stand-in.
 * @typedef {object} Namco62State
 * @property {number[]} ram 16 bytes, 8 bits each
 */

/**
 * The 62XX as MAME treats it (gaplus_m.cpp `customio_3_r/w`): the real
 * MB8843 is not run. Its 16 addresses are 8-bit RAM; offsets 0-3 read
 * fixed values that depend on the "mode" byte at offset 8, and a write of
 * $0F or more to offset 9 starts the explosion sample.
 */
export class Namco62 {
  /**
   * @param {() => number} in2 IN2 port (cabinet, service), 4 bits
   * @param {() => void} [onBang] explosion trigger (MAME samples->start(0,0))
   */
  constructor(in2, onBang) {
    /** Plain 8-bit RAM (a MAME memory share: 0 at power-on, never reset). */
    this.ram = new Uint8Array(16);
    this.in2 = in2;
    /** @type {(() => void) | undefined} */
    this.onBang = onBang;
  }

  /** @param {number} offset @returns {number} */
  read(offset) {
    const o = offset & 0x0f;
    const mode = this.ram[8];
    switch (o) {
      case 0: return this.in2();                       // cabinet & test
      case 1: return mode === 2 ? this.ram[1] : 0x0f;
      case 2: return mode === 2 ? 0x0f : 0x0e;
      case 3: return mode === 2 ? this.ram[3] : 0x01;
      default: return this.ram[o];
    }
  }

  /** @param {number} offset @param {number} data */
  write(offset, data) {
    const o = offset & 0x0f;
    const v = data & 0xff;
    if (o === 9 && v >= 0x0f) this.onBang?.();
    this.ram[o] = v;
  }

  /** @returns {Namco62State} */
  getState() { return { ram: Array.from(this.ram) }; }

  /** @param {Namco62State} s */
  setState(s) { this.ram.set(s.ram); }
}

// ------------------------------------------------------ the three together

/**
 * Snapshot of all three chips plus the pending frame runs.
 * @typedef {object} GaplusIoState
 * @property {NamcoIoState} n56
 * @property {NamcoIoState} n58
 * @property {Namco62State} n62
 * @property {{ n56: boolean, n58: boolean }} pending runs armed by vblank
 */

/**
 * The Gaplus (`gapluso`) I/O chip set, wired as MAME wires it:
 *
 *   56XX in0..3 = COINS, P1, P2, BUTTONS         $6800-$680F
 *   58XX in0..3 = DSWA_HIGH, DSWB_LOW, DSWB_HIGH, DSWA_LOW  $6810-$681F
 *   62XX IN2                                      $6820-$682F
 *
 * Both 56XX and 58XX share one reset line (FRESET).
 */
export class GaplusIo {
  /**
   * @param {InputState} [inputs] live input state (mutated by the host)
   * @param {{ onBang?: () => void }} [opts]
   */
  constructor(inputs = createInputState(), opts = {}) {
    /** The live input state; the host may replace or mutate it. */
    this.inputs = inputs;
    const ports = () => inputPorts(this.inputs);
    this.n56 = new Namco56xx([
      () => ports().COINS, () => ports().P1, () => ports().P2,
      () => ports().BUTTONS,
    ]);
    this.n58 = new Namco58xx([
      () => ports().DSWA_HIGH, () => ports().DSWB_LOW,
      () => ports().DSWB_HIGH, () => ports().DSWA_LOW,
    ]);
    this.n62 = new Namco62(() => ports().IN2, () => {
      this.bangs += 1;
      this.onBang?.();
    });
    /** Explosion-sample trigger hook for the audio side. @type {(() => void) | undefined} */
    this.onBang = opts.onBang;
    /** Number of explosion triggers so far (diagnostics; not snapshotted). */
    this.bangs = 0;
    /** Runs armed at the last vblank, performed by update(). */
    this.pending = { n56: false, n58: false };
  }

  /**
   * CPU read of $6800-$682F (pass the address or the offset from $6800).
   * @param {number} addr @returns {number}
   */
  read(addr) {
    const o = addr & 0x3f;
    if (o < 0x10) return this.n56.read(o);
    if (o < 0x20) return this.n58.read(o & 0x0f);
    if (o < 0x30) return this.n62.read(o & 0x0f);
    return 0;
  }

  /**
   * CPU write of $6800-$682F.
   * @param {number} addr @param {number} data
   */
  write(addr, data) {
    const o = addr & 0x3f;
    if (o < 0x10) this.n56.write(o, data);
    else if (o < 0x20) this.n58.write(o & 0x0f, data);
    else if (o < 0x30) this.n62.write(o & 0x0f, data);
  }

  /**
   * FRESET: `true` holds the 56XX and 58XX in reset ($9800-$9FFF),
   * `false` releases them ($9000-$97FF). MAME `freset_w`.
   * @param {boolean} assert
   */
  setReset(assert) {
    this.n58.setResetLine(assert);
    this.n56.setResetLine(assert);
  }

  /** @returns {boolean} whether FRESET is asserted */
  get inReset() { return this.n56.reset === 1; }

  /**
   * The vblank instant (`gapluso_state::vblank_irq`): arm each chip's run
   * for 50 us later unless it is in reset *now*. MAME's `gapluso` wiring
   * crosses the gates (the 56XX run is armed when the 58XX is out of reset
   * and vice versa); both chips share FRESET, so this is equivalent to
   * "each chip unless in reset", but it is kept literal. A reset asserted
   * between vblank and update() does not cancel an armed run (MAME's timer
   * callback does not look at the line either).
   */
  vblank() {
    if (!this.n58.readResetLine()) this.pending.n56 = true;
    if (!this.n56.readResetLine()) this.pending.n58 = true;
  }

  /**
   * 50 us after vblank: perform the armed runs. The 56XX's timer was
   * adjusted first in `gapluso_state::vblank_irq`, and MAME orders timers
   * of equal expiry by insertion, so the 56XX runs before the 58XX (the
   * two are independent, so the order is not observable).
   */
  update() {
    if (this.pending.n56) { this.pending.n56 = false; this.n56.run(); }
    if (this.pending.n58) { this.pending.n58 = false; this.n58.run(); }
  }

  /**
   * Machine reset (MAME device_reset of both namcoio devices; the 62XX
   * share and the edge detectors are untouched). Armed runs are kept: the
   * run timers belong to the driver state, which a soft reset does not
   * touch. (Only a watchdog reset could hit this; it is unmeasured.)
   */
  machineReset() {
    this.n56.deviceReset();
    this.n58.deviceReset();
  }

  /** @returns {GaplusIoState} */
  getState() {
    return {
      n56: this.n56.getState(),
      n58: this.n58.getState(),
      n62: this.n62.getState(),
      pending: { ...this.pending },
    };
  }

  /** @param {GaplusIoState} s */
  setState(s) {
    this.n56.setState(s.n56);
    this.n58.setState(s.n58);
    this.n62.setState(s.n62);
    this.pending = { ...s.pending };
  }
}
