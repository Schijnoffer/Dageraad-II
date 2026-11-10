import { describe, expect, it } from 'vitest';
import {
  findByName, nameKey, newFriendId, normaliseName, resolveFriendForName,
  sortedProfiles, type FriendProfile,
} from './friend.js';

/**
 * The identity that has to survive a new phone.
 *
 * Everything here exists to stop one specific silent failure: somebody's
 * history forking in two without anybody noticing, because they typed their
 * name slightly differently or turned up on a borrowed handset.
 */

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const profile = (id: string, displayName: string): FriendProfile =>
  ({ id, displayName, createdAt: 0 });

describe('a friend id', () => {
  it('is not derived from the name', () => {
    // Two people called Sanne are two people; one person who renames is one
    // person. Deriving the id from the name gets both wrong.
    const a = newFriendId(seeded(1));
    const b = newFriendId(seeded(2));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^f:[a-z0-9]{10}$/);
  });

  it('does not collide across a plausible number of friends', () => {
    const random = seeded(42);
    const ids = new Set(Array.from({ length: 500 }, () => newFriendId(random)));
    expect(ids.size).toBe(500);
  });
});

describe('matching somebody to a profile they already have', () => {
  const profiles = [profile('f:1', 'Milan'), profile('f:2', 'Sanne')];

  it('finds them however they capitalise it', () => {
    expect(findByName(profiles, 'milan')?.id).toBe('f:1');
    expect(findByName(profiles, 'MILAN')?.id).toBe('f:1');
  });

  it('finds them through stray whitespace', () => {
    // A trailing space from a phone keyboard must not fork a history.
    expect(findByName(profiles, '  Milan ')?.id).toBe('f:1');
    expect(findByName(profiles, 'Mi  lan')).toBeNull();  // that IS a different name
  });

  it('says nothing matched rather than guessing', () => {
    expect(findByName(profiles, 'Joris')).toBeNull();
    expect(findByName(profiles, '')).toBeNull();
    expect(findByName(profiles, '   ')).toBeNull();
  });

  it('reuses an existing profile instead of creating a fork', () => {
    expect(resolveFriendForName(profiles, '  MILAN ')).toEqual({
      kind: 'existing', profile: profiles[0],
    });
    expect(resolveFriendForName(profiles, 'Joris')).toEqual({
      kind: 'new', displayName: 'Joris',
    });
    expect(resolveFriendForName(profiles, '   ')).toBeNull();
  });
});

describe('tidying a name without changing who it is', () => {
  it('collapses whitespace but keeps the case people chose', () => {
    expect(normaliseName('  Sanne   B  ')).toBe('Sanne B');
    expect(normaliseName('MILAN')).toBe('MILAN');
  });

  it('compares case-insensitively', () => {
    expect(nameKey(' Sanne B ')).toBe(nameKey('sanne b'));
  });
});

describe('the picker list', () => {
  it('is alphabetical, so a name is always in the same place', () => {
    // Somebody scanning for their own name at a noisy table should not have to
    // read the whole list twice.
    const rows = sortedProfiles([
      profile('f:3', 'Joris'), profile('f:1', 'milan'), profile('f:2', 'Eva'),
    ]);
    expect(rows.map((p) => p.displayName)).toEqual(['Eva', 'Joris', 'milan']);
  });

  it('does not mutate what it was given', () => {
    const original = [profile('f:2', 'Zoe'), profile('f:1', 'Ann')];
    sortedProfiles(original);
    expect(original.map((p) => p.id)).toEqual(['f:2', 'f:1']);
  });
});
