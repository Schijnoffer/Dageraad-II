import { describe, expect, it } from 'vitest';
import {
  assertFriendProfileAvailable, assertUniqueFriendProfiles, occupiedFriendSeat,
} from './friendseat.js';
import type { SessionMember } from './session.js';

function member(
  uid: string,
  friendId: string,
  friendName = friendId,
  leftAtRound: number | null = null,
): SessionMember {
  return { uid, joinedAtRound: 1, leftAtRound, friendId, friendName };
}

describe('occupiedFriendSeat', () => {
  it('finds another active seated holder of the same friend id', () => {
    const members = [member('a', 'f:1', 'Rieks'), member('b', 'f:2', 'Sanne')];
    expect(occupiedFriendSeat(members, ['a', 'b'], 'b', {
      friendId: 'f:1', friendName: 'Rieks',
    })).toEqual({
      uid: 'a', friendId: 'f:1', friendName: 'Rieks',
    });
  });

  it('matches a forked profile by normalised display name', () => {
    // Typing "rieks" again used to mint f:new while f:old still held the seat.
    const members = [member('a', 'f:old', 'Rieks'), member('b', 'f:new', 'rieks')];
    expect(occupiedFriendSeat(members, ['a'], 'b', {
      friendId: 'f:new', friendName: 'rieks',
    })).toEqual({
      uid: 'a', friendId: 'f:old', friendName: 'Rieks',
    });
  });

  it('ignores guests, departed seats and your own uid', () => {
    const members = [
      member('a', '', 'Gast'),
      member('b', 'f:1', 'Rieks', 0),
      member('c', 'f:1', 'Rieks'),
    ];
    expect(occupiedFriendSeat(members, ['a', 'b', 'c'], 'c', {
      friendId: 'f:1', friendName: 'Rieks',
    })).toBeNull();
    expect(occupiedFriendSeat(members, ['a', 'c'], 'c', {
      friendId: 'f:1', friendName: 'Rieks',
    })).toBeNull();
    expect(occupiedFriendSeat(members, ['c'], 'c', {
      friendId: '', friendName: 'Gast',
    })).toBeNull();
  });
});

describe('assertUniqueFriendProfiles', () => {
  it('rejects two seated copies of one friend id', () => {
    expect(() => assertUniqueFriendProfiles(
      [member('a', 'f:1', 'Rieks'), member('b', 'f:1', 'Rieks')],
      ['a', 'b'],
    )).toThrow(/wordt al gebruikt/);
  });

  it('rejects two different ids that share a display name', () => {
    expect(() => assertUniqueFriendProfiles(
      [member('a', 'f:1', 'Rieks'), member('b', 'f:2', 'rieks')],
      ['a', 'b'],
    )).toThrow(/wordt al gebruikt/);
  });

  it('allows the same label once the old seat has left', () => {
    expect(() => assertUniqueFriendProfiles(
      [member('a', 'f:1', 'Rieks', 0), member('b', 'f:1', 'Rieks')],
      ['b'],
    )).not.toThrow();
  });
});

describe('assertFriendProfileAvailable', () => {
  it('throws when another active seat already holds the label', () => {
    expect(() => assertFriendProfileAvailable(
      [member('a', 'f:1', 'Rieks')], ['a'], 'b', 'f:1', 'Rieks',
    )).toThrow(/wordt al gebruikt/);
  });
});
