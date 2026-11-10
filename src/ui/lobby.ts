import type { RoleId, SeatIndex } from '../engine/types.js';
import { ROLES } from '../engine/roles.js';
import { roleName, t, type Lang } from './i18n.js';

/**
 * Seating arrangement (§13).
 *
 * This is FUNCTIONALLY REQUIRED, not decoration: the Dorpsgek shifts every
 * card one seat left or right, which is meaningless without a real, agreed
 * adjacency. If the on-screen ring doesn't match where people are actually
 * sitting, that role stops making sense at the table.
 *
 * Interaction is tap-A-then-tap-B to swap two seats, rather than drag. Dragging
 * a small target around a circle on a phone, at a table, with eight people
 * waiting, is exactly the kind of fiddly the concept doc worried about (§15).
 * Two taps is unambiguous, works with cold fingers, and is trivially undoable.
 */

export interface LobbyPlayer {
  uid: string;
  displayName: string;
  seatIndex: SeatIndex;
  /** Soft presence; used to flag likely ghost seats from dead tabs. */
  lastSeen?: number;
  /** An AI player. Labelled on the ring, because a seat that is not a person
   * has to be legible from across the table. */
  isBot?: boolean;
}

/** A seat with no heartbeat for this long is probably a closed test tab. */
export const STALE_PRESENCE_MS = 90_000;

export function isStalePresence(lastSeen: number | undefined, now = Date.now()): boolean {
  if (lastSeen === undefined) return false;
  return now - lastSeen > STALE_PRESENCE_MS;
}

export interface LobbyView {
  lang: Lang;
  players: LobbyPlayer[];
  /** Everyone present may agree and arrange the physical order before a deal. */
  canArrange: boolean;
  /** First tap of a pending swap, if any. */
  pendingSwap: SeatIndex | null;
  onSeatTap?: (seat: SeatIndex) => void;
  onStart?: () => void;
  canStart: boolean;
  /**
   * Whether this browser may change the AI roster.
   *
   * True only on the browser that resolves the room, only in a practice
   * lobby. It is not a mode and not a role — it is one browser, and the
   * security rules refuse every other one. Everybody else sees the bots on
   * the ring, labelled, with no buttons.
   */
  canManageBots?: boolean;
  onAddBot?: () => void;
  onRemoveBot?: (uid: string) => void;
  canManagePlayers?: boolean;
  onRemovePlayer?: (uid: string) => void;
  activeRoles?: RoleId[];
  canManageRoles?: boolean;
  onRolesChange?: (roles: RoleId[]) => void;
}

export function renderLobby(view: LobbyView): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lobby';

  const hint = document.createElement('p');
  hint.className = 'sheet__sub';
  hint.textContent = view.canArrange
    ? view.pendingSwap === null
      ? t(view.lang, 'lobby.arrange')
      : t(view.lang, 'lobby.swap')
    : t(view.lang, 'lobby.locked');
  el.append(hint);

  const ring = document.createElement('div');
  ring.className = 'table';

  const ringLine = document.createElement('div');
  ringLine.className = 'table__ring';
  ring.append(ringLine);

  const seated = [...view.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const n = Math.max(seated.length, 1);

  seated.forEach((p, i) => {
    const angle = Math.PI / 2 + (i / n) * Math.PI * 2;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seat';
    if (view.pendingSwap === p.seatIndex) btn.classList.add('seat--selected');
    if (!view.canArrange) btn.classList.add('seat--disabled');
    btn.style.left = `${50 + Math.cos(angle) * 39}%`;
    btn.style.top = `${50 + Math.sin(angle) * 39}%`;

    const card = document.createElement('div');
    card.className = 'seat__card';
    const num = document.createElement('span');
    num.className = 'seat__role';
    num.textContent = String(i + 1);
    card.append(num);

    const name = document.createElement('span');
    name.className = 'seat__name';
    name.textContent = p.displayName;
    if (p.isBot) {
      btn.dataset.bot = 'true';
      // On the seat itself, not only in the list below: this is the label
      // somebody reads while deciding whether to believe what that seat said.
      const tag = document.createElement('span');
      tag.className = 'seat__role';
      tag.textContent = t(view.lang, 'lobby.botTag');
      card.append(tag);
    }

    btn.append(card, name);
    btn.addEventListener('click', () => view.onSeatTap?.(p.seatIndex));
    ring.append(btn);
  });

  el.append(ring);

  el.append(rolePicker(view, seated.length));

  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'btn btn--primary';
  start.textContent = t(view.lang, 'lobby.start', { n: seated.length });
  start.disabled = !view.canStart;
  start.addEventListener('click', () => view.onStart?.());
  el.append(start);

  if (view.canManageBots) el.append(botRoster(view, seated));
  if (view.canManagePlayers) el.append(playerRoster(view, seated));

  const note = document.createElement('p');
  note.className = 'sheet__note';
  note.textContent = t(view.lang, 'lobby.adjacency');
  el.append(note);

  return el;
}

