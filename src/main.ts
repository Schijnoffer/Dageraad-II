import { connect } from './firestore/client.js';
import { firebaseConfig } from './firebase/config.js';
import { FirestoreBackend } from './firestore/backend.js';
import { botSeatsFor, demoTable, seatDemoBots, type DemoTable } from './app/demoworld.js';
import { AppController } from './app/controller.js';
import { homeUrl, roomCodeFromUrl, roomUrl } from './app/roomlink.js';
import { rememberedRoom, rememberRoom } from './app/recentroom.js';
import { renderApp, type AppActions } from './ui/app.js';
import { renderRecovery } from './ui/recovery.js';
import {
  renderAllTime, renderFriendPicker, renderModePicker, renderRoomStatusBadge,
} from './ui/alltime.js';
import { allTimeStandings, type HistoryRecord } from './stats/alltime.js';
import {
  rememberFriendId, rememberedFriendId, type FriendProfile,
} from './app/friend.js';
import {
  renderDiscussionTimer, renderRoomSetup, renderResolutionPicker,
  controllerModeIsPlaying, type ControllerMode,
} from './ui/setup.js';
import {
  nextPendingRequest, renderPrompt, seatSelectable, toggleCenterPick,
} from './ui/prompt.js';
import { describeReveal, renderSheet } from './ui/sheet.js';
import { renderVoting } from './ui/voting.js';
import { renderResults } from './ui/results.js';
import { aggregate as aggregatePlayerHistory, renderStats } from './ui/stats.js';
import { readRoomOnce, runGame, type BotSeats } from './app/refereeRunner.js';
import { randomBot } from './engine/bot.js';
import { detectLang, roleName, setLang, t, type Lang } from './ui/i18n.js';
import {
  DEFAULT_ACTIVE_ROLES, DEPENDENCY_CONFIG, TWO_ROUND_CONFIG,
} from './engine/presets.js';
import { mayArrangeSeats, reorderForSwap } from './app/seating.js';
import { canPrepareNextRound } from './app/shell.js';
import {
  MAX_DISCUSSION_MS, MIN_DISCUSSION_MS, type Backend, type RoomMode,
} from './app/backend.js';
import type { Choice, ResolutionMode, RoleId, SeatIndex } from './engine/types.js';
import { PausableClock, SystemClock } from './orchestration/clock.js';

/**
 * The app.
 *
 * This was a demo harness with invented data until now — three surfaces you
 * could look at and argue about, wired to nothing. Everything it rendered is
 * still here; what changed is that the data underneath it is a real room that
 * other people are also in.
 *
 * The shape is deliberately dull: one controller owning the subscriptions
 * (controller.ts), one pure function deciding which screen this device is on
 * (shell.ts), one that decides what it may draw (seats.ts), and one that turns
 * that into elements (ui/app.ts). This file owns only what is genuinely local
 * to one device and one browser tab: which language, what is typed into a
 * field, whether a sheet is open. None of that belongs in a database.
 */

/* ----------------------------- local state ------------------------------ */

interface Local {
  lang: Lang;
  mode: ControllerMode;
  code: string;
  displayName: string;
  error: string | null;
  busy: boolean;
  menuOpen: boolean;
  emergencyMenuOpen: boolean;
  emergencyVoteOpen: boolean;
  emergencyTyped: string;
  emergencyVoter: string;
  emergencyTarget: string;
  recovering: boolean;
  recoveryTyped: string;
  shareCopied: boolean;
  /** First tap of a pending seat swap, in the lobby. */
  pendingSwap: SeatIndex | null;
  /** Seats picked for the night prompt currently open. */
  picked: SeatIndex[];
  pickedCenters: number[];
  /** Day phase: who this device is voting for, and whether it is abstaining. */
  voteTarget: SeatIndex | null;
  abstaining: boolean;
  /** "Let us vote now." A decision about the clock, not the outcome. */
  readyToVote: boolean;
  votePanelOpen: boolean;
  finalVoteRound: number | null;
  /** Private result messages acknowledged in the current round. */
  acknowledgedPrivateInfo: number;
  privateInfoRound: number | null;
  /** True once this device has run the round it is refereeing. */
  refereeRunning: boolean;
  /** Referee tab is in the background — night/day will stall. */
  refereeBackground: boolean;
  /** Prevent a failed recovery from retrying on every live snapshot. */
  resumeAttemptedRound: number | null;
  /** Which human this device is, across evenings. Null until picked. */
  friend: FriendProfile | null;
  identityKind: 'unselected' | 'profile' | 'guest';
  friends: FriendProfile[];
  friendTyped: string;
  /** Whether the room this device is about to create will count. */
  roomMode: RoomMode;
  resolutionMode: ResolutionMode;
  discussionMinutes: string;
  history: HistoryRecord[];
  showAllTime: boolean;
  showProfiles: boolean;
  /** Answers submitted locally in the currently open night window. */
  submittedDecisionKeys: string[];
  decisionWindow: string | null;
  statsSeat: SeatIndex | null;
  interactionContext: string | null;
  decisionSyncMarker: string | null;
  decisionSyncLoading: boolean;
  voteSyncMarker: string | null;
  /** Opens the ballot once on the transition to voting, but still permits collapse. */
  observedVotingRound: string | null;
}

const local: Local = {
  lang: detectLang(),
  mode: 'table-device',
  code: roomCodeFromUrl(location.href) ?? '',
  displayName: rememberedName(),
  error: null,
  busy: false,
  menuOpen: false,
  emergencyMenuOpen: false,
  emergencyVoteOpen: false,
  emergencyTyped: '',
  emergencyVoter: '',
  emergencyTarget: '',
  recovering: false,
  recoveryTyped: '',
  shareCopied: false,
  pendingSwap: null,
  picked: [],
  pickedCenters: [],
  voteTarget: null,
  abstaining: false,
  readyToVote: false,
  votePanelOpen: false,
  finalVoteRound: null,
  acknowledgedPrivateInfo: 0,
  privateInfoRound: null,
  refereeRunning: false,
  refereeBackground: false,
  resumeAttemptedRound: null,
  friend: null,
  identityKind: 'unselected',
  friends: [],
  friendTyped: '',
  // Practice unless somebody deliberately says otherwise. A test evening in
  // append-only history cannot be taken back out.
  roomMode: 'practice',
  resolutionMode: 'tworound',
  discussionMinutes: '15',
  history: [],
  showAllTime: false,
  showProfiles: false,
  submittedDecisionKeys: [],
  decisionWindow: null,
  statsSeat: null,
  interactionContext: null,
  decisionSyncMarker: null,
  decisionSyncLoading: false,
  voteSyncMarker: null,
  observedVotingRound: null,
};

const NAME_KEY = 'dageraad.name';

/** Your name, so a reload does not ask again. Losing it costs nothing (§14). */
function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private browsing. The field just starts empty next time.
  }
}

/* ------------------------------- start-up ------------------------------- */

let controller: AppController;
let backend: Backend;

/**
 * Which backend.
 *
 * `?demo` runs the whole app against the in-memory world, in one tab, with no
 * Firebase project — the same implementation every test uses. It exists so the
 * screens can be walked through offline, and so a broken Firebase config is
 * never the reason nobody can look at the app.
 */
let demo: DemoTable | null = null;

/** True when the URL asks for a walkthrough rather than a real evening. */
function isFast(): boolean {
  return new URLSearchParams(location.search).has('fast');
}

/**
 * Which resolution mode a new room uses.
 *
 * `?mode=dependency` picks the longer variant where everyone acts live and
 * waits for each other; the default is the two-round one the group plays. A
 * URL flag rather than a setup screen for now — the host picking this is a
 * real feature and this is the walkthrough hook for it.
 */
