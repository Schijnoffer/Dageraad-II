import type {
  CardId, GameConfig, PrivateInfo, RoleId, Choice, NightEvent, NightState,
  DecisionRequest, Team,
} from '../engine/types.js';
import type { Timeline } from '../engine/timeline.js';
import type { DiscardReason, VoteOutcome } from '../engine/dayphase.js';
import type { RoundResult } from '../app/session.js';

/**
 * Firestore document shapes. These mirror firestore.rules exactly — if you add
 * a field here, check whether a rule needs to know about it, especially in
 * `profiles` (which uses an explicit key allowlist) and `calibration`.
 *
 * Layout:
 *   /rooms/{roomId}                    public room state
 *   /rooms/{roomId}/players/{uid}      public: name, avatar, seat
 *   /rooms/{roomId}/members/{uid}      who is in the evening, and for how long
 *   /rooms/{roomId}/rounds/{n}         append-only record of one finished game
 *   /rooms/{roomId}/private/{uid}      SECRET: dealt role, card, reveals
 *   /rooms/{roomId}/engine/state       SECRET: the entire deal (referee only)
 *   /rooms/{roomId}/submissions/{uid}  night choices (owner writes, referee reads)
 *   /rooms/{roomId}/votes/{uid}        day votes (hidden until results)
 *   /profiles/{uid}                    persistent identity (NO stats — see below)
 *   /calibration/{sampleId}            append-only timing samples
 */

/** Room lifecycle. Several rules key off this, so the order matters. */
export type RoomPhase = 'lobby' | 'night' | 'day' | 'voting' | 'results';

/** Practice rounds are played and stored in full; they are never counted. */
export type RoomMode = 'practice' | 'official';

export interface RoomDoc {
  /** Created the room and normally manages its setup. */
  hostUid: string;
  /**
   * The device that computes resolution — ideally the neutral tablet, since it
   * necessarily holds every player's card (see README "Trust model").
   *
   * Normally fixed for the game. A trusted group may deliberately transfer
   * control through the phrase-guarded emergency recovery path in the rules.
   */
  refereeUid: string;
  /**
   * Not a secret: an explicit phrase required by the emergency recovery rule.
   * Its purpose is to make a role takeover a conscious action in the app.
   */
  recoveryPhrase: string | null;
  phase: RoomPhase;
  /**
   * Whether this evening counts.
   *
   * IMMUTABLE AFTER CREATION, and the rules enforce it. A room that could be
   * promoted from practice to official after the fact would let a good night
   * be retconned into the record and a bad one quietly demoted, which is worse
   * than having no history at all.
   *
   * Defaults to 'practice' EVERYWHERE, deliberately: the failure we can afford
   * is a real evening accidentally not counting, which is annoying. The one we
   * cannot is a test round polluting a year of history, because the records
   * are append-only and there is no delete path by design.
   */
  mode: RoomMode;
  /** Chosen at creation and immutable: 1-120 minutes. */
  discussionMs: number;
  /** Shared countdown target while phase == 'day'. */
  discussionEndsAt: number | null;
  /** Referee-only shortcut for practice testing. */
  practiceSkipDiscussion: boolean;
  /**
   * Which game of the evening this is, counting from 1 (0 in the lobby).
   *
   * A room is a SESSION, not a single game (see session.ts). This field is
   * load-bearing for scoring, not just for display: the rules pin a joining
   * member's `joinedAtRound` to it, and that is the only thing a latecomer's
   * seed is computed from. It is therefore MONOTONIC — the rules refuse a
   * write that moves it backwards, because rewinding it would let the referee
   * re-seed somebody against a floor that has already been superseded.
   */
  currentRound: number;
  /**
   * Advanced by the referee as each night window closes. A submission is only
   * accepted when its windowIndex matches this, which blocks a late write after
   * seeing a reveal without having to trust any client's clock.
   */
  nightWindowIndex: number;
  /** Current night step the referee explicitly chose to finish without all answers. */
  nightForceAdvanceIndex: number | null;
  /** PUBLIC by design — the host picks these at setup and everyone sees them. */
  activeRoles: RoleId[];
  nightOrder: RoleId[];
  config: GameConfig;
  /**
   * Seat order around the physical table, as uids: index IS the seat. Written
   * by the referee at each round boundary and frozen while a round runs.
   *
   * THE ONLY PLACE A SEAT IS RECORDED. There is deliberately no seatIndex on
   * the player document: that would be redundant (the doc is keyed by uid) and
   * forgeable, and no rule could stop a player writing somebody else's seat
   * number into a document they own. Same reasoning as the submissions store.
   */
  seating: string[];
  /**
   * Safe to publish: derived from activeRoles alone, never from the deal
   * (see timeline.ts). Publishing it leaks nothing everyone doesn't have.
   */
  timeline: Timeline;
  /** Spoiler-free events for the shared tablet (§12). */
  publicEvents: NightEvent[];
  shieldedSlots: number[];
  revealedCards: CardId[];
  createdAt: number;
  /** Set while the host has paused for an absent player. Public by design. */
  pausedAt: number | null;
  /**
   * Live counts, published by the referee. Safe to show: they are counts, and
   * never who voted for whom — in the physical game you can see perfectly well
   * whose hand is still down.
   */
  votesCast: number;
  abstainCount: number;
  /**
   * How many have asked to open the ballot early.
   *
   * A COUNT. Publishing which seats asked would turn a show of hands into a
   * record of who was impatient, and at a table that is information about how
   * confident somebody is feeling.
   */
  earlyVoteCount: number;
  /** Set when the 50/50 suspense extension fires (§7). Public on purpose. */
  discussionExtendedByMs: number;
  /**
   * Every seat's card at dawn. Written ONCE, when the game is over — this is
   * the single moment roles become public, and until then it is null.
   */
  finalRoles: Record<number, RoleId> | null;
  /** Dealt roles, revealed only once the room reaches results. */
  originalRoles?: Record<number, RoleId>;
  outcome: string | null;
  /** Full public result, added after the first real playtest exposed raw `tie`. */
  eliminatedSeats?: number[];
  winningTeams?: Team[];
  finalVotes?: Record<number, number | null>;
  discardedVotes?: Partial<Record<number, DiscardReason>>;
  finalTally?: Record<number, number>;
  /** Published only in the result phase for playtest verification. */
  finalCenterRoles?: RoleId[];
  nightInfo?: Record<number, PrivateInfo[]>;
  /**
   * SLOT -> the role lying face up there right now (§12).
   *
   * Republished by the referee after every window, derived from which CARDS
   * were flipped and where those cards currently are. Never accumulated from
   * old reveal events: a reveal belongs to the card, and everything that moves
   * cards acts after the Medium.
   */
  revealedSlots: Record<number, RoleId>;
  shieldedSeats: number[];
}

