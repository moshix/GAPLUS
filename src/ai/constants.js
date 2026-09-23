// Copyright 2026 by Moshix
/**
 * Everything the AI believes about Gaplus, in one place, each value traced
 * to the ROM routine it comes from (reference/gaplus-main.asm and
 * gaplus-sub.asm). Almost none of these are tuning knobs; the handful that
 * are judgement calls are grouped at the end and say so.
 *
 * COORDINATES are the sprite shadow's own (sprite_shadow_1, $0E00): entry
 * i has its code/colour at $0E00+2i, its position at $1600+2i and its
 * flags at $1E00+2i. The monitor is rotated, so the names in the listing
 * ("player_y" $1600, "player_x" $1601) are the hardware's, not the
 * screen's. The AI uses screen terms:
 *
 *   h = $1600+2i            horizontal, 0-255, increasing to the right
 *   v = $1601+2i | bit 0 of $1E01+2i << 8
 *                           9-bit vertical, increasing DOWNWARDS; the
 *                           fighter lives in v = $0C8..$149
 *   in use = bit 7 of $1E01+2i
 */

// ------------------------------------------------------------ game state

/** attract_flag: 1 in attract mode and its demo game, 0 once credited. */
export const ATTRACT_FLAG = 0x09f4;
/** game_mode: 0 stage start, 1-4 entry, 5 play, 6 clear, 7 challenging
 * stage, 8 its results, 9 game over / name entry. */
export const GAME_MODE = 0x102f;
/** main_task: index into the current mode's task list. */
export const MAIN_TASK = 0x1030;
/** frame_counter: +1 per main IRQ, cleared at every stage start. */
export const FRAME_COUNTER = 0x1016;
/** lives_p1: ships left including the one in play (0 after the last). */
export const LIVES_P1 = 0x1104;
/** stage_p1: player 1's stage, 0-based (PARSEC n is stage n-1). */
export const STAGE_P1 = 0x1106;
/** score_p1: 3 BCD bytes, least significant first, in tens of points. */
export const SCORE_P1 = 0x09b0;
/** two_players / cur_player. */
export const TWO_PLAYERS = 0x102e;
export const CUR_PLAYER = 0x102d;

/** The game modes the AI treats specially. */
export const MODE_PLAY = 5;
export const MODE_CHALLENGE = 7;
export const MODE_GAME_OVER = 9;

// ------------------------------------------------------------ the fighter

/** Fighter position: sprite shadow entry 0. */
export const PLAYER_H = 0x1600;
export const PLAYER_V = 0x1601;
export const PLAYER_VHI = 0x1e01;
/** player_frozen: the stick is ignored (capture, effects, respawn). */
export const PLAYER_FROZEN = 0x10d9;
/** $1111: set by the capture steering; vertical moves are skipped
 * (task_move_player $CF73). */
export const PLAYER_VLOCK = 0x1111;
/** $10E9: set by the capture steering; task_player_fire does nothing. */
export const FIRE_LOCK = 0x10e9;
/** player_exploding / player_dying: the fighter is being lost. */
export const PLAYER_EXPLODING = 0x110f;
export const PLAYER_DYING = 0x10fe;
/** $101A: task_player_hit_check is skipped while it is set ($D922). */
export const HIT_SKIP = 0x101a;
/** player_step: horizontal pixels per frame (2, start_turn $CDE0). */
export const PLAYER_STEP = 0x10d1;
/** player_speed: vertical pixels per frame (1, start_turn $CDE5). */
export const PLAYER_SPEED = 0x1032;
/** player_xmin / player_xmax: horizontal limits ($0D / $DA): a move left
 * is taken while h >= min, a move right while h < max ($CF8E/$CF99). */
export const PLAYER_HMIN = 0x1078;
export const PLAYER_HMAX = 0x1079;
/**
 * Vertical limits. task_move_player compares only the LOW byte: up stops
 * when it is $C8, down when it is $49 ($CFA4 / $CFB4), so with the 9-bit
 * position the fighter lives in $0C8..$149 and starts at $148.
 */
