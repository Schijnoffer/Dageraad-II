import { defaultNightOrder } from '../engine/roles.js';
import { buildTimeline, DEFAULT_DURATIONS, type Durations, type Timeline } from '../engine/timeline.js';
import type { LatencySample } from '../engine/telemetry.js';
import type {
  Choice, DecisionRequest, GameConfig, NightResult, NightState, PrivateInfo,
  RoleId, SeatIndex,
} from '../engine/types.js';
import type { Bot } from '../engine/bot.js';
import type { Clock } from './clock.js';
import { PausableClock } from './clock.js';
import { answerKey, probe, requestsForWindow } from './replay.js';
import { publicView } from '../engine/publicview.js';
import { resolvePrecommit } from '../engine/precommit.js';
import type { NightCheckpoint, RoomStore } from './store.js';

/**
 * The referee loop — the thing that actually runs a night.
 *
 * This is the device holding every player's card (see README "Trust model"),
 * so it is also the thing that must be careful about WHEN it writes. The two
 * rules it exists to enforce:
 *
 *  1. **Every window runs for its full fixed minimum duration**, whether or not
 *     anybody in it has an action. After that minimum it waits for every real
 *     player, unless the referee consciously skips the unanswered actions.
 *
 *  2. **A seat's private info is written only when its reveal is due**, per the
 *     timeline. Writing a reveal early is the same leak by a different route.
 *
 * Neither rule ever consults the deal. The timeline is computed from the public
 * active-role list alone, and this loop just walks it.
 */

export interface RefereeOptions {
  state: NightState;
  activeRoles: RoleId[];
  config: GameConfig;
  store: RoomStore;
  clock: Clock;
  durations?: Durations;
  /** Rebuild a finished night after a refresh without rewinding the public phase. */
  setNightPhase?: boolean;
  /** Leave an already-open ballot open after reconstructing the night state. */
  advanceToDay?: boolean;
  /** Optional: called when a window opens, so a UI can prompt. */
  onWindowOpen?: (window: WindowInfo) => void;
  /**
   * Seats played automatically (test mode, and later a bot filling an empty
   * chair). A bot seat's decisions are generated rather than read from the
   * store; everything else about the window is identical, including its full
   * fixed duration — a bot answering instantly must not shorten it.
   */
  bots?: { seats: ReadonlySet<SeatIndex>; bot: Bot };
}

export interface WindowInfo {
  index: number;
  kind: 'open' | 'followup';
  role: RoleId | null;
  /** Who is actually being asked something. Referee-only knowledge. */
  requests: DecisionRequest[];
  closesAtMs: number;
}

export interface NightRunResult {
  result: NightResult;
  timeline: Timeline;
  /** Latency samples gathered, for calibration between sessions. */
  samples: LatencySample[];
  /** Decisions the referee consciously skipped and defaulted to no action. */
  skipped: DecisionRequest[];
}

/**
 * Run one night start to finish.
 *
 * Structure: walk the timeline's phases. For each, work out which outstanding
 * decisions belong to it, open it, wait out its FULL duration, collect whatever
 * arrived, then release the reveals that have come due. Repeat.
 */