/**
 * Public per-player info. Name and picture, and nothing that is worth points
 * or reveals a card.
 *
 * NOTE THE ABSENCE OF A SEAT. Seating is the room document's ordered uid list,
 * written by the referee; a seatIndex here would be a seat number sitting in a
 * document its own player can write. The rules allowlist these keys.
 */
export interface PlayerDoc {
  displayName: string;
  avatar: string | null;
  joinedAt: number;
  /** Soft presence; updated while the tab is open. Optional for older docs. */
  lastSeen?: number;
  /**
   * An AI player, added by the controlling browser to fill out a practice
   * table.
   *
   * Written ONLY by the referee, and only in a practice room. A human able to
   * mark their own document as a bot would be a human the referee is then
   * allowed to vote on behalf of — which is the one thing the narrow
   * voteAsBot method exists to prevent.
   */
  isBot?: boolean;
}

/** SECRET. Readable only by its owner and the referee. */
export interface PrivateDoc {
  /** §6.0: fixed at deal time; drives night order and which action you take. */
  originalRole: RoleId;
  /** §6.0: mutable; drives your team and win condition at dawn. */
  currentCard: CardId;
  currentRole: RoleId;
  /**
   * Everything this seat has privately learned, each tagged with the night step
   * at which it was TRUE — the UI must render "at your turn, seat 3 held X",
   * never as a current fact, because the Dorpsgek may have moved it since.
   */
  privateInfo: PrivateInfo[];
  /** Released reveals only. The referee withholds later ones until due. */
  revealedThrough: number;
  /**
   * What this seat is being asked for the window now open, written by the
   * referee. Empty when nothing is being asked — a real state, and what clears
   * the previous window's question off the screen.
   */
  pendingDecisions?: DecisionRequest[];
}

/**
 * SECRET. Referee only. Nothing else in the app may read this.
 *
 * A SERIALISED NightState, not the thing itself. `NightState` uses `Set`s for
 * the shielded slots and revealed cards, and Firestore cannot store a Set — it
 * would arrive back as an empty object, and an empty shield set is a Bodyguard
 * who silently stopped working. Use the converters below rather than casting.
 */