function playerRoster(view: LobbyView, seated: LobbyPlayer[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'lobby__bots';
  const title = document.createElement('p');
  title.className = 'sheet__sub';
  title.textContent = t(view.lang, 'lobby.playersTitle');
  box.append(title);
  for (const player of seated.filter((entry) => !entry.isBot)) {
    const row = document.createElement('div');
    row.className = 'rolerow';
    const name = document.createElement('span');
    name.className = 'rolerow__name';
    name.textContent = isStalePresence(player.lastSeen)
      ? t(view.lang, 'lobby.stalePlayer', { name: player.displayName })
      : player.displayName;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = t(view.lang, 'lobby.removePlayer');
    remove.addEventListener('click', () => view.onRemovePlayer?.(player.uid));
    row.append(name, remove);
    box.append(row);
  }
  return box;
}

function rolePicker(view: LobbyView, playerCount: number): HTMLElement {
  const box = document.createElement('section');
  box.className = 'lobby__roles';
  box.dataset.rolePicker = 'true';

  const roles = view.activeRoles ?? [];
  const needed = playerCount + 3;
  const selected = roles.length;
  const title = document.createElement('h2');
  title.className = 'setup__title';
  title.textContent = t(view.lang, 'lobby.rolesTitle');

  const status = document.createElement('p');
  status.className = selected === needed ? 'rolecount rolecount--ready' : 'rolecount';
  status.textContent = selected === needed
    ? t(view.lang, 'lobby.rolesReady', { selected, players: playerCount })
    : selected < needed
      ? t(view.lang, 'lobby.rolesMissing', { n: needed - selected, selected, needed })
      : t(view.lang, 'lobby.rolesExtra', { n: selected - needed, selected, needed });
  box.append(title, status);

  const grid = document.createElement('div');
  grid.className = 'rolepicker';
  const ordered = Object.values(ROLES).sort((a, b) => a.defaultOrder - b.defaultOrder);
  // The plain Werewolf is retained only for reading old practice records. New
  // games use the three named wolf variants, including on the Alpha Wolf spot.
  for (const role of ordered.filter(
    (entry) => entry.id !== 'dorpeling' && entry.id !== 'weerwolf',
  )) {
    const chosen = roles.includes(role.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = chosen ? 'rolepicker__role rolepicker__role--selected' : 'rolepicker__role';
    toggle.textContent = roleName(view.lang, role.id);
    toggle.setAttribute('aria-pressed', String(chosen));
    toggle.disabled = view.canManageRoles !== true;
    toggle.addEventListener('click', () => {
      view.onRolesChange?.(chosen
        ? roles.filter((entry) => entry !== role.id)
        : [...roles, role.id]);
    });
    grid.append(toggle);
  }
  box.append(grid);

  const villagers = roles.filter((role) => role === 'dorpeling').length;
  const villagerRow = document.createElement('div');
  villagerRow.className = 'rolepicker__villagers';
  const label = document.createElement('span');
  label.textContent = `${roleName(view.lang, 'dorpeling')} × ${villagers}`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn';
  remove.textContent = '−';
  remove.disabled = view.canManageRoles !== true || villagers === 0;
  remove.addEventListener('click', () => {
    const next = [...roles];
    next.splice(next.lastIndexOf('dorpeling'), 1);
    view.onRolesChange?.(next);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn';
  add.textContent = '+';
  add.disabled = view.canManageRoles !== true;
  add.addEventListener('click', () => view.onRolesChange?.([...roles, 'dorpeling']));
  villagerRow.append(label, remove, add);
  box.append(villagerRow);
  return box;
}

/**
 * Add and remove AI players, one at a time.
 *
 * One at a time on purpose. The path this replaces was a single "play solo
 * with seven AI players" button, which could not do the thing a playtest
 * actually needs: three friends and four bots, or five and one. The count is
 * the thing being chosen, so it is chosen one tap at a time.
 */
function botRoster(view: LobbyView, seated: LobbyPlayer[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'lobby__bots';
  box.dataset.bots = 'true';

  const title = document.createElement('p');
  title.className = 'sheet__sub';
  title.textContent = t(view.lang, 'lobby.botsTitle');
  box.append(title);

  for (const bot of seated.filter((p) => p.isBot)) {
    const row = document.createElement('div');
    row.className = 'rolerow';

    const name = document.createElement('span');
    name.className = 'rolerow__name';
    name.textContent = bot.displayName;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.dataset.removeBot = bot.uid;
    remove.textContent = t(view.lang, 'lobby.removeBot');
    remove.addEventListener('click', () => view.onRemoveBot?.(bot.uid));

    row.append(name, remove);
    box.append(row);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn';
  add.dataset.addBot = 'true';
  add.textContent = t(view.lang, 'lobby.addBot');
  // The same twelve as for people. A table is a table.
  add.disabled = seated.length >= 12;
  add.addEventListener('click', () => view.onAddBot?.());
  box.append(add);

  const note = document.createElement('p');
  note.className = 'sheet__note';
  note.textContent = t(view.lang, 'lobby.botsNote');
  box.append(note);

  return box;
}

/** Swap two players' seats. Pure, so the caller can undo by calling it again. */
export function swapSeats(
  players: LobbyPlayer[],
  a: SeatIndex,
  b: SeatIndex,
): LobbyPlayer[] {
  return players.map((p) => {
    if (p.seatIndex === a) return { ...p, seatIndex: b };
    if (p.seatIndex === b) return { ...p, seatIndex: a };
    return p;
  });
}

/**
 * Seat numbers must be a contiguous 0..n-1 with no gaps or duplicates, or the
 * Dorpsgek's rotation has holes in it. Called before the game can start.
 */
export function seatingIsValid(players: LobbyPlayer[]): boolean {
  const seats = players.map((p) => p.seatIndex).sort((x, y) => x - y);
  return seats.every((s, i) => s === i);
}
