import type { AppState } from '../app/controller.js';
import {
  canDeal, canPrepareNextRound, mayManageBots, nextRoundRoster, type Screen,
} from '../app/shell.js';
import { mayArrangeSeats } from '../app/seating.js';
import type { PlayerView, RoomView } from '../app/backend.js';
import type { RoleId, SeatIndex } from '../engine/types.js';
import { assertSpoilerFree, renderTablet, type TabletSeat, type TabletView } from './tablet.js';
import { renderTable } from './table.js';
import { renderLobby, type LobbyPlayer } from './lobby.js';
import { renderRoomSetup, type ControllerMode } from './setup.js';
import { renderDeparted, renderJoin, renderWaiting } from './join.js';
import { seatViews } from './seats.js';
import { t, type Lang } from './i18n.js';
import type { SuspicionMap } from './suspicionpicker.js';

/**
 * One device's whole screen, chosen from state it does not own.
 *
 * The routing decision already happened (shell.ts) and the privacy decision
 * already happened (seats.ts); this file is the join between them and the
 * renderers. Keeping it that thin is the point — anything that decides
 * something here is something two screens can disagree about.
 */

export interface AppDeps {
  lang: Lang;
  state: AppState;
  screen: Screen;
  /** Local, per-device UI state that no backend should ever hold. */
  mode: ControllerMode;
  code: string;
  displayName: string;
  error?: string | null;
  busy?: boolean;
  suspicions?: SuspicionMap;
  selected?: SeatIndex | null;
  prompting?: boolean;
  /** Legal targets for this device's current private prompt. */
  legalTargetSeats?: SeatIndex[];
  timer?: string | null;
  actions: AppActions;
}

export interface AppActions {
  onModeChange(mode: ControllerMode): void;
  onCreate(mode: ControllerMode): void;
  onCodeChange(code: string): void;
  onNameChange(name: string): void;
  onJoin(code: string, displayName: string): void;
  onBack(): void;
  onLeave(): void;
  onRejoin(): void;
  onDeal(): void;
  onPrepareNextRound?(): void;
  onSeatTap(seat: SeatIndex): void;
  onCardTap(seat: SeatIndex): void;
  onNameTap(seat: SeatIndex): void;
  onAddBot?(): void;
  onRemoveBot?(uid: string): void;
  onRemovePlayer?(uid: string): void;
  onRolesChange?(roles: RoleId[]): void;
}

export function renderApp(deps: AppDeps): HTMLElement {
  const { screen } = deps;
  switch (screen.kind) {
    case 'setup':
      return renderRoomSetup({
        lang: deps.lang,
        mode: deps.mode,
        canCreate: deps.busy !== true,
        onModeChange: deps.actions.onModeChange,
        onCreate: deps.actions.onCreate,
      });

    case 'join':
      return renderJoin({
        lang: deps.lang,
        code: deps.code,
        displayName: deps.displayName,
        error: deps.error,
        busy: deps.busy,
        onCodeChange: deps.actions.onCodeChange,
        onNameChange: deps.actions.onNameChange,
        onJoin: deps.actions.onJoin,
        onBack: deps.actions.onBack,
      });

    case 'waiting':
      return renderWaiting({
        lang: deps.lang,
        joinsAtRound: screen.joinsAtRound,
        onLeave: deps.actions.onLeave,
      });

    case 'departed':
      return renderDeparted({ lang: deps.lang, onRejoin: deps.actions.onRejoin });

    case 'tablet':
      return renderTablet(tabletViewFor(deps), canPrepareNextRound(deps.state.room!, deps.state.uid)
        && deps.actions.onPrepareNextRound
        ? { onNextRound: deps.actions.onPrepareNextRound }
        : undefined);

    case 'lobby':
      return renderLobbyScreen(deps);

    case 'table':
    case 'results':
      return renderTableScreen(deps);
  }
}

/* ------------------------------- the table ------------------------------- */

function renderTableScreen(deps: AppDeps): HTMLElement {
  const room = deps.state.room!;
  const wrap = document.createElement('div');
  wrap.className = 'tablewrap';
  wrap.append(renderTable({
    lang: deps.lang,
    seats: seatViews({
      room,
      players: deps.state.players,
      uid: deps.state.uid,
      ownRole: deps.state.own.originalRole,
      suspicions: deps.suspicions,
      selected: deps.selected,
      prompting: deps.prompting,
      legalTargetSeats: deps.legalTargetSeats,
    }),
    centerCount: 3,
    // Public information: the host picked the roles and everyone saw them.
    hasAlphaWolfCard: room.activeRoles.includes('alphawolf'),
    onCardTap: deps.actions.onCardTap,
    onNameTap: deps.actions.onNameTap,
  }));
  return wrap;
}

/* ------------------------------- the lobby ------------------------------- */

