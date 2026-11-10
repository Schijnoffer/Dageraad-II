import type {
  GameConfig, PrivateInfo, RoleId, SeatIndex, Choice, NightEvent, NightState,
  DecisionRequest, Team,
} from '../engine/types.js';
import type { Timeline } from '../engine/timeline.js';
import type { DiscardReason, VoteOutcome } from '../engine/dayphase.js';
import type { RoundRecord, SessionMember, SessionStanding } from './session.js';
import type { HistoryRecord } from '../stats/alltime.js';
import type { FriendProfile } from './friend.js';
import type { DayStore } from '../orchestration/dayrunner.js';
import type { RoomStore } from '../orchestration/store.js';

export const DEFAULT_DISCUSSION_MS = 15 * 60_000;
export const MIN_DISCUSSION_MS = 60_000;
export const MAX_DISCUSSION_MS = 120 * 60_000;

export function validDiscussionMs(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_DISCUSSION_MS
    && value <= MAX_DISCUSSION_MS;
}

/**
 * Everything the app needs from the network, behind one interface.
 *
 * Two implementations: `FirestoreBackend` for real play, and `MemoryBackend`
 * which runs the whole thing in-process. The memory one is not a test double
 * bolted on afterwards — it is what lets a complete night be played in a unit
 * test and in the browser without a Firebase project, which is the only honest
 * way to know the shell works before it ever touches a live database.
 *
 * The referee's own reads and writes keep going through the existing
 * `RoomStore`/`DayStore` interfaces, so `runNight` and `runDay` are untouched.
 */

/** Public room state, readable by anyone with the link. */
export interface RoomView {
  roomId: string;
  hostUid: string;
  /**
   * The device that computes the night. It normally stays the device that
   * created the room, because whoever holds it can read every card. A trusted
   * group may deliberately transfer it through `takeEmergencyControl` after a
   * device failure.
   */
  refereeUid: string;
  phase: RoomPhase;
  /**
   * Which game of the evening this is, counting from 1.
   *
   * A room is a SESSION, not a single game (see session.ts). Joins and
   * departures land on a round boundary, so this is what they are measured
   * against — and it is what the scoreboard is rebuilt from.
   */
  round: number;
  nightWindowIndex: number;
  /** Set only when the referee deliberately skips the current unanswered step. */
  nightForceAdvanceIndex?: number | null;
  activeRoles: RoleId[];
  config: GameConfig;
  timeline: Timeline | null;
  /** Seat order as uids, index = seat. Frozen once a round starts. */
  seating: string[];
  /**
   * Everyone in the session, including people waiting for the next round and
   * people who have gone home. Seating is who is PLAYING; this is who is HERE.
   */
  members: SessionMember[];
  /** The evening's scoreboard, recomputed from the finished rounds. */
  standings: SessionStanding[];
  /** Whether this evening counts toward all-time history. Immutable. */
  mode: RoomMode;
  /** Shared discussion length chosen before the room is created. */
  discussionMs?: number;
  /** Public wall-clock deadline while the discussion is running. */
  discussionEndsAt?: number | null;
  /** Practice-only referee shortcut consumed by the day runner. */
  practiceSkipDiscussion?: boolean;
  publicEvents: NightEvent[];
  shieldedSeats: SeatIndex[];
  /**
   * SLOT -> the role lying face up there, right now.
   *
   * Slots rather than seats, because a revealed card swapped into the centre
   * is still face up when it lands. Recomputed by the referee after every
   * window from the card identities that were flipped, so it follows the card
   * — a reveal belongs to the card, not to the seat it happened at.
   */
  revealedSlots: Record<number, RoleId>;
  /** Live counts, published by the referee. Never who voted for whom. */
  abstainCount: number;
  votesCast: number;
  /** How many have asked to start voting. A count, never a list of names. */
  earlyVoteCount: number;
  pausedAt: number | null;
  /** Set when the 50/50 suspense extension fires (§7). Public on purpose. */
  discussionExtendedByMs: number;
  /** Set when the game is over, so every device can show the same result. */
  finalRoles: Record<SeatIndex, RoleId> | null;
  /** Roles dealt at the start, published only together with the result. */
  originalRoles?: Record<SeatIndex, RoleId>;
  outcome: string | null;
  /** Public dawn summary. Missing only on rooms finished by an older build. */
  eliminatedSeats?: SeatIndex[];
  /** The teams that actually won; normally one, but represented honestly. */
  winningTeams?: Team[];
  /** Every ballot becomes public only after resolution. */
  finalVotes?: Record<SeatIndex, SeatIndex | null>;
  /** Why a ballot did not count, keyed by voter seat. */
  discardedVotes?: Partial<Record<SeatIndex, DiscardReason>>;
  /** Final count after Looier and Bodyguard effects. */
  finalTally?: Record<SeatIndex, number>;
  /** Test/audit detail that becomes public only with the result. */
  finalCenterRoles?: RoleId[];
  nightInfo?: Record<SeatIndex, PrivateInfo[]>;
}

