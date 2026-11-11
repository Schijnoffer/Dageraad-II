import { centerSlot, finalRoleOf, roleAt } from '../engine/state.js';
import type { Bot } from '../engine/bot.js';
import type { DayOptions } from '../engine/dayphase.js';
import type { Durations } from '../engine/timeline.js';
import type { RoleId, SeatIndex, Team } from '../engine/types.js';
import type { Clock } from '../orchestration/clock.js';
import { PausableClock, SystemClock } from '../orchestration/clock.js';
import {
  DEFAULT_DAY_CONFIG, runDay,
  type DayConfig, type DayRunnerHooks, type DayRunResult, type DayStore,
} from '../orchestration/dayrunner.js';
import { runNight, type NightRunResult, type WindowInfo } from '../orchestration/referee.js';
import { SandboxStore, mayRecordResults, type GameMode } from '../orchestration/sandbox.js';
import type { RoomStore } from '../orchestration/store.js';
import type { Backend, GameResults, RoomView, SeatResult } from './backend.js';
import type { RoundRecord } from './session.js';

/**
 * One evening, start to finish, on the referee's device.
 *
 * `runNight` and `runDay` already know how to play a game; what was missing was
 * the thing that hands them a real room and then does something with what they
 * hand back. That is all this is — the join between the engine's two halves and
 * the network, and the only place in the app where a whole game is a function
 * call.
 *
 * It runs on ONE device: the referee's, ideally the tablet (see backend.ts).
 * Nothing here should ever run on a player's phone, and the security rules
 * refuse it if it tries.
 */

export interface BotSeats {
  seats: ReadonlySet<SeatIndex>;
  bot: Bot;
  /**
   * The bot's own device, when it has one.
   *
   * Only the offline demo world gives a bot a Backend of its own. A bot in a
   * real practice room has no login and no browser — the controlling browser
   * answers for it through `voteAsBot`, which is the narrow capability that
   * makes that safe. Optional so both can share this shape.
   */
  device?(seat: SeatIndex): Backend;
  /**
   * The bot's own ballot. Without it a bot names a random other seat. An AI
   * player that took part in the discussion decides here instead.
   */
  vote?(seat: SeatIndex): Promise<SeatIndex | null>;
}

export interface RefereeRunnerOptions {
  backend: Backend;
  roomId: string;
  /** 'test' blocks calibration and permanent stats, structurally (§16). */
  mode?: GameMode;
  clock?: Clock;
  durations?: Durations;
  dayConfig?: Partial<DayConfig>;
  dayOptions?: DayOptions;
  random?: () => number;
  bots?: BotSeats;
  onWindowOpen?: (window: WindowInfo) => void;
  dayHooks?: DayRunnerHooks;
  /** Called once the phase turns over, for a UI that wants to follow along. */
  onPhase?: (phase: 'night' | 'day' | 'voting' | 'results') => void;
}

export interface GameRunResult {
  night: NightRunResult;
  day: DayRunResult;
  /** The full record, as published. */
  results: GameResults;
  /** The evening's row for this round. Written only for a live game. */
  record: RoundRecord;
  /** Every seat's card at dawn (§6.0) — the one thing that becomes public. */
  finalRoles: Record<SeatIndex, RoleId>;
  outcome: string;
  /** False in test mode: nothing was written to anyone's permanent record. */
  resultsPersisted: boolean;
  /** What test mode refused to write, so the UI can say so out loud. */
  blocked: { method: string; count: number }[];
}

export class RefereeError extends Error {}

/**
 * Read a room once.
 *
 * `watchRoom` is the only read in the interface, deliberately — every screen in
 * the app is live, so a one-shot read is the special case rather than the norm.
 * Both implementations fire the callback with current state on subscribe.
 */
export function readRoomOnce(backend: Backend, roomId: string): Promise<RoomView> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new RefereeError(`room read timed out: ${roomId}`));
    }, 10_000);
    const off = backend.watchRoom(roomId, (room) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Unsubscribe on the next tick: a synchronous callback (memory backend)
      // would otherwise call this before `off` has been assigned.
      queueMicrotask(() => off());
      if (room) resolve(room);
      else reject(new RefereeError(`no such room: ${roomId}`));
    });
  });
}