function renderLobbyScreen(deps: AppDeps): HTMLElement {
  const room = deps.state.room!;
  const roster = nextRoundRoster(room, deps.state.players);

  // The lobby arranges who is ABOUT to play, so it is built from the next
  // round's roster rather than the current seating — otherwise somebody who
  // arrived a minute ago is invisible on the screen where seats are agreed.
  const players: LobbyPlayer[] = roster.map((p, i) => ({
    uid: p.uid,
    displayName: p.displayName,
    seatIndex: i as SeatIndex,
    ...(p.isBot ? { isBot: true } : {}),
  }));

  return renderLobby({
    lang: deps.lang,
    players,
    // Everyone PRESENT can agree the physical order before the first deal —
    // at a real table the person who moved the chairs is the one who knows.
    // Not merely anyone rendering this screen: a departed member is not there
    // to move a chair, and the rules refuse their write anyway.
    canArrange: mayArrangeSeats(room, deps.state.uid) || room.refereeUid === deps.state.uid,
    pendingSwap: deps.selected ?? null,
    canStart: canDeal(room, deps.state.uid)
      && players.length >= 3
      && room.activeRoles.length === players.length + 3,
    onSeatTap: deps.actions.onSeatTap,
    onStart: deps.actions.onDeal,
    canManageBots: mayManageBots(room, deps.state.uid),
    ...(deps.actions.onAddBot ? { onAddBot: deps.actions.onAddBot } : {}),
    ...(deps.actions.onRemoveBot ? { onRemoveBot: deps.actions.onRemoveBot } : {}),
    // Any active lobby member may clear a ghost seat (another phone left over
    // from testing). Mid-round removals stay host/referee-only in the backend.
    canManagePlayers: room.phase === 'lobby'
      && (room.hostUid === deps.state.uid
        || room.refereeUid === deps.state.uid
        || room.members.some((member) => member.uid === deps.state.uid
          && member.leftAtRound === null)),
    ...(deps.actions.onRemovePlayer ? { onRemovePlayer: deps.actions.onRemovePlayer } : {}),
    activeRoles: room.activeRoles,
    canManageRoles: deps.busy !== true && room.phase === 'lobby'
      && (room.hostUid === deps.state.uid || room.refereeUid === deps.state.uid),
    ...(deps.actions.onRolesChange ? { onRolesChange: deps.actions.onRolesChange } : {}),
  });
}

/* ------------------------------ the tablet ------------------------------- */

/**
 * The neutral shared display.
 *
 * Built from the PUBLIC room document only — never from this device's private
 * view, even though the table device happens to be the referee and has one.
 * `assertSpoilerFree` re-checks that at runtime rather than trusting this
 * function to have stayed honest, because the tablet is the one screen the
 * whole table can read at once (§12).
 */
export function tabletViewFor(deps: AppDeps): TabletView {
  const room = deps.state.room!;
  const nameByUid = new Map(deps.state.players.map((p) => [p.uid, p.displayName]));

  const seats: TabletSeat[] = room.seating.map((uid, seat) => {
    const view: TabletSeat = {
      seat,
      displayName: nameByUid.get(uid) ?? uid,
      shielded: room.shieldedSeats.includes(seat),
    };
    // Only a card genuinely turned face up in play. The results screen is the
    // deliberate place that final roles become visible; painting them onto the
    // neutral board would make a private-looking screen suddenly spoil them.
    const revealed = room.revealedSlots[seat];
    if (revealed) view.revealedRole = revealed;
    return view;
  });

  const view: TabletView = {
    lang: deps.lang,
    phase: room.phase,
    activeRole: activeRoleFor(room),
    roundLabel: room.round > 0 ? t(deps.lang, 'phase.round', { n: room.round }) : null,
    timer: deps.timer ?? null,
    paused: room.pausedAt !== null,
    seats,
    centerCount: 3,
    hasAlphaWolfCard: room.activeRoles.includes('alphawolf'),
  };

  // Belt and braces. If a field is ever added to TabletSeat that is not
  // public, this throws here rather than showing it to eight people.
  assertSpoilerFree(view);
  return view;
}

/**
 * Whose window is open, from the PUBLIC timeline.
 *
 * The timeline is derived from the active role list alone and never from the
 * deal (see timeline.ts), which is exactly why publishing it leaks nothing:
 * it says a Ziener window is open, not that anybody is the Ziener.
 */
function activeRoleFor(room: RoomView): RoleId | null {
  if (room.phase !== 'night' || !room.timeline) return null;
  // Phases, not a flat step list: the timeline interleaves the open window
  // (role null, everybody at once) with per-role follow-ups.
  const phase = room.timeline.phases?.[room.nightWindowIndex];
  return phase?.role ?? null;
}

/** Everyone in the room, for a screen that lists people rather than seats. */
export function roster(room: RoomView, players: PlayerView[]): PlayerView[] {
  return nextRoundRoster(room, players);
}
