import type { PublicNightView } from '../engine/publicview.js';
import type {
  Choice, DecisionRequest, GameConfig, PrivateInfo, RoleId, SeatIndex,
} from '../engine/types.js';

/**
 * EXPERIMENTAL — AI players (LLM or scripted) for practice rooms.
 *
 * Everything in src/ai/ sits on top of the existing bot seam (`Bot`,
 * `addBot`, `voteAsBot`, `runGame({ bots })`). The engine and the referee do
 * not know an LLM exists; they only see a bot seat that answers like any other.
 */

/**
 * Everything ONE seat may legitimately know. Prompts are built from this and
 * from nothing else, so an AI can never be handed another seat's card: the
 * type has no field that could carry it.
 */
export interface SeatKnowledge {
  seat: SeatIndex;
  /** Display name per seat, index = seat. Public. */
  names: string[];
  /** The card this seat was dealt. Its own, so it may know it. */
  dealtRole: RoleId;
  /** Exactly what the referee released to this seat, in order. */
  privateInfo: PrivateInfo[];
  /** Face-up cards and shield tokens: what everyone at the table can see. */
  publicView: PublicNightView | null;
  /** The public card list for this round (roles + padding Dorpelingen). */
  cards: RoleId[];
  config: GameConfig;
  /** Whether the separate Alpha Wolf centre card exists this round. */
  hasAlphaWolfCard: boolean;
}

export interface PublicMessage {
  seat: SeatIndex | null;
  name: string;
  text: string;
  /** Discussion round, 1-based. 0 for messages typed by humans out of turn. */
  round: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ms: number;
}

/** One answer plus the private reasoning behind it. Reasoning never reaches the table. */
export interface Turn<T> {
  value: T;
  reasoning: string;
  usage?: Usage;
  /** True when the model's answer was unusable and the scripted fallback decided. */
  fallback?: boolean;
}

export interface SpeakContext {
  round: number;
  rounds: number;
  chat: readonly PublicMessage[];
  /** Picked by the Rechter and not yet spoken: this statement must be true. */
  mustTellTruth: boolean;
}

export interface VoteDecision {
  target: SeatIndex;
  /** Belief probe: chance (0..1) that each other seat ends the night as a wolf. */
  beliefs: Record<number, number>;
}

export interface AiAgent {
  /** e.g. "mock", "openai:gpt-6-luna". Shown in replays and model comparisons. */
  readonly label: string;
  night(k: SeatKnowledge, request: DecisionRequest): Promise<Turn<Choice>>;
  /** Returns null to stay silent this round. */
  speak(k: SeatKnowledge, ctx: SpeakContext): Promise<Turn<string | null>>;
  vote(k: SeatKnowledge, chat: readonly PublicMessage[]): Promise<Turn<VoteDecision>>;
}

/* ------------------------------------------------------------------ */
/* Game log: everything needed for an omniscient replay afterwards.     */
/* ------------------------------------------------------------------ */

export interface SeatSetup {
  seat: SeatIndex;
  name: string;
  uid: string;
  kind: 'ai' | 'human';
  agent: string | null;
}

export type LogEvent =
  | { t: 'setup'; seats: SeatSetup[]; cards: RoleId[]; config: GameConfig; seed: number }
  | { t: 'deal'; dealt: RoleId[]; center: RoleId[]; alphaWolfCard: RoleId | null }
  | {
      t: 'night'; seat: SeatIndex; key: string; actingAs: RoleId;
      choice: Choice; reasoning: string; fallback?: boolean;
    }
  | { t: 'private'; seat: SeatIndex; info: PrivateInfo[] }
  | { t: 'public-view'; view: PublicNightView }
  | {
      t: 'say'; seat: SeatIndex | null; name: string; round: number;
      text: string | null; reasoning: string | null; human: boolean; fallback?: boolean;
    }
  | {
      t: 'vote'; seat: SeatIndex; target: SeatIndex | null;
      reasoning: string | null; beliefs: Record<number, number> | null; fallback?: boolean;
    }
  | {
      t: 'result'; outcome: string; eliminated: SeatIndex[]; winningTeams: string[];
      finalRoles: Record<number, RoleId>; finalVotes: Record<number, SeatIndex | null>;
      tally: Record<number, number>; seatWon: Record<number, boolean>;
      centerAtDawn: RoleId[];
    }
  | {
      t: 'call'; seat: SeatIndex; agent: string; phase: 'night' | 'speak' | 'vote';
      inputTokens: number; outputTokens: number; costUsd: number | null; ms: number;
    };

export interface GameLog {
  version: 1;
  startedAt: string;
  events: LogEvent[];
}

export type { Choice, DecisionRequest, PrivateInfo, RoleId, SeatIndex };
