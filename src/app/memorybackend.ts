import { cardsForRoles, deal } from '../engine/deal.js';
import { roleDef } from '../engine/roles.js';
import { buildTimeline } from '../engine/timeline.js';
import type { LatencySample } from '../engine/telemetry.js';
import type { Vote } from '../engine/dayphase.js';
import type {
  Choice, GameConfig, NightEvent, NightState, PrivateInfo, RoleId, SeatIndex, DecisionRequest,
} from '../engine/types.js';
import type { DayStore } from '../orchestration/dayrunner.js';
import type { NightCheckpoint, RoomStore } from '../orchestration/store.js';
import { newFriendId, normaliseName, type FriendProfile } from './friend.js';
import type { HistoryRecord } from '../stats/alltime.js';
import type { PublicNightView } from '../engine/publicview.js';
import {
  DEFAULT_DISCUSSION_MS, generateRoomCode, validDiscussionMs,
  type Backend, type CreateRoomOptions, type GameResults,
  type FriendLabel, type PlayerView, type PrivateView, type RoomPhase, type RoomView,
  type SeatResult, type Unsubscribe,
} from './backend.js';
import {
  seatingForNextRound, standings,
  type RoundRecord, type SessionMember,
} from './session.js';
import {
  assertFriendProfileAvailable, assertUniqueFriendProfiles, occupiedFriendSeat,
} from './friendseat.js';

/** Names for AI players. Recognisably not people, and short enough to fit. */
const BOT_NAMES = [
  'AI Bram', 'AI Fleur', 'AI Joris', 'AI Noor', 'AI Daan',
  'AI Eva', 'AI Tijn', 'AI Isa', 'AI Sam', 'AI Lot', 'AI Kees',
];

/**
 * A whole Dageraad server, in memory.
 *
 * `world.device(uid)` hands back a `Backend` for one phone, all sharing this
 * state — so eight devices round a table are eight `device()` calls, and a test
 * can play a complete night without a Firebase project in sight.
 *
 * IT DELIBERATELY ENFORCES THE SECURITY RULES. Not because anything here is
 * exposed, but because a local backend that is more permissive than the real
 * one is worse than useless: it would let a shell be written that works
 * perfectly in tests and is rejected by Firestore the first time it is played
 * for real. Every refusal below mirrors a rule in `firestore.rules`.
 */
export class MemoryWorld {
  private readonly rooms = new Map<string, RoomRecord>();
  readonly random: () => number;

  /**
   * The group, not one evening.
   *
   * Friends and all-time history sit on the WORLD rather than on a room,
   * because that is exactly what makes them all-time: a friend is the same
   * person in every room, and the record spans them. In Firestore these are
   * top-level collections for the same reason.
   */
  readonly friends: FriendProfile[] = [];
  readonly history: HistoryRecord[] = [];
  readonly friendWatchers = new Set<(f: FriendProfile[]) => void>();
  readonly historyWatchers = new Set<(h: HistoryRecord[]) => void>();

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  device(uid: string): Backend {
    return new MemoryBackend(this, uid);
  }

  /* ------------------------------------------------------------------ */

  room(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`no such room: ${roomId}`);
    return room;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  create(uid: string, options: CreateRoomOptions): string {
    const discussionMs = options.discussionMs ?? DEFAULT_DISCUSSION_MS;
    if (!validDiscussionMs(discussionMs)) throw new Error('discussion timer must be 1-120 minutes');
    let roomId = generateRoomCode(this.random);
    while (this.rooms.has(roomId)) roomId = generateRoomCode(this.random);

    // A neutral tablet is the referee and takes no seat — it holds every card,
    // so dealing it one would be dealing a card to the person who can read
    // them all. A phone hosting its own game does take a seat.
    const playing = options.playing !== false;

    this.rooms.set(roomId, {
      view: {
        roomId,
        hostUid: uid,
        // The creator becomes the referee. A deliberate trusted-group recovery
        // can take over if this device fails (see Backend.takeEmergencyControl).
        refereeUid: uid,
        phase: 'lobby',
        mode: options.mode ?? 'practice',
        discussionMs,
        discussionEndsAt: null,
        practiceSkipDiscussion: false,
        round: 0,
        nightWindowIndex: 0,
        nightForceAdvanceIndex: null,
        activeRoles: options.activeRoles,
        config: options.config,
        timeline: null,
        seating: playing ? [uid] : [],
        members: playing
          ? [{
              uid, joinedAtRound: 1, leftAtRound: null,
              friendId: options.friend?.friendId ?? '',
              friendName: options.friend?.friendName ?? options.displayName,
            }]
          : [],
        standings: [],
        publicEvents: [],
        shieldedSeats: [],
        revealedSlots: {},
        abstainCount: 0,
        earlyVoteCount: 0,
        votesCast: 0,
        pausedAt: null,
        discussionExtendedByMs: 0,
        finalRoles: null,
        outcome: null,
      },
      players: playing
        ? new Map([[uid, {
            uid, displayName: options.displayName,
            seatIndex: 0, playing: true, departed: false,
          }]])
        : new Map(),
      privates: new Map(),
      submissions: new Map(),
      votes: new Map(),
      results: new Map(),
      rounds: [],
      latency: [],
      state: null,
      checkpoint: null,
      watchers: {
        room: new Set(), players: new Set(), private: new Map(), rounds: new Set(),
      },
    });
    return roomId;
  }