function configFromSetup() {
  return local.resolutionMode === 'dependency' ? DEPENDENCY_CONFIG : TWO_ROUND_CONFIG;
}

/**
 * The deal seed, when one was asked for.
 *
 * `?seed=N` makes a round reproducible, which is what lets a specific
 * situation be walked through deliberately rather than waited for. The engine
 * shuffle has always been seeded; this just stops the seed being random.
 */
function seedFromUrl(): number {
  const asked = new URLSearchParams(location.search).get('seed');
  const parsed = asked === null ? Number.NaN : Number(asked);
  return Number.isFinite(parsed) ? parsed : Math.floor(Math.random() * 1e9);
}

/**
 * `?fast` shortens the whole round so the flow can be walked in seconds.
 *
 * BOTH halves, which is the bit that is easy to get wrong: shortening only the
 * night leaves a fifteen-minute discussion and a ten-minute vote wait, so the
 * round appears to hang somewhere after the last window. A real evening uses
 * the real numbers — a night window is as long as it is because people need
 * that long to decide (§5.3), and the discussion is the game.
 */
function fastDurations(): { openWindowMs: number; resolvePadMs: number;
  followupMs: Record<string, number>; defaultFollowupMs: number } | undefined {
  if (!isFast()) return undefined;
  return { openWindowMs: 400, resolvePadMs: 100, followupMs: {}, defaultFollowupMs: 400 };
}

function fastDayConfig(): { discussionMs: number; voteWaitTimeoutMs: number;
  abstainPollMs: number } | undefined {
  if (!isFast()) return undefined;
  return { discussionMs: 800, voteWaitTimeoutMs: 4_000, abstainPollMs: 100 };
}

async function makeBackend(): Promise<Backend> {
  if (new URLSearchParams(location.search).has('demo')) {
    demo = demoTable(Math.random);
    // A solo walk-through needs this browser to receive a seat alongside the
    // bots. The normal table-device default would create only a neutral board.
    local.mode = 'trusted-host';
    return demo.me;
  }
  const connection = await connect(firebaseConfig);
  return new FirestoreBackend(connection.db, connection.uid, reportListenerError);
}

function firebaseFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  return code === 'permission-denied' || code === 'firestore/permission-denied'
    ? t(local.lang, 'firebase.permissionDenied')
    : String(error);
}

/** Strip the `Error:` prefix browsers put on thrown messages. */
function cleanError(error: unknown): string {
  return firebaseFailure(error).replace(/^Error:\s*/i, '');
}

/**
 * Join failures used to all become "kamer bestaat niet", which hid the real
 * cause on a second phone (permission denied, referee seat, network, …).
 */
function joinFailureMessage(error: unknown): string {
  const mapped = firebaseFailure(error);
  if (mapped !== String(error)) return mapped;
  const raw = cleanError(error);
  if (/no room/i.test(raw)) return t(local.lang, 'join.noSuchRoom');
  if (/referee is not a player/i.test(raw)) return t(local.lang, 'join.refereeCannotPlay');
  return raw;
}

function reportListenerError(error: unknown): void {
  local.error = firebaseFailure(error);
  render();
}

async function start(): Promise<void> {
  const app = document.getElementById('app')!;
  try {
    backend = await makeBackend();
  } catch (err) {
    // Anonymous auth disabled in the console is the overwhelmingly likely
    // cause, and it looks like a broken app rather than a missing setting
    // unless somebody says so (SETUP.md §10.3).
    app.replaceChildren(fatal(String(err)));
    return;
  }

  controller = new AppController(backend);
  controller.onChange((state) => {
    if (state.roomId && state.room?.phase === 'voting') {
      const votingRound = `${state.roomId}:${state.room.round}`;
      if (local.observedVotingRound !== votingRound) {
        local.observedVotingRound = votingRound;
        local.votePanelOpen = true;
      }
    }
    syncInteractionContext(state);
    void syncPersistedActions();
    render();
    void maybeResumeReferee();
  });
  window.setInterval(refreshDiscussionTimer, 250);
  document.addEventListener('visibilitychange', onRefereeVisibility);

  // The group, rather than one evening: both span every room, so both are
  // watched for as long as the app is open.
  backend.watchFriends((friends) => {
    local.friends = friends;
    const remembered = rememberedFriendId();
    if (local.identityKind === 'unselected' && remembered) {
      local.friend = friends.find((f) => f.id === remembered) ?? null;
      if (local.friend) local.identityKind = 'profile';
    }
    render();
  });
  backend.watchHistory((history) => {
    local.history = history;
    render();
  });

  // Arriving on a shared link goes straight to joining that room, with the
  // code already filled in. One link in a group chat is the whole
  // distribution story.
  if (local.code) controller.setJoining(true);

  render();
}

async function syncPersistedActions(): Promise<void> {
  const state = controller.current();
  const room = state.room;
  if (!state.roomId || !room) return;

  if (room.phase === 'night') {
    const marker = `${state.roomId}:${room.round}:${room.nightWindowIndex}`;
    if (local.decisionSyncMarker !== marker) {
      local.decisionSyncMarker = marker;
      local.decisionSyncLoading = true;
      try {
        const keys = await backend.submittedKeys(
          state.roomId,
          room.round,
          room.nightWindowIndex,
        );
        if (local.decisionSyncMarker === marker) local.submittedDecisionKeys = keys;
      } catch (error) {
        if (local.decisionSyncMarker === marker) local.decisionSyncMarker = null;
        reportListenerError(error);
      } finally {
        if (local.decisionSyncMarker === marker) local.decisionSyncLoading = false;
        render();
      }
    }
  }

  if (room.phase === 'day' || room.phase === 'voting') {
    const marker = `${state.roomId}:${room.round}`;
    if (local.voteSyncMarker !== marker) {
      local.voteSyncMarker = marker;
      try {
        const saved = await backend.ownVote(state.roomId);
        if (local.voteSyncMarker !== marker || saved?.round !== room.round) return;
        local.abstaining = saved.abstain;
        local.readyToVote = saved.readyToVote;
        if (saved.target !== null) {
          const seat = room.seating.indexOf(saved.target);
          local.voteTarget = seat < 0 ? null : seat as SeatIndex;
          local.finalVoteRound = room.round;
        }
      } catch (error) {
        if (local.voteSyncMarker === marker) local.voteSyncMarker = null;
        reportListenerError(error);
      } finally {
        render();
      }
    }
  }
}

function fatal(message: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'join';
  const p = document.createElement('p');
  p.className = 'join__error';
  p.setAttribute('role', 'alert');
  p.textContent = message;
  el.append(p);
  return el;
}

/* -------------------------------- actions ------------------------------- */

/** Run a backend call, showing failures rather than swallowing them. */
async function attempt(fn: () => Promise<void>, onFail?: string): Promise<boolean> {
  local.busy = true;
  local.error = null;
  render();
  try {
    await fn();
    return true;
  } catch (err) {
    const mapped = firebaseFailure(err);
    local.error = mapped === String(err) && onFail ? onFail : cleanError(err);
    return false;
  } finally {
    local.busy = false;
    render();
  }
}