/**
 * Run the game the room is set up for.
 *
 * Call this AFTER `startGame` — the deal is the host pressing a button, and
 * this is what happens next. Splitting them matters: the deal is one write that
 * either happened or did not, and this is a long-running loop that a refresh
 * has to be able to resume against a room that is already dealt.
 */
export async function runGame(opts: RefereeRunnerOptions): Promise<GameRunResult> {
  const { backend, roomId } = opts;
  const mode: GameMode = opts.mode ?? 'live';

  const room = await readRoomOnce(backend, roomId);
  if (room.refereeUid !== backend.uid) {
    throw new RefereeError(
      'only the referee device may run the game — create the room on the tablet',
    );
  }

  const state = await backend.refereeNightState(roomId);
  if (!state) throw new RefereeError('the game has not been dealt yet');

  // The host pause has to stop the countdown for everyone at once (§5.3), so it
  // wraps whatever clock the caller supplied rather than replacing it.
  const clock = opts.clock ?? new PausableClock(new SystemClock());

  const live = backend.refereeStore(roomId);
  // In test mode the store PHYSICALLY cannot write calibration samples. This is
  // a wrapper rather than an `if` at the call site because the failure it
  // prevents — bot timings dragging every future window towards zero — would
  // surface weeks later at a real table looking like an unrelated bug.
  const base: RoomStore & DayStore = mode === 'test' ? new SandboxStore(live) : live;
  const store = withPhaseHook(base, opts, room);

  // Where we are starting from. `startGame` already moved the room to 'night',
  // so the first setPhase the night runner makes is a no-op — a UI following
  // along still needs to be told which phase it is joining.
  if (room.phase !== 'lobby') opts.onPhase?.(room.phase);

  const night = await runNight({
    state,
    activeRoles: room.activeRoles,
    config: room.config,
    store,
    clock,
    setNightPhase: room.phase === 'night',
    advanceToDay: room.phase !== 'voting',
    ...(opts.durations ? { durations: opts.durations } : {}),
    ...(opts.onWindowOpen ? { onWindowOpen: opts.onWindowOpen } : {}),
    ...(opts.bots ? { bots: { seats: opts.bots.seats, bot: opts.bots.bot } } : {}),
  });

  const resumingDay = room.phase === 'day';
  const remainingDiscussionMs = resumingDay && room.discussionEndsAt != null
    ? Math.max(0, room.discussionEndsAt - (room.pausedAt ?? clock.now()))
    : (room.discussionMs ?? DEFAULT_DAY_CONFIG.discussionMs);
  // A crash may have happened halfway through the bot loop. Retrying is safe:
  // named votes are create-only, and castBotVotes deliberately absorbs the
  // refusal for any bot whose final vote already exists.
  if (room.phase === 'voting') await castBotVotes(opts, room);

  const day = await runDay({
    state: night.result.state,
    store,
    clock,
    config: {
      ...DEFAULT_DAY_CONFIG,
      // Always from the room, never from the caller: the abstain threshold is
      // measured against how many people are at the table, and getting it from
      // anywhere else is how two of the first three tappers end an eight-player
      // vote.
      seatCount: room.seating.length,
      discussionMs: remainingDiscussionMs,
      ...opts.dayConfig,
      // An extension that is already visible must never be rolled a second time
      // after a refresh. If none fired yet, the original rule still applies.
      ...(resumingDay && room.discussionExtendedByMs > 0
        ? { suspenseExtension: false }
        : {}),
    },
    resumeAt: room.phase === 'voting' ? 'voting' : 'day',
    ...(opts.dayOptions ? { dayOptions: opts.dayOptions } : {}),
    ...(opts.dayHooks ? { hooks: opts.dayHooks } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });

  const results = await buildResults(night, day, store, room);
  const persist = mayRecordResults(mode);

  // The evening's record. Only a live round goes in: a bot game would
  // permanently inflate somebody's scoreboard and every stats breakdown built
  // on top of it, and these rows are append-only by design.
  const record: RoundRecord = {
    round: room.round,
    activeRoles: room.activeRoles,
    seatCount: room.seating.length,
    outcome: results.outcome,
    results: Object.entries(results.seats).map(([seatKey, seat]) => ({
      uid: room.seating[Number(seatKey)] ?? '',
      seat: Number(seatKey),
      originalRole: seat.originalRole,
      finalRole: seat.finalRole,
      won: seat.won,
      voteOutcome: seat.voteOutcome,
      suspicionAccuracy: seat.suspicionAccuracy,
    })).filter((r) => r.uid !== ''),
  };
  await backend.finalizeRound(roomId, results, persist ? record : null);
  opts.onPhase?.('results');

  return {
    night,
    day,
    results,
    record,
    finalRoles: results.finalRoles,
    outcome: results.outcome,
    resultsPersisted: persist,
    blocked: base instanceof SandboxStore ? base.blocked : [],
  };
}

/**
 * Assemble the one thing that becomes public.
 *
 * §6.0: a player's win is judged on the card they END the night holding, not
 * the one they were dealt — so both go in the record. Keeping the original as
 * well is what makes "you were dealt the Ziener and finished as a Weerwolf"
 * showable afterwards, which is most of the fun of the results screen.
 */
async function buildResults(
  night: NightRunResult,
  day: DayRunResult,
  store: DayStore,
  room: RoomView,
): Promise<GameResults> {
  const state = night.result.state;
  // Read once more now the day has resolved. Votes were hidden until this
  // moment; from here they are part of the public record.
  const votes = await store.readVotes();

  const finalRoles: Record<SeatIndex, RoleId> = {};
  const originalRoles: Record<SeatIndex, RoleId> = {};
  const seats: Record<SeatIndex, SeatResult> = {};
  const finalVotes: Record<SeatIndex, SeatIndex | null> = {};

  for (let seat = 0; seat < state.seatCount; seat++) {
    const finalRole = finalRoleOf(state, seat);
    finalRoles[seat] = finalRole;
    originalRoles[seat] = state.originalRole[seat]!;

    const vote = votes.get(seat);
    const targetSeat = vote?.target ?? null;
    finalVotes[seat] = targetSeat;
    seats[seat] = {
      finalRole,
      originalRole: state.originalRole[seat]!,
      won: day.result.seatWon[seat] ?? false,
      votedFor: targetSeat === null ? null : (room.seating[targetSeat] ?? null),
      voteOutcome: day.outcomes[seat] ?? 'not-scored',
      // The referee never sees anyone's suspicion notes — they live on the
      // guesser's device and are theirs to submit or keep (§14).
      suspicionAccuracy: null,
    };
  }

  const winningTeams = Object.entries(day.result.teamsWon)
    .filter(([, won]) => won)
    .map(([team]) => team as Team);

  return {
    outcome: day.result.outcome,
    eliminatedSeats: [...day.result.eliminated],
    winningTeams,
    finalVotes,
    discardedVotes: Object.fromEntries(
      day.result.discarded.map(({ voter, reason }) => [voter, reason]),
    ),
    finalTally: { ...day.result.tally },
    finalRoles,
    originalRoles,
    finalCenterRoles: Array.from(
      { length: state.centerCount },
      (_, index) => roleAt(state, centerSlot(state, index)),
    ),
    nightInfo: Object.fromEntries(
      Object.entries(night.result.privateInfo).map(([seat, info]) => [seat, [...info]]),
    ) as GameResults['nightInfo'],
    seats,
  };
}

/**
 * Wrap the store so the runner can react to a phase change without either
 * `runNight` or `runDay` having to know a network exists.
 *
 * Two things hang off it: the caller's `onPhase`, and the moment bot seats have
 * to cast their votes — which is exactly when voting opens and not a second
 * before, since that is when the rules start accepting a target.
 */
function withPhaseHook(
  inner: RoomStore & DayStore,
  opts: RefereeRunnerOptions,
  room: RoomView,
): RoomStore & DayStore {
  // `runNight` ends by setting 'day' and `runDay` opens by setting it again —
  // each is right on its own, and together they are one redundant write that
  // every device would see as a change and re-render for. Collapse it here
  // rather than making either half aware of the other.
  let lastPhase: string = room.phase;

  return {
    readNightCheckpoint: () => inner.readNightCheckpoint(),
    saveNightCheckpoint: (checkpoint) => inner.saveNightCheckpoint(checkpoint),
    setWindowIndex: (i) => inner.setWindowIndex(i),
    forceAdvanceRequested: (i) => inner.forceAdvanceRequested(i),
    readSubmissions: (i) => inner.readSubmissions(i),
    setPrivateInfo: (seat, info) => inner.setPrivateInfo(seat, info),
    releaseDecisions: (seat, requests) => inner.releaseDecisions(seat, requests),
    setPublicEvents: (events) => inner.setPublicEvents(events),
    publishPublicView: (view) => inner.publishPublicView(view),
    recordLatency: (samples) => inner.recordLatency(samples),
    readVotes: () => inner.readVotes(),
    announceExtension: (ms) => inner.announceExtension(ms),
    setDiscussionDeadline: (endsAt) => inner.setDiscussionDeadline?.(endsAt) ?? Promise.resolve(),
    practiceForceVoteRequested: () => inner.practiceForceVoteRequested?.() ?? Promise.resolve(false),
    async setPhase(phase) {
      if (phase === lastPhase) return;
      lastPhase = phase;
      await inner.setPhase(phase);
      if (phase !== 'lobby') opts.onPhase?.(phase);
      if (phase === 'voting') await castBotVotes(opts, room);
    },
  };
}

async function castBotVotes(opts: RefereeRunnerOptions, room: RoomView): Promise<void> {
  const bots = opts.bots;
  if (!bots) return;
  const state = await opts.backend.refereeNightState(opts.roomId);
  if (!state) return;
  const random = opts.random ?? Math.random;

  for (const seat of bots.seats) {
    // Bots never participate in the discussion's abstain/ready toggles. Once
    // the ballot opens they immediately pick one OTHER seated player, exactly
    // once, and their named vote is as final as a human's.
    const targets = room.seating
      .map((_, target) => target as SeatIndex)
      .filter((target) => target !== seat);
    let targetSeat = targets[Math.floor(random() * targets.length)];
    if (bots.vote) {
      try {
        const chosen = await bots.vote(seat);
        if (chosen !== null && targets.includes(chosen)) targetSeat = chosen;
      } catch {
        // An AI that cannot decide still has to name somebody; voting is
        // mandatory and the ballot would otherwise wait forever.
      }
    }
    const targetUid = targetSeat === undefined ? null : (room.seating[targetSeat] ?? null);
    const ownUid = room.seating[seat];
    // Defensive: a bot that named itself would be refused by the rules anyway,
    // and a refusal thrown here would abort the whole day for everyone.
    const safeTarget = targetUid === ownUid ? null : targetUid;
    try {
      const own = bots.device?.(seat);
      if (own) {
        // The seat has a login of its own — a simulated table, where the test
        // holds all eight phones. It votes for ITSELF, through the ordinary
        // player method, which is why this needs no privilege at all.
        if (safeTarget) await own.vote(opts.roomId, safeTarget, false);
      } else if (ownUid) {
        // A real AI player: no login, no browser. The controlling browser
        // answers for it through the NARROW bot-only method, which refuses
        // unless the seat really holds an `isBot` player in a practice room.
        // A general "vote as any player" would be one rule away from the
        // referee quietly voting for a human.
        if (safeTarget) await opts.backend.voteAsBot(opts.roomId, ownUid, safeTarget, false);
      }
    } catch {
      // A bot that cannot vote is a bug in the bot, not a reason to invent a
      // result. The ballot stays open so the referee can use emergency control.
    }
  }
}