  notify(roomId: string): void {
    const r = this.room(roomId);

    // The scoreboard is DERIVED, every time, from the finished rounds. Never a
    // counter anybody increments — see session.ts for why that matters.
    r.view.standings = standings(r.view.members, r.rounds);

    // Seat numbers follow the CURRENT seating, so somebody waiting for the
    // next round genuinely has no seat rather than a stale one.
    for (const p of r.players.values()) {
      const seat = r.view.seating.indexOf(p.uid);
      p.seatIndex = seat < 0 ? null : seat;
      p.playing = seat >= 0;
    }

    for (const cb of r.watchers.room) cb({ ...r.view });
    const players = [...r.players.values()].sort(sortPlayers);
    for (const cb of r.watchers.players) cb(players.map((p) => ({ ...p })));
    for (const cb of r.watchers.rounds) cb(r.rounds.map((x) => ({ ...x })));
    for (const [uid, cbs] of r.watchers.private) {
      const own = r.privates.get(uid) ?? { originalRole: null, privateInfo: [], pending: [] };
      for (const cb of cbs) cb({ ...own, privateInfo: [...own.privateInfo] });
    }
  }
}

/**
 * Seated players first, in seat order; then everyone waiting for the next
 * round; then whoever has gone home. That is the order the lobby wants to
 * render, and putting it here keeps every subscriber consistent.
 */
function sortPlayers(a: PlayerView, b: PlayerView): number {
  const rank = (p: PlayerView) => (p.departed ? 2 : p.seatIndex === null ? 1 : 0);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  if (a.seatIndex !== null && b.seatIndex !== null) return a.seatIndex - b.seatIndex;
  return a.uid.localeCompare(b.uid);
}

interface RoomRecord {
  view: RoomView;
  players: Map<string, PlayerView>;
  privates: Map<string, PrivateView>;
  submissions: Map<string, { windowIndex: number; choices: Record<string, Choice> }>;
  votes: Map<string, { target: string | null; abstain: boolean; readyToVote?: boolean }>;
  /** Append-only, live games only. What profile stats aggregate from. */
  results: Map<string, SeatResult>;
  /** Finished rounds. Append-only: the scoreboard is rebuilt from these. */
  rounds: RoundRecord[];
  latency: LatencySample[];
  state: NightState | null;
  checkpoint: NightCheckpoint | null;
  watchers: {
    room: Set<(r: RoomView | null) => void>;
    players: Set<(p: PlayerView[]) => void>;
    private: Map<string, Set<(p: PrivateView) => void>>;
    rounds: Set<(r: RoundRecord[]) => void>;
  };
}

class MemoryBackend implements Backend {
  constructor(private readonly world: MemoryWorld, readonly uid: string) {}

  async createRoom(options: CreateRoomOptions): Promise<string> {
    const roomId = this.world.create(this.uid, options);
    this.world.notify(roomId);
    return roomId;
  }

  async takeEmergencyControl(roomId: string, phrase: string): Promise<void> {
    if (phrase !== 'referee') throw new Error('type referee to confirm takeover');
    const r = this.world.room(roomId);
    const member = r.view.members.find((entry) => entry.uid === this.uid);
    if (!member || member.leftAtRound !== null) throw new Error('active member only');
    r.view.hostUid = this.uid;
    r.view.refereeUid = this.uid;
    this.world.notify(roomId);
  }

