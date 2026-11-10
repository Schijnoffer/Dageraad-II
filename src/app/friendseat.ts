import type { SessionMember } from './session.js';

/**
 * One friend profile, one seat.
 *
 * A friendId is a label for all-time history, not a login. Still, two phones
 * claiming the same label in one lobby is almost always "I tested on the other
 * device and now I am here" — not two people who both want to be Milan. The
 * join path reclaims the old seat rather than leaving a silent duplicate that
 * only fails when somebody tries to deal.
 */

export interface OccupiedFriendSeat {
  uid: string;
  friendId: string;
  friendName?: string;
}

/** Active seated member holding `friendId`, if any, excluding `ownUid`. */
export function occupiedFriendSeat(
  members: SessionMember[],
  seating: string[],
  ownUid: string,
  friendId: string,
): OccupiedFriendSeat | null {
  if (!friendId) return null;
  const seated = new Set(seating);
  const hit = members.find((member) => member.uid !== ownUid
    && seated.has(member.uid)
    && member.leftAtRound === null
    && member.friendId === friendId);
  if (!hit || !hit.friendId) return null;
  return {
    uid: hit.uid,
    friendId: hit.friendId,
    ...(hit.friendName ? { friendName: hit.friendName } : {}),
  };
}

export function assertUniqueFriendProfiles(
  members: SessionMember[],
  seating: string[],
): void {
  const byUid = new Map(members.map((member) => [member.uid, member]));
  const seen = new Map<string, SessionMember>();
  for (const uid of seating) {
    const member = byUid.get(uid);
    const friendId = member?.friendId;
    if (!friendId) continue;
    if (seen.has(friendId)) throw duplicateFriendProfileError(member?.friendName);
    seen.set(friendId, member!);
  }
}

export function assertFriendProfileAvailable(
  members: SessionMember[],
  seating: string[],
  ownUid: string,
  friendId: string,
): void {
  const occupied = occupiedFriendSeat(members, seating, ownUid, friendId);
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
