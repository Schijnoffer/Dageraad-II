import type { Backend, GameResults, RoomView } from '../app/backend.js';
import type { BotSeats, GameRunResult } from '../app/refereeRunner.js';
import type { WindowInfo } from '../orchestration/referee.js';
import { scriptedAgent } from './scripted.js';
import { readRoomOnce } from '../app/refereeRunner.js';
import type { PublicNightView } from '../engine/publicview.js';
import { centerSlot, roleAt } from '../engine/state.js';
import type { Choice, DecisionRequest, PrivateInfo, RoleId, SeatIndex } from '../engine/types.js';
import type {
  AiAgent, GameLog, LogEvent, PublicMessage, SeatKnowledge, SpeakContext, Turn,
} from './types.js';

export type HumanSpeaker = (seat: SeatIndex, ctx: SpeakContext) => Promise<string | null>;

export interface AiTableOptions {
  /** The referee device's backend (the table device). */
  backend: Backend;
  roomId: string;
  /** AI players by uid. Every uid must be an `isBot` player in the room. */
  agents: ReadonlyMap<string, AiAgent>;
  /** Public discussion rounds before the vote opens (when autoVote). */
  rounds?: number;
  /**
   * Open the ballot once the AI rounds are done (practice-only referee
   * shortcut). Off when humans should decide when talking is over.
   */
  autoVote?: boolean;
  /** Humans who take a turn in the round order (offline/terminal play). */
  humanSpeakers?: ReadonlyMap<SeatIndex, HumanSpeaker>;
  /** Seeded order of speakers within a round. */
  random?: () => number;
  /** Called for every public message, AI or human, as it is said. */
  onPublic?: (msg: PublicMessage) => void;
  /** Called with every log event as it happens (live replay/streaming). */
  onEvent?: (event: LogEvent) => void;
  seed?: number;
  /**
   * How long after a night window closes an AI may still be thinking before
   * its scripted fallback answers instead. AI decisions start when the window
   * OPENS and normally finish inside it; this cap keeps a slow model from
   * stretching the gap between windows, because a gap that depends on which
   * seats had actions is the timing leak README "anti-leak invariant" forbids.
   * Unset = wait (headless games, where nobody is timing anything).
   */
  nightGraceMs?: number;
}

/**
 * The AI players' side of one round, run on the referee device.
 *
 * The referee already holds every card (README "Trust model"), so it is the
 * only place an AI seat can be answered from. What this class guarantees is
 * that each AI is told ONLY what that seat's own phone would have shown: the
 * dealt card, the private receipts the referee released to it (captured at the
 * moment they were written), the public table, and the public chat.
 */
export class AiTable {
  readonly log: GameLog = { version: 1, startedAt: new Date().toISOString(), events: [] };
  readonly chat: PublicMessage[] = [];

  private room!: RoomView;
  private names: string[] = [];
  private dealt: RoleId[] = [];
  private hasAlphaWolfCard = false;
  private readonly seatAgents = new Map<SeatIndex, AiAgent>();
  private readonly released = new Map<SeatIndex, PrivateInfo[]>();
  private publicView: PublicNightView | null = null;
  private readonly spoken = new Set<SeatIndex>();
  private discussion: Promise<void> | null = null;
  private readonly nightTurns = new Map<string, Promise<Turn<Choice>>>();
  private readonly votes = new Map<SeatIndex, Promise<SeatIndex | null>>();
  private readonly fallbacks = new Map<SeatIndex, AiAgent>();
  private queue: Promise<void> = Promise.resolve();
  private readonly random: () => number;
  readonly backend: Backend;

  constructor(private readonly opts: AiTableOptions) {
    this.random = opts.random ?? Math.random;
    this.backend = this.wrap(opts.backend);
  }

  private emit(event: LogEvent): void {
    this.log.events.push(event);
    this.opts.onEvent?.(event);
  }