  async joinRoom(
    roomId: string,
    displayName: string,
    friend?: FriendLabel,
  ): Promise<void> {
    const r = this.world.room(roomId);

    // A referee who sat the game out cannot change their mind and take a seat:
    // they have already seen the room from the one place every card is visible.
    // Sitting down now would be dealing a card to somebody who can read them
    // all, which is the exact thing the referee/player split exists to prevent.
    if (r.view.refereeUid === this.uid && !r.players.has(this.uid)) {
      throw new Error('the referee is not a player in this room');
    }

    const existing = r.players.get(this.uid);
    if (existing) {
      // Already here — this is a rename, or somebody coming back after
      // leaving. Coming back re-uses their original seed rather than handing
      // them a fresh one; otherwise stepping out for a round would be a way to
      // top your score up off the bottom of the table.
      existing.displayName = displayName;
      existing.departed = false;
      const member = r.view.members.find((m) => m.uid === this.uid);
      if (member) {
        member.leftAtRound = null;
        if (friend) {
          if (r.view.phase === 'lobby') {
            this.reclaimFriendSeat(r, friend.friendId);
          } else {
            assertFriendProfileAvailable(
              r.view.members, r.view.seating, this.uid, friend.friendId,
            );
          }
          member.friendId = friend.friendId;
          member.friendName = friend.friendName;
        }
      }
      this.world.notify(roomId);
      return;
    }

    // Joining mid-evening: seated at the NEXT round, seeded with the score of
    // whoever is currently last (Milan, 2026-08-26). In the lobby that is
    // round 1 and a seed of zero, which is the same code path.
    //
    // The seed itself is NOT written down. `joinedAtRound` is the entire record
    // of it, and `standings()` recomputes the floor from the rounds before that
    // one — which is what stops a joining device dictating its own score.
    const inLobby = r.view.phase === 'lobby';
    const nextRound = inLobby ? 1 : r.view.round + 1;
    const friendId = friend?.friendId ?? '';
    const friendName = friend?.friendName ?? displayName;

    if (inLobby) {
      // Same person, new phone: free the lobby seat the old device still holds.
      this.reclaimFriendSeat(r, friendId);
    } else {
      assertFriendProfileAvailable(r.view.members, r.view.seating, this.uid, friendId);
    }

    r.players.set(this.uid, {
      uid: this.uid,
      displayName,
      seatIndex: null,
      playing: false,
      departed: false,
    });
    r.view.members = [
      ...r.view.members,
      {
        uid: this.uid, joinedAtRound: nextRound, leftAtRound: null,
        friendId,
        friendName,
      },
    ];

    // In the lobby they sit down immediately; mid-round they wait, because
    // there is no card to hand somebody who walks in at second twenty.
    if (inLobby) r.view.seating = [...r.view.seating, this.uid];

    this.world.notify(roomId);
  }

  async setFriendProfile(roomId: string, friend: FriendLabel): Promise<void> {
    const r = this.world.room(roomId);
    if (r.view.phase !== 'lobby') throw new Error('profiles are frozen once the game starts');
    const member = r.view.members.find((entry) => entry.uid === this.uid);
    if (!member || member.leftAtRound !== null) throw new Error('active member only');
    this.reclaimFriendSeat(r, friend.friendId);
    member.friendId = friend.friendId;
    member.friendName = friend.friendName;
    this.world.notify(roomId);
  }

  /**
   * Free a lobby seat held by another device under the same friend label.
   *
   * Trusted-group behaviour: a friendId is not a password, and the common
   * failure is a test phone still sitting at the table. Mid-round we refuse
   * instead — the deal already has that seat's card.
   */
  private reclaimFriendSeat(r: RoomRecord, friendId: string): void {
    const occupied = occupiedFriendSeat(
      r.view.members, r.view.seating, this.uid, friendId,
    );
    if (!occupied) return;
    const member = r.view.members.find((entry) => entry.uid === occupied.uid);
    if (member) member.leftAtRound = Math.max(0, r.view.round);
    const player = r.players.get(occupied.uid);
    if (player) player.departed = true;
    r.view.seating = r.view.seating.filter((uid) => uid !== occupied.uid);
  }

  async leaveRoom(roomId: string): Promise<void> {
    const r = this.world.room(roomId);
    const member = r.view.members.find((m) => m.uid === this.uid);
    if (!member) return;              // never here; nothing to do

    const player = r.players.get(this.uid);
    if (player) player.departed = true;

    // `leftAtRound` is the LAST round they play, not the first they miss. Mid
    // round that is the round now running: the deal already has their card in
    // it, their outstanding decisions decline like an AFK player's, and the
    // seat disappears at the next boundary. The evening does not stop.
    member.leftAtRound = r.view.phase === 'lobby'
      ? Math.max(0, r.view.round)
      : r.view.round;

    if (r.view.phase === 'lobby') {
      r.view.seating = r.view.seating.filter((uid) => uid !== this.uid);
    }
    this.world.notify(roomId);
  }

  watchRounds(roomId: string, cb: (rounds: RoundRecord[]) => void): Unsubscribe {
    const r = this.world.room(roomId);
    r.watchers.rounds.add(cb);
    cb(r.rounds.map((x) => ({ ...x })));
    return () => r.watchers.rounds.delete(cb);
  }

  async setSeating(roomId: string, seating: string[]): Promise<void> {
    const r = this.world.room(roomId);
    const member = r.view.members.find((entry) => entry.uid === this.uid);
    const activeMember = member?.leftAtRound === null;
    if (r.view.hostUid !== this.uid && r.view.refereeUid !== this.uid && !activeMember) {
      throw new Error('active member, host, or referee only');
    }
    if (r.view.phase !== 'lobby') throw new Error('seating is frozen once the game starts');
    // Measured against who is SEATED, not who is in the room: somebody waiting
    // for the next round has no seat to arrange yet.
    const current = new Set(r.view.seating);
    if (seating.length !== r.view.seating.length
      || new Set(seating).size !== seating.length
      || seating.some((uid) => !current.has(uid))) {
      throw new Error('seating must contain every seated player exactly once');
    }
    r.view.seating = [...seating];
    seating.forEach((uid, seat) => {
      const p = r.players.get(uid);
      if (p) p.seatIndex = seat;
    });
    this.world.notify(roomId);
  }