const actions: AppActions = {
  onModeChange(mode) {
    local.mode = mode;
    render();
  },

  async onCreate(mode) {
    const discussionMs = discussionMsFromInput(local.discussionMinutes);
    if (discussionMs === null) {
      local.error = t(local.lang, 'timer.invalid');
      render();
      return;
    }
    local.mode = mode;
    const name = local.displayName.trim() || defaultName(mode);
    await attempt(async () => {
      const roomId = await backend.createRoom({
        displayName: name,
        activeRoles: DEFAULT_ACTIVE_ROLES,
        config: configFromSetup(),
        // The single point where the player-facing choice becomes technical:
        // a table device must not be dealt a card, because it can read them
        // all (see ui/setup.ts).
        playing: controllerModeIsPlaying(mode),
        mode: local.roomMode,
        discussionMs,
        ...(local.friend
          ? { friend: { friendId: local.friend.id, friendName: local.friend.displayName } }
          : {}),
      });
      local.code = roomId;
      rememberRoom(roomId);
      // In demo mode the rest of the table sits down immediately, so one tab
      // has enough people to deal a round.
      if (demo) await seatDemoBots(demo, roomId);
      history.replaceState(null, '', roomUrl(location.href, roomId));
      controller.watch(roomId);
    });
  },

  onCodeChange(code) {
    local.code = code;
    local.error = null;
  },

  onNameChange(name) {
    local.displayName = name;
  },

  async onJoin(code, displayName) {
    rememberName(displayName);
    local.displayName = displayName;
    local.busy = true;
    local.error = null;
    render();
    try {
      await backend.joinRoom(code, displayName, local.friend
        ? { friendId: local.friend.id, friendName: local.friend.displayName }
        : undefined);
    } catch (err) {
      local.error = joinFailureMessage(err);
      return;
    } finally {
      local.busy = false;
      render();
    }
    rememberRoom(code);
    history.replaceState(null, '', roomUrl(location.href, code));
    controller.watch(code);
  },

  onBack() {
    controller.reset();
    controller.setJoining(false);
    local.error = null;
    render();
  },

  async onLeave() {
    const roomId = controller.current().roomId;
    if (!roomId) return;
    await attempt(() => backend.leaveRoom(roomId));
  },

  async onRejoin() {
    const roomId = controller.current().roomId;
    if (!roomId) return;
    await attempt(() => backend.joinRoom(roomId, local.displayName || 'Speler'));
  },

  /**
   * Deal, then actually run the round.
   *
   * Two calls rather than one, and the split matters: the deal is a single
   * write that either happened or did not, and `runGame` is a long loop that
   * sleeps out every window. Only the referee device does either — the button
   * is not rendered anywhere else, and both the backend and the rules refuse
   * it regardless.
   */
  async onDeal() {
    const roomId = controller.current().roomId;
    if (!roomId || local.refereeRunning) return;
    // A fresh seed per round, so two rounds of one evening are not the same
    // deal. The engine's shuffle is seeded so a round stays replayable.
    const dealSeed = seedFromUrl();
    local.refereeRunning = true;
    render();
    try {
      const dealt = await attempt(() => backend.startGame(roomId, dealSeed));
      if (!dealt) return;
      await runRefereeRound(roomId, dealSeed);
    } catch (err) {
      local.error = String(err);
    } finally {
      local.refereeRunning = false;
      render();
    }
  },

  async onPrepareNextRound() {
    const roomId = controller.current().roomId;
    if (!roomId) return;
    await attempt(() => backend.prepareNextRound(roomId));
  },

  /**
   * Lobby seat swapping: tap one seat, then another.
   *
   * ALL present players may rearrange before a round starts (Milan,
   * 2026-08-26) — at a real table the person who moved chairs is the one who
   * knows, and it is not worth routing that through whoever happens to be
   * host. The order locks the moment play begins, because the Dorpsgek's shift
   * depends on a stable adjacency (§13), and the rules enforce that lock.
   */
  onSeatTap(seat) {
    const state = controller.current();
    const room = state.room;
    // Guarded here as well as in the rules: every present member may arrange,
    // and nobody may once play has begun.
    if (!room || (!mayArrangeSeats(room, state.uid) && room.refereeUid !== state.uid)) return;

    if (local.pendingSwap === null) {
      local.pendingSwap = seat;
      render();
      return;
    }
    const first = local.pendingSwap;
    local.pendingSwap = null;
    if (first === seat) {
      render();
      return;
    }

    const order = reorderForSwap(room, state.players, first, seat);

    const roomId = state.roomId;
    if (!roomId) return;
    void attempt(() => backend.setSeating(roomId, order));
  },

  /**
   * Tapping a card.
   *
   * During a night prompt this is picking a target, and that has to win over
   * everything else — a player with a question open is answering it. Outside a
   * prompt, the day phase uses the same gesture to choose who to vote for.
   */
  onCardTap(seat) {
    const state = controller.current();
    const request = firstPending();

    if (request && seatSelectable(request, seat)) {
      if (request.prompt.kind === 'seat-or-center') local.pickedCenters = [];
      const already = local.picked.indexOf(seat);
      if (already >= 0) local.picked.splice(already, 1);
      else if (request.prompt.kind === 'two-seats') {
        // Two seats and no more: a third tap replaces the older pick rather
        // than silently doing nothing, which reads as a broken screen.
        local.picked = [...local.picked, seat].slice(-2);
      } else {
        local.picked = [seat];
      }
      render();
      return;
    }

    const room = state.room;
    if (!room) return;
    if (room.phase === 'voting' && local.votePanelOpen
      && local.finalVoteRound !== room.round) {
      // §7: never yourself. The rules reject it too, but a screen that lets
      // you tap it and then fails is a screen that lied.
      const ownSeat = room.seating.indexOf(state.uid);
      if (seat === ownSeat) return;
      local.voteTarget = local.voteTarget === seat ? null : seat;
      render();
    }
  },

  onNameTap(seat) {
    local.statsSeat = seat;
    render();
  },

  /**
   * Add one AI player to a practice lobby.
   *
   * One tap, one bot, so a table can be any mix of people and machines. The
   * button is only rendered on the browser that resolves the room, in a
   * practice lobby, and every one of those conditions is re-checked by the
   * backend and again by the security rules — this handler is the convenience,
   * not the protection.
   */
  onAddBot() {
    const roomId = controller.current().roomId;
    if (!roomId) return;
    void attempt(() => backend.addBot(roomId));
  },

  onRemoveBot(uid: string) {
    const roomId = controller.current().roomId;
    if (!roomId) return;
    void attempt(() => backend.removeBot(roomId, uid));
  },

  onRemovePlayer(uid: string) {
    const state = controller.current();
    if (!state.roomId) return;
    const name = state.players.find((player) => player.uid === uid)?.displayName ?? uid;
    const message = local.lang === 'nl'
      ? `${name} uit deze sessie laten vertrekken?`
      : `Mark ${name} as having left this session?`;
    if (!window.confirm(message)) return;
    void attempt(() => backend.removePlayer(state.roomId!, uid));
  },

  onRolesChange(roles: RoleId[]) {
    const state = controller.current();
    if (!state.roomId || !state.room) return;
    void attempt(() => backend.setActiveRoles(state.roomId!, roles, state.room!.config));
  },
};

async function runRefereeRound(roomId: string, seed: number): Promise<void> {
  const room = await readRoomOnce(backend, roomId);
  const bots = demo
    ? botSeatsFor(demo, room.seating, seed ^ 0x51f15e)
    : botSeats(await backend.refereeBotSeats(roomId), seed ^ 0x51f15e);
  const durations = fastDurations();
  const dayConfig = fastDayConfig();
  const clock = new PausableClock(new SystemClock());
  const stopPause = backend.watchRoom(roomId, (liveRoom) => {
    if (liveRoom?.pausedAt === null) clock.resume();
    else if (liveRoom?.pausedAt != null) clock.pause();
  });
  try {
    await runGame({
      backend,
      roomId,
      clock,
      onPhase: () => render(),
      onWindowOpen: () => render(),
      ...(durations ? { durations } : {}),
      ...(dayConfig ? { dayConfig } : {}),
      ...(bots ? { bots } : {}),
    });
  } finally {
    stopPause();
  }
}