export async function runNight(opts: RefereeOptions): Promise<NightRunResult> {
  const { state, activeRoles, config, store, clock } = opts;
  const durations = opts.durations ?? DEFAULT_DURATIONS;
  const nightOrder = defaultNightOrder(activeRoles);
  const timeline = buildTimeline(activeRoles, config, durations);

  const checkpoint = await store.readNightCheckpoint();
  const answers = new Map<string, Choice>(
    checkpoint?.answers.map(({ key, choice }) => [key, choice]) ?? [],
  );
  const samples: LatencySample[] = [];
  const skipped: DecisionRequest[] = [];
  const releasedSoFar = releasedAtCheckpoint(
    checkpoint, state, nightOrder, config, timeline, answers,
  );

  if (opts.setNightPhase !== false) await store.setPhase('night');

  for (const phase of timeline.phases) {
    if (phase.index <= (checkpoint?.completedWindowIndex ?? -1)) continue;
    const current = probe(state, nightOrder, config, answers);
    const requests = requestsForWindow(current, state, phase);

    await store.setWindowIndex(phase.index);
    opts.onWindowOpen?.({
      index: phase.index,
      kind: phase.kind,
      role: phase.role,
      requests,
      closesAtMs: phase.endMs,
    });

    // Each seat is told what IT is being asked, and nothing about anyone else.
    // Published before the window's sleep, so a player has the whole window to
    // answer rather than the tail of it. A seat with nothing to do this window
    // is sent an empty list, which is what clears last window's prompt off
    // their screen — silence would leave a stale question on the table.
    const bySeat = new Map<SeatIndex, DecisionRequest[]>();
    for (const seat of everySeat(state)) bySeat.set(seat, []);
    for (const request of requests) {
      bySeat.get(request.seat)?.push(request);
    }
    for (const [seat, forSeat] of bySeat) {
      if (opts.bots?.seats.has(seat)) continue;   // a bot is not reading a screen
      await store.releaseDecisions(seat, forSeat);
    }

    const openedAt = clock.now();

    // RULE 1. Keep the fixed public minimum even when every answer is already
    // in. After it, never discard a slow player's action merely because a
    // clock expired: wait until all humans have answered or the referee uses
    // the explicit recovery control.
    await clock.sleep(phase.endMs - phase.startMs);

    let submitted = await store.readSubmissions(phase.index);
    while (!windowAnswered(requests, submitted, opts.bots?.seats)) {
      if (await store.forceAdvanceRequested(phase.index)) break;
      await clock.sleep(500);
      submitted = await store.readSubmissions(phase.index);
    }
    const paused = clock instanceof PausableClock ? clock.consumeDirty() : false;

    for (const request of requests) {
      // A bot decides instead of the store being consulted. Note this happens
      // AFTER the window has already run its full length, not instead of it: a
      // bot answering in a microsecond must not make its window shorter, or
      // test mode would stop testing the thing that matters most.
      if (opts.bots?.seats.has(request.seat)) {
        answers.set(answerKey(request), await opts.bots.bot.choose(request, state));
        continue;
      }

      const choices = submitted.get(request.seat);
      const choice = choices?.[request.key];
      const latencyMs = clock.now() - openedAt;

      if (choice === undefined) {
        skipped.push(request);
        samples.push({
          role: request.actingAs, key: request.key, latencyMs,
          outcome: 'referee-skipped', paused, sessionId: 'local',
        });
        // A deliberate referee skip is a decided decline, not a pending
        // decision. Recording it is what lets recovery and later reveals
        // continue deterministically.
        answers.set(answerKey(request), { kind: 'none' });
        continue;
      }
      // A stored RULE is not an answer yet. In 'tworound' mode the Heks
      // commits one target per team before she has seen anything, and it is
      // resolved here against the card she actually turned over — the engine
      // handed us that in request.seen. A rule that cannot answer this
      // decision resolves to nothing, which the referee already treats as a
      // decline; firing a pre-commit on the wrong decision would be worse.
      answers.set(answerKey(request), resolveChoice(request, choice));
      samples.push({
        role: request.actingAs, key: request.key, latencyMs,
        outcome: 'submitted', paused, sessionId: 'local',
      });
    }

    // RULE 2. Release only what is due at this phase's reveal point.
    const after = probe(state, nightOrder, config, answers);
    await releaseDueReveals(
      store, after.result, timeline, phase.revealAtMs, releasedSoFar, after.settledSeats,
    );

    await store.setPublicEvents(after.result.events);

    // What the table can see, recomputed from the state this window resolved
    // to. AFTER the window, never on a tap: publishing when somebody answers
    // would leak that a decision had been made, and from the timing, roughly
    // which one.
    //
    // Published every window rather than only when something changed, because
    // "nothing was revealed this window" and "this window did not run" must
    // look identical from outside — the same reason a window sleeps its full
    // length whether or not anyone is in it.
    await store.publishPublicView(publicView(after.result.state));
    await store.saveNightCheckpoint(checkpointFor(phase.index, answers));
  }

  // Final pass with every answer in hand.
  const final = probe(state, nightOrder, config, answers);
  await releaseDueReveals(
    store, final.result, timeline, Number.POSITIVE_INFINITY, releasedSoFar, final.settledSeats,
  );
  await store.setPublicEvents(final.result.events);
  await store.publishPublicView(publicView(final.result.state));

  await store.recordLatency(samples);
  // The last scheduled window has no next window to clear its questions.
  // Clear every human explicitly before opening the day; otherwise a skipped
  // final prompt remains over the table and hides the private no-action/result
  // receipt that explains how the night actually resolved.
  for (const seat of everySeat(state)) {
    if (opts.bots?.seats.has(seat)) continue;
    await store.releaseDecisions(seat, []);
  }
  if (opts.advanceToDay !== false) await store.setPhase('day');

  return { result: final.result, timeline, samples, skipped };
}