export const V_TOP_LO = 0xc8;
export const V_BOTTOM_LO = 0x49;
export const V_TOP = 0x0c8;
export const V_BOTTOM = 0x149;

/**
 * The fighter's hit box, from task_player_hit_check ($D92F-$D948): an
 * object at (h, v) kills it when h - H is in [-6, +6) and v/2 - V/2 (the
 * 9-bit values halved, `lsrb / rora`) is in [-3, +3).
 */
export const HIT_H = 6;
export const HIT_V2 = 3;

// ------------------------------------------------------------ its shots

/** Player shot slots: entries $0EA2, $0EA4 (and $0EA6 when shot_slots_end
 * $10D3 says so), task_player_fire $D18D. */
export const SHOT_FIRST = 0x51;
/** shot_slots_end: address one past the last shot slot. */
export const SHOT_SLOTS_END = 0x10d3;
/** shot_speed: pixels up per frame (6, start_turn $CDEA). */
export const SHOT_SPEED = 0x10d2;
/** fire_held: non-zero until the button has been seen released once
 * (task_player_fire $D17B): a new shot needs a fresh press. */
export const FIRE_HELD = 0x1019;
/**
 * Shot hit box, task_shot_hits $D2AF-$D2D2: a target at (h, v) is hit
 * when h - shot h is in [$1100 + $10DD - $1101 - $10DE, $1100 + $10DD)
 * (normally [-6, +6)) and v - shot v, low bytes, is in [-10, +10), the
 * shot's v bit 8 matching the target's.
 */
export const SHOT_BOX_R = 0x1100;
export const SHOT_BOX_W = 0x1101;
export const FIGHTER_OFFSETS = 0x10dd;
export const SHOT_HIT_V = 10;
/** A shot is freed once it has passed v = $40 (task_move_shots $D206). */
export const SHOT_EXIT_V = 0x40;

// ------------------------------------------------------------- enemies

/** formation_flags: one per slot, b0 = empty, b1 = out of the formation
 * (flying: use its sprite entry), 44 slots + 2 sentinels. */
export const FORMATION_FLAGS = 0x1860;
export const FORMATION_SLOTS = 44;
/** The formation's home positions, (h, v low) per slot (task_shot_hits
 * $D31E: used while b1 is clear; v bit 8 is 0 there). */
export const FORMATION_POS = 0x1b00;
/** A flying formation member k is sprite entry DIVER_FIRST + k ($0E30). */
export const DIVER_FIRST = 0x18;
/** Enemy shots: entries $0ECE-$0EDA (task_move_enemy_shots, sub $FA2E). */
export const ESHOT_FIRST = 0x67;
export const ESHOT_COUNT = 7;
/**
 * Their sideways speed: $1B60+2j signed-magnitude pixels (bit 7 = left)
 * and $1B61+2j the fraction in 1/256 ($FA6F-$FAAB); downwards they move 2
 * and 3 pixels on alternate frames ($FA55).
 */
export const ESHOT_VEL = 0x1b60;
export const ESHOT_VY = 2.5;
/** Objects the main CPU flies (entries $0EE2-$0F12): lethal to touch and
 * shootable (task_shot_hits $D534). */
export const OBJECT_FIRST = 0x71;
export const OBJECT_LAST = 0x89;
/**
 * The two ranges task_player_hit_check tests ($D94A, $D989): entries
 * $0ECE-$0F12 and $0E30-$0E86. Anything in use there that touches the
 * fighter kills it.
 */
export const LETHAL_RANGES = Object.freeze([[0x67, 0x89], [0x18, 0x43]]);
/** Number of sprite shadow entries. */
export const ENTRIES = 154;

// ------------------------------------------------------------- the stick

/** Directions as (dh, dv) unit steps; index 0 is "no move". */
export const DIRS = Object.freeze([
  [0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

// ------------------------------------------------ judgement calls (tuned)

/** Frames the planner looks ahead. */
export const HORIZON = 30;
/** How far ahead a shot is simulated (a shot crosses the screen in ~44). */
export const SHOT_HORIZON = 48;
/** Aim error allowed on each side of the shot box, pixels. */
export const SHOT_TOLERANCE = 2;
