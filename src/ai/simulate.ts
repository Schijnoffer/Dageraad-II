import type { Backend, RoomView } from '../app/backend.js';
import { MemoryWorld } from '../app/memorybackend.js';
import { readRoomOnce, runGame, type GameRunResult } from '../app/refereeRunner.js';
import { cardsForRoles } from '../engine/deal.js';
import { DEFAULT_ACTIVE_ROLES, TWO_ROUND_CONFIG } from '../engine/presets.js';
import type { Choice, DecisionRequest, GameConfig, PrivateInfo, RoleId, SeatIndex } from '../engine/types.js';
import type { Clock } from '../orchestration/clock.js';
import { AiTable, type HumanSpeaker } from './table.js';
import type { AiAgent, GameLog, LogEvent, PublicMessage } from './types.js';

/**
 * A clock that runs as fast as the game allows, but never past work that a
 * real table would be waiting for (the AI discussion, a human thinking).
 * The referee's fixed night windows still happen in order; they just take no
 * wall-clock time.
 */
export class VirtualClock implements Clock {
  private t = 0;
  private readonly blockers = new Set<Promise<unknown>>();

  now(): number {
    return this.t;
  }

  block(work: Promise<unknown>): void {
    const tracked = work.finally(() => this.blockers.delete(tracked));
    this.blockers.add(tracked);
  }