  async setActiveRoles(roomId: string, roles: RoleId[], config: GameConfig): Promise<void> {
    const r = this.world.room(roomId);
    if (r.view.hostUid !== this.uid && r.view.refereeUid !== this.uid) throw new Error('host only');
    if (r.view.phase !== 'lobby') throw new Error('roles are frozen once the game starts');
    for (const role of roles) roleDef(role);
    const special = roles.filter((role) => role !== 'dorpeling');
    if (new Set(special).size !== special.length) {
      throw new Error('only Villagers may appear more than once');
    }
    r.view.activeRoles = [...roles];
    r.view.config = config;
    this.world.notify(roomId);
  }

  async startGame(roomId: string, seed: number): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.phase !== 'lobby') {
      throw new Error('a round is already running');
    }

    const nextRound = r.view.round + 1;

    // THE ROUND BOUNDARY. Everybody waiting sits down, everybody who left is
    // removed, and the ring closes up — a hole in the seating is a hole in the
    // Dorpsgek's rotation (§13).
    r.view.seating = seatingForNextRound(r.view.members, r.view.seating, nextRound);
    assertUniqueFriendProfiles(r.view.members, r.view.seating);
    assertExactRoleCount(r.view.activeRoles, r.view.seating.length);
    r.view.round = nextRound;

    // Clear last round's table so nothing bleeds across.
    r.submissions.clear();
    r.votes.clear();
    r.privates.clear();
    r.view.publicEvents = [];
    r.view.shieldedSeats = [];
    r.view.revealedSlots = {};
    r.view.abstainCount = 0;
    r.view.earlyVoteCount = 0;
    r.view.votesCast = 0;
    r.view.pausedAt = null;
    r.view.discussionExtendedByMs = 0;
    r.view.discussionEndsAt = null;
    r.view.practiceSkipDiscussion = false;
    r.view.finalRoles = null;
    delete r.view.originalRoles;
    r.view.outcome = null;
    delete r.view.eliminatedSeats;
    delete r.view.winningTeams;
    delete r.view.finalVotes;
    delete r.view.discardedVotes;
    delete r.view.finalTally;
    delete r.view.finalCenterRoles;
    delete r.view.nightInfo;

    const seatCount = r.view.seating.length;
    const cards = cardsForRoles(r.view.activeRoles, seatCount);
    const dealt = deal({ cards, seatCount, seed });

    r.state = dealt.state;
    r.checkpoint = null;
    r.view.timeline = buildTimeline(r.view.activeRoles, r.view.config);
    r.view.phase = 'night';
    r.view.nightWindowIndex = 0;
    r.view.nightForceAdvanceIndex = null;

    // Each seat learns its own dealt role and nothing else. This is the only
    // moment the referee writes a role anywhere, and it writes one per device.
    r.view.seating.forEach((uid, seat) => {
      r.privates.set(uid, {
        originalRole: dealt.seatRoles[seat] ?? null,
        privateInfo: [],
        pending: [],
      });
    });

    this.world.notify(roomId);
  }

  async prepareNextRound(roomId: string): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.phase !== 'results') throw new Error('round is not finished');
    r.view.seating = seatingForNextRound(r.view.members, r.view.seating, r.view.round + 1);
    r.view.seating.forEach((uid, seat) => {
      const player = r.players.get(uid);
      if (player) player.seatIndex = seat;
    });
    r.view.phase = 'lobby';
    this.world.notify(roomId);
  }

  watchRoom(roomId: string, cb: (room: RoomView | null) => void): Unsubscribe {
    const r = this.world.room(roomId);
    r.watchers.room.add(cb);
    cb({ ...r.view });
    return () => r.watchers.room.delete(cb);
  }

  watchPlayers(roomId: string, cb: (players: PlayerView[]) => void): Unsubscribe {
    const r = this.world.room(roomId);
    r.watchers.players.add(cb);
    cb([...r.players.values()].sort(sortPlayers));
    return () => r.watchers.players.delete(cb);
  }

  watchPrivate(roomId: string, cb: (own: PrivateView) => void): Unsubscribe {
    const r = this.world.room(roomId);
    const set = r.watchers.private.get(this.uid) ?? new Set();
    set.add(cb);
    r.watchers.private.set(this.uid, set);
    cb(r.privates.get(this.uid) ?? { originalRole: null, privateInfo: [], pending: [] });
    return () => set.delete(cb);
  }

  async submit(
    roomId: string,
    windowIndex: number,
    choices: Record<string, Choice>,
  ): Promise<void> {
    const r = this.world.room(roomId);
    // Mirrors the rule exactly: a write is accepted only while the room is
    // still on the window it was made for. This is what closes a window
    // server-side without trusting any client's clock.
    if (r.view.phase !== 'night') throw new Error('not night');
    if (windowIndex !== r.view.nightWindowIndex) throw new Error('window closed');
    const existing = r.submissions.get(this.uid);
    r.submissions.set(this.uid, {
      windowIndex,
      choices: { ...(existing?.windowIndex === windowIndex ? existing.choices : {}), ...choices },
    });
  }

  async submittedKeys(roomId: string, round: number, windowIndex: number): Promise<string[]> {
    const r = this.world.room(roomId);
    if (r.view.round !== round) return [];
    const submission = r.submissions.get(this.uid);
    return submission?.windowIndex === windowIndex ? Object.keys(submission.choices) : [];
  }

  async vote(roomId: string, target: string | null, abstain: boolean): Promise<void> {
    const r = this.world.room(roomId);
    if (target === this.uid) throw new Error('no self-votes');
    // §7: an abstain counts at any moment, so it is accepted during the
    // discussion. A named target is confined to 'voting' — letting one be
    // locked in early would quietly make a simultaneous vote a first-mover one.
    const phase = r.view.phase;
    const ok = (phase === 'voting' && target !== null && !abstain)
      || (phase === 'day' && target === null);
    if (!ok) throw new Error(`cannot vote in phase ${phase}`);
    if (target !== null && !r.view.seating.includes(target)) throw new Error('target is not seated');
    const existing = r.votes.get(this.uid);
    if (phase === 'voting' && existing?.target !== null && existing?.target !== undefined) {
      throw new Error('vote is final');
    }
    r.votes.set(this.uid, {
      target,
      abstain,
      readyToVote: abstain ? false : existing?.readyToVote,
    });
    this.world.notify(roomId);
  }

  async ownVote(roomId: string): Promise<{
    round: number; target: string | null; abstain: boolean; readyToVote: boolean;
  } | null> {
    const r = this.world.room(roomId);
    const vote = r.votes.get(this.uid);
    if (!vote) return null;
    return {
      round: r.view.round,
      target: vote.target,
      abstain: vote.abstain,
      readyToVote: vote.readyToVote === true,
    };
  }

  async emergencyVote(
    roomId: string, voterUid: string, targetUid: string, phrase: string,
  ): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (phrase.trim() !== 'takeover') throw new Error('type takeover to confirm');
    if (r.view.phase !== 'voting') throw new Error('voting is not open');
    if (!r.view.seating.includes(voterUid)) throw new Error('voter is not seated');
    if (!r.view.seating.includes(targetUid)) throw new Error('target is not seated');
    if (voterUid === targetUid) throw new Error('no self-votes');
    const existing = r.votes.get(voterUid);
    if (existing?.target !== null && existing?.target !== undefined) throw new Error('vote is final');
    r.votes.set(voterUid, { target: targetUid, abstain: false });
    this.world.notify(roomId);
  }

  /* --------------------------------- bots --------------------------------- */

  /**
   * Add one AI player to a practice lobby.
   *
   * Every guard here is duplicated in the security rules; these exist to give
   * a sensible error before the round-trip rather than to be the protection.
   */
  async addBot(roomId: string): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.mode !== 'practice') {
      throw new Error('bots are only for practice rooms');
    }
    if (r.view.phase !== 'lobby') throw new Error('bots can only be added in the lobby');
    if (r.view.seating.length >= 12) throw new Error('Maximaal 12 spelers.');

    const botCount = [...r.players.values()].filter((p) => p.isBot).length;
    let number = 1;
    while (r.players.has(`bot-${roomId}-${number}`)) number += 1;
    const uid = `bot-${roomId}-${number}`;
    const displayName = BOT_NAMES[botCount % BOT_NAMES.length] ?? `AI ${number}`;

    r.players.set(uid, {
      uid, displayName, seatIndex: null, playing: false, departed: false,
      isBot: true,
    });
    // A real membership, so a bot is seated by the ordinary round-boundary
    // logic rather than by anything that knows what a bot is.
    r.view.members = [
      ...r.view.members,
      {
        // Pinned to the next round exactly as a human's is — in the lobby the
        // round is 0, so this is 1 by the same arithmetic rather than by a
        // special case for bots.
        uid, joinedAtRound: r.view.round + 1,
        leftAtRound: null, friendId: '', friendName: displayName,
      },
    ];
    r.view.seating = [...r.view.seating, uid];
    this.world.notify(roomId);
  }

  /**
   * Remove one.
   *
   * Lobby only, so no round is ever half-played by a seat that vanishes. The
   * membership goes with it: leaving a member behind would keep the bot on the
   * next round's roster and on the evening's scoreboard.
   */
  async removeBot(roomId: string, botUid: string): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.mode !== 'practice') throw new Error('bots are only for practice rooms');
    if (r.view.phase !== 'lobby') throw new Error('bots can only be removed in the lobby');
    const player = r.players.get(botUid);
    if (!player?.isBot) throw new Error('not a bot');

    r.players.delete(botUid);
    r.view.members = r.view.members.filter((m) => m.uid !== botUid);
    r.view.seating = r.view.seating.filter((uid) => uid !== botUid);
    this.world.notify(roomId);
  }

  async removePlayer(roomId: string, playerUid: string): Promise<void> {
    const r = this.world.room(roomId);
    // Lobby: any active member may clear a ghost seat (another phone still
    // listed after testing). Mid-round only host/referee — the deal is fixed.
    if (r.view.phase === 'lobby') {
      const self = r.view.members.find((entry) => entry.uid === this.uid);
      const privileged = r.view.hostUid === this.uid || r.view.refereeUid === this.uid;
      if (!privileged && (!self || self.leftAtRound !== null)) {
        throw new Error('active member, host, or referee only');
      }
    } else {
      this.requireHostOrReferee(r);
    }
    const player = r.players.get(playerUid);
    const member = r.view.members.find((entry) => entry.uid === playerUid);
    if (!player || !member) throw new Error('player not found');
    if (player.isBot) throw new Error('use removeBot');
    member.leftAtRound = r.view.round;
    player.departed = true;
    if (r.view.phase === 'lobby') {
      r.view.seating = r.view.seating.filter((uid) => uid !== playerUid);
    }
    this.world.notify(roomId);
  }

  async refereeBotSeats(roomId: string): Promise<SeatIndex[]> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    return r.view.seating.flatMap((uid, seat) =>
      r.players.get(uid)?.isBot ? [seat as SeatIndex] : []);
  }

  /** A bot's day vote. Never a human's — see Backend.voteAsBot. */
  async voteAsBot(
    roomId: string,
    botUid: string,
    target: string | null,
    abstain: boolean,
  ): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.mode !== 'practice') throw new Error('bots are only for practice rooms');
    const player = r.players.get(botUid);
    if (!player?.isBot) throw new Error('not a bot');
    if (target === botUid) throw new Error('no self-votes');
    const phase = r.view.phase;
    const ok = phase === 'voting' && target !== null && !abstain;
    if (!ok) throw new Error(`cannot vote in phase ${phase}`);
    if (!r.view.seating.includes(target)) throw new Error('target is not seated');
    const existing = r.votes.get(botUid);
    if (existing?.target !== null && existing?.target !== undefined) throw new Error('vote is final');
    r.votes.set(botUid, { target, abstain });
    this.world.notify(roomId);
  }

  /** "Let us vote now." Reversible, private, and not an abstain. */
  async requestEarlyVote(roomId: string, requested: boolean): Promise<void> {
    const r = this.world.room(roomId);
    const phase = r.view.phase;
    if (phase !== 'day') {
      throw new Error(`cannot ask to vote in phase ${phase}`);
    }
    const existing = r.votes.get(this.uid) ?? { target: null, abstain: false };
    r.votes.set(this.uid, {
      ...existing,
      abstain: requested ? false : existing.abstain,
      readyToVote: requested,
    });
    this.world.notify(roomId);
  }

  async forceNightWindow(roomId: string): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.phase !== 'night') throw new Error('night is not running');
    r.view.nightForceAdvanceIndex = r.view.nightWindowIndex;
    this.world.notify(roomId);
  }

  async forcePracticeVote(roomId: string): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    if (r.view.mode !== 'practice') throw new Error('practice rooms only');
    if (r.view.phase !== 'day') throw new Error('the discussion is not running');
    r.view.practiceSkipDiscussion = true;
    this.world.notify(roomId);
  }

  async setPaused(roomId: string, paused: boolean): Promise<void> {
    const r = this.world.room(roomId);
    this.requireHostOrReferee(r);
    const now = Date.now();
    if (paused) {
      if (r.view.pausedAt === null) r.view.pausedAt = now;
    } else if (r.view.pausedAt !== null) {
      if (typeof r.view.discussionEndsAt === 'number') {
        r.view.discussionEndsAt += now - r.view.pausedAt;
      }
      r.view.pausedAt = null;
    }
    this.world.notify(roomId);
  }

  refereeStore(roomId: string): RoomStore & DayStore {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    return new MemoryRefereeStore(this.world, roomId);
  }

  async refereeNightState(roomId: string): Promise<NightState | null> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    return r.state;
  }

  async publishResults(
    roomId: string,
    results: GameResults,
    persist: boolean,
  ): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    r.view.finalRoles = results.finalRoles;
    r.view.originalRoles = results.originalRoles ?? Object.fromEntries(
      Object.entries(results.seats).map(([seat, result]) => [seat, result.originalRole]),
    );
    r.view.outcome = results.outcome;
    r.view.eliminatedSeats = results.eliminatedSeats;
    r.view.winningTeams = results.winningTeams;
    r.view.finalVotes = results.finalVotes;
    r.view.discardedVotes = results.discardedVotes;
    r.view.finalTally = results.finalTally;
    r.view.finalCenterRoles = results.finalCenterRoles ?? [];
    r.view.nightInfo = results.nightInfo ?? {};
    // Only a live game leaves a permanent record. See the note on the
    // interface: these documents are append-only and there is no delete path.
    if (persist) {
      for (const [seatKey, seatResult] of Object.entries(results.seats)) {
        const uid = r.view.seating[Number(seatKey)];
        if (uid) r.results.set(uid, seatResult);
      }
    }
    this.world.notify(roomId);
  }

  async finalizeRound(
    roomId: string,
    results: GameResults,
    record: RoundRecord | null,
  ): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    r.view.finalRoles = results.finalRoles;
    r.view.originalRoles = results.originalRoles ?? Object.fromEntries(
      Object.entries(results.seats).map(([seat, result]) => [seat, result.originalRole]),
    );
    r.view.outcome = results.outcome;
    r.view.eliminatedSeats = results.eliminatedSeats;
    r.view.winningTeams = results.winningTeams;
    r.view.finalVotes = results.finalVotes;
    r.view.discardedVotes = results.discardedVotes;
    r.view.finalTally = results.finalTally;
    r.view.finalCenterRoles = results.finalCenterRoles ?? [];
    r.view.nightInfo = results.nightInfo ?? {};

    if (record && !r.rounds.some((entry) => entry.round === record.round)) {
      r.rounds = [...r.rounds, record];
    }
    if (record && r.view.mode === 'official') this.reconcileHistory(r, roomId, record);
    r.view.phase = 'results';
    this.world.notify(roomId);
  }

  private reconcileHistory(r: RoomRecord, roomId: string, record: RoundRecord): void {
    const byUid = new Map(r.view.members.map((member) => [member.uid, member]));
    for (const line of record.results) {
      const member = byUid.get(line.uid);
      if (!member?.friendId) continue;
      const exists = this.world.history.some((entry) => entry.roomId === roomId
        && entry.round === record.round && entry.friendId === member.friendId);
      if (exists) continue;
      this.world.history.push({
        roomId, round: record.round, friendId: member.friendId,
        name: member.friendName ?? member.friendId, seat: line.seat,
        originalRole: line.originalRole, finalRole: line.finalRole,
        won: line.won, voteOutcome: line.voteOutcome,
        suspicionAccuracy: line.suspicionAccuracy, recordedAt: Date.now(),
      });
    }
    for (const cb of this.world.historyWatchers) cb([...this.world.history]);
  }

  /** The all-time record. Aggregated on read; nothing stored is a total. */
  watchHistory(cb: (records: HistoryRecord[]) => void): Unsubscribe {
    this.world.historyWatchers.add(cb);
    cb([...this.world.history]);
    return () => this.world.historyWatchers.delete(cb);
  }

  watchFriends(cb: (friends: FriendProfile[]) => void): Unsubscribe {
    this.world.friendWatchers.add(cb);
    cb([...this.world.friends]);
    return () => this.world.friendWatchers.delete(cb);
  }

  async createFriend(displayName: string): Promise<FriendProfile> {
    const profile: FriendProfile = {
      id: newFriendId(this.world.random),
      displayName: normaliseName(displayName),
      createdAt: Date.now(),
    };
    this.world.friends.push(profile);
    for (const cb of this.world.friendWatchers) cb([...this.world.friends]);
    return profile;
  }

  async recordRound(roomId: string, record: RoundRecord): Promise<void> {
    const r = this.world.room(roomId);
    this.requireReferee(r);
    // Append-only, exactly like the Firestore collection it mirrors. A round
    // that is already recorded is not re-recorded — a referee refreshing their
    // tab must not double-score the evening.
    if (r.rounds.some((x) => x.round === record.round)) return;
    r.rounds = [...r.rounds, record];

    // Only an official evening reaches the group's all-time record, and a
    // player with no friend profile is skipped rather than invented: we do not
    // know who they were, and this record is append-only.
    if (r.view.mode === 'official') {
      const byUid = new Map(r.view.members.map((m) => [m.uid, m]));
      for (const line of record.results) {
        const member = byUid.get(line.uid);
        if (!member?.friendId) continue;
        const already = this.world.history.some(
          (h) => h.roomId === roomId && h.round === record.round
            && h.friendId === member.friendId,
        );
        if (already) continue;
        this.world.history.push({
          roomId, round: record.round,
          friendId: member.friendId,
          name: member.friendName ?? member.friendId,
          seat: line.seat,
          originalRole: line.originalRole,
          finalRole: line.finalRole,
          won: line.won,
          voteOutcome: line.voteOutcome,
          suspicionAccuracy: line.suspicionAccuracy,
          recordedAt: Date.now(),
        });
      }
      for (const cb of this.world.historyWatchers) cb([...this.world.history]);
    }

    this.world.notify(roomId);
  }

  /* ---------------------------- guards ---------------------------- */

  private requireHost(r: RoomRecord): void {
    if (r.view.hostUid !== this.uid) throw new Error('host only');
  }
  private requireReferee(r: RoomRecord): void {
    if (r.view.refereeUid !== this.uid) throw new Error('referee only');
  }
  private requireHostOrReferee(r: RoomRecord): void {
    if (r.view.hostUid !== this.uid && r.view.refereeUid !== this.uid) {
      throw new Error('host or referee only');
    }
  }
}