function windowAnswered(
  requests: readonly DecisionRequest[],
  submitted: ReadonlyMap<SeatIndex, Record<string, Choice>>,
  bots: ReadonlySet<SeatIndex> | undefined,
): boolean {
  return requests.every((request) =>
    bots?.has(request.seat) || submitted.get(request.seat)?.[request.key] !== undefined);
}

/**
 * Write out each seat's private info that has come due, and no more.
 *
 * A seat's reveal time is looked up by the role it was DEALT, because that is
 * what determines its slot in the night order (§6.0) — not whatever card it may
 * be holding by now.
 *
 * `settledSeats` is the safety catch: a seat with an outstanding decision has a
 * provisional resolution downstream of a placeholder answer, and none of that
 * may be written. Without this check a slow player's own screen could show them
 * a result computed as if they had declined.
 */
async function releaseDueReveals(
  store: RoomStore,
  result: NightResult,
  timeline: Timeline,
  nowMs: number,
  releasedSoFar: Map<SeatIndex, number>,
  settledSeats: Set<SeatIndex>,
): Promise<void> {
  for (const [seatKey, info] of Object.entries(result.privateInfo)) {
    const seat = Number(seatKey);
    if (!settledSeats.has(seat)) continue;

    const dealt = result.state.originalRole[seat];
    const dueAt = dealt ? timeline.revealAtMs[dealt] : undefined;
    // A seat whose role has no reveal gate (no night action) still receives
    // anything addressed to it — the Rechter's private notice, for instance.
    if (dueAt !== undefined && dueAt > nowMs) continue;

    const already = releasedSoFar.get(seat) ?? 0;
    const fresh: PrivateInfo[] = info.slice(already);
    if (fresh.length === 0) continue;

    await store.setPrivateInfo(seat, info);
    releasedSoFar.set(seat, info.length);
  }
}

function checkpointFor(completedWindowIndex: number, answers: Map<string, Choice>): NightCheckpoint {
  return {
    completedWindowIndex,
    answers: [...answers].map(([key, choice]) => ({ key, choice })),
  };
}

/** Reconstruct what was already released at the last durable window boundary. */
function releasedAtCheckpoint(
  checkpoint: NightCheckpoint | null,
  state: NightState,
  nightOrder: RoleId[],
  config: GameConfig,
  timeline: Timeline,
  answers: Map<string, Choice>,
): Map<SeatIndex, number> {
  const released = new Map<SeatIndex, number>();
  if (!checkpoint) return released;
  const phase = timeline.phases.find((candidate) => candidate.index === checkpoint.completedWindowIndex);
  if (!phase) return released;
  const current = probe(state, nightOrder, config, answers);
  for (const [seatKey, info] of Object.entries(current.result.privateInfo)) {
    const seat = Number(seatKey) as SeatIndex;
    if (!current.settledSeats.has(seat)) continue;
    const dealt = current.result.state.originalRole[seat];
    const dueAt = dealt ? timeline.revealAtMs[dealt] : undefined;
    if (dueAt === undefined || dueAt <= phase.revealAtMs) released.set(seat, info.length);
  }
  return released;
}

/**
 * A submitted choice, or the answer a submitted RULE produces.
 *
 * Kept out of the engine on purpose: the engine's job is to say what it is
 * asking and what the asker has seen, not to hold anybody's stored policy.
 * The classification the rule needs — which team a card belongs to — is engine
 * logic and lives in precommit.ts, so this is only the join between them.
 */
function resolveChoice(request: DecisionRequest, choice: Choice): Choice {
  if (choice.kind !== 'heks-policy') return choice;
  const resolved = resolvePrecommit(request, {
    kind: 'heks-policy',
    policy: { wolf: choice.wolf, looier: choice.looier, village: choice.village },
  });
  return resolved ?? { kind: 'none' };
}

/** Every seat at the table, as indices. */
function everySeat(state: { seatCount: number }): SeatIndex[] {
  return Array.from({ length: state.seatCount }, (_, i) => i as SeatIndex);
}