/** A refreshed or replacement controller resumes the active round once. */
async function maybeResumeReferee(): Promise<void> {
  const state = controller.current();
  const room = state.room;
  if (!state.roomId || !room || !['night', 'day', 'voting'].includes(room.phase)
    || room.refereeUid !== state.uid || local.refereeRunning
    || local.resumeAttemptedRound === room.round) return;

  local.resumeAttemptedRound = room.round;
  local.refereeRunning = true;
  render();
  try {
    await runRefereeRound(state.roomId, room.round ^ 0x4f1bbcdc);
  } catch (err) {
    local.error = cleanError(err);
  } finally {
    local.refereeRunning = false;
    render();
  }
}

/**
 * The referee browser IS the clock. Phone sleep / tab switch stalls the night
 * for everyone — say so loudly while it is happening, not only in PLAYTEST.md.
 */
function onRefereeVisibility(): void {
  const state = controller.current();
  const room = state.room;
  const isReferee = !!room && room.refereeUid === state.uid;
  const live = !!room && ['night', 'day', 'voting'].includes(room.phase);
  const hidden = document.visibilityState === 'hidden';
  const next = isReferee && live && hidden;
  if (next === local.refereeBackground) return;
  local.refereeBackground = next;
  if (!hidden) render();
  else render();
}

/** Return this browser to the start screen without removing it from the room. */
function returnHome(): void {
  controller.reset();
  local.code = '';
  local.menuOpen = false;
    local.showAllTime = false;
    local.showProfiles = false;
  local.recovering = false;
  local.error = null;
  history.replaceState(null, '', homeUrl(location.href));
  render();
}

/**
 * Open a practice room this browser plays in and controls.
 *
 * This replaces a button that said "play solo with 7 AI players" and meant it
 * literally: seven bots, no way to seat a friend beside them, and a night
 * window of 400ms because the same flag that summoned the bots also
 * fast-forwarded the clock. Four hundred milliseconds is not a decision, it is
 * a flicker — which is why the Doppelganger's copied-role prompt was never
 * answerable by the person holding the phone.
 *
 * So: a real room, in practice mode, at the timings a person can actually use.
 * The AI players are added one at a time in the lobby, beside however many
 * friends are in the room. Nothing about this path is a special mode — it is
 * the ordinary room, opened with the two choices already made.
 */
function defaultName(mode: ControllerMode): string {
  return mode === 'table-device' ? 'Tafel' : 'Speler';
}

/** Real Firebase bots have no login; the referee uses the narrow bot methods. */
function botSeats(botSeatList: SeatIndex[], seed: number): BotSeats | undefined {
  const seats = new Set(botSeatList);
  return seats.size === 0 ? undefined : { seats, bot: randomBot(seed) };
}

/* -------------------------------- render -------------------------------- */

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.replaceChildren();

  const state = controller.current();
  syncInteractionContext(state);
  const screen = controller.screen();
  const pendingPrompt = firstPending();

  if (demo) {
    const banner = document.createElement('p');
    banner.className = 'join__error';
    banner.setAttribute('role', 'status');
    banner.textContent = t(local.lang, 'demo.banner');
    app.append(banner);
  }
  if (local.refereeBackground) {
    const warn = document.createElement('p');
    warn.className = 'join__error';
    warn.setAttribute('role', 'alert');
    warn.textContent = t(local.lang, 'referee.background');
    app.append(warn);
  }

  // Creating a room is the one screen that needs a name before it exists, so
  // it gets its own path rather than being squeezed into renderApp's setup.
  if (screen.kind === 'setup') {
    // Who you are comes first. Everything after it is about this evening; this
    // is the one question whose answer outlives it.
    if (local.identityKind === 'unselected' && !demo) {
      app.append(friendPicker());
      app.append(joinExistingButton());
      app.append(bottomBar(false));
      if (local.error) app.append(fatal(local.error));
      return;
    }

    app.append(renderModePicker({
      lang: local.lang,
      mode: local.roomMode,
      onModeChange: (mode) => {
        local.roomMode = mode;
        render();
      },
    }));
    const recent = rememberedRoom();
    if (recent) {
      const reopen = button(t(local.lang, 'home.returnToRoom', { code: recent }), () => {
        local.code = recent;
        local.error = null;
        // A new phone is not yet a member: watching alone is not enough.
        controller.setJoining(true);
        history.replaceState(null, '', roomUrl(location.href, recent));
        controller.watch(recent);
      });
      reopen.classList.add('btn--secondary');
      app.append(reopen);
      const reopenNote = document.createElement('p');
      reopenNote.className = 'sheet__sub';
      reopenNote.textContent = t(local.lang, 'home.returnToRoomNote');
      app.append(reopenNote);
    }
    app.append(renderResolutionPicker({
      lang: local.lang,
      mode: local.resolutionMode,
      onModeChange: (mode) => {
        local.resolutionMode = mode;
        render();
      },
    }));
    app.append(renderDiscussionTimer({
      lang: local.lang,
      minutes: local.discussionMinutes,
      onMinutesChange: (minutes) => {
        local.discussionMinutes = minutes;
        local.error = null;
      },
    }));
    app.append(nameField(), renderRoomSetup({
      lang: local.lang,
      mode: local.mode,
      canCreate: !local.busy,
      onModeChange: actions.onModeChange,
      onCreate: actions.onCreate,
    }));
    app.append(joinExistingButton());
    app.append(bottomBar(false));
    if (local.error) app.append(fatal(local.error));
    return;
  }

  // A shared-link visitor chooses who they are before joining. Without this,
  // joining from the link skipped the profile picker entirely and the round
  // could never be attributed to the friend in all-time history.
  if (screen.kind === 'join' && local.identityKind === 'unselected' && !demo) {
    app.append(friendPicker(), bottomBar(false));
    if (local.error) app.append(fatal(local.error));
    return;
  }

  app.append(renderApp({
    lang: local.lang,
    state,
    screen,
    mode: local.mode,
    code: local.code,
    displayName: local.displayName,
    error: local.error,
    busy: local.busy,
    // The table stays interactive underneath a decision sheet. Reflect the
    // first live card pick there, otherwise a successful tap looks ignored.
    selected: pendingPrompt && local.picked.length === 1
      ? local.picked[0]
      : state.room?.phase === 'voting' && local.votePanelOpen
        ? local.voteTarget
        : local.pendingSwap,
    prompting: pendingPrompt !== undefined,
    legalTargetSeats: pendingPrompt
      ? state.room?.seating
        .map((_, seat) => seat as SeatIndex)
        .filter((seat) => seatSelectable(pendingPrompt, seat))
      : undefined,
    timer: state.room ? discussionTimerText(state.room) : null,
    actions,
  }));

  // A practice evening says so the whole time it is being played, not
  // afterwards. Above everything, so it is not something you scroll to.
  if (state.room) {
    const practiceVote = practiceVoteShortcut();
    if (practiceVote) app.prepend(practiceVote);
    app.prepend(renderRoomStatusBadge(local.lang, state.room.mode, state.room.config.mode));
    app.prepend(gameProgress());
  }

  if (state.room && local.votePanelOpen
    && (state.room.phase === 'day' || state.room.phase === 'voting')) {
    const ownSeat = state.room.seating.indexOf(state.uid);
    if (ownSeat >= 0) app.append(votePanel(ownSeat as SeatIndex));
  }

  if (state.roomId) app.append(bottomBar(true));
  if (local.error) app.append(inRoomError(local.error));
  if (local.showAllTime) app.append(allTimeSheet());
  if (local.showProfiles) app.append(profileSheet());
  if (local.statsSeat !== null) app.append(playerStatsSheet(local.statsSeat));

  // Drawn OVER the table, never instead of it (§13.1): from across the room,
  // deciding and idly browsing have to look the same.
  const overlay = tableOverlay();
  if (overlay) app.append(overlay);

  if (local.menuOpen) app.append(menu());
  if (local.emergencyMenuOpen) app.append(emergencyMenu());
  if (local.emergencyVoteOpen) app.append(emergencyVoteSheet());
  if (local.recovering) app.append(recoverySheet());
}