/** The referee's side, satisfying the interfaces runNight and runDay expect. */
class MemoryRefereeStore implements RoomStore, DayStore {
  constructor(
    private readonly world: MemoryWorld,
    private readonly roomId: string,
  ) {}

  private get r() {
    return this.world.room(this.roomId);
  }

  private uidForSeat(seat: SeatIndex): string | undefined {
    return this.r.view.seating[seat];
  }

  async readNightCheckpoint(): Promise<NightCheckpoint | null> {
    const checkpoint = this.r.checkpoint;
    return checkpoint ? { ...checkpoint, answers: [...checkpoint.answers] } : null;
  }

  async saveNightCheckpoint(checkpoint: NightCheckpoint): Promise<void> {
    this.r.checkpoint = { ...checkpoint, answers: [...checkpoint.answers] };
  }

  async setWindowIndex(windowIndex: number): Promise<void> {
    this.r.view.nightWindowIndex = windowIndex;
    this.r.view.nightForceAdvanceIndex = null;
    this.world.notify(this.roomId);
  }

  async forceAdvanceRequested(windowIndex: number): Promise<boolean> {
    return this.r.view.nightForceAdvanceIndex === windowIndex;
  }

  async readSubmissions(windowIndex: number) {
    const out = new Map<SeatIndex, Record<string, Choice>>();
    const { seating } = this.r.view;
    for (const [uid, sub] of this.r.submissions) {
      if (sub.windowIndex !== windowIndex) continue;
      // Seat comes from the document's OWNER, never from a field inside it —
      // the same reasoning as FirestoreRoomStore.
      const seat = seating.indexOf(uid);
      if (seat < 0) continue;
      out.set(seat, sub.choices);
    }
    return out;
  }

