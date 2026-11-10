import { nameKey } from './friend.js';
import type { SessionMember } from './session.js';

/**
 * One friend profile, one seat.
 *
 * A friendId is a label for all-time history, not a login. Still, two phones
 * claiming the same label in one lobby is almost always "I tested on the other
 * device and now I am here" — not two people who both want to be Milan. The
 * join path reclaims the old seat rather than leaving a silent duplicate that
 * only fails when somebody tries to deal.
 *
 * Matching is by friendId first, then by normalised friendName: typing the
 * same name used to mint a fresh friendId and leave the old seat in place.
 */

export interface OccupiedFriendSeat {
  uid: string;
  friendId: string;
  friendName?: string;
}

export interface FriendSeatClaim {
  friendId: string;
  friendName?: string;
}

/** Active seated member holding this friend label, if any, excluding `ownUid`. */
export function occupiedFriendSeat(
  members: SessionMember[],
  seating: string[],
  ownUid: string,
  claim: FriendSeatClaim | string,
): OccupiedFriendSeat | null {
  const friendId = typeof claim === 'string' ? claim : claim.friendId;
  const friendName = typeof claim === 'string' ? undefined : claim.friendName;
  if (!friendId && !friendName) return null;
  const seated = new Set(seating);

  if (friendId) {
    const byId = members.find((member) => member.uid !== ownUid
      && seated.has(member.uid)
      && member.leftAtRound === null
      && member.friendId === friendId);
    if (byId?.friendId) {
      return {
        uid: byId.uid,
        friendId: byId.friendId,
        ...(byId.friendName ? { friendName: byId.friendName } : {}),
      };
    }
  }

  const key = nameKey(friendName ?? '');
  if (!key) return null;
  const byName = members.find((member) => member.uid !== ownUid
    && seated.has(member.uid)
    && member.leftAtRound === null
    && !!member.friendId
    && nameKey(member.friendName ?? '') === key);
  if (!byName?.friendId) return null;
  return {
    uid: byName.uid,
    friendId: byName.friendId,
    ...(byName.friendName ? { friendName: byName.friendName } : {}),
  };
}

export function assertUniqueFriendProfiles(
  members: SessionMember[],
  seating: string[],
): void {
  const byUid = new Map(members.map((member) => [member.uid, member]));
  const seenIds = new Map<string, SessionMember>();
  const seenNames = new Map<string, SessionMember>();
  for (const uid of seating) {
    const member = byUid.get(uid);
    if (!member?.friendId) continue;
    if (seenIds.has(member.friendId)) {
      throw duplicateFriendProfileError(member.friendName);
    }
    seenIds.set(member.friendId, member);
    const key = nameKey(member.friendName ?? '');
    if (key) {
      if (seenNames.has(key)) throw duplicateFriendProfileError(member.friendName);
      seenNames.set(key, member);
    }
  }
}

export function assertFriendProfileAvailable(
  members: SessionMember[],
  seating: string[],
  ownUid: string,
  friendId: string,
  friendName?: string,
): void {
  const occupied = occupiedFriendSeat(members, seating, ownUid, { friendId, friendName });
  if (occupied) throw duplicateFriendProfileError(occupied.friendName);
}

export function duplicateFriendProfileError(name?: string): Error {
  const profile = name ? ` \u201c${name}\u201d` : '';
  return new Error(
    `Profiel${profile} wordt al gebruikt op een ander apparaat in deze kamer. `
    + 'Verwijder onder Spelers beheren het oude apparaat, of kies via Menu > '
    + 'Profielen voor Eenmalig spelen (geen statistieken).',
  );
}