function syncInteractionContext(state: ReturnType<AppController['current']>): void {
  const context = state.roomId && state.room ? `${state.roomId}:${state.room.round}` : null;
  if (context === local.interactionContext) return;
  local.interactionContext = context;
  local.pendingSwap = null;
  local.picked = [];
  local.pickedCenters = [];
  local.voteTarget = null;
  local.abstaining = false;
  local.readyToVote = false;
  local.votePanelOpen = false;
  local.finalVoteRound = null;
  local.acknowledgedPrivateInfo = 0;
  local.privateInfoRound = state.room?.round ?? null;
  local.submittedDecisionKeys = [];
  local.decisionWindow = null;
  local.decisionSyncMarker = null;
  local.decisionSyncLoading = false;
  local.voteSyncMarker = null;
  local.statsSeat = null;
}

function inRoomError(message: string): HTMLElement {
  const alert = document.createElement('div');
  alert.className = 'app-error';
  alert.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = message;
  const close = button('×', () => {
    local.error = null;
    render();
  });
  close.setAttribute('aria-label', t(local.lang, 'action.close'));
  alert.append(text, close);
  return alert;
}

function nameField(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'join';
  const field = document.createElement('input');
  field.className = 'join__name';
  field.type = 'text';
  field.maxLength = 24;
  field.value = local.displayName;
  field.placeholder = t(local.lang, 'join.namePlaceholder');
  field.setAttribute('aria-label', t(local.lang, 'join.name'));
  field.addEventListener('input', () => {
    local.displayName = field.value;
    rememberName(field.value);
  });
  wrap.append(field);
  return wrap;
}

function bottomBar(inRoom: boolean): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'bottombar';

  if (inRoom) {
    const menuButton = button(t(local.lang, 'menu.title'), () => {
      local.menuOpen = true;
      render();
    });
    menuButton.classList.add('bottombar__menu');
    bar.append(menuButton);

    const room = controller.current().room;
    if (room && (room.phase === 'day' || room.phase === 'voting')
      && room.seating.includes(controller.current().uid)) {
      const final = local.finalVoteRound === room.round;
      const voteLabel = final
        ? (local.lang === 'nl' ? 'Stem vastgelegd' : 'Vote recorded')
        : local.votePanelOpen
          ? (local.lang === 'nl' ? 'Stemmen inklappen' : 'Close ballot')
          : (local.lang === 'nl' ? 'Stemmen' : 'Voting');
      const voteButton = button(voteLabel, () => {
        if (final) return;
        local.votePanelOpen = !local.votePanelOpen;
        render();
      });
      voteButton.disabled = final;
      voteButton.classList.add('bottombar__vote');
      bar.append(voteButton);
    }
  }
  bar.append(button(local.lang === 'nl' ? 'EN' : 'NL', () => {
    local.lang = local.lang === 'nl' ? 'en' : 'nl';
    setLang(local.lang);
    render();
  }));
  return bar;
}

/**
 * A public heartbeat for every device. It deliberately says only which shared
 * stage is open and how many public night windows exist, never who is acting
 * or whether somebody has already answered.
 */
function gameProgress(): HTMLElement {
  const room = controller.current().room!;
  const el = document.createElement('div');
  el.className = 'gameprogress';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  if (room.phase === 'night') {
    const total = room.timeline?.phases.length ?? 1;
    el.textContent = local.lang === 'nl'
      ? `Nacht bezig · stap ${Math.min(room.nightWindowIndex + 1, total)} van ${total}`
      : `Night in progress · step ${Math.min(room.nightWindowIndex + 1, total)} of ${total}`;
    return el;
  }

  if (room.phase === 'day') {
    el.classList.add('gameprogress--timer');
    el.dataset.discussionTimer = 'true';
    el.textContent = `${t(local.lang, 'phase.day')} · ${discussionTimerText(room) ?? '0:00'}`;
    setTimerUrgency(el, room);
    return el;
  }

  if (room.phase === 'lobby') {
    const minutes = Math.round((room.discussionMs ?? 15 * 60_000) / 60_000);
    el.textContent = `${t(local.lang, 'phase.lobby')} · ${minutes} ${t(local.lang, 'timer.minutes')}`;
    return el;
  }

  el.textContent = t(local.lang, `phase.${room.phase}`);
  return el;
}

/** A discoverable but deliberately quiet shortcut for solo/practice testing. */
function practiceVoteShortcut(): HTMLElement | null {
  const state = controller.current();
  const room = state.room;
  if (!state.roomId || !room || room.phase !== 'day'
    || room.mode !== 'practice' || room.refereeUid !== state.uid) return null;

  const row = document.createElement('div');
  row.className = 'practicevote';
  const force = button(t(local.lang, 'menu.forceVote'), () => {
    void attempt(() => backend.forcePracticeVote(state.roomId!));
  });
  force.classList.add('practicevote__button');
  force.disabled = local.busy;
  row.append(force);
  return row;
}

function joinExistingButton(): HTMLElement {
  return button(t(local.lang, 'join.open'), () => {
    local.error = null;
    controller.setJoining(true);
  });
}

/**
 * The menu.
 *
 * Sharing the link and leaving are ordinary. Taking over the game is not, and
 * it sits at the bottom, styled as the exception it is — reachable in two
 * taps, never in one, and never adjacent to anything somebody reaches for
 * casually.
 */
