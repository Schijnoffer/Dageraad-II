import { describe, expect, it } from 'vitest';
import {
  assertFriendProfileAvailable, assertUniqueFriendProfiles, occupiedFriendSeat,
} from './friendseat.js';
import type { SessionMember } from './session.js';

function member(
  uid: string,
  friendId: string,
  leftAtRound: number | null = null,
): SessionMember {
  return { uid, joinedAtRound: 1, leftAtRound, friendId, friendName: friendId };
}

describe('occupiedFriendSeat', () => {
  it('finds another active seated holder of the same friend id', () => {
    const members = [member('a', 'f:1'), member('b', 'f:2')];
    expect(occupiedFriendSeat(members, ['a', 'b'], 'b', 'f:1')).toEqual({
      uid: 'a', friendId: 'f:1', friendName: 'f:1',
    });
  });

  it('ignores guests, departed seats and your own uid', () => {
    const members = [
      member('a', ''),
      member('b', 'f:1', 0),
      member('c', 'f:1'),
    ];
    expect(occupiedFriendSeat(members, ['a', 'b', 'c'], 'c', 'f:1')).toBeNull();
    expect(occupiedFriendSeat(members, ['a', 'c'], 'c', 'f:1')).toBeNull();
    expect(occupiedFriendSeat(members, ['c'], 'c', '')).toBeNull();
  });
});

describe('assertUniqueFriendProfiles', () => {
  it('rejects two seated copies of one friend id', () => {
    expect(() => assertUniqueFriendProfiles(
      [member('a', 'f:1'), member('b', 'f:1')],
      ['a', 'b'],
    )).toThrow(/wordt al gebruikt/);
  });

  it('allows the same label once the old seat has left', () => {
    expect(() => assertUniqueFriendProfiles(
      [member('a', 'f:1', 0), member('b', 'f:1')],
      ['b'],
    )).not.toThrow();
  });
});

describe('assertFriendProfileAvailable', () => {
  it('throws when another active seat already holds the label', () => {
    expect(() => assertFriendProfileAvailable(
      [member('a', 'f:1')], ['a'], 'b', 'f:1',
    )).toThrow(/wordt al gebruikt/);
  });
});