export interface EngineStateDoc {
  seatCount: number;
  centerCount: number;
  slots: CardId[];
  cardRole: Record<CardId, RoleId>;
  originalRole: RoleId[];
  /** Set<SlotIndex> as an array. */
  shieldedSlots: number[];
  /** Set<CardId> as an array. */
  revealedCards: CardId[];
  alphaWolfSlot: number | null;
  /**
   * Seats that COUNT AS a role without their card having changed — the
   * Onderzoeker case. Carried explicitly because losing it would not throw:
   * the night would resolve, and one player would quietly be on the wrong team
   * at dawn.
   */
  assumedRole: Record<number, RoleId>;
  /** Referee-only recovery data; absent on rooms created before this support. */
  completedWindowIndex?: number;
  nightAnswers?: Array<{ key: string; choice: Choice }>;
}

/** NightState -> document. Sets become arrays; nothing else changes. */
export function engineStateToDoc(state: NightState): EngineStateDoc {
  return {
    seatCount: state.seatCount,
    centerCount: state.centerCount,
    slots: [...state.slots],
    cardRole: { ...state.cardRole },
    originalRole: [...state.originalRole],
    shieldedSlots: [...state.shieldedSlots],
    revealedCards: [...state.revealedCards],
    alphaWolfSlot: state.alphaWolfSlot,
    assumedRole: { ...state.assumedRole },
  };
}

/** Document -> NightState. The inverse, and tested as one. */
export function engineStateFromDoc(doc: EngineStateDoc): NightState {
  return {
    seatCount: doc.seatCount,
    centerCount: doc.centerCount,
    slots: [...doc.slots],
    cardRole: { ...doc.cardRole },
    originalRole: [...doc.originalRole],
    shieldedSlots: new Set(doc.shieldedSlots ?? []),
    revealedCards: new Set(doc.revealedCards ?? []),
    alphaWolfSlot: doc.alphaWolfSlot,
    assumedRole: { ...(doc.assumedRole ?? {}) },
  };
}

export interface SubmissionDoc {
  /** The round this choice belongs to. Old unscoped documents are ignored. */
  round: number;
  /** Must equal the room's current nightWindowIndex or the write is rejected. */
  windowIndex: number;
  /** Keyed by DecisionRequest.key, so one doc can hold a whole window. */
  choices: Record<string, Choice>;
  submittedAt: number;
}

export interface VoteDoc {
  /** The round this vote belongs to. Old unscoped documents are ignored. */
  round: number;
  /** null = abstained without naming anyone. Never equal to your own uid (§7). */
  target: string | null;
  abstain: boolean;
  /** "Let us vote now." Separate from abstain; see Backend.requestEarlyVote. */
  readyToVote?: boolean;
  /** Conscious-friction marker for a referee casting for a failed device. */
  takeoverPhrase?: string;
  castAt: number;
}

/**
 * Append-only per-game outcome. THESE ARE THE AUTHORITATIVE STATS.
 *
 * There are deliberately no mutable win counters anywhere in this schema.
 * Profile stats are aggregated client-side by reading these documents, which
 * removes "who is allowed to increment my win count" as a question and makes
 * game history tamper-evident. At this group's volume it is a few hundred tiny
 * documents a year.
 */
export interface ResultDoc {
  finalRole: RoleId;
  originalRole: RoleId;
  won: boolean;
  votedFor: string | null;
  /**
   * Full categorical outcome, NOT a boolean. `caused-village-loss` has to stay
   * distinguishable from an ordinary wrong guess — it is the Bodyguard case
   * Milan wants tracked — and once a boolean is written here that distinction
   * is gone for good. `inconsequential` and `not-scored` likewise must not be
   * stored as `false`: a timed-out window is not a wrong answer (§10).
   */
  voteOutcome: VoteOutcome;
  suspicionAccuracy: number | null;
  recordedAt: number;
}

/**
 * Who is in the evening, and for which stretch of it.
 *
 * THE FIELD THAT IS NOT HERE IS THE POINT. This used to carry `seeded`: the
 * number of points a latecomer's scoreboard row starts at, written by the
 * joining client into a document that same client owns. `seeded: 9999` typed
 * into devtools was a first-place finish for the evening, and no security rule
 * could reject it — rules can answer "may you write this document", not "was
 * 9999 the right floor at round four", which needs the whole evening replayed.
 *
 * The seed is now DERIVED (session.ts `standings`) from `joinedAtRound` and
 * the append-only round records. Both are out of the joiner's hands: the rules
 * pin `joinedAtRound` to the room's `currentRound` at the instant of the
 * write, and rounds are referee-written and create-only. What is left in this
 * document is which round you arrived and which round you left, and neither of
 * those is worth points.
 *
 * The rules allowlist these keys exactly, so a re-added `seeded` field is
 * rejected at the database rather than quietly ignored by one client.
 */
