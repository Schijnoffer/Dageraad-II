import { describe, expect, it } from 'vitest';
import { DEFAULT_ACTIVE_ROLES, TWO_ROUND_CONFIG } from '../engine/presets.js';
import { cardsForRoles } from '../engine/deal.js';
import type { RoomView, PlayerView, PrivateView } from './backend.js';
import { generateRoomCode, isValidRoomCode, normaliseRoomCode } from './backend.js';
import { MemoryWorld } from './memorybackend.js';
import { readRoomOnce } from './refereeRunner.js';

/**
 * These tests are as much about the REFUSALS as the happy path.
 *
 * MemoryWorld exists so a whole night can be played without Firebase, and it is
 * only worth anything if it says no in the same places `firestore.rules` says
 * no. A shell written against a more permissive local backend would pass every
 * test here and be rejected by Firestore the first time it was played for real.
 */

const NAMES = ['Milan', 'Sanne', 'Joris', 'Fleur', 'Bram', 'Noor', 'Tijn', 'Isa'];

async function lobbyOfEight() {
  const world = new MemoryWorld(seededRandom(7));
  const tablet = world.device('tablet');
  const roomId = await tablet.createRoom({
    displayName: 'Tafel',
    activeRoles: cardsForRoles(DEFAULT_ACTIVE_ROLES, NAMES.length),
    config: TWO_ROUND_CONFIG,
    // The shape of a real evening: the tablet is the referee and takes no
    // seat, and the eight humans fill seats 0..7 from their own phones.
    playing: false,
  });
  const phones = NAMES.map((name) => ({ name, device: world.device(`u:${name}`) }));
  for (const p of phones) await p.device.joinRoom(roomId, p.name);
  return { world, tablet, roomId, phones };
}