  async setPrivateInfo(seat: SeatIndex, info: PrivateInfo[]): Promise<void> {
    const uid = this.uidForSeat(seat);
    if (!uid) return;
    const existing = this.r.privates.get(uid) ?? { originalRole: null, privateInfo: [], pending: [] };
    this.r.privates.set(uid, {
      ...existing,
      privateInfo: [...info],
    });
    this.world.notify(this.roomId);
  }

  /** What this seat is being asked right now. Replaces, never appends. */
  async releaseDecisions(seat: SeatIndex, requests: DecisionRequest[]): Promise<void> {
    const uid = this.uidForSeat(seat);
    if (!uid) return;
    const existing = this.r.privates.get(uid) ?? { originalRole: null, privateInfo: [], pending: [] };
    this.r.privates.set(uid, { ...existing, pending: [...requests] });
    this.world.notify(this.roomId);
  }

  async setPublicEvents(events: NightEvent[]): Promise<void> {
    const r = this.r;
    r.view.publicEvents = [...events];
    this.world.notify(this.roomId);
  }

  /**
   * What the table can see, replaced wholesale.
   *
   * Deliberately NOT accumulated from the reveal events above. Those record
   * that a card was turned over at a slot, which stops being where the card is
   * the moment anything moves it — and everything that moves cards acts after
   * the Medium.
   */
  async publishPublicView(view: PublicNightView): Promise<void> {
    const r = this.r;
    r.view.revealedSlots = { ...view.revealed };
    r.view.shieldedSeats = [...view.shielded];
    this.world.notify(this.roomId);
  }