  /**
   * The referee's backend, with its store tapped so released private info and
   * the public view are recorded exactly as they are published.
   */
  private wrap(inner: Backend): Backend {
    const self = this;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'refereeStore') {
          return (roomId: string) => {
            const store = target.refereeStore(roomId);
            return new Proxy(store, {
              get(s, p, r) {
                if (p === 'setPrivateInfo') {
                  return async (seat: SeatIndex, info: PrivateInfo[]) => {
                    self.released.set(seat, [...info]);
                    return s.setPrivateInfo(seat, info);
                  };
                }
                if (p === 'publishPublicView') {
                  return async (view: PublicNightView) => {
                    self.publicView = view;
                    return s.publishPublicView(view);
                  };
                }
                const value = Reflect.get(s, p, r) as unknown;
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(s) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** Call after `startGame`, before `runGame`. */
  async prepare(): Promise<void> {
    this.room = await readRoomOnce(this.opts.backend, this.opts.roomId);
    const players = await new Promise<{ uid: string; displayName: string; isBot?: boolean }[]>((resolve) => {
      const off = this.opts.backend.watchPlayers(this.opts.roomId, (p) => {
        queueMicrotask(() => off());
        resolve(p);
      });
    });
    const byUid = new Map(players.map((p) => [p.uid, p]));
    this.names = this.room.seating.map((uid) => byUid.get(uid)?.displayName ?? uid);
    this.room.seating.forEach((uid, seat) => {
      const agent = this.opts.agents.get(uid);
      if (!agent) return;
      if (!byUid.get(uid)?.isBot) throw new Error(`AI agent for ${uid}, but that seat is not a bot`);
      this.seatAgents.set(seat, agent);
    });

    const state = await this.opts.backend.refereeNightState(this.opts.roomId);
    if (!state) throw new Error('deal the round (startGame) before preparing the AI table');
    this.dealt = [...state.originalRole];
    this.hasAlphaWolfCard = state.alphaWolfSlot !== null;

    this.emit({
      t: 'setup',
      seed: this.opts.seed ?? 0,
      cards: physicalCards(this.room.activeRoles),
      config: this.room.config,
      seats: this.room.seating.map((uid, seat) => ({
        seat, uid, name: this.names[seat]!,
        kind: this.seatAgents.has(seat) ? 'ai' : 'human',
        agent: this.seatAgents.get(seat)?.label ?? null,
      })),
    });
    this.emit({
      t: 'deal',
      dealt: [...state.originalRole],
      center: Array.from({ length: state.centerCount }, (_, i) => roleAt(state, centerSlot(state, i))),
      alphaWolfCard: state.alphaWolfSlot === null ? null : roleAt(state, state.alphaWolfSlot),
    });
  }

  get aiSeats(): ReadonlySet<SeatIndex> {
    return new Set(this.seatAgents.keys());
  }

  seatNames(): readonly string[] {
    return this.names;
  }

  /** What one seat knows right now. Built from nothing but that seat's own view. */
  knowledge(seat: SeatIndex): SeatKnowledge {
    return {
      seat,
      names: [...this.names],
      dealtRole: this.dealt[seat]!,
      privateInfo: [...(this.released.get(seat) ?? [])],
      publicView: this.publicView,
      cards: physicalCards(this.room.activeRoles),
      config: this.room.config,
      hasAlphaWolfCard: this.hasAlphaWolfCard,
    };
  }

  private call(seat: SeatIndex, phase: 'night' | 'speak' | 'vote', turn: Turn<unknown>): void {
    if (!turn.usage) return;
    this.emit({
      t: 'call', seat, agent: this.seatAgents.get(seat)?.label ?? '?', phase,
      inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens,
      costUsd: turn.usage.costUsd, ms: turn.usage.ms,
    });
  }

  private nightKey(request: DecisionRequest): string {
    return `${request.seat}:${request.key}`;
  }

  private startNight(request: DecisionRequest): Promise<Turn<Choice>> {
    const key = this.nightKey(request);
    const existing = this.nightTurns.get(key);
    if (existing) return existing;
    const agent = this.seatAgents.get(request.seat)!;
    const turn = agent.night(this.knowledge(request.seat), request);
    this.nightTurns.set(key, turn);
    return turn;
  }

  /** Pass as `runGame({ onWindowOpen })`: AI seats start thinking as the window opens. */
  onWindowOpen = (window: WindowInfo): void => {
    for (const request of window.requests) {
      if (this.seatAgents.has(request.seat)) void this.startNight(request).catch(() => undefined);
    }
  };

  private async decideNight(request: DecisionRequest): Promise<Choice> {
    const pending = this.startNight(request);
    const grace = this.opts.nightGraceMs;
    let turn: Turn<Choice> | null = null;
    if (grace === undefined) turn = await pending.catch(() => null);
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), grace); });
      turn = await Promise.race([pending.catch(() => null), late]);
      clearTimeout(timer);
    }
    if (!turn) {
      const fallback = await this.fallbackFor(request.seat).night(this.knowledge(request.seat), request);
      turn = { ...fallback, fallback: true, reasoning: `[te laat of fout, fallback] ${fallback.reasoning}` };
    }
    this.call(request.seat, 'night', turn);
    this.emit({
      t: 'night', seat: request.seat, key: request.key, actingAs: request.actingAs,
      choice: turn.value, reasoning: turn.reasoning,
      ...(turn.fallback ? { fallback: true } : {}),
    });
    return turn.value;
  }

  private fallbackFor(seat: SeatIndex): AiAgent {
    let agent = this.fallbacks.get(seat);
    if (!agent) {
      agent = scriptedAgent((this.opts.seed ?? 0) * 131 + seat);
      this.fallbacks.set(seat, agent);
    }
    return agent;
  }

  private startVotes(): void {
    const ready = (async () => {
      await this.discussion;
      await this.queue;
    })();
    for (const [seat, agent] of this.seatAgents) {
      if (this.votes.has(seat)) continue;
      this.votes.set(seat, ready.then(async () => {
        const turn = await agent.vote(this.knowledge(seat), [...this.chat]);
        this.call(seat, 'vote', turn);
        this.emit({
          t: 'vote', seat, target: turn.value.target, reasoning: turn.reasoning,
          beliefs: turn.value.beliefs, ...(turn.fallback ? { fallback: true } : {}),
        });
        return turn.value.target;
      }));
    }
  }