/** Deterministic, so a failing room code is reproducible. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

describe('room codes', () => {
  it('accepts a code typed with lowercase and spaces', () => {
    expect(normaliseRoomCode(' q7k m2 ')).toBe('Q7KM2');
  });

  it('rejects the characters left out on purpose', () => {
    // 0/O and 1/I/L are the ones people mis-hear across a table.
    expect(isValidRoomCode('Q7KM0')).toBe(false);
    expect(isValidRoomCode('Q7KMI')).toBe(false);
    expect(isValidRoomCode('Q7KM')).toBe(false);
  });

  it('generates codes that pass its own validator', () => {
    const random = seededRandom(99);
    for (let i = 0; i < 200; i++) {
      expect(isValidRoomCode(generateRoomCode(random))).toBe(true);
    }
  });
});

describe('lobby', () => {
  it('seats everyone who joins, creator first', async () => {
    const { world, roomId } = await lobbyOfEight();
    let players: PlayerView[] = [];
    world.device('tablet').watchPlayers(roomId, (p) => { players = p; });

    expect(players).toHaveLength(NAMES.length);
    expect(players[0]!.uid).toBe('u:Milan');
    expect(players.map((p) => p.uid)).not.toContain('tablet');
    expect(players.map((p) => p.seatIndex)).toEqual(players.map((_, i) => i));
  });

  it('lets an active member consciously take control when the tablet has failed', async () => {
    const { world, roomId } = await lobbyOfEight();
    let room: RoomView | null = null;
    world.device('u:Milan').watchRoom(roomId, (r) => { room = r; });

    expect(room!.refereeUid).toBe('tablet');
    await expect(world.device('u:Milan').takeEmergencyControl(roomId, 'wrong'))
      .rejects.toThrow(/type referee/);
    await world.device('u:Milan').takeEmergencyControl(roomId, 'referee');
    expect(room!.hostUid).toBe('u:Milan');
    expect(room!.refereeUid).toBe('u:Milan');
  });

  it('lets a lobby player arrange physical seating', async () => {
    const { world, roomId, phones } = await lobbyOfEight();
    const seating = NAMES.map((n) => `u:${n}`).reverse();
    await expect(phones[0]!.device.setSeating(roomId, seating)).resolves.toBeUndefined();
    await expect(world.device('tablet').setSeating(roomId, seating)).resolves.toBeUndefined();
  });

  it('refuses a seating that does not cover every player', async () => {
    const { world, roomId } = await lobbyOfEight();
    await expect(world.device('tablet').setSeating(roomId, ['u:Milan']))
      .rejects.toThrow(/every seated player/);
  });

  it('refuses to seat a referee who sat the game out', async () => {
    const { world, roomId } = await lobbyOfEight();
    // The tablet has already seen the room from the one place every card is
    // visible. Letting it change its mind and take a seat would deal a card to
    // the device that can read all of them.
    await expect(world.device('tablet').joinRoom(roomId, 'Tafel speelt mee'))
      .rejects.toThrow(/not a player/);
  });

  it('does seat a host who created the room to play in it', async () => {
    const world = new MemoryWorld(seededRandom(11));
    const roomId = await world.device('u:Milan').createRoom({
      displayName: 'Milan',
      activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG,
      playing: true,
    });
    let players: PlayerView[] = [];
    world.device('u:Milan').watchPlayers(roomId, (p) => { players = p; });
    expect(players.map((p) => p.uid)).toEqual(['u:Milan']);
  });

  it('lets a rejoin update the name rather than adding a second seat', async () => {
    const { world, roomId, phones } = await lobbyOfEight();
    await phones[0]!.device.joinRoom(roomId, 'Milan (tablet kapot)');

    let players: PlayerView[] = [];
    world.device('tablet').watchPlayers(roomId, (p) => { players = p; });
    expect(players).toHaveLength(NAMES.length);
    expect(players.find((p) => p.uid === 'u:Milan')!.displayName)
      .toBe('Milan (tablet kapot)');
  });

  it('lets the controller remove a failed human device without deleting history', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.removePlayer(roomId, phones[1]!.device.uid);

    const room = await readRoomOnce(tablet, roomId);
    expect(room.seating).not.toContain(phones[1]!.device.uid);
    expect(room.members.find((member) => member.uid === phones[1]!.device.uid))
      .toMatchObject({ leftAtRound: 0 });
  });

  it('never reuses a surviving bot id after removing another bot', async () => {
    const world = new MemoryWorld(seededRandom(13));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false, mode: 'practice',
    });
    await tablet.addBot(roomId);
    await tablet.addBot(roomId);
    let players: PlayerView[] = [];
    tablet.watchPlayers(roomId, (next) => { players = next; });
    const original = players.filter((player) => player.isBot).map((player) => player.uid);
    await tablet.removeBot(roomId, original[0]!);
    await tablet.addBot(roomId);

    const ids = players.filter((player) => player.isBot).map((player) => player.uid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(original[1]);
  });
});

describe('starting a game', () => {
  it('is refused to anyone but the referee', async () => {
    const { roomId, phones } = await lobbyOfEight();
    await expect(phones[0]!.device.startGame(roomId, 1)).rejects.toThrow(/referee only/);
  });

  it('gives every seat its own role and nobody else’s', async () => {
    const { world, tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 4242);

    const room = await readRoomOnce(phones[0]!.device, roomId);
    const ordered = room.seating;

    const seen = new Map<string, PrivateView>();
    for (const p of phones) {
      p.device.watchPrivate(roomId, (own) => { seen.set(p.device.uid, own); });
    }

    // Everyone has exactly one role, and it is a real one.
    for (const p of phones) {
      const own = seen.get(p.device.uid)!;
      expect(own.originalRole).toBeTruthy();
      expect(own.privateInfo).toEqual([]);
    }

    // And the private view carries no way to learn anyone else's. Pinned as an
    // exact key list on purpose: a field added here is a field one device can
    // read, so adding one has to be a deliberate act with a test to change.
    const anyOwn = seen.get(phones[0]!.device.uid)!;
    expect(Object.keys(anyOwn).sort())
      .toEqual(['originalRole', 'pending', 'privateInfo']);

    // `pending` is what this seat is being asked. It must never carry another
    // seat's question — that is the whole reason the referee publishes it
    // per-seat rather than broadcasting a list the client filters.
    for (const p of phones) {
      const own = seen.get(p.device.uid)!;
      const seat = ordered.indexOf(p.device.uid);
      for (const request of own.pending) {
        expect(request.seat).toBe(seat);
      }
    }

    // The referee, and only the referee, holds the whole deal.
    const state = await tablet.refereeNightState(roomId);
    expect(state!.seatCount).toBe(NAMES.length);
    await expect(phones[0]!.device.refereeNightState(roomId))
      .rejects.toThrow(/referee only/);
    expect(() => phones[0]!.device.refereeStore(roomId)).toThrow(/referee only/);
  });

  it('freezes the table for the round now running', async () => {
    const { tablet, roomId } = await lobbyOfEight();
    await tablet.startGame(roomId, 1);

    await expect(tablet.setSeating(roomId, ['u:Milan'])).rejects.toThrow(/frozen/);
    await expect(tablet.setActiveRoles(roomId, [], TWO_ROUND_CONFIG)).rejects.toThrow(/frozen/);
    await expect(tablet.startGame(roomId, 2)).rejects.toThrow(/already running/);
  });

  it('requires an explicit setup step between finished rounds', async () => {
    const { tablet, roomId } = await lobbyOfEight();
    await tablet.startGame(roomId, 1);
    await tablet.refereeStore(roomId).setPhase('results');
    await expect(tablet.startGame(roomId, 2)).rejects.toThrow(/already running/);

    await tablet.prepareNextRound(roomId);
    await tablet.startGame(roomId, 2);
    await expect(readRoomOnce(tablet, roomId)).resolves.toMatchObject({
      phase: 'night', round: 2,
    });
  });

  it('reclaims a lobby seat when a second phone joins with the same friend profile', async () => {
    const world = new MemoryWorld(seededRandom(17));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const friend = { friendId: 'friend-milan', friendName: 'Milan' };
    const phoneA = world.device('phone-a');
    const phoneB = world.device('phone-b');
    await phoneA.joinRoom(roomId, 'Milan', friend);
    await phoneB.joinRoom(roomId, 'Milan', friend);

    const room = await readRoomOnce(tablet, roomId);
    expect(room.seating).toEqual(['phone-b']);
    expect(room.members.find((member) => member.uid === 'phone-a')?.leftAtRound).toBe(0);
    expect(room.members.find((member) => member.uid === 'phone-b')).toMatchObject({
      friendId: 'friend-milan', leftAtRound: null,
    });
  });

  it('lets a player repair a duplicate profile from the lobby', async () => {
    const world = new MemoryWorld(seededRandom(18));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const shared = { friendId: 'friend-paul', friendName: 'Paul' };
    const a = world.device('phone-a');
    const b = world.device('phone-b');
    await a.joinRoom(roomId, 'Paul', shared);
    await b.joinRoom(roomId, 'Ivo', { friendId: 'friend-ivo', friendName: 'Ivo' });

    await expect(b.setFriendProfile(roomId, {
      friendId: 'friend-ivo', friendName: 'Ivo',
    })).resolves.toBeUndefined();
    const room = await readRoomOnce(b, roomId);
    expect(room.members.find((member) => member.uid === 'phone-b')).toMatchObject({
      friendId: 'friend-ivo', friendName: 'Ivo',
    });
  });

  it('reclaims a profile when chosen in the lobby by another phone', async () => {
    const world = new MemoryWorld(seededRandom(19));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const a = world.device('phone-a');
    const b = world.device('phone-b');
    await a.joinRoom(roomId, 'Paul', { friendId: 'friend-paul', friendName: 'Paul' });
    await b.joinRoom(roomId, 'Ivo', { friendId: 'friend-ivo', friendName: 'Ivo' });

    await expect(b.setFriendProfile(roomId, {
      friendId: 'friend-paul', friendName: 'Paul',
    })).resolves.toBeUndefined();
    const room = await readRoomOnce(b, roomId);
    expect(room.seating).toEqual(['phone-b']);
    expect(room.members.find((member) => member.uid === 'phone-a')?.leftAtRound).toBe(0);
    expect(room.members.find((member) => member.uid === 'phone-b')).toMatchObject({
      friendId: 'friend-paul', friendName: 'Paul',
    });
  });

  it('lets any lobby member clear a ghost seat', async () => {
    const world = new MemoryWorld(seededRandom(29));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const a = world.device('phone-a');
    const b = world.device('phone-b');
    await a.joinRoom(roomId, 'Paul');
    await b.joinRoom(roomId, 'Ivo');
    await b.removePlayer(roomId, a.uid);
    const room = await readRoomOnce(b, roomId);
    expect(room.seating).toEqual(['phone-b']);
    expect(room.members.find((member) => member.uid === 'phone-a')?.leftAtRound).toBe(0);
  });

  it('reclaims by display name when a typed name minted a forked friend id', async () => {
    const world = new MemoryWorld(seededRandom(31));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const phoneA = world.device('phone-a');
    const phoneB = world.device('phone-b');
    await phoneA.joinRoom(roomId, 'Rieks', { friendId: 'f:old', friendName: 'Rieks' });
    await phoneB.joinRoom(roomId, 'Rieks', { friendId: 'f:new', friendName: 'rieks' });

    const room = await readRoomOnce(tablet, roomId);
    expect(room.seating).toEqual(['phone-b']);
    expect(room.members.find((member) => member.uid === 'phone-a')?.leftAtRound).toBe(0);
  });

  it('createFriend returns the existing profile for the same name', async () => {
    const world = new MemoryWorld(seededRandom(32));
    const device = world.device('phone');
    const first = await device.createFriend('  Rieks ');
    const second = await device.createFriend('rieks');
    expect(second).toEqual(first);
  });

  it('lets a lobby player become a guest without an all-time profile', async () => {
    const world = new MemoryWorld(seededRandom(20));
    const tablet = world.device('tablet');
    const roomId = await tablet.createRoom({
      displayName: 'Tafel', activeRoles: DEFAULT_ACTIVE_ROLES,
      config: TWO_ROUND_CONFIG, playing: false,
    });
    const phone = world.device('phone-guest');
    await phone.joinRoom(roomId, 'Bezoeker', {
      friendId: 'friend-visitor', friendName: 'Bezoeker',
    });
    await phone.setFriendProfile(roomId, { friendId: '', friendName: 'Bezoeker' });

    const room = await readRoomOnce(phone, roomId);
    expect(room.members.find((member) => member.uid === 'phone-guest')).toMatchObject({
      friendId: '', friendName: 'Bezoeker',
    });
  });

  it('refuses to start when the selected deck is not players plus three', async () => {
    const world = new MemoryWorld(seededRandom(21));
    const host = world.device('host');
    const roomId = await host.createRoom({
      displayName: 'Host', activeRoles: ['alphawolf', 'mystiekewolf', 'droomwolf'],
      config: TWO_ROUND_CONFIG, playing: true,
    });
    await world.device('a').joinRoom(roomId, 'A');
    await world.device('b').joinRoom(roomId, 'B');

    await expect(host.startGame(roomId, 1)).rejects.toThrow(/precies 6 kaarten/);
  });

  it('lets a latecomer join mid-round and seats them in the NEXT one', async () => {
    // Milan, 2026-08-26: arriving late must not mean waiting out the evening,
    // and it must not end anybody else's round either.
    const { world, tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 1);

    const late = world.device('u:Laatkomer');
    await expect(late.joinRoom(roomId, 'Laatkomer')).resolves.toBeUndefined();

    let players: PlayerView[] = [];
    phones[0]!.device.watchPlayers(roomId, (p) => { players = p; });
    const row = players.find((p) => p.uid === 'u:Laatkomer')!;

    // Present, but genuinely seatless — not holding a stale seat number.
    expect(row.playing).toBe(false);
    expect(row.seatIndex).toBeNull();
    // ...and the round in progress is untouched.
    const room = await readRoomOnce(phones[0]!.device, roomId);
    expect(room.seating).not.toContain('u:Laatkomer');
    expect(room.seating).toHaveLength(NAMES.length);
  });

  it('publishes a timeline built from the public role list alone', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 1);

    let room: RoomView | null = null;
    phones[0]!.device.watchRoom(roomId, (r) => { room = r; });
    expect(room!.timeline).not.toBeNull();
    expect(room!.phase).toBe('night');
    // The timeline is public and must stay derivable from activeRoles — if it
    // ever varied with the deal it would be a map of who is playing what.
    expect(JSON.stringify(room!.timeline)).not.toContain('originalRole');
  });
});

describe('night submissions', () => {
  it('accepts a write for the current window and rejects a stale one', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 9);
    const player = phones[0]!.device;

    await expect(player.submit(roomId, 0, { pick: { kind: 'seat', seat: 3 } }))
      .resolves.toBeUndefined();

    // The referee advances the window; the old one is now closed. This is what
    // stops a late write after seeing a reveal, without trusting any clock.
    await tablet.refereeStore(roomId).setWindowIndex(1);
    await expect(player.submit(roomId, 0, { pick: { kind: 'seat', seat: 4 } }))
      .rejects.toThrow(/window closed/);
    await expect(player.submit(roomId, 1, { pick: { kind: 'seat', seat: 4 } }))
      .resolves.toBeUndefined();
  });

  it('files a submission under the seat of the device that wrote it', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 9);
    await phones[0]!.device.submit(roomId, 0, { pick: { kind: 'seat', seat: 5 } });

    const store = tablet.refereeStore(roomId);
    const subs = await store.readSubmissions(0);
    // Seat 0 is the first phone — the tablet is the referee and takes no seat.
    expect([...subs.keys()]).toEqual([0]);
  });

  it('restores the submitted decision keys after a refresh', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 9);
    const player = phones[0]!.device;
    await player.submit(roomId, 0, {
      first: { kind: 'seat', seat: 3 }, second: { kind: 'none' },
    });

    await expect(player.submittedKeys(roomId, 1, 0))
      .resolves.toEqual(['first', 'second']);
    await expect(player.submittedKeys(roomId, 2, 0)).resolves.toEqual([]);
  });
});

describe('voting', () => {
  it('accepts an abstain during the discussion but not a named target', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    await tablet.refereeStore(roomId).setPhase('day');

    // §7 as revised 2026-08-26: the group may decide not to vote at ANY moment.
    await expect(phones[0]!.device.vote(roomId, null, true)).resolves.toBeUndefined();
    // But nobody may lock a target in early — that would quietly turn a
    // simultaneous vote into a first-mover one.
    await expect(phones[0]!.device.vote(roomId, 'u:Sanne', false))
      .rejects.toThrow(/cannot vote in phase day/);

    await tablet.refereeStore(roomId).setPhase('voting');
    await expect(phones[0]!.device.vote(roomId, 'u:Sanne', false)).resolves.toBeUndefined();
  });

  it('refuses a self-vote in every phase', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    await tablet.refereeStore(roomId).setPhase('voting');
    await expect(phones[0]!.device.vote(roomId, 'u:Milan', false))
      .rejects.toThrow(/no self-votes/);
  });

  it('publishes counts to the table, never who voted for whom', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    const store = tablet.refereeStore(roomId);
    await store.setPhase('voting');

    await phones[0]!.device.vote(roomId, 'u:Sanne', false);
    await phones[1]!.device.vote(roomId, 'u:Joris', false);
    await store.readVotes();

    let room: RoomView | null = null;
    phones[2]!.device.watchRoom(roomId, (r) => { room = r; });
    expect(room!.votesCast).toBe(2);
    expect(room!.abstainCount).toBe(0);
    // The seating order is public — who voted for whom is not. Everything the
    // room view says about the vote is COUNTS, and nothing else.
    const voteFields = Object.entries(room!)
      .filter(([k]) => /vote|abstain|target/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    expect(voteFields.map(([k]) => k))
      .toEqual(['abstainCount', 'earlyVoteCount', 'votesCast']);

    // The property, stated directly rather than implied by that list: every
    // one of them is a number. A field here that held seats or uids would be
    // a public record of who did what, whatever it was called.
    for (const [key, value] of voteFields) {
      expect(typeof value, `${key} must be a count`).toBe('number');
    }
  });

  it('makes a named vote final', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    await tablet.refereeStore(roomId).setPhase('voting');
    await phones[0]!.device.vote(roomId, 'u:Sanne', false);
    await expect(phones[0]!.device.vote(roomId, 'u:Joris', false))
      .rejects.toThrow(/final/);
  });

  it('restores this device’s final vote after a refresh', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    await tablet.refereeStore(roomId).setPhase('voting');
    await phones[0]!.device.vote(roomId, 'u:Sanne', false);

    await expect(phones[0]!.device.ownVote(roomId)).resolves.toEqual({
      round: 1, target: 'u:Sanne', abstain: false, readyToVote: false,
    });
  });

  it('lets the referee replace a missing vote, but never an existing one', async () => {
    const { tablet, roomId, phones } = await lobbyOfEight();
    await tablet.startGame(roomId, 3);
    await tablet.refereeStore(roomId).setPhase('voting');

    await expect(tablet.emergencyVote(roomId, 'u:Milan', 'u:Sanne', 'wrong'))
      .rejects.toThrow(/takeover/);
    await expect(tablet.emergencyVote(roomId, 'u:Milan', 'u:Sanne', 'takeover'))
      .resolves.toBeUndefined();
    await expect(tablet.emergencyVote(roomId, 'u:Milan', 'u:Joris', 'takeover'))
      .rejects.toThrow(/final/);
    await expect(phones[1]!.device.emergencyVote(
      roomId, 'u:Joris', 'u:Sanne', 'takeover',
    )).rejects.toThrow(/referee/);
  });
});

describe('watchers', () => {
  it('pushes an update to every device when the room changes', async () => {
    const { world, tablet, roomId } = await lobbyOfEight();
    const phases: string[] = [];
    world.device('u:Noor').watchRoom(roomId, (r) => { if (r) phases.push(r.phase); });

    await tablet.startGame(roomId, 5);
    await tablet.refereeStore(roomId).setPhase('day');

    expect(phases).toEqual(['lobby', 'night', 'day']);
  });

  it('stops pushing after unsubscribe', async () => {
    const { world, tablet, roomId } = await lobbyOfEight();
    let count = 0;
    const off = world.device('u:Noor').watchRoom(roomId, () => { count++; });
    const afterFirst = count;
    off();
    await tablet.startGame(roomId, 5);
    expect(count).toBe(afterFirst);
  });
});