  async recordLatency(samples: LatencySample[]): Promise<void> {
    this.r.latency.push(...samples);
  }

  async setPhase(phase: RoomPhase): Promise<void> {
    this.r.view.phase = phase;
    this.world.notify(this.roomId);
  }

  async readVotes(): Promise<Map<SeatIndex, Vote>> {
    const r = this.r;
    const out = new Map<SeatIndex, Vote>();
    for (const [uid, v] of r.votes) {
      const seat = r.view.seating.indexOf(uid);
      if (seat < 0) continue;
      const targetSeat = v.target === null ? null : r.view.seating.indexOf(v.target);
      out.set(seat, {
        voter: seat,
        target: targetSeat === undefined || targetSeat === null || targetSeat < 0 ? null : targetSeat,
        abstain: v.abstain,
        readyToVote: v.readyToVote === true,
      });
    }
    // Publish the counts the table is allowed to see: how many, never who.
    r.view.abstainCount = [...out.values()].filter((v) => v.abstain).length;
    r.view.earlyVoteCount = [...out.values()].filter((v) => v.readyToVote === true).length;
    r.view.votesCast = [...out.values()].filter((v) => v.target !== null).length;
    this.world.notify(this.roomId);
    return out;
  }

  async announceExtension(extraMs: number): Promise<void> {
    // Public on purpose — seeing the extension land IS the mechanic (§7).
    // Deliberately not written to `outcome`: that field means "the game is
    // over and here is the result", and an extension is the opposite of that.
    this.r.view.discussionExtendedByMs = extraMs;
    this.world.notify(this.roomId);
  }

  async setDiscussionDeadline(endsAt: number | null): Promise<void> {
    this.r.view.discussionEndsAt = endsAt;
    this.world.notify(this.roomId);
  }

  async practiceForceVoteRequested(): Promise<boolean> {
    return this.r.view.practiceSkipDiscussion === true;
  }

}

function assertExactRoleCount(roles: RoleId[], seatCount: number): void {
  const needed = seatCount + 3;
  if (roles.length !== needed) {
    throw new Error(`${seatCount} spelers hebben precies ${needed} kaarten nodig; er zijn er ${roles.length}.`);
  }
}

export { MemoryRefereeStore };
