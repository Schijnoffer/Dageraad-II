import type { Backend, PlayerView, RoomView } from '../app/backend.js';
import { readRoomOnce, runGame, type GameRunResult } from '../app/refereeRunner.js';
import { cardsForRoles } from '../engine/deal.js';
import { DEFAULT_ACTIVE_ROLES, TWO_ROUND_CONFIG } from '../engine/presets.js';
import type { GameConfig, RoleId } from '../engine/types.js';
import type { Clock } from '../orchestration/clock.js';
import { AiTable } from './table.js';
import type { AiAgent, GameLog, LogEvent, PublicMessage } from './types.js';

/**
 * AI seats in a REAL room with humans on their own phones.
 *
 * This device is the table device (referee, takes no seat). Humans join from
 * the normal app with the room code and see nothing new: the AI seats are the
 * existing practice-room bots ("AI Bram", …), so no Firestore rule, schema or
 * UI change is needed. What the AIs say is shown on this device, and what the
 * humans say out loud is typed in here (see cli/host.ts).
 */

export interface CreateAiRoomOptions {
  ais: number;
  activeRoles?: RoleId[];
  config?: GameConfig;
  discussionMs?: number;
}

export async function createAiRoom(backend: Backend, opts: CreateAiRoomOptions): Promise<string> {
  const roomId = await backend.createRoom({
    displayName: 'AI-tafel',
    activeRoles: opts.activeRoles ?? DEFAULT_ACTIVE_ROLES,
    config: opts.config ?? TWO_ROUND_CONFIG,
    playing: false,
    mode: 'practice',
    ...(opts.discussionMs ? { discussionMs: opts.discussionMs } : {}),
  });
  for (let i = 0; i < opts.ais; i++) await backend.addBot(roomId);
  return roomId;
}

export interface PlayRoundOptions {
  agentFor(index: number, name: string): AiAgent;
  seed: number;
  activeRoles?: RoleId[];
  clock?: Clock;
  rounds?: number;
  /** Open the ballot when the AI rounds end. Leave off when humans decide. */
  autoVote?: boolean;
  onEvent?: (event: LogEvent) => void;
  onPublic?: (msg: PublicMessage) => void;
  /** Hands the live table to the caller (to feed human chat into it). */
  onTable?: (table: AiTable) => void;
  onPhase?: (phase: 'night' | 'day' | 'voting' | 'results') => void;
  /** See AiTableOptions.nightGraceMs. Default 2s with a real clock. */
  nightGraceMs?: number;
}

export interface PlayedRound {
  log: GameLog;
  run: GameRunResult;
  room: RoomView;
}

/** Deal and play one round in an existing lobby. The caller decides when to start. */
export async function playAiRound(
  backend: Backend, roomId: string, opts: PlayRoundOptions,
): Promise<PlayedRound> {
  let room = await readRoomOnce(backend, roomId);
  if (room.phase === 'results') {
    await backend.prepareNextRound(roomId);
    room = await readRoomOnce(backend, roomId);
  }
  const roles = opts.activeRoles ?? DEFAULT_ACTIVE_ROLES;
  let present: PlayerView[] = [];
  for (let attempt = 0; ; attempt++) {
    // Everyone still in the room is dealt in at this boundary — the same rule
    // startGame applies. A human who just joined is not in `seating` yet.
    present = (await settledPlayers(backend, roomId)).filter((p) => !p.departed);
    await backend.setActiveRoles(roomId, cardsForRoles(roles, present.length), room.config);
    try {
      await backend.startGame(roomId, opts.seed);
      break;
    } catch (err) {
      // Somebody joined or left between counting and dealing: count again.
      if (attempt >= 2 || !/kaarten nodig/.test(String(err))) throw err;
    }
  }
  const agents = new Map<string, AiAgent>();
  present.filter((p) => p.isBot).forEach((p, i) => agents.set(p.uid, opts.agentFor(i, p.displayName)));

  const table = new AiTable({
    backend, roomId, agents, seed: opts.seed,
    rounds: opts.rounds ?? 2,
    autoVote: opts.autoVote ?? false,
    // A virtual clock means nobody is timing the windows; a real one means
    // humans are, and a slow model must not stretch the night.
    ...(opts.clock ? {} : { nightGraceMs: opts.nightGraceMs ?? 2_000 }),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    ...(opts.onPublic ? { onPublic: opts.onPublic } : {}),
  });
  await table.prepare();
  opts.onTable?.(table);

  const clock = opts.clock;
  const run = await runGame({
    backend: table.backend,
    roomId,
    mode: 'test',
    ...(clock ? { clock } : {}),
    bots: table.botSeats(),
    onWindowOpen: table.onWindowOpen,
    onPhase: (phase) => {
      table.onPhase(phase);
      opts.onPhase?.(phase);
      const virtual = clock as { block?: (p: Promise<unknown>) => void } | undefined;
      if (phase === 'day' && virtual?.block) virtual.block(table.discussionDone());
    },
  });
  table.recordResult(run);
  return { log: table.log, run, room: await readRoomOnce(backend, roomId) };
}

/**
 * The player list once it has stopped changing. A Firestore listener answers
 * from the local cache first (only the bots this device wrote), then from the
 * server; the memory backend answers once, synchronously.
 */
function settledPlayers(backend: Backend, roomId: string, quietMs = 800): Promise<PlayerView[]> {
  return new Promise((resolve) => {
    let latest: PlayerView[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = backend.watchPlayers(roomId, (players) => {
      latest = players;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { off(); resolve(latest); }, quietMs);
    });
  });
}