function menu(): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'menu';

  const title = document.createElement('h2');
  title.className = 'setup__title';
  title.textContent = t(local.lang, 'menu.title');
  sheet.append(title);

  const code = controller.current().roomId;
  if (code) {
    const share = button(
      local.shareCopied ? t(local.lang, 'menu.copied') : `${t(local.lang, 'menu.share')} — ${code}`,
      () => {
        void navigator.clipboard?.writeText(roomUrl(location.href, code)).then(() => {
          local.shareCopied = true;
          render();
        }).catch(() => { /* no clipboard permission; the code is on screen */ });
      },
    );
    share.classList.add('menu__item');
    sheet.append(share);
  }

  const table = button(t(local.lang, 'alltime.title'), () => {
    local.menuOpen = false;
    local.showAllTime = true;
    render();
  });
  table.classList.add('menu__item');
  sheet.append(table);

  const profiles = button(t(local.lang, 'friend.profiles'), () => {
    local.menuOpen = false;
    local.showProfiles = true;
    render();
  });
  profiles.classList.add('menu__item');
  sheet.append(profiles);

  const room = controller.current().room;
  if (code && room && (room.hostUid === backend.uid || room.refereeUid === backend.uid)
    && ['night', 'day', 'voting'].includes(room.phase)) {
    const pause = button(
      t(local.lang, room.pausedAt === null ? 'action.pause' : 'action.resume'),
      () => {
        local.menuOpen = false;
        void attempt(() => backend.setPaused(code, room.pausedAt === null));
      },
    );
    pause.classList.add('menu__item');
    sheet.append(pause);
  }
  if (code && room?.refereeUid === backend.uid && room.phase === 'night') {
    const advance = button(t(local.lang, 'menu.forceNight'), () => {
      local.menuOpen = false;
      void attempt(() => backend.forceNightWindow(code));
    });
    advance.classList.add('menu__item', 'menu__item--danger');
    sheet.append(advance);
    const note = document.createElement('p');
    note.className = 'sheet__note';
    note.textContent = t(local.lang, 'menu.forceNightNote');
    sheet.append(note);
  }
  if (code && room?.mode === 'practice' && room.refereeUid === backend.uid && room.phase === 'day') {
    const force = button(t(local.lang, 'menu.forceVote'), () => {
      local.menuOpen = false;
      void attempt(() => backend.forcePracticeVote(code));
    });
    force.classList.add('menu__item');
    sheet.append(force);
    const note = document.createElement('p');
    note.className = 'sheet__note';
    note.textContent = t(local.lang, 'menu.forceVoteNote');
    sheet.append(note);
  }

  const home = button(t(local.lang, 'menu.home'), returnHome);
  home.classList.add('menu__item');
  sheet.append(home);

  const leave = button(t(local.lang, 'menu.leave'), () => {
    local.menuOpen = false;
    void actions.onLeave();
  });
  leave.classList.add('menu__item');
  sheet.append(leave);

  const recover = button(
    local.lang === 'nl' ? 'Noodbediening' : 'Emergency controls',
    () => {
    local.menuOpen = false;
    local.emergencyMenuOpen = true;
    local.error = null;
    render();
  });
  recover.classList.add('menu__item', 'menu__item--danger');
  sheet.append(recover);

  const close = button(t(local.lang, 'menu.close'), () => {
    local.menuOpen = false;
    local.shareCopied = false;
    render();
  });
  close.classList.add('menu__item');
  sheet.append(close);

  return sheet;
}

function emergencyMenu(): HTMLElement {
  const sheet = document.createElement('div');
  sheet.className = 'menu menu--emergency';

  const title = document.createElement('h2');
  title.className = 'setup__title';
  title.textContent = local.lang === 'nl' ? 'Noodbediening' : 'Emergency controls';
  sheet.append(title);

  const note = document.createElement('p');
  note.className = 'sheet__note';
  note.textContent = local.lang === 'nl'
    ? 'Alleen gebruiken als een apparaat uitvalt. Vertel de tafel wat je doet.'
    : 'Use only when a device fails. Tell the table what you are doing.';
  sheet.append(note);

  const controllerTakeover = button(t(local.lang, 'menu.recover'), () => {
    local.emergencyMenuOpen = false;
    local.recovering = true;
    local.recoveryTyped = '';
    local.error = null;
    render();
  });
  controllerTakeover.classList.add('menu__item', 'menu__item--danger');
  sheet.append(controllerTakeover);

  const state = controller.current();
  const canVote = state.room?.phase === 'voting'
    && state.room.refereeUid === state.uid;
  const emergencyVote = button(
    local.lang === 'nl' ? 'Stem overnemen' : 'Take over a vote',
    () => {
      local.emergencyMenuOpen = false;
      local.emergencyVoteOpen = true;
      local.emergencyTyped = '';
      local.emergencyVoter = '';
      local.emergencyTarget = '';
      local.error = null;
      render();
    },
  );
  emergencyVote.disabled = !canVote;
  emergencyVote.classList.add('menu__item', 'menu__item--danger');
  sheet.append(emergencyVote);

  if (!canVote) {
    const unavailable = document.createElement('p');
    unavailable.className = 'sheet__note';
    unavailable.textContent = local.lang === 'nl'
      ? 'Een noodstem kan alleen door de huidige spelleider worden uitgebracht wanneer de stemming open is.'
      : 'Only the current controller can cast an emergency vote while voting is open.';
    sheet.append(unavailable);
  }

  const close = button(t(local.lang, 'menu.close'), () => {
    local.emergencyMenuOpen = false;
    render();
  });
  close.classList.add('menu__item');
  sheet.append(close);
  return sheet;
}

function emergencyVoteSheet(): HTMLElement {
  const state = controller.current();
  const room = state.room;
  const wrap = document.createElement('div');
  wrap.className = 'recover';

  const title = document.createElement('h2');
  title.className = 'setup__title';
  title.textContent = local.lang === 'nl' ? 'Noodstem uitbrengen' : 'Cast emergency vote';
  const warning = document.createElement('p');
  warning.className = 'recover__warning';
  warning.textContent = local.lang === 'nl'
    ? 'Dit legt namens een andere speler een definitieve stem vast. Een bestaande stem wordt nooit overschreven.'
    : 'This records a final vote for another player. An existing vote is never overwritten.';
  wrap.append(title, warning);

  const players = room ? room.seating.map((uid, seat) => ({
    uid, seat, name: seatNames()[seat as SeatIndex] ?? uid,
  })) : [];
  const voter = selectField(
    local.lang === 'nl' ? 'Speler met uitgevallen apparaat' : 'Player whose device failed',
    local.emergencyVoter,
    players,
    (value) => {
      local.emergencyVoter = value;
      if (local.emergencyTarget === value) local.emergencyTarget = '';
      render();
    },
  );
  const targets = players.filter((player) => player.uid !== local.emergencyVoter);
  const target = selectField(
    local.lang === 'nl' ? 'Definitieve stem op' : 'Final vote for',
    local.emergencyTarget,
    targets,
    (value) => { local.emergencyTarget = value; render(); },
  );
  wrap.append(voter, target);

  const phrase = document.createElement('label');
  phrase.className = 'recover__field';
  phrase.textContent = local.lang === 'nl'
    ? 'Typ takeover om dit bewust te bevestigen'
    : 'Type takeover to confirm deliberately';
  const input = document.createElement('input');
  input.className = 'join__name';
  input.type = 'text';
  input.value = local.emergencyTyped;
  input.autocomplete = 'off';
  phrase.append(input);
  wrap.append(phrase);

  const confirm = button(local.lang === 'nl' ? 'Noodstem vastleggen' : 'Record emergency vote', () => {
    const roomId = state.roomId;
    if (!roomId) return;
    void attempt(
      () => backend.emergencyVote(
        roomId, local.emergencyVoter, local.emergencyTarget, local.emergencyTyped.trim(),
      ),
      local.lang === 'nl' ? 'De noodstem kon niet worden vastgelegd.' : 'The emergency vote could not be recorded.',
    ).then((ok) => {
      if (!ok) return;
      local.emergencyVoteOpen = false;
      local.emergencyTyped = '';
      local.emergencyVoter = '';
      local.emergencyTarget = '';
      render();
    });
  });
  confirm.classList.add('btn--primary');
  confirm.disabled = local.emergencyTyped.trim() !== 'takeover'
    || !local.emergencyVoter || !local.emergencyTarget;
  input.addEventListener('input', () => {
    local.emergencyTyped = input.value;
    confirm.disabled = local.emergencyTyped.trim() !== 'takeover'
      || !local.emergencyVoter || !local.emergencyTarget;
  });
  const cancel = button(t(local.lang, 'menu.close'), () => {
    local.emergencyVoteOpen = false;
    local.emergencyTyped = '';
    local.error = null;
    render();
  });
  wrap.append(confirm, cancel);
  if (local.error) wrap.append(fatal(local.error));
  return wrap;
}