export type RoomPhase = 'lobby' | 'night' | 'day' | 'voting' | 'results';

export interface PlayerView {
  uid: string;
  displayName: string;
  /** Soft presence heartbeat; missing on older documents. */
  lastSeen?: number;
  /** An AI player. Labelled as such everywhere a person can see a name. */
  isBot?: boolean;
  /**
   * Seat in the CURRENT round, or null when they are not in it — someone who
   * arrived mid-night and is waiting, or who has left. Null is a real state
   * rather than a missing value, and the lobby renders it as "next round".
   */
  seatIndex: SeatIndex | null;
  /** True once they are in the seating for the round now being played. */
  playing: boolean;
  /** Set when they have left. Their finished rounds still count (§session). */
  departed: boolean;
}

/** What one device may know about its own seat. Never about anyone else's. */
export interface PrivateView {
  originalRole: RoleId | null;
  privateInfo: PrivateInfo[];
  /**
   * What this device is being asked, for the window currently open.
   *
   * Written by the referee, because the questions come from the deal and the
   * deal never leaves it. Empty means nothing is being asked of you right now
   * — which is a real state and not a missing one, and is what clears the last
   * window's question off the screen.
   */
  pending: DecisionRequest[];
}

export type Unsubscribe = () => void;

/**
 * One player's line in the game record.
 *
 * Deliberately the full categorical `voteOutcome` and not a boolean: a
 * Bodyguard whose vote cost the village the game has to stay distinguishable
 * from an ordinary wrong guess, and a window that timed out is not a wrong
 * answer at all (§10). Once a boolean is written here that distinction is gone
 * for good, and these documents are append-only.
 */
export interface SeatResult {
  finalRole: RoleId;
  originalRole: RoleId;
  won: boolean;
  /** uid, or null for an abstain. Public once the game is over. */
  votedFor: string | null;
  voteOutcome: VoteOutcome;
  /**
   * How well this player's suspicion guesses matched the truth, if they kept
   * any. Null when they did not, and null from the referee's point of view
   * always: the guesses live on the guesser's own device and are theirs to
   * submit or keep. Nobody is scored on notes they did not hand in.
   */
  suspicionAccuracy: number | null;
}

/** Everything the table learns at dawn, in one object. */
export interface GameResults {
  outcome: string;
  eliminatedSeats: SeatIndex[];
  winningTeams: Team[];
  finalVotes: Record<SeatIndex, SeatIndex | null>;
  discardedVotes: Partial<Record<SeatIndex, DiscardReason>>;
  finalTally: Record<SeatIndex, number>;
  /** Every seat's card at dawn (§6.0) — what the win condition is judged on. */
  finalRoles: Record<SeatIndex, RoleId>;
  /** Every seat's role at the start, before copying and card movement. */
  originalRoles?: Record<SeatIndex, RoleId>;
  /** The three ordinary centre cards at dawn, published only with the result. */
  finalCenterRoles?: RoleId[];
  /** Every private receipt, made public only after the game is over. */
  nightInfo?: Record<SeatIndex, PrivateInfo[]>;
  seats: Record<SeatIndex, SeatResult>;
}

export interface CreateRoomOptions {
  displayName: string;
  /**
   * Whether this evening counts toward the group's all-time history.
   *
   * DEFAULTS TO 'practice' and is immutable once the room exists. The failure
   * we can afford is a real evening accidentally not counting; the one we
   * cannot is a test round in a year of append-only history that has no delete
   * path by design.
   */
  mode?: RoomMode;
  /** Discussion timer for every round in this room. Defaults to 15 minutes. */
  discussionMs?: number;
  /** Which human is creating it, for history that spans evenings. */
  friend?: FriendLabel;
  activeRoles: RoleId[];
  config: GameConfig;
  /**
   * Whether the creating device also takes a seat.
   *
   * A neutral tablet passes false: it is the referee, it holds every card, and
   * it must not be dealt one. Someone's phone hosting a small game passes true
   * and plays like everyone else — with the caveat that the host then knows the
   * whole deal, which the group has to be fine with. Defaults to true because
   * that is the commoner case; the tablet flow is the one that says so.
   */
  playing?: boolean;
}

/** Who a device says it is across evenings. A label, never an authorisation. */
export interface FriendLabel {
  friendId: string;
  friendName: string;
}

export type RoomMode = 'practice' | 'official';