  async sleep(ms: number): Promise<void> {
    while (this.blockers.size > 0) await Promise.allSettled([...this.blockers]);
    this.t += Math.max(0, ms);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A human seat in an offline game (terminal play, or a scripted stand-in in tests). */
export interface HumanPlayer {
  name: string;
  night(info: {
    seat: SeatIndex; names: readonly string[]; dealtRole: RoleId | null;
    privateInfo: readonly PrivateInfo[]; request: DecisionRequest;
  }): Promise<Choice>;
  speak: HumanSpeaker;
  vote(info: {
    seat: SeatIndex; names: readonly string[]; privateInfo: readonly PrivateInfo[];
    chat: readonly PublicMessage[];
  }): Promise<SeatIndex>;
}

export interface SimulateOptions {
  /** Number of AI seats. */
  ais: number;
  /** Builds the agent for the i-th AI seat (0-based among AIs). */
  agentFor(index: number, name: string): AiAgent;
  humans?: HumanPlayer[];
  seed: number;
  activeRoles?: RoleId[];
  config?: GameConfig;
  rounds?: number;
  onEvent?: (event: LogEvent) => void;
  onPublic?: (msg: PublicMessage) => void;
  /** Shuffle the seating with the seed (default true). */
  shuffleSeats?: boolean;
  /** See AiTableOptions.nightGraceMs. */
  nightGraceMs?: number;
}

export interface SimulationResult {
  log: GameLog;
  run: GameRunResult;
  table: AiTable;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function onceRoom(backend: Backend, roomId: string): Promise<RoomView> {
  return readRoomOnce(backend, roomId);
}

/**
 * One complete round — deal, night, discussion, vote, result — played through
 * the SAME code a real practice room uses: MemoryWorld backend, `startGame`,
 * the referee's `runGame`, bot seats, and `voteAsBot`.
 */
export async function simulateGame(opts: SimulateOptions): Promise<SimulationResult> {
  const random = seeded(opts.seed);
  const world = new MemoryWorld(seeded(opts.seed ^ 0x5eed));
  const tablet = world.device('ai-table');
  const humans = opts.humans ?? [];
  const seatCount = opts.ais + humans.length;
  if (seatCount < 3 || seatCount > 12) throw new Error('3 to 12 players');

  const activeRoles = opts.activeRoles ?? DEFAULT_ACTIVE_ROLES;
  const config = opts.config ?? TWO_ROUND_CONFIG;
  const roomId = await tablet.createRoom({
    displayName: 'AI-tafel', activeRoles, config, playing: false, mode: 'practice',
  });

  const humanDevices = humans.map((h) => world.device(`human:${h.name}`));
  for (let i = 0; i < humans.length; i++) await humanDevices[i]!.joinRoom(roomId, humans[i]!.name);
  for (let i = 0; i < opts.ais; i++) await tablet.addBot(roomId);

  let room = await onceRoom(tablet, roomId);
  if (opts.shuffleSeats !== false) {
    const seating = [...room.seating];
    for (let i = seating.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [seating[i], seating[j]] = [seating[j]!, seating[i]!];
    }
    await tablet.setSeating(roomId, seating);
  }
  await tablet.setActiveRoles(roomId, cardsForRoles(activeRoles, seatCount), config);

  const players = await new Promise<{ uid: string; displayName: string; isBot?: boolean }[]>((resolve) => {
    const off = tablet.watchPlayers(roomId, (p) => { queueMicrotask(() => off()); resolve(p); });
  });
  const agents = new Map<string, AiAgent>();
  players.filter((p) => p.isBot).forEach((p, i) => agents.set(p.uid, opts.agentFor(i, p.displayName)));

  await tablet.startGame(roomId, opts.seed);
  room = await onceRoom(tablet, roomId);

  const clock = new VirtualClock();
  const humanSpeakers = new Map<SeatIndex, HumanSpeaker>();
  const humanSeat = new Map<number, SeatIndex>();
  humans.forEach((h, i) => {
    const seat = room.seating.indexOf(humanDevices[i]!.uid);
    humanSeat.set(i, seat);
    humanSpeakers.set(seat, h.speak);
  });

  const table = new AiTable({
    backend: tablet, roomId, agents, random, seed: opts.seed,
    rounds: opts.rounds ?? 3, autoVote: true, humanSpeakers,
    ...(opts.nightGraceMs !== undefined ? { nightGraceMs: opts.nightGraceMs } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onPublic ? { onPublic: opts.onPublic } : {}),
  });
  await table.prepare();

  const stops = humans.map((h, i) => driveHuman(h, humanDevices[i]!, roomId, humanSeat.get(i)!, table, clock));

  try {
    const run = await runGame({
      backend: table.backend,
      roomId,
      mode: 'test',
      clock,
      random,
      dayConfig: { discussionMs: 60 * 60_000, abstainPollMs: 1_000 },
      bots: table.botSeats(),
      onWindowOpen: table.onWindowOpen,
      onPhase: (phase) => {
        table.onPhase(phase);
        if (phase === 'day') clock.block(table.discussionDone());
      },
    });
    table.recordResult(run);
    return { log: table.log, run, table };
  } finally {
    stops.forEach((stop) => stop());
  }
}

/** Answer a human seat's night prompts and ballot through its own device. */
export function driveHuman(
  human: HumanPlayer, device: Backend, roomId: string, seat: SeatIndex,
  table: AiTable, clock: VirtualClock,
): () => void {
  let room: RoomView | null = null;
  let privateInfo: PrivateInfo[] = [];
  let dealtRole: RoleId | null = null;
  const answered = new Set<string>();
  let voted = false;

  const offRoom = device.watchRoom(roomId, (r) => {
    room = r;
    if (r?.phase === 'voting' && !voted) {
      voted = true;
      clock.block((async () => {
        const target = await human.vote({ seat, names: table.seatNames(), privateInfo, chat: [...table.chat] });
        await device.vote(roomId, r.seating[target] ?? null, false);
      })());
    }
  });
  const offPrivate = device.watchPrivate(roomId, (own) => {
    privateInfo = own.privateInfo;
    dealtRole = own.originalRole;
    for (const request of own.pending) {
      // A seat's decision keys are unique within one night.
      if (answered.has(request.key)) continue;
      answered.add(request.key);
      clock.block((async () => {
        const choice = await human.night({
          seat, names: table.seatNames(), dealtRole, privateInfo, request,
        });
        const current = room as RoomView | null;
        await device.submit(roomId, current?.nightWindowIndex ?? 0, { [request.key]: choice });
      })());
    }
  });
  return () => { offRoom(); offPrivate(); };
}
