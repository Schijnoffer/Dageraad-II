/**
 * Who somebody is, across evenings.
 *
 * Firebase anonymous auth gives each browser a uid. That is the right
 * identity for one evening — it is what every security rule keys off, and it
 * is what stops one player writing another's card. It is the WRONG identity
 * for a year of history: clear your browser, play on a borrowed phone, or
 * reinstall, and you are a stranger to your own record.
 *
 * So there is a second identity that is deliberately weaker and deliberately
 * durable: a friend profile the player picks from a list, or creates once.
 * No account, no password — this is eight people who know each other, and the
 * threat model has never been somebody impersonating a friend to inflate a
 * board game scoreboard. What it buys is that history survives a new phone.
 *
 * The two are kept strictly apart. The uid stays the security identity and is
 * what the rules check. The friendId is a LABEL carried alongside, used only
 * for grouping history. Nothing is authorised because of it.
 */

export interface FriendProfile {
  /** Stable forever. Generated once, never derived from the name. */
  id: string;
  /** What they are called now. Changing it does not change who they are. */
  displayName: string;
  createdAt: number;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new friend id.
 *
 * Random rather than derived from the name, because a name is not an identity:
 * two people called Sanne are two people, and one person who renames is still
 * one person. Deriving from the name would get both cases wrong.
 */
export function newFriendId(random: () => number = Math.random): string {
  let tail = '';
  for (let i = 0; i < 10; i++) {
    tail += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return `f:${tail}`;
}

/** Names are compared for duplicates case- and space-insensitively. */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function nameKey(name: string): string {
  return normaliseName(name).toLowerCase();
}

/**
 * Pick an existing friend by name, or say that a new one is needed.
 *
 * Offered as a LIST first and a text field second, on purpose: somebody typing
 * their own name from scratch every evening will eventually mistype it, and a
 * mistyped name with a fresh id is a silently forked history. Matching an
 * existing profile is the common path and should be the easy one.
 */
export function findByName(
  profiles: FriendProfile[],
  name: string,
): FriendProfile | null {
  const key = nameKey(name);
  if (!key) return null;
  return profiles.find((p) => nameKey(p.displayName) === key) ?? null;
}

/**
 * Prefer an existing profile over creating a fork.
 *
 * Typing "Rieks" again after testing must return the SAME friendId. A second
 * id with the same display name silently splits all-time history and also
 * bypasses lobby seat reclaim (which keys off friendId).
 */
export function resolveFriendForName(
  profiles: FriendProfile[],
  name: string,
): { kind: 'existing'; profile: FriendProfile } | { kind: 'new'; displayName: string } | null {
  const displayName = normaliseName(name);
  if (!displayName) return null;
  const existing = findByName(profiles, displayName);
  if (existing) return { kind: 'existing', profile: existing };
  return { kind: 'new', displayName };
}

/** Profiles for a picker: alphabetical, so the same name is in the same place. */
export function sortedProfiles(profiles: FriendProfile[]): FriendProfile[] {
  return [...profiles].sort((a, b) =>
    normaliseName(a.displayName).localeCompare(normaliseName(b.displayName)));
}

const STORAGE_KEY = 'dageraad.friendId';

/**
 * The friend this browser used last time.
 *
 * Remembered so the common case is one tap, not a decision. Losing it costs
 * nothing — you pick your name from the list again, and it is the SAME profile
 * because the list is shared, which is the entire difference between this and
 * keying history off the uid.
 */
export function rememberedFriendId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberFriendId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing. They pick from the list next time.
  }
}
