import {
  collection, deleteField, doc, getDoc, getDocs, onSnapshot, runTransaction, setDoc,
  updateDoc, writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { cardsForRoles, deal } from '../engine/deal.js';
import { roleDef } from '../engine/roles.js';
import { buildTimeline } from '../engine/timeline.js';
import type {
  Choice, GameConfig, NightState, RoleId, SeatIndex,
} from '../engine/types.js';
import type { DayStore } from '../orchestration/dayrunner.js';
import type { RoomStore } from '../orchestration/store.js';
import {
  DEFAULT_DISCUSSION_MS, generateRoomCode, validDiscussionMs,
  type Backend, type CreateRoomOptions, type FriendLabel,
  type GameResults, type PlayerView, type PrivateView, type RoomView,
  type Unsubscribe,
} from '../app/backend.js';
import {
  canStartRound, seatingForNextRound, standings,
  type RoundRecord, type SessionMember,
} from '../app/session.js';
import { FirestoreRoomStore } from './roomstore.js';
import { FirestoreSessionStore } from './sessionstore.js';
import { newFriendId, normaliseName, type FriendProfile } from '../app/friend.js';
import {
  assertFriendProfileAvailable, assertUniqueFriendProfiles, occupiedFriendSeat,
} from '../app/friendseat.js';
import type { HistoryRecord } from '../stats/alltime.js';
import {
  engineStateFromDoc, engineStateToDoc, paths,
  type FriendDoc, type HistoryDoc,
  type EngineStateDoc, type PlayerDoc, type PrivateDoc, type RoomDoc, type RoundDoc,
  type VoteDoc, type SessionMemberDoc,
} from './schema.js';

/**
 * The real backend: the same `Backend` interface `MemoryBackend` implements,
 * against Firestore.
 *
 * Every method here has a counterpart in memorybackend.ts, and where the two
 * disagree the app breaks in a way no test catches — the memory one is what
 * all 283 tests run against. So the rule for this file is that it mirrors that
 * one's BEHAVIOUR, and where it cannot, the difference is written down.
 *
 * The other rule is that this file assumes it will be lied to. Every guard in
 * here is duplicated in firestore.rules, because a guard that lives only in
 * the client is a guard a player with devtools does not have. The checks below
 * exist to produce a sensible error message before the round-trip; the rules
 * are what actually stop anything.
 */
export class FirestoreBackend implements Backend {
  constructor(
    private readonly db: Firestore,
    readonly uid: string,
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {}

  private roomRef(roomId: string) {
    return doc(this.db, paths.room(roomId));
  }

  private session(roomId: string): FirestoreSessionStore {
    return new FirestoreSessionStore(this.db, roomId, this.onListenerError);
  }

  private async room(roomId: string): Promise<RoomDoc> {
    const snap = await getDoc(this.roomRef(roomId));
    if (!snap.exists()) throw new Error(`no room ${roomId}`);
    return snap.data() as RoomDoc;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Create the room, and become its referee.
   *
   * The creating device is the referee. In practice this still means creating
   * the room on the tablet; a phrase-confirmed trusted-group recovery exists
   * only for when that device fails.
   */
  async createRoom(options: CreateRoomOptions): Promise<string> {
    const playing = options.playing !== false;
    const discussionMs = options.discussionMs ?? DEFAULT_DISCUSSION_MS;
    if (!validDiscussionMs(discussionMs)) throw new Error('discussion timer must be 1-120 minutes');
    const roomId = await this.freeRoomCode();

    const room: RoomDoc = {
      hostUid: this.uid,
      refereeUid: this.uid,
      recoveryPhrase: null,
      phase: 'lobby',
      // Practice unless somebody deliberately said otherwise.
      mode: options.mode ?? 'practice',
      discussionMs,
      discussionEndsAt: null,
      practiceSkipDiscussion: false,
      // 0 means "nothing played yet". Somebody joining now is a round-1
      // member, which is currentRound + 1 — the same arithmetic as joining
      // mid-evening rather than a special case.
      currentRound: 0,
      nightWindowIndex: 0,
      nightForceAdvanceIndex: null,
      activeRoles: options.activeRoles,
      nightOrder: [],
      config: options.config,
      // A neutral tablet is the referee and takes NO seat: it holds every
      // card, so dealing it one would be dealing a card to the person who can
      // read them all. A phone hosting its own game does take a seat, with the
      // caveat that its owner then knows the whole deal.
      seating: playing ? [this.uid] : [],
      timeline: null as unknown as RoomDoc['timeline'],
      publicEvents: [],
      shieldedSlots: [],
      revealedCards: [],
      createdAt: Date.now(),
      pausedAt: null,
      votesCast: 0,
      abstainCount: 0,
      earlyVoteCount: 0,
      discussionExtendedByMs: 0,
      finalRoles: null,
      outcome: null,
      revealedSlots: {},
      shieldedSeats: [],
    };
    await setDoc(this.roomRef(roomId), room);

    if (playing) {
      await this.writePlayer(roomId, options.displayName);
      await this.session(roomId).join(this.uid, friendLabel(options.friend, options.displayName));
    }
    return roomId;
  }

  async takeEmergencyControl(roomId: string, phrase: string): Promise<void> {
    if (phrase !== 'referee') throw new Error('type referee to confirm takeover');
    await updateDoc(this.roomRef(roomId), {
      hostUid: this.uid,
      refereeUid: this.uid,
      recoveryPhrase: phrase,
    });
  }

  /**
   * A code nobody is using.
   *
   * 32^5 is about 33 million, so a collision is not a real concern for one
   * group — but it is checked rather than assumed, because a collision that
   * went unchecked would silently drop somebody into a stranger's evening.
   */
  private async freeRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateRoomCode();
      if (!(await getDoc(this.roomRef(code))).exists()) return code;
    }
    throw new Error('could not find a free room code');
  }

  private async writePlayer(roomId: string, displayName: string): Promise<void> {
    const player: PlayerDoc = { displayName, avatar: null, joinedAt: Date.now() };
    await setDoc(doc(this.db, paths.player(roomId, this.uid)), player);
  }

  /**
   * Join the session. Allowed at any time, not just in the lobby.
   *
   * Mid-round you become a member now and are seated when the next round
   * starts — there is no card to hand somebody who walks in at second twenty,
   * and the Dorpsgek's shift needs stable adjacency (§13).
   *
   * Nothing here decides how many points you start on, because nothing here is
   * allowed to: the seed is derived from joinedAtRound, which the rules pin to
   * the room's own round counter. See sessionstore.ts.
   */
  async joinRoom(
    roomId: string,
    displayName: string,
    friend?: FriendLabel,
  ): Promise<void> {
    const roomRef = this.roomRef(roomId);
    const memberRef = doc(this.db, paths.member(roomId, this.uid));
    const playerRef = doc(this.db, paths.player(roomId, this.uid));
    const label = friendLabel(friend, displayName);
    // Pre-read candidates for reclaim: transactions cannot query collections.
    const members = await this.readMembers(roomId);
    const roomPeek = await this.room(roomId);
    const reclaim = roomPeek.phase === 'lobby'
      ? occupiedFriendSeat(members, roomPeek.seating, this.uid, label.friendId)
      : null;
    if (roomPeek.phase !== 'lobby' && label.friendId) {
      assertFriendProfileAvailable(members, roomPeek.seating, this.uid, label.friendId);
    }

    await runTransaction(this.db, async (tx) => {
      const reads = [tx.get(roomRef), tx.get(memberRef)] as const;
      const reclaimRef = reclaim
        ? doc(this.db, paths.member(roomId, reclaim.uid))
        : null;
      const [roomSnap, memberSnap, reclaimSnap] = await Promise.all([
        reads[0], reads[1], reclaimRef ? tx.get(reclaimRef) : Promise.resolve(null),
      ]);
      if (!roomSnap.exists()) throw new Error(`no room ${roomId}`);
      const room = roomSnap.data() as RoomDoc;
      if (room.refereeUid === this.uid && !memberSnap.exists()) {
        throw new Error('the referee is not a player in this room');
      }

      let seating = [...room.seating];
      if (reclaim && reclaimSnap?.exists() && room.phase === 'lobby') {
        const data = reclaimSnap.data() as SessionMemberDoc;
        if (data.leftAtRound == null && data.friendId === label.friendId) {
          tx.update(reclaimRef!, { leftAtRound: room.currentRound });
          seating = seating.filter((uid) => uid !== reclaim.uid);
        }
      }

      const player: PlayerDoc = { displayName, avatar: null, joinedAt: Date.now() };
      tx.set(playerRef, player);
      if (memberSnap.exists()) {
        const member = memberSnap.data() as SessionMemberDoc;
        if (member.leftAtRound !== null && member.leftAtRound !== undefined) {
          tx.update(memberRef, { leftAtRound: null });
        }
        if (room.phase === 'lobby' && !seating.includes(this.uid)) {
          seating = [...seating, this.uid];
        }
        if (seating.join(',') !== room.seating.join(',')) {
          tx.update(roomRef, { seating });
        }
        return;
      }

      tx.set(memberRef, {
        uid: this.uid,
        joinedAtRound: room.currentRound + 1,
        leftAtRound: null,
        ...label,
      });
      if (room.phase === 'lobby' && !seating.includes(this.uid)) {
        seating = [...seating, this.uid];
      }
      if (seating.join(',') !== room.seating.join(',')) {
        tx.update(roomRef, { seating });
      }
    });
  }

  async setFriendProfile(roomId: string, friend: FriendLabel): Promise<void> {
    const room = await this.room(roomId);
    if (room.phase !== 'lobby') throw new Error('profiles are frozen once the game starts');
    const members = await this.readMembers(roomId);
    const own = members.find((member) => member.uid === this.uid);
    if (!own || own.leftAtRound !== null) throw new Error('active member only');

    const reclaim = occupiedFriendSeat(members, room.seating, this.uid, friend.friendId);
    if (reclaim) {
      await runTransaction(this.db, async (tx) => {
        const roomRef = this.roomRef(roomId);
        const ownRef = doc(this.db, paths.member(roomId, this.uid));
        const otherRef = doc(this.db, paths.member(roomId, reclaim.uid));
        const [roomSnap, otherSnap] = await Promise.all([tx.get(roomRef), tx.get(otherRef)]);
        if (!roomSnap.exists()) throw new Error(`no room ${roomId}`);
        const live = roomSnap.data() as RoomDoc;
        if (live.phase !== 'lobby') throw new Error('profiles are frozen once the game starts');
        if (otherSnap.exists()) {
          const data = otherSnap.data() as SessionMemberDoc;
          if (data.leftAtRound == null && data.friendId === friend.friendId) {
            tx.update(otherRef, { leftAtRound: live.currentRound });
            tx.update(roomRef, {
              seating: live.seating.filter((uid) => uid !== reclaim.uid),
            });
          }
        }
        tx.update(ownRef, {
          friendId: friend.friendId,
          friendName: friend.friendName,
        });
      });
      return;
    }

    await updateDoc(doc(this.db, paths.member(roomId, this.uid)), {
      friendId: friend.friendId,
      friendName: friend.friendName,
    });
  }

  /**
   * Leave without ending the evening for everybody else.
   *
   * Mid-round this does NOT stop the game: the seat stays in the deal and its
   * outstanding decisions decline exactly as an AFK player's would, and the
   * seat disappears at the next round boundary. Ending the night because one
   * person has to drive home is the behaviour this exists to prevent.
   */
  async leaveRoom(roomId: string): Promise<void> {
    const member = await getDoc(doc(this.db, paths.member(roomId, this.uid)));
    if (!member.exists()) return;                  // never here; nothing to do

    await this.session(roomId).leave(this.uid);

    const room = await this.room(roomId);
    if (room.phase === 'lobby') {
      await updateDoc(this.roomRef(roomId), {
        seating: room.seating.filter((uid) => uid !== this.uid),
      });
    }
  }

  /* -------------------------------- lobby -------------------------------- */

  async setSeating(roomId: string, seating: string[]): Promise<void> {
    const room = await this.room(roomId);
    const member = await getDoc(doc(this.db, paths.member(roomId, this.uid)));
    const activeMember = member.exists()
      && (member.data() as { leftAtRound?: number | null }).leftAtRound === null;
    if (room.hostUid !== this.uid && room.refereeUid !== this.uid && !activeMember) {
      throw new Error('active member, host, or referee only');
    }
    if (room.phase !== 'lobby') throw new Error('seating is frozen once the game starts');
    // Measured against who is SEATED, not who is in the room: somebody waiting
    // for the next round has no seat to arrange yet.
    const current = new Set(room.seating);
    if (seating.length !== room.seating.length
      || new Set(seating).size !== seating.length
      || seating.some((uid) => !current.has(uid))) {
      throw new Error('seating must contain every seated player exactly once');
    }
    await updateDoc(this.roomRef(roomId), { seating: [...seating] });
  }

  async setActiveRoles(roomId: string, roles: RoleId[], config: GameConfig): Promise<void> {
    const room = await this.room(roomId);
    if (room.hostUid !== this.uid && room.refereeUid !== this.uid) throw new Error('host only');
    if (room.phase !== 'lobby') throw new Error('roles are frozen once the game starts');
    validateRoleSelection(roles);
    await updateDoc(this.roomRef(roomId), { activeRoles: [...roles], config });
  }

  async setPaused(roomId: string, paused: boolean): Promise<void> {
    await runTransaction(this.db, async (tx) => {
      const ref = this.roomRef(roomId);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error(`no room ${roomId}`);
      const room = snap.data() as RoomDoc;
      if (room.hostUid !== this.uid && room.refereeUid !== this.uid) {
        throw new Error('host or referee only');
      }
      const now = Date.now();
      if (paused) {
        if (room.pausedAt === null) tx.update(ref, { pausedAt: now });
        return;
      }
      if (room.pausedAt === null) return;
      const extension = now - room.pausedAt;
      tx.update(ref, {
        pausedAt: null,
        discussionEndsAt: room.discussionEndsAt === null
          ? null
          : room.discussionEndsAt + extension,
      });
    });
  }

  /* ------------------------------- the deal ------------------------------ */

  /**
   * Deal and begin the next round. Referee only.
   *
   * This is the ROUND BOUNDARY: everybody waiting sits down, everybody who
   * left is removed, and the ring closes up — a hole in the seating is a hole
   * in the Dorpsgek's rotation (§13). It is also the only moment a role is
   * written anywhere, and it writes one document per seat.
   */
  async startGame(roomId: string, seed: number): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if (room.phase !== 'lobby') {
      throw new Error('a round is already running');
    }

    const nextRound = room.currentRound + 1;
    const members = await this.readMembers(roomId);
    const seating = seatingForNextRound(members, room.seating, nextRound);
    assertUniqueFriendProfiles(members, seating);
    assertExactRoleCount(room.activeRoles, seating.length);

    const tooSmall = canStartRound(seating.length);
    if (tooSmall) throw new Error(tooSmall);

    const cards = cardsForRoles(room.activeRoles, seating.length);
    const dealt = deal({ cards, seatCount: seating.length, seed });

    // One batch, so the table never observes a half-dealt room: seats assigned
    // without cards behind them, or a phase that has turned over before the
    // private documents exist, is a round that looks broken to everybody.
    const batch = writeBatch(this.db);

    batch.update(this.roomRef(roomId), {
      currentRound: nextRound,
      seating,
      phase: 'night',
      nightWindowIndex: 0,
      nightForceAdvanceIndex: null,
      timeline: buildTimeline(room.activeRoles, room.config),
      // Clear last round's table so nothing bleeds across.
      publicEvents: [],
      shieldedSeats: [],
      revealedSlots: {},
      votesCast: 0,
      abstainCount: 0,
      earlyVoteCount: 0,
      pausedAt: null,
      discussionExtendedByMs: 0,
      discussionEndsAt: null,
      practiceSkipDiscussion: false,
      finalRoles: null,
      originalRoles: deleteField(),
      outcome: null,
      eliminatedSeats: deleteField(),
      winningTeams: deleteField(),
      finalVotes: deleteField(),
      discardedVotes: deleteField(),
      finalTally: deleteField(),
      finalCenterRoles: deleteField(),
      nightInfo: deleteField(),
    });

    batch.set(doc(this.db, paths.engineState(roomId)), engineStateToDoc(dealt.state));

    // Each seat learns its own dealt role and nothing else.
    seating.forEach((uid, seat) => {
      const priv: PrivateDoc = {
        originalRole: dealt.seatRoles[seat]!,
        currentCard: dealt.state.slots[seat]!,
        currentRole: dealt.seatRoles[seat]!,
        privateInfo: [],
        revealedThrough: 0,
      };
      batch.set(doc(this.db, paths.private(roomId, uid)), priv);
    });

    await batch.commit();
  }

  async prepareNextRound(roomId: string): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if (room.phase !== 'results') throw new Error('round is not finished');
    const members = await this.readMembers(roomId);
    const seating = seatingForNextRound(members, room.seating, room.currentRound + 1);
    await updateDoc(this.roomRef(roomId), { phase: 'lobby', seating });
  }

  /* -------------------------------- reads -------------------------------- */

  /**
   * The public room, live.
   *
   * Three listeners, because the scoreboard is derived rather than stored:
   * the room document, the members, and the rounds. Recomputing on every
   * snapshot is the point — a cached total is a total that can be wrong.
   */
  watchRoom(roomId: string, cb: (room: RoomView | null) => void): Unsubscribe {
    let room: RoomDoc | null = null;
    let members: SessionMember[] = [];
    let rounds: RoundRecord[] = [];
    let haveRoom = false;

    const emit = () => {
      if (!haveRoom) return;
      cb(room ? this.composeRoomView(roomId, room, members, rounds) : null);
    };

    const stopRoom = onSnapshot(
      this.roomRef(roomId),
      (snap) => {
        haveRoom = true;
        room = snap.exists() ? (snap.data() as RoomDoc) : null;
        emit();
      },
      this.onListenerError,
    );
    const session = this.session(roomId);
    const stopMembers = session.watchMembers((m) => { members = m; emit(); });
    const stopRounds = session.watchRounds((r) => { rounds = r; emit(); });

    return () => { stopRoom(); stopMembers(); stopRounds(); };
  }

  private composeRoomView(
    roomId: string,
    room: RoomDoc,
    members: SessionMember[],
    rounds: RoundRecord[],
  ): RoomView {
    return {
      roomId,
      hostUid: room.hostUid,
      refereeUid: room.refereeUid,
      phase: room.phase,
      round: room.currentRound,
      mode: room.mode ?? 'practice',
      discussionMs: room.discussionMs ?? DEFAULT_DISCUSSION_MS,
      discussionEndsAt: room.discussionEndsAt ?? null,
      practiceSkipDiscussion: room.practiceSkipDiscussion ?? false,
      nightWindowIndex: room.nightWindowIndex ?? 0,
      nightForceAdvanceIndex: room.nightForceAdvanceIndex ?? null,
      activeRoles: room.activeRoles ?? [],
      config: room.config,
      timeline: room.timeline ?? null,
      seating: room.seating ?? [],
      members,
      standings: standings(members, rounds),
      publicEvents: room.publicEvents ?? [],
      shieldedSeats: room.shieldedSeats ?? [],
      revealedSlots: room.revealedSlots ?? {},
      abstainCount: room.abstainCount ?? 0,
      earlyVoteCount: room.earlyVoteCount ?? 0,
      votesCast: room.votesCast ?? 0,
      pausedAt: room.pausedAt ?? null,
      discussionExtendedByMs: room.discussionExtendedByMs ?? 0,
      finalRoles: room.finalRoles ?? null,
      ...(room.originalRoles ? { originalRoles: room.originalRoles } : {}),
      outcome: room.outcome ?? null,
      ...(room.eliminatedSeats ? { eliminatedSeats: room.eliminatedSeats } : {}),
      ...(room.winningTeams ? { winningTeams: room.winningTeams } : {}),
      ...(room.finalVotes ? { finalVotes: room.finalVotes } : {}),
      ...(room.discardedVotes ? { discardedVotes: room.discardedVotes } : {}),
      ...(room.finalTally ? { finalTally: room.finalTally } : {}),
      ...(room.finalCenterRoles ? { finalCenterRoles: room.finalCenterRoles } : {}),
      ...(room.nightInfo ? { nightInfo: room.nightInfo } : {}),
    };
  }

  /**
   * Everyone in the evening, live.
   *
   * Seats come from the ROOM's seating list, not from the player documents, so
   * somebody waiting for the next round genuinely has no seat rather than a
   * stale one — and so no player can write their own seat number.
   */
  watchPlayers(roomId: string, cb: (players: PlayerView[]) => void): Unsubscribe {
    let names = new Map<string, string>();
    let botUids = new Set<string>();
    let seating: string[] = [];
    let members: SessionMember[] = [];
    let havePlayers = false;

    const emit = () => {
      if (!havePlayers) return;
      const departed = new Set(
        members.filter((m) => m.leftAtRound !== null).map((m) => m.uid),
      );
      const out: PlayerView[] = [...names].map(([uid, displayName]) => {
        const seat = seating.indexOf(uid);
        return {
          uid,
          displayName,
          seatIndex: seat < 0 ? null : (seat as SeatIndex),
          playing: seat >= 0,
          departed: departed.has(uid),
          ...(botUids.has(uid) ? { isBot: true } : {}),
        };
      });
      out.sort((a, b) => {
        if (a.seatIndex !== null && b.seatIndex !== null) return a.seatIndex - b.seatIndex;
        if (a.seatIndex !== null) return -1;
        if (b.seatIndex !== null) return 1;
        return a.uid.localeCompare(b.uid);
      });
      cb(out);
    };

    const stopPlayers = onSnapshot(
      collection(this.db, paths.players(roomId)),
      (snap) => {
        havePlayers = true;
        names = new Map(
          snap.docs.map((d) => [d.id, (d.data() as PlayerDoc).displayName ?? d.id]),
        );
        botUids = new Set(
          snap.docs.filter((d) => (d.data() as PlayerDoc).isBot === true)
            .map((d) => d.id),
        );
        emit();
      },
      this.onListenerError,
    );
    const stopRoom = onSnapshot(
      this.roomRef(roomId),
      (snap) => {
        seating = (snap.data() as RoomDoc | undefined)?.seating ?? [];
        emit();
      },
      this.onListenerError,
    );
    const stopMembers = this.session(roomId).watchMembers((m) => { members = m; emit(); });

    return () => { stopPlayers(); stopRoom(); stopMembers(); };
  }

  /** This device's own card and reveals. Never anybody else's. */
  watchPrivate(roomId: string, cb: (own: PrivateView) => void): Unsubscribe {
    return onSnapshot(
      doc(this.db, paths.private(roomId, this.uid)),
      (snap) => {
        const data = snap.data() as PrivateDoc | undefined;
        cb({
          originalRole: data?.originalRole ?? null,
          privateInfo: data?.privateInfo ?? [],
          pending: data?.pendingDecisions ?? [],
        });
      },
      this.onListenerError,
    );
  }

  watchRounds(roomId: string, cb: (rounds: RoundRecord[]) => void): Unsubscribe {
    return this.session(roomId).watchRounds(cb);
  }

  private async readMembers(roomId: string): Promise<SessionMember[]> {
    const snap = await getDocs(collection(this.db, paths.members(roomId)));
    return snap.docs.map((d) => {
      const data = d.data() as Partial<SessionMember>;
      return {
        uid: d.id,
        joinedAtRound: typeof data.joinedAtRound === 'number' ? data.joinedAtRound : 1,
        leftAtRound: typeof data.leftAtRound === 'number' ? data.leftAtRound : null,
        ...(typeof data.friendId === 'string' ? { friendId: data.friendId } : {}),
        ...(typeof data.friendName === 'string' ? { friendName: data.friendName } : {}),
      };
    });
  }

  /* ------------------------------- writes -------------------------------- */

  /**
   * A player's own night choices, for the window currently open.
   *
   * The phase and window checks below mirror the security rule exactly. They
   * are here for the error message; the rule is what closes the window,
   * without trusting any client's clock.
   */
  async submit(
    roomId: string,
    windowIndex: number,
    choices: Record<string, Choice>,
  ): Promise<void> {
    const room = await this.room(roomId);
    if (room.phase !== 'night') throw new Error('not night');
    if (windowIndex !== room.nightWindowIndex) throw new Error('window closed');

    const ref = doc(this.db, paths.submission(roomId, this.uid));
    const existing = (await getDoc(ref)).data() as
      { round?: number; windowIndex?: number; choices?: Record<string, Choice> } | undefined;
    // Merge only within the SAME window. A document left over from an earlier
    // window must not have its choices carried forward into this one.
    const carried = existing?.round === room.currentRound && existing.windowIndex === windowIndex
      ? existing.choices ?? {}
      : {};
    await setDoc(ref, {
      round: room.currentRound,
      windowIndex,
      choices: { ...carried, ...choices },
      submittedAt: Date.now(),
    });
  }

  async submittedKeys(roomId: string, round: number, windowIndex: number): Promise<string[]> {
    const snap = await getDoc(doc(this.db, paths.submission(roomId, this.uid)));
    const data = snap.data() as {
      round?: number; windowIndex?: number; choices?: Record<string, Choice>;
    } | undefined;
    if (data?.round !== round || data.windowIndex !== windowIndex) return [];
    return Object.keys(data.choices ?? {});
  }

  /**
   * A vote, or an abstain.
   *
   * §7: an abstain counts at any moment and so is accepted during the
   * discussion; a named target is confined to 'voting', because letting one be
   * locked in early would quietly turn a simultaneous vote into a first-mover
   * one even though nobody can read it yet. Never a vote for yourself.
   */
  async vote(roomId: string, target: string | null, abstain: boolean): Promise<void> {
    if (target === this.uid) throw new Error('no self-votes');
    const room = await this.room(roomId);
    const ok = (room.phase === 'voting' && target !== null && !abstain)
      || (room.phase === 'day' && target === null);
    if (!ok) throw new Error(`cannot vote in phase ${room.phase}`);
    if (target !== null && !room.seating.includes(target)) throw new Error('target is not seated');
    const ref = doc(this.db, paths.vote(roomId, this.uid));
    const existing = (await getDoc(ref)).data() as Partial<VoteDoc> | undefined;
    if (room.phase === 'voting' && existing?.round === room.currentRound
      && existing.target !== null && existing.target !== undefined) {
      throw new Error('vote is final');
    }
    await setDoc(ref, {
      round: room.currentRound,
      target,
      abstain,
      // A player can ask to open the ballot, then choose a target when it opens.
      // Preserve that request only from this round; last round's document is stale.
      readyToVote: abstain
        ? false
        : existing?.round === room.currentRound && existing.readyToVote === true,
      castAt: Date.now(),
    });
  }

  async ownVote(roomId: string): Promise<{
    round: number; target: string | null; abstain: boolean; readyToVote: boolean;
  } | null> {
    const data = (await getDoc(doc(this.db, paths.vote(roomId, this.uid))))
      .data() as Partial<VoteDoc> | undefined;
    if (typeof data?.round !== 'number') return null;
    return {
      round: data.round,
      target: data.target ?? null,
      abstain: data.abstain === true,
      readyToVote: data.readyToVote === true,
    };
  }

  async emergencyVote(
    roomId: string, voterUid: string, targetUid: string, phrase: string,
  ): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if (phrase.trim() !== 'takeover') throw new Error('type takeover to confirm');
    if (room.phase !== 'voting') throw new Error('voting is not open');
    if (!room.seating.includes(voterUid) || !room.seating.includes(targetUid)) {
      throw new Error('both players must be seated');
    }
    if (voterUid === targetUid) throw new Error('no self-votes');
    const ref = doc(this.db, paths.vote(roomId, voterUid));
    const existing = (await getDoc(ref)).data() as Partial<VoteDoc> | undefined;
    if (existing?.round === room.currentRound
      && existing.target !== null && existing.target !== undefined) {
      throw new Error('vote is final');
    }
    await setDoc(ref, {
      round: room.currentRound,
      target: targetUid,
      abstain: false,
      readyToVote: false,
      castAt: Date.now(),
      takeoverPhrase: phrase.trim(),
    });
  }

  /**
   * Ask to open the ballot now. Reversible, and not an abstain.
   *
   * Written onto this device's own vote document, which only its owner may
   * write and only the referee may read — so the request is private in exactly
   * the way a vote is, and only the count ever becomes public.
   */
  async requestEarlyVote(roomId: string, requested: boolean): Promise<void> {
    const room = await this.room(roomId);
    if (room.phase !== 'day') {
      throw new Error(`cannot ask to vote in phase ${room.phase}`);
    }
    const ref = doc(this.db, paths.vote(roomId, this.uid));
    const existing = (await getDoc(ref)).data() as Partial<VoteDoc> | undefined;
    const current = existing?.round === room.currentRound ? existing : undefined;
    await setDoc(ref, {
      round: room.currentRound,
      target: current?.target ?? null,
      abstain: requested ? false : current?.abstain === true,
      readyToVote: requested,
      castAt: Date.now(),
    });
  }

  async forceNightWindow(roomId: string): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if (room.phase !== 'night') throw new Error('night is not running');
    await updateDoc(this.roomRef(roomId), {
      nightForceAdvanceIndex: room.nightWindowIndex,
    });
  }

  async forcePracticeVote(roomId: string): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if ((room.mode ?? 'practice') !== 'practice') throw new Error('practice rooms only');
    if (room.phase !== 'day') throw new Error('the discussion is not running');
    await updateDoc(this.roomRef(roomId), { practiceSkipDiscussion: true });
  }

  /* --------------------------------- bots -------------------------------- */

  /**
   * Add one AI player to a practice lobby.
   *
   * Both writes go in one batch: a player document marked isBot and a real
   * membership. The membership matters — it is what seats the bot through the
   * ordinary round-boundary logic rather than through anything that knows what
   * a bot is.
   *
   * Every check below is duplicated in the rules. These produce a sensible
   * error before the round-trip; the rules are the protection.
   */
  async addBot(roomId: string): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if ((room.mode ?? 'practice') !== 'practice') {
      throw new Error('bots are only for practice rooms');
    }
    if (room.phase !== 'lobby') throw new Error('bots can only be added in the lobby');
    if (room.seating.length >= 12) throw new Error('Maximaal 12 spelers.');

    const players = await getDocs(collection(this.db, paths.players(roomId)));
    const botDocs = players.docs.filter((d) => (d.data() as PlayerDoc).isBot);
    const used = new Set(players.docs.map((entry) => entry.id));
    let number = 1;
    while (used.has(`bot-${roomId}-${number}`)) number += 1;
    const uid = `bot-${roomId}-${number}`;
    const displayName = BOT_NAMES[botDocs.length % BOT_NAMES.length] ?? `AI ${number}`;

    const batch = writeBatch(this.db);
    batch.set(doc(this.db, paths.player(roomId, uid)), {
      displayName, avatar: null, joinedAt: Date.now(), isBot: true,
    });
    batch.set(doc(this.db, paths.member(roomId, uid)), {
      uid, joinedAtRound: room.currentRound + 1, leftAtRound: null,
      friendId: '', friendName: displayName,
    });
    batch.update(this.roomRef(roomId), { seating: [...room.seating, uid] });
    await batch.commit();
  }

  /**
   * Remove one.
   *
   * The membership goes with the player document. Leaving it behind would keep
   * the bot on the next round's roster and on the evening's scoreboard, which
   * is exactly the incoherent history this is meant to avoid.
   */
  async removeBot(roomId: string, botUid: string): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if ((room.mode ?? 'practice') !== 'practice') {
      throw new Error('bots are only for practice rooms');
    }
    if (room.phase !== 'lobby') throw new Error('bots can only be removed in the lobby');

    const player = await getDoc(doc(this.db, paths.player(roomId, botUid)));
    if (!(player.data() as PlayerDoc | undefined)?.isBot) throw new Error('not a bot');

    const batch = writeBatch(this.db);
    batch.delete(doc(this.db, paths.player(roomId, botUid)));
    batch.delete(doc(this.db, paths.member(roomId, botUid)));
    batch.update(this.roomRef(roomId), {
      seating: room.seating.filter((uid) => uid !== botUid),
    });
    await batch.commit();
  }

  async removePlayer(roomId: string, playerUid: string): Promise<void> {
    await runTransaction(this.db, async (tx) => {
      const roomRef = this.roomRef(roomId);
      const memberRef = doc(this.db, paths.member(roomId, playerUid));
      const selfRef = doc(this.db, paths.member(roomId, this.uid));
      const [roomSnap, memberSnap, selfSnap] = await Promise.all([
        tx.get(roomRef), tx.get(memberRef), tx.get(selfRef),
      ]);
      if (!roomSnap.exists() || !memberSnap.exists()) throw new Error('player not found');
      const room = roomSnap.data() as RoomDoc;
      const privileged = room.hostUid === this.uid || room.refereeUid === this.uid;
      if (room.phase === 'lobby') {
        const self = selfSnap.exists() ? selfSnap.data() as SessionMemberDoc : null;
        if (!privileged && (!self || self.leftAtRound !== null)) {
          throw new Error('active member, host, or referee only');
        }
      } else if (!privileged) {
        throw new Error('host or referee only');
      }
      const player = await tx.get(doc(this.db, paths.player(roomId, playerUid)));
      if ((player.data() as PlayerDoc | undefined)?.isBot) throw new Error('use removeBot');
      tx.update(memberRef, { leftAtRound: room.currentRound });
      if (room.phase === 'lobby') {
        tx.update(roomRef, { seating: room.seating.filter((uid) => uid !== playerUid) });
      }
    });
  }

  async refereeBotSeats(roomId: string): Promise<SeatIndex[]> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    const players = await getDocs(collection(this.db, paths.players(roomId)));
    const bots = new Set(
      players.docs.filter((entry) => (entry.data() as PlayerDoc).isBot).map((entry) => entry.id),
    );
    return room.seating.flatMap((uid, seat) => bots.has(uid) ? [seat as SeatIndex] : []);
  }

  /** A bot's day vote. Never a human's — see Backend.voteAsBot. */
  async voteAsBot(
    roomId: string,
    botUid: string,
    target: string | null,
    abstain: boolean,
  ): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');
    if ((room.mode ?? 'practice') !== 'practice') {
      throw new Error('bots are only for practice rooms');
    }
    if (target === botUid) throw new Error('no self-votes');
    const ok = room.phase === 'voting' && target !== null && !abstain;
    if (!ok) throw new Error(`cannot vote in phase ${room.phase}`);
    if (!room.seating.includes(target)) throw new Error('target is not seated');

    const player = await getDoc(doc(this.db, paths.player(roomId, botUid)));
    if (!(player.data() as PlayerDoc | undefined)?.isBot) throw new Error('not a bot');

    const voteRef = doc(this.db, paths.vote(roomId, botUid));
    const existing = (await getDoc(voteRef)).data() as Partial<VoteDoc> | undefined;
    if (existing?.round === room.currentRound
      && existing.target !== null && existing.target !== undefined) {
      throw new Error('vote is final');
    }
    await setDoc(voteRef, {
      round: room.currentRound, target, abstain, castAt: Date.now(),
    });
  }

  /* ------------------------------- referee ------------------------------- */

  refereeStore(roomId: string): RoomStore & DayStore {
    // Not checked here: the rules refuse every write this store makes unless
    // the caller really is the referee, and a client-side guard would only
    // change which error you get.
    return new FirestoreRoomStore(this.db, roomId);
  }

  async refereeNightState(roomId: string): Promise<NightState | null> {
    const snap = await getDoc(doc(this.db, paths.engineState(roomId)));
    if (!snap.exists()) return null;
    return engineStateFromDoc(snap.data() as EngineStateDoc);
  }

  /**
   * Publish the outcome. The one moment roles become public.
   *
   * `persist` separates two things that look alike. The room's own result is
   * shown to the table either way — you still want to see who won a test game.
   * The finished round itself is recorded separately. Keeping this write on the
   * room document means a second round cannot collide with a first round's
   * create-only per-player result document.
   */
  async publishResults(
    roomId: string,
    results: GameResults,
    persist: boolean,
  ): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');

    await updateDoc(this.roomRef(roomId), {
      finalRoles: results.finalRoles,
      originalRoles: results.originalRoles ?? Object.fromEntries(
        Object.entries(results.seats).map(([seat, result]) => [seat, result.originalRole]),
      ),
      outcome: results.outcome,
      eliminatedSeats: results.eliminatedSeats,
      winningTeams: results.winningTeams,
      finalVotes: results.finalVotes,
      discardedVotes: results.discardedVotes,
      finalTally: results.finalTally,
      finalCenterRoles: results.finalCenterRoles ?? [],
      nightInfo: results.nightInfo ?? {},
    });
  }

  async finalizeRound(
    roomId: string,
    results: GameResults,
    record: RoundRecord | null,
  ): Promise<void> {
    const room = await this.room(roomId);
    if (room.refereeUid !== this.uid) throw new Error('referee only');

    const batch = writeBatch(this.db);
    if (record) {
      const roundRef = doc(this.db, paths.round(roomId, record.round));
      if (!(await getDoc(roundRef)).exists()) {
        const roundDoc: RoundDoc = {
          round: record.round,
          activeRoles: record.activeRoles,
          seatCount: record.seatCount,
          outcome: record.outcome,
          results: record.results,
          recordedAt: Date.now(),
        };
        batch.set(roundRef, roundDoc);
      }

      if ((room.mode ?? 'practice') === 'official') {
        const members = await this.readMembers(roomId);
        const byUid = new Map(members.map((member) => [member.uid, member]));
        for (const line of record.results) {
          const member = byUid.get(line.uid);
          if (!member?.friendId) continue;
          const historyRef = doc(
            this.db,
            paths.historyEntry(roomId, record.round, member.friendId),
          );
          if ((await getDoc(historyRef)).exists()) continue;
          const historyDoc: HistoryDoc = {
            roomId,
            round: record.round,
            friendId: member.friendId,
            name: member.friendName ?? member.friendId,
            seat: line.seat,
            originalRole: line.originalRole,
            finalRole: line.finalRole,
            won: line.won,
            voteOutcome: line.voteOutcome,
            suspicionAccuracy: line.suspicionAccuracy,
            recordedAt: Date.now(),
          };
          batch.set(historyRef, historyDoc);
        }
      }
    }

    batch.update(this.roomRef(roomId), {
      phase: 'results',
      finalRoles: results.finalRoles,
      originalRoles: results.originalRoles ?? Object.fromEntries(
        Object.entries(results.seats).map(([seat, result]) => [seat, result.originalRole]),
      ),
      outcome: results.outcome,
      eliminatedSeats: results.eliminatedSeats,
      winningTeams: results.winningTeams,
      finalVotes: results.finalVotes,
      discardedVotes: results.discardedVotes,
      finalTally: results.finalTally,
      finalCenterRoles: results.finalCenterRoles ?? [],
      nightInfo: results.nightInfo ?? {},
    });
    await batch.commit();
  }

  /**
   * Append the finished round to the evening's record.
   *
   * Separate from publishResults on purpose: that one shows the table who won,
   * this one is the row the scoreboard and every stats breakdown are rebuilt
   * from, and a test round must produce the first without the second.
   *
   * Recording is idempotent by construction — the document id is the round
   * number, and the rules allow create but never update, so a referee who
   * refreshes their tab cannot double-score the evening.
   */
  async recordRound(roomId: string, record: RoundRecord): Promise<void> {
    const existing = await getDoc(doc(this.db, paths.round(roomId, record.round)));
    if (existing.exists()) return;
    await this.session(roomId).recordRound(record);

    // ...and, for an official evening only, the group's all-time record.
    const room = await this.room(roomId);
    if ((room.mode ?? 'practice') !== 'official') return;
    await this.writeHistory(roomId, record, await this.readMembers(roomId));
  }

  /**
   * One append-only row per player per official round.
   *
   * Keyed by room, round and friend, so recording the same round twice is a
   * collision rather than a second row — the rules allow create and never
   * update, so a referee refreshing their tab cannot double-count a year.
   *
   * A player with no friend profile is SKIPPED rather than written under a
   * placeholder. We do not know who they were; inventing an identity for them
   * would put a stranger in the group's history permanently.
   */
  private async writeHistory(
    roomId: string,
    record: RoundRecord,
    members: SessionMember[],
  ): Promise<void> {
    const byUid = new Map(members.map((m) => [m.uid, m]));
    const batch = writeBatch(this.db);
    let wrote = 0;

    for (const line of record.results) {
      const member = byUid.get(line.uid);
      const friendId = member?.friendId;
      if (!friendId) continue;

      const entry: HistoryDoc = {
        roomId,
        round: record.round,
        friendId,
        name: member.friendName ?? friendId,
        seat: line.seat,
        // Public at dawn: every card becomes public when the game ends (§6.0),
        // and the vote outcome is already in the per-room results.
        originalRole: line.originalRole,
        finalRole: line.finalRole,
        won: line.won,
        voteOutcome: line.voteOutcome,
        suspicionAccuracy: line.suspicionAccuracy,
        recordedAt: Date.now(),
      };
      batch.set(doc(this.db, paths.historyEntry(roomId, record.round, friendId)), entry);
      wrote += 1;
    }

    if (wrote > 0) await batch.commit();
  }

  /** The all-time record. Aggregated on read; nothing here is a total. */
  watchHistory(cb: (records: HistoryRecord[]) => void): Unsubscribe {
    return onSnapshot(
      collection(this.db, paths.history()),
      (snap) => cb(snap.docs.map((d) => d.data() as HistoryDoc)),
      this.onListenerError,
    );
  }

  watchFriends(cb: (friends: FriendProfile[]) => void): Unsubscribe {
    return onSnapshot(
      collection(this.db, paths.friends()),
      (snap) => {
        cb(snap.docs.map((d) => {
          const data = d.data() as Partial<FriendDoc>;
          return {
            id: d.id,
            displayName: data.displayName ?? d.id,
            createdAt: data.createdAt ?? 0,
          };
        }));
      },
      this.onListenerError,
    );
  }

  async createFriend(displayName: string): Promise<FriendProfile> {
    const profile: FriendProfile = {
      id: newFriendId(),
      displayName: normaliseName(displayName),
      createdAt: Date.now(),
    };
    await setDoc(doc(this.db, paths.friend(profile.id)), profile);
    return profile;
  }
}

function validateRoleSelection(roles: RoleId[]): void {
  for (const role of roles) roleDef(role);
  const special = roles.filter((role) => role !== 'dorpeling');
  if (new Set(special).size !== special.length) {
    throw new Error('only Villagers may appear more than once');
  }
}

function assertExactRoleCount(roles: RoleId[], seatCount: number): void {
  const needed = seatCount + 3;
  if (roles.length !== needed) {
    throw new Error(`${seatCount} spelers hebben precies ${needed} kaarten nodig; er zijn er ${roles.length}.`);
  }
}

/** Names for AI players. Recognisably not people, and short enough to fit. */
const BOT_NAMES = [
  'AI Bram', 'AI Fleur', 'AI Joris', 'AI Noor', 'AI Daan',
  'AI Eva', 'AI Tijn', 'AI Isa', 'AI Sam', 'AI Lot', 'AI Kees',
];

/**
 * A friend label, falling back to something usable.
 *
 * A device that never picked a profile still has to be able to play — the
 * evening works without any of this. It simply will not appear in the
 * all-time table, which is the honest outcome: we do not know who it was.
 */
function friendLabel(friend: FriendLabel | undefined, displayName: string): FriendLabel {
  return friend ?? { friendId: '', friendName: displayName };
}