export interface SessionMemberDoc {
  /** Equal to the document id. Redundant on purpose — see roomstore.ts. */
  uid: string;
  /** Pinned by the rules to the room's currentRound at the time of the write. */
  joinedAtRound: number;
  /** The LAST round they play, not the first they miss. Null while still here. */
  leftAtRound: number | null;
  /**
   * Which human this device is, for history that spans evenings.
   *
   * A LABEL, never an authorisation. Every rule still keys off the uid; this
   * only says whose row in the all-time table a finished round belongs to. It
   * is on the member document rather than looked up later because a player can
   * go home, and the record of who was here has to survive them leaving.
   */
  friendId: string;
  /** What they were called this evening, so old rounds stay readable. */
  friendName: string;
}

/**
 * One finished game of the evening. APPEND-ONLY, referee-written.
 *
 * The document id is the round number as a string, and the rules check that it
 * matches the `round` field — so a round can be recorded once and only once,
 * and cannot be smuggled in a second time under another id.
 *
 * This is the other half of what replaced the stored seed: the scoreboard, and
 * every latecomer's seed with it, is rebuilt from these documents alone.
 */
export interface RoundDoc {
  round: number;
  activeRoles: RoleId[];
  seatCount: number;
  outcome: string;
  results: RoundResult[];
  recordedAt: number;
}

/**
 * A friend of the group. Chosen from a list when joining, created once.
 *
 * Deliberately thin, and deliberately not owned by anybody: it is a shared
 * address book for eight people who know each other, not an account. There is
 * no password because there is nothing here worth taking — claiming to be
 * somebody else buys you their board game scoreboard and nothing whatsoever
 * inside a game, where the uid is still what every rule checks.
 */
export interface FriendDoc {
  id: string;
  displayName: string;
  createdAt: number;
}

/**
 * One player's line in one finished OFFICIAL round. The all-time record.
 *
 * Append-only and immutable, like the per-room results it mirrors, and for a
 * stronger reason: this is the only thing the group's history is made of, so
 * an editable row is an editable year.
 *
 * EVERYTHING HERE IS PUBLIC AT DAWN. Roles become public when the game ends
 * (§6.0) and the vote outcome is already in the per-room results. Nothing
 * about the night — targets, reveals, what anybody saw — appears, and nothing
 * that was ever secret is made public a moment earlier than it already was.
 *
 * Practice rooms write nothing here at all. That is checked in the rules
 * against the room document rather than trusted from the write.
 */
export interface HistoryDoc {
  roomId: string;
  round: number;
  friendId: string;
  /** Name snapshot at the time, so an old evening reads correctly. */
  name: string;
  seat: number;
  originalRole: RoleId;
  finalRole: RoleId;
  won: boolean;
  voteOutcome: VoteOutcome;
  suspicionAccuracy: number | null;
  recordedAt: number;
}

/** Persistent identity. The rules allowlist these keys exactly — no stats here. */
export interface ProfileDoc {
  displayName: string;
  avatar: string | null;
  language: 'nl' | 'en';
  createdAt: number;
  updatedAt: number;
}

/**
 * Append-only timing sample. Keyed by role NAME and never by who was playing
 * it — attaching a uid would turn this collection into a public record of who
 * played what. The rules enforce the key allowlist.
 */
export interface CalibrationDoc {
  role: RoleId;
  key: string;
  latencyMs: number;
  outcome: 'submitted' | 'timed-out' | 'referee-skipped';
  paused: boolean;
  sessionId: string;
  createdAt: number;
}

/* ------------------------------ path helpers ------------------------------ */

export const paths = {
  room: (roomId: string) => `rooms/${roomId}`,
  players: (roomId: string) => `rooms/${roomId}/players`,
  player: (roomId: string, uid: string) => `rooms/${roomId}/players/${uid}`,
  private: (roomId: string, uid: string) => `rooms/${roomId}/private/${uid}`,
  engineState: (roomId: string) => `rooms/${roomId}/engine/state`,
  submission: (roomId: string, uid: string) => `rooms/${roomId}/submissions/${uid}`,
  vote: (roomId: string, uid: string) => `rooms/${roomId}/votes/${uid}`,
  members: (roomId: string) => `rooms/${roomId}/members`,
  member: (roomId: string, uid: string) => `rooms/${roomId}/members/${uid}`,
  rounds: (roomId: string) => `rooms/${roomId}/rounds`,
  /** Keyed by round number, so recording the same round twice is a collision. */
  round: (roomId: string, round: number) => `rooms/${roomId}/rounds/${round}`,
  profile: (uid: string) => `profiles/${uid}`,
  friends: () => 'friends',
  friend: (friendId: string) => `friends/${friendId}`,
  /** Append-only, one document per player per official round, across evenings. */
  history: () => 'history',
  historyEntry: (roomId: string, round: number, friendId: string) =>
    `history/${roomId}_${round}_${friendId}`,
  calibration: () => 'calibration',
} as const;