  /** Plug into `runGame({ bots })`. */
  botSeats(): BotSeats {
    return {
      seats: this.aiSeats,
      bot: {
        choose: async (request: DecisionRequest): Promise<Choice> => {
          if (!this.seatAgents.has(request.seat)) return { kind: 'none' };
          return this.decideNight(request);
        },
        chooseVote: () => ({ target: null, abstain: false }),
      },
      vote: async (seat) => {
        if (!this.seatAgents.has(seat)) return null;
        this.startVotes();
        return this.votes.get(seat) ?? null;
      },
    };
  }

  /** Pass as `runGame({ onPhase })`. Starts the AI discussion when day breaks. */
  onPhase = (phase: 'night' | 'day' | 'voting' | 'results'): void => {
    // All AI ballots are worked out at once rather than one after another.
    if (phase === 'voting') this.startVotes();
    if (phase !== 'day' || this.discussion) return;
    for (const [seat, info] of this.released) this.emit({ t: 'private', seat, info: [...info] });
    if (this.publicView) this.emit({ t: 'public-view', view: this.publicView });
    this.discussion = this.runDiscussion();
  };

  /** Resolves once the scripted rounds of talk are over. */
  discussionDone(): Promise<void> {
    return this.discussion ?? Promise.resolve();
  }

  private async speakTurn(seat: SeatIndex, round: number, rounds: number): Promise<void> {
    const ctx: SpeakContext = {
      round, rounds, chat: [...this.chat],
      mustTellTruth: !this.spoken.has(seat)
        && (this.released.get(seat) ?? []).some((i) => i.kind === 'judged'),
    };
    const human = this.opts.humanSpeakers?.get(seat);
    if (human) {
      const text = await human(seat, ctx);
      this.say(seat, this.names[seat]!, round, text, null, true);
      return;
    }
    const agent = this.seatAgents.get(seat);
    if (!agent) return;
    const turn = await agent.speak(this.knowledge(seat), ctx);
    this.call(seat, 'speak', turn);
    this.say(seat, this.names[seat]!, round, turn.value, turn.reasoning, false, turn.fallback);
  }

  private say(
    seat: SeatIndex | null, name: string, round: number, text: string | null,
    reasoning: string | null, human: boolean, fallback?: boolean,
  ): void {
    this.emit({
      t: 'say', seat, name, round, text, reasoning, human,
      ...(fallback ? { fallback: true } : {}),
    });
    if (seat !== null && text) this.spoken.add(seat);
    if (!text) return;
    const msg: PublicMessage = { seat, name, text, round };
    this.chat.push(msg);
    this.opts.onPublic?.(msg);
  }

  private shuffledSpeakers(): SeatIndex[] {
    const seats = [...this.seatAgents.keys(), ...(this.opts.humanSpeakers?.keys() ?? [])];
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [seats[i], seats[j]] = [seats[j]!, seats[i]!];
    }
    return seats;
  }

  private async runDiscussion(): Promise<void> {
    const rounds = this.opts.rounds ?? 3;
    for (let round = 1; round <= rounds; round++) {
      // Like Clocktower Bench's waves: a fresh random order every round, and
      // each speaker hears everyone who spoke before them.
      for (const seat of this.shuffledSpeakers()) {
        await this.serial(() => this.speakTurn(seat, round, rounds));
      }
    }
    if (this.opts.autoVote !== false) await this.opts.backend.forcePracticeVote(this.opts.roomId);
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A human at a real table said something (typed in on the table device).
   * Every AI gets one chance to react, in a random order.
   */
  async humanMessage(name: string, text: string, seat: SeatIndex | null = null): Promise<void> {
    await this.serial(async () => this.say(seat, name, 0, text, null, true));
    for (const ai of this.shuffledSpeakers()) {
      if (!this.seatAgents.has(ai)) continue;
      await this.serial(() => this.speakTurn(ai, (this.opts.rounds ?? 3) + 1, (this.opts.rounds ?? 3) + 1));
    }
  }

  /** Append the published result. Call with what `runGame` returned. */
  recordResult(run: GameRunResult): void {
    const results: GameResults = run.results;
    const seatWon: Record<number, boolean> = {};
    for (const [seat, r] of Object.entries(results.seats)) seatWon[Number(seat)] = r.won;
    this.emit({
      t: 'result',
      outcome: results.outcome,
      eliminated: results.eliminatedSeats,
      winningTeams: results.winningTeams,
      finalRoles: results.finalRoles,
      finalVotes: results.finalVotes,
      tally: results.finalTally,
      seatWon,
      centerAtDawn: results.finalCenterRoles ?? [],
    });
  }
}

/**
 * Every card on the table. With the Alfawolf, one wolf card goes face down on
 * its spot and a Dorpeling fills the deck back up (see engine/deal.ts), so
 * players can honestly count one more Dorpeling than the selection shows.
 */
export function physicalCards(activeRoles: readonly RoleId[]): RoleId[] {
  return activeRoles.includes('alphawolf') ? [...activeRoles, 'dorpeling'] : [...activeRoles];
}