export interface Backend {
  /** This device's stable id. Every security rule keys off it. */
  readonly uid: string;

  createRoom(options: CreateRoomOptions): Promise<string>;

  /**
   * Trusted-group recovery after the host/referee device has failed. The app
   * asks for the deliberate phrase `referee` before calling this. It moves both
   * control roles to this active member, who can then run the stored game.
   */
  takeEmergencyControl(roomId: string, phrase: string): Promise<void>;

  /**
   * Join the session. Allowed AT ANY TIME, not just in the lobby.
   *
   * If a round is already running you are added as a member and seated when
   * the next one starts — there is no card to hand somebody who walks in at
   * second twenty, and the Dorpsgek's shift needs stable adjacency (§13).
   *
   * A player arriving mid-evening is seeded with the points of whoever is
   * currently LAST, so they join at the back of the pack rather than below it
   * (Milan, 2026-08-26). Only rounds they actually play count toward their
   * record; the seed stays visible as its own number rather than being
   * laundered into a win count.
   */
  joinRoom(roomId: string, displayName: string, friend?: FriendLabel): Promise<void>;

  /** Correct this device's all-time identity while the table is still in setup. */
  setFriendProfile(roomId: string, friend: FriendLabel): Promise<void>;

  /**
   * Leave the session without ending it for everybody else.
   *
   * Mid-round this does NOT stop the game: the seat stays in the deal and its
   * outstanding decisions decline, exactly as an AFK player's would. The seat
   * disappears at the next round boundary. Ending the evening because one
   * person has to drive home is the behaviour this exists to prevent.
   */
  leaveRoom(roomId: string): Promise<void>;

  /** Lobby members or the table device arrange physical seats. Order is uids. */
  setSeating(roomId: string, seating: string[]): Promise<void>;
  setActiveRoles(roomId: string, roles: RoleId[], config: GameConfig): Promise<void>;

  /**
   * Deal and begin the next round. Referee only — it is the one device allowed
   * to write the private documents, and the only one that ever sees the deal.
   *
   * This is also the point at which the table is re-seated: everybody waiting
   * sits down, everybody who left is removed, and the ring is closed up so the
   * Dorpsgek's rotation has no holes.
   */
  startGame(roomId: string, seed: number): Promise<void>;

  /** Return finished room to setup and seat the next round's roster. */
  prepareNextRound(roomId: string): Promise<void>;

  /** Finished rounds, for the scoreboard and for the stats screens. */
  watchRounds(roomId: string, cb: (rounds: RoundRecord[]) => void): Unsubscribe;

  watchRoom(roomId: string, cb: (room: RoomView | null) => void): Unsubscribe;
  watchPlayers(roomId: string, cb: (players: PlayerView[]) => void): Unsubscribe;
  watchPrivate(roomId: string, cb: (own: PrivateView) => void): Unsubscribe;

  /** A player writing their own night choices for the current window. */
  submit(roomId: string, windowIndex: number, choices: Record<string, Choice>): Promise<void>;
  /** This device's already-saved keys for one night window (refresh recovery). */
  submittedKeys(roomId: string, round: number, windowIndex: number): Promise<string[]>;

  /**
   * A player's vote. `target` is a uid, or null for an abstain.
   *
   * Note the security rules accept an abstain during the discussion but a named
   * target only once voting is open (§7) — the group may decide not to vote at
   * any moment, but nobody may lock in a target early.
   */
  vote(roomId: string, target: string | null, abstain: boolean): Promise<void>;
  /** This device's current-round vote toggles/ballot (refresh recovery). */
  ownVote(roomId: string): Promise<{
    round: number; target: string | null; abstain: boolean; readyToVote: boolean;
  } | null>;

  /** Phrase-confirmed referee fallback for one player whose device failed. */
  emergencyVote(
    roomId: string, voterUid: string, targetUid: string, phrase: string,
  ): Promise<void>;

  /**
   * "I am ready — let us vote now." Reversible, and not an abstain.
   *
   * A decision about the CLOCK, not the outcome: abstaining says nobody
   * hangs, this says we have finished arguing. Strictly more than half of the
   * seated players holding it at once opens the ballot. Only the COUNT is ever
   * published — who asked is a fact about how confident somebody is.
   */
  requestEarlyVote(roomId: string, requested: boolean): Promise<void>;

  /** Referee-only: consciously skip unanswered actions in the current night step. */
  forceNightWindow(roomId: string): Promise<void>;

  /** Open the ballot immediately. Referee-only and practice-only. */
  forcePracticeVote(roomId: string): Promise<void>;