function selectField(
  label: string,
  value: string,
  options: Array<{ uid: string; name: string }>,
  onChange: (value: string) => void,
): HTMLElement {
  const field = document.createElement('label');
  field.className = 'recover__field';
  field.textContent = label;
  const select = document.createElement('select');
  select.className = 'join__name';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '—';
  select.append(empty);
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.uid;
    item.textContent = option.name;
    select.append(item);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  field.append(select);
  return field;
}

function recoverySheet(): HTMLElement {
  return renderRecovery({
    lang: local.lang,
    typed: local.recoveryTyped,
    error: local.error,
    busy: local.busy,
    onTyped: (value) => {
      local.recoveryTyped = value;
      render();
    },
    onCancel: () => {
      local.recovering = false;
      local.recoveryTyped = '';
      local.error = null;
      render();
    },
    onConfirm: () => {
      const roomId = controller.current().roomId;
      if (!roomId) return;
      void attempt(
        () => backend.takeEmergencyControl(roomId, local.recoveryTyped.trim()),
        t(local.lang, 'recover.failed'),
      ).then((ok) => {
        if (!ok) return;
        local.recovering = false;
        local.recoveryTyped = '';
        render();
      });
    },
  });
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function discussionMsFromInput(value: string): number | null {
  const minutes = Number(value);
  const ms = minutes * 60_000;
  return Number.isInteger(minutes) && ms >= MIN_DISCUSSION_MS && ms <= MAX_DISCUSSION_MS
    ? ms
    : null;
}

function discussionTimerText(room: {
  phase: string; discussionEndsAt?: number | null; pausedAt?: number | null;
}): string | null {
  if (room.phase !== 'day' || room.discussionEndsAt == null) return null;
  const now = room.pausedAt ?? Date.now();
  const seconds = Math.max(0, Math.ceil((room.discussionEndsAt - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function setTimerUrgency(
  element: HTMLElement,
  room: { phase: string; discussionEndsAt?: number | null; pausedAt?: number | null },
): void {
  const remaining = room.discussionEndsAt == null
    ? Number.POSITIVE_INFINITY
    : room.discussionEndsAt - (room.pausedAt ?? Date.now());
  element.classList.toggle(
    'discussiontimer--urgent',
    room.phase === 'day' && remaining > 0 && remaining <= 2 * 60_000,
  );
}

function refreshDiscussionTimer(): void {
  const room = controller.current().room;
  if (!room || room.phase !== 'day') return;
  const value = discussionTimerText(room) ?? '0:00';
  document.querySelectorAll<HTMLElement>('[data-discussion-timer="true"]').forEach((el) => {
    el.textContent = el.classList.contains('gameprogress')
      ? `${t(local.lang, 'phase.day')} · ${value}`
      : value;
    setTimerUrgency(el, room);
  });
}

void start();

/* ------------------------- what is on top of the table ------------------- */

/**
 * The sheet over the table, if anything is being asked right now.
 *
 * Order is the order of urgency at a real table: a night question you were
 * handed, then the vote, then the result. Only one at a time — two open sheets
 * is two people talking at once.
 */
function tableOverlay(): HTMLElement | null {
  const state = controller.current();
  const room = state.room;
  if (!room) return null;

  const ownSeat = room.seating.indexOf(state.uid);
  if (ownSeat < 0) {
    return room.phase === 'results' && room.finalRoles && room.refereeUid === state.uid
      ? resultSheet(null)
      : null;
  }

  const request = firstPending();
  if (request) return promptSheet(request, ownSeat as SeatIndex);

  const privateReceipt = nextPrivateReceipt();
  if (privateReceipt) return privateReceipt;

  if (room.phase === 'results' && room.finalRoles) {
    return resultSheet(ownSeat as SeatIndex);
  }
  return null;
}

/** A private reveal must stay readable after its choice sheet closes. */
function nextPrivateReceipt(): HTMLElement | null {
  const state = controller.current();
  const round = state.room?.round ?? null;
  if (local.privateInfoRound !== round) {
    local.privateInfoRound = round;
    local.acknowledgedPrivateInfo = 0;
  }
  const info = state.own.privateInfo[local.acknowledgedPrivateInfo];
  if (!info) return null;

  const message = document.createElement('p');
  message.className = 'sheet__sub';
  message.textContent = describeReveal(
    local.lang,
    info,
    (seat) => seatNames()[seat as SeatIndex] ?? String(seat + 1),
    (role) => roleName(local.lang, role as RoleId),
  );
  return renderSheet({
    title: local.lang === 'nl' ? 'Wat je zag' : 'What you saw',
    variant: 'receipt',
    body: message,
    actions: [{
      label: local.lang === 'nl' ? 'Verder' : 'Continue',
      primary: true,
      onSelect: () => {
        local.acknowledgedPrivateInfo += 1;
        render();
      },
    }],
    dismissable: false,
    passiveScrim: true,
  });
}

function seatNames(): Record<SeatIndex, string> {
  const state = controller.current();
  const byUid = new Map(state.players.map((p) => [p.uid, p.displayName]));
  const names: Record<SeatIndex, string> = {};
  (state.room?.seating ?? []).forEach((uid, seat) => {
    names[seat as SeatIndex] = byUid.get(uid) ?? uid;
  });
  return names;
}

function promptSheet(
  request: NonNullable<ReturnType<typeof firstPending>>,
  ownSeat: SeatIndex,
): HTMLElement {
  const state = controller.current();
  const send = async (choice: Choice) => {
    const roomId = state.roomId;
    if (!roomId || !state.room) return;
    const saved = await attempt(() => backend.submit(
      roomId,
      state.room!.nightWindowIndex,
      { [request.key]: choice },
    ));
    if (!saved) return;
    local.submittedDecisionKeys.push(request.key);
    local.picked = [];
    local.pickedCenters = [];
    render();
  };

  return renderSheet({
    title: t(local.lang, 'phase.night'),
    variant: 'night',
    body: renderPrompt({
      lang: local.lang,
      request,
      names: seatNames(),
      ownSeat,
      picked: local.picked,
      pickedCenters: local.pickedCenters,
      centerCount: 3,
      onPickSeat: (seat) => actions.onCardTap(seat),
      onPickCenter: (index) => {
        if (request.prompt.kind === 'seat-or-center') local.picked = [];
        const count = request.prompt.kind === 'center'
          ? request.prompt.count
          : request.prompt.kind === 'seat-or-center'
            ? request.prompt.centerCount
            : 1;
        local.pickedCenters = toggleCenterPick(local.pickedCenters, index, count);
        render();
      },
      onConfirm: send,
    }),
    note: `${t(local.lang, 'prompt.noDeadline')} ${t(local.lang, 'reveal.staleWarning')}`,
    passiveScrim: true,
  });
}

/** Narrowing helper so promptSheet can name the type without importing it. */
function firstPending() {
  const state = controller.current();
  const room = state.room;
  const marker = room ? `${room.round}:${room.nightWindowIndex}` : null;
  if (local.decisionWindow !== marker) {
    local.decisionWindow = marker;
    local.submittedDecisionKeys = [];
    local.picked = [];
    local.pickedCenters = [];
  }
  if (local.decisionSyncLoading) return undefined;
  return nextPendingRequest(
    state.own.pending,
    local.submittedDecisionKeys,
    room?.phase ?? 'lobby',
  );
}

function votePanel(ownSeat: SeatIndex): HTMLElement {
  const state = controller.current();
  const room = state.room!;
  const roomId = state.roomId!;

  const cast = async (target: SeatIndex | null, abstain: boolean): Promise<boolean> => {
    const uid = target === null ? null : (room.seating[target] ?? null);
    return attempt(() => backend.vote(roomId, uid, abstain));
  };

  const panel = document.createElement('section');
  panel.className = 'ballotpanel';
  const title = document.createElement('h2');
  title.className = 'sheet__title';
  title.textContent = t(local.lang, room.phase === 'voting' ? 'day.voteNow' : 'day.discussing');
  panel.append(title, renderVoting({
      lang: local.lang,
      ownSeat,
      names: seatNames(),
      target: local.voteTarget,
      abstain: local.abstaining,
      abstainCount: room.abstainCount,
      seatCount: room.seating.length,
      votesCast: room.votesCast,
      votingOpen: room.phase === 'voting',
      finalSubmitted: local.finalVoteRound === room.round,
      // What this device BELIEVES it is, from its own dealt card. The engine
      // resolves the shield on whoever holds the Bodyguard card at dawn, so a
      // player swapped away from it goes on shielding nobody (§6.0).
      isBodyguard: state.own.originalRole === 'bodyguard',
      onTarget: (seat) => {
        if (local.finalVoteRound === room.round || room.phase !== 'voting') return;
        local.voteTarget = local.voteTarget === seat ? null : seat;
        render();
      },
      // §7: the abstain toggle is live from the first second of the
      // discussion and counts at any moment, so it is sent immediately rather
      // than waiting for a confirm.
      onAbstain: (next) => {
        if (room.phase !== 'day') return;
        local.abstaining = next;
        if (next) local.readyToVote = false;
        void (async () => {
          if (next) await attempt(() => backend.requestEarlyVote(roomId, false));
          await cast(null, next);
        })();
        render();
      },
      onConfirm: () => {
        if (local.voteTarget === null || local.finalVoteRound === room.round) return;
        void cast(local.voteTarget, false).then((ok) => {
          if (!ok) return;
          local.finalVoteRound = room.round;
          local.votePanelOpen = false;
          local.voteTarget = null;
          render();
        });
      },
      readyToVote: local.readyToVote,
      earlyVoteCount: room.earlyVoteCount,
      // Sent immediately, like the abstain, because it is counted
      // simultaneously — a request that only lands when you confirm something
      // else is not a show of hands.
      onReadyToVote: (next) => {
        if (room.phase !== 'day') return;
        local.readyToVote = next;
        if (next) local.abstaining = false;
        void (async () => {
          if (next) await cast(null, false);
          await attempt(() => backend.requestEarlyVote(roomId, next));
        })();
        render();
      },
      onCollapse: () => {
        local.votePanelOpen = false;
        render();
      },
    }));
  return panel;
}

/**
 * What the table sees at dawn.
 *
 * Built only from the PUBLIC room document. Votes stay secret throughout the
 * game and are published here once resolution is complete, together with the
 * deaths and winning team. This panel has no scrim: at dawn the open cards are
 * the main event, and the explanation belongs beside them rather than over
 * them.
 */
function resultSheet(ownSeat: SeatIndex | null): HTMLElement {
  const room = controller.current().room!;
  const state = controller.current();
  return renderResults({
    lang: local.lang,
    outcome: room.outcome ?? '',
    finalRoles: room.finalRoles ?? {},
    ...(room.originalRoles ? { originalRoles: room.originalRoles } : {}),
    names: seatNames(),
    ownSeat,
    ...(room.eliminatedSeats ? { eliminatedSeats: room.eliminatedSeats } : {}),
    ...(room.winningTeams ? { winningTeams: room.winningTeams } : {}),
    ...(room.finalVotes ? { finalVotes: room.finalVotes } : {}),
    ...(room.discardedVotes ? { discardedVotes: room.discardedVotes } : {}),
    ...(room.finalTally ? { finalTally: room.finalTally } : {}),
    ...(room.finalCenterRoles ? { finalCenterRoles: room.finalCenterRoles } : {}),
    ...(room.nightInfo ? { nightInfo: room.nightInfo } : {}),
    ...(state.room && canPrepareNextRound(state.room, state.uid)
      && actions.onPrepareNextRound
      ? { onNextRound: actions.onPrepareNextRound }
      : {}),
  });
}

function playerStatsSheet(seat: SeatIndex): HTMLElement {
  const state = controller.current();
  const uid = state.room?.seating[seat] ?? '';
  const player = state.players.find((entry) => entry.uid === uid);
  const member = state.room?.members.find((entry) => entry.uid === uid);
  const friendId = member?.friendId;
  const name = player?.displayName ?? member?.friendName ?? String(seat + 1);
  const rows = friendId
    ? local.history.filter((entry) => entry.friendId === friendId)
    : [];
  return renderSheet({
    title: name,
    variant: 'receipt',
    body: renderStats(aggregatePlayerHistory(name, rows), local.lang),
    actions: [{
      label: t(local.lang, 'action.close'),
      primary: true,
      onSelect: () => {
        local.statsSeat = null;
        render();
      },
    }],
    passiveScrim: true,
  });
}

/* --------------------------- who you are, all-time ----------------------- */

function friendPicker(onPicked?: () => void): HTMLElement {
  return renderFriendPicker({
    lang: local.lang,
    profiles: local.friends,
    rememberedId: rememberedFriendId(),
    typed: local.friendTyped,
    busy: local.busy,
    onTyped: (value) => {
      local.friendTyped = value;
    },
    onPick: (profile) => {
      void attempt(() => selectFriend(profile, onPicked));
    },
    onCreate: (displayName) => {
      void attempt(async () => {
        const profile = await backend.createFriend(displayName);
        local.friendTyped = '';
        await selectFriend(profile, onPicked);
      });
    },
    onGuest: () => {
      void attempt(() => selectGuest(onPicked));
    },
  });
}

async function selectFriend(profile: FriendProfile, onPicked?: () => void): Promise<void> {
  const state = controller.current();
  const isMember = state.room?.members.some((member) => member.uid === state.uid) === true;
  if (state.roomId && isMember) {
    await backend.setFriendProfile(state.roomId, {
      friendId: profile.id,
      friendName: profile.displayName,
    });
  }
  local.friend = profile;
  local.identityKind = 'profile';
  // Remembered so the common case is one tap next time. Losing it costs
  // nothing: the list is shared, so picking the same name gets the SAME
  // profile — which is the whole difference from keying off the uid.
  rememberFriendId(profile.id);
  if (!local.displayName) local.displayName = profile.displayName;
  onPicked?.();
}

async function selectGuest(onPicked?: () => void): Promise<void> {
  const state = controller.current();
  const isMember = state.room?.members.some((member) => member.uid === state.uid) === true;
  if (state.roomId && isMember) {
    await backend.setFriendProfile(state.roomId, {
      friendId: '',
      friendName: local.displayName.trim() || t(local.lang, 'friend.guest'),
    });
  }
  local.friend = null;
  local.identityKind = 'guest';
  onPicked?.();
}

/**
 * The all-time table.
 *
 * Practice rounds are filtered out by never having been written, so this is
 * simply everything there is — and the totals are recomputed here from the
 * rows rather than read from any stored number.
 */
function allTimeSheet(): HTMLElement {
  const body = renderAllTime({
    lang: local.lang,
    rows: allTimeStandings(local.history),
    ownFriendId: local.friend?.id ?? null,
    // The sheet supplies the heading.
    heading: false,
  });
  return renderSheet({
    title: t(local.lang, 'alltime.title'),
    body,
    onDismiss: () => {
      local.showAllTime = false;
      render();
    },
  });
}

/** The shared address book remains reachable after entering a room. */
function profileSheet(): HTMLElement {
  return renderSheet({
    title: t(local.lang, 'friend.profiles'),
    body: friendPicker(() => { local.showProfiles = false; }),
    onDismiss: () => {
      local.showProfiles = false;
      render();
    },
  });
}