  /**
   * Add one AI player to a PRACTICE lobby. Controlling browser only.
   *
   * Bots exist so a real table can be filled out for a practice evening —
   * three humans and five bots, or seven humans and one. They are not a
   * separate way to play; they sit in the same seating, in the same rounds,
   * under the same rules.
   *
   * PRACTICE ONLY, and that is checked against the room document rather than
   * trusted from the caller. A bot in an official evening would put invented
   * results in a permanent record that has no delete path.
   *
   * They have no device and no login. The controlling browser already holds
   * the whole deal, so it answers for them — which is why only that browser
   * may add them, and why they need no private screen of their own.
   */
  addBot(roomId: string): Promise<void>;

  /** Remove one, by uid. Lobby only, so no round is ever half-played. */
  removeBot(roomId: string, botUid: string): Promise<void>;

  /** Host/referee: mark a human as departed; the current dealt round survives. */
  removePlayer(roomId: string, playerUid: string): Promise<void>;

  /** Referee-only authoritative bot seats, read coherently when a run starts. */
  refereeBotSeats(roomId: string): Promise<SeatIndex[]>;

  /**
   * Cast a bot's day vote. Deliberately NOT "vote as any player".
   *
   * The controlling browser must be able to answer for a seat with nobody
   * behind it, and there is no honest way around that. What there IS a way
   * around is giving it a general power to vote as anyone: this refuses unless
   * the target really is a bot, in a practice room, during voting. A generic
   * capability would be one rule away from a referee quietly voting for a
   * human, and no rule could tell the two writes apart.
   */
  voteAsBot(
    roomId: string,
    botUid: string,
    target: string | null,
    abstain: boolean,
  ): Promise<void>;

  /** The referee's own view of the room, for runNight/runDay. */
  refereeStore(roomId: string): RoomStore & DayStore;

  /**
   * The referee's copy of the deal.
   *
   * Referee only, and it never leaves that device during play — it is the whole
   * game state, every card and every slot. It is here rather than on RoomStore
   * because the engine never needs to fetch it: the referee already has it.
   */
  refereeNightState(roomId: string): Promise<NightState | null>;

  /**
   * Publish the outcome once the day resolves, so every device shows the same
   * thing. This is the ONE moment roles become public — the game is over.
   *
   * `persist` separates two things that look alike and are not. The room's own
   * result is shown to the table either way, including in test mode — you still
   * want to see who won. The append-only per-player result documents are what
   * profile stats aggregate from, and a test game must never write one: there
   * is no delete path by design, so a bot game would inflate somebody's record
   * permanently (§16).
   */
  publishResults(roomId: string, results: GameResults, persist: boolean): Promise<void>;

  /** Atomically expose results and persist/reconcile the finished round. */
  finalizeRound(
    roomId: string,
    results: GameResults,
    record: RoundRecord | null,
  ): Promise<void>;

  /**
   * Append the finished round to the evening's record.
   *
   * Separate from `publishResults` on purpose. That one shows the table who
   * won; this one is the row the scoreboard and every stats breakdown are
   * rebuilt from, and a test round must produce the first without the second.
   */
  recordRound(roomId: string, record: RoundRecord): Promise<void>;

  /**
   * The group's all-time record, across every evening.
   *
   * Append-only per player per official round. Practice rooms contribute
   * nothing, and that is decided against the room document rather than trusted
   * from the caller. Totals are DERIVED from these on read (stats/alltime.ts)
   * — there is no stored aggregate, because a stored total is a number
   * somebody has to be trusted to have incremented correctly.
   */
  watchHistory(cb: (records: HistoryRecord[]) => void): Unsubscribe;

  /** The shared address book. Chosen from when joining; created once. */
  watchFriends(cb: (friends: FriendProfile[]) => void): Unsubscribe;
  /**
   * Create a friend profile, or return the existing one with the same name.
   * Names match case- and whitespace-insensitively so typing "Rieks" again
   * does not fork history or bypass lobby seat reclaim.
   */
  createFriend(displayName: string): Promise<FriendProfile>;

  /** Soft presence heartbeat while this device is in a room. */
  touchPresence(roomId: string): Promise<void>;

  /** Host: pause/resume for an absent player. Public and manual (§5.3). */
  setPaused(roomId: string, paused: boolean): Promise<void>;
}

/**
 * Room codes.
 *
 * Five characters from an alphabet with no 0/O/1/I/L, because these get read
 * aloud across a table and typed by someone holding a beer. 32^5 is about 33
 * million — collisions are not a real concern for one group, and a collision
 * would fail loudly on create rather than silently join the wrong room.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function normaliseRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomCode(input: string): boolean {
  const code = normaliseRoomCode(input);
  return code.length === 5 && [...code].every((c) => CODE_ALPHABET.includes(c));
}
