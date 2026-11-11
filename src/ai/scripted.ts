import { isWolfRole, ROLES, teamOf } from '../engine/roles.js';
import type { Choice, DecisionRequest, RoleId, SeatIndex, Team } from '../engine/types.js';
import { roleName } from './rules.js';
import type {
  AiAgent, PublicMessage, SeatKnowledge, SpeakContext, Turn, VoteDecision,
} from './types.js';

/**
 * Deterministic scripted player: no API key, no network, same game for the
 * same seed. Exists so tests and demos run anywhere, and as the fallback when
 * an LLM answer is unusable.
 *
 * It is deliberately simple but plays the social game: the village shares
 * what it saw, wolves claim a fake village role with fake info, everybody
 * accuses whoever the chat links to "wolf", and votes follow suspicion.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** The team this seat believes it is on, from its own receipts only. */
export function believedTeam(k: SeatKnowledge): Team {
  return teamOf(believedRole(k));
}

export function believedRole(k: SeatKnowledge): RoleId {
  let role: RoleId = k.dealtRole;
  for (const info of k.privateInfo) {
    if (info.kind === 'copied-role' || info.kind === 'became-role' || info.kind === 'own-final-card') {
      role = info.role;
    }
    if (info.kind === 'action-confirmed' && info.action?.kind === 'took-looier') role = 'looier';
  }
  // A card lying face up in front of me is my card now, and everyone saw it.
  return k.publicView?.revealed[k.seat] ?? role;
}

export function knownWolves(k: SeatKnowledge): SeatIndex[] {
  const out = new Set<SeatIndex>();
  for (const info of k.privateInfo) {
    if (info.kind === 'saw-wolves') info.seats.forEach((s) => out.add(s));
    if (info.kind === 'saw-card' && info.slot < k.names.length && isWolfRole(info.role)) out.add(info.slot);
  }
  out.delete(k.seat);
  return [...out];
}

const WOLF_WORDS = ['wolf', 'wolven', 'weerwolf', 'alfawolf', 'droomwolf', 'mystieke'];

function nameKeys(name: string): string[] {
  const keys = [name.toLowerCase()];
  const last = name.split(/\s+/).pop()?.toLowerCase();
  if (last && last.length >= 3 && last !== keys[0]) keys.push(last);
  return keys;
}

/** Who the public chat links to wolves. A crude reading of the table. */
export function chatSuspicion(names: readonly string[], chat: readonly PublicMessage[], self: SeatIndex): number[] {
  const score = names.map(() => 0);
  for (const msg of chat) {
    const text = msg.text.toLowerCase();
    if (!WOLF_WORDS.some((w) => text.includes(w))) continue;
    names.forEach((name, seat) => {
      if (seat === msg.seat) return;
      if (nameKeys(name).some((key) => new RegExp(`\\b${escapeRe(key)}\\b`).test(text))) {
        score[seat]! += msg.seat === self ? 0.5 : 1;
      }
    });
  }
  return score;
}

/**
 * Role claims ("Ik ben de Heks") that the public card list cannot support:
 * more claimants than copies, or a role that is not in the game at all.
 */
export function claimSuspicion(
  names: readonly string[], cards: readonly RoleId[], chat: readonly PublicMessage[],
): number[] {
  const score = names.map(() => 0);
  const claims = new Map<RoleId, Set<number>>();
  const byName = Object.values(ROLES).map((def) => [def.nl.toLowerCase(), def.id] as const);
  for (const msg of chat) {
    if (msg.seat === null) continue;
    const m = /\bik ben (?:de |het |een |gewoon (?:de |het |een )?)?([a-z ]+?)(?:[.,!]|$)/i.exec(msg.text);
    if (!m) continue;
    const said = m[1]!.toLowerCase().trim();
    const role = byName.find(([nl]) => said.startsWith(nl))?.[1];
    if (!role) continue;
    const set = claims.get(role) ?? new Set<number>();
    set.add(msg.seat);
    claims.set(role, set);
  }
  // "Middenkaart 1 was Medium": that copy lay in the middle, so nobody was dealt it.
  const centre = new Map<RoleId, Map<number, Set<number>>>();
  for (const msg of chat) {
    if (msg.seat === null) continue;
    for (const m of msg.text.matchAll(/\bmiddenkaart (\d) was (?:een |de |het )?([a-z ]+?)(?:[.,!:]|$)/gi)) {
      const role = byName.find(([nl]) => m[2]!.toLowerCase().trim().startsWith(nl))?.[1];
      if (!role) continue;
      const byIndex = centre.get(role) ?? new Map<number, Set<number>>();
      const reporters = byIndex.get(Number(m[1])) ?? new Set<number>();
      reporters.add(msg.seat);
      byIndex.set(Number(m[1]), reporters);
      centre.set(role, byIndex);
    }
  }
  for (const [role, seats] of claims) {
    const copies = cards.filter((c) => c === role).length;
    const inMiddle = centre.get(role) ?? new Map<number, Set<number>>();
    if (copies === 0) seats.forEach((s) => { score[s]! += 2; });
    else if (seats.size > copies) seats.forEach((s) => { score[s]! += 1.5; });
    else if (seats.size + inMiddle.size > copies) {
      // Either the claimant or the one who "saw" it in the middle is lying.
      seats.forEach((s) => { score[s]! += 1.5; });
      for (const reporters of inMiddle.values()) reporters.forEach((s) => { if (!seats.has(s)) score[s]! += 1; });
    }
  }
  return score;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FAKE_CLAIMS: RoleId[] = ['leerlingziener', 'dorpeling', 'heks', 'dorpsgek', 'medium'];

export function scriptedAgent(seed: number): AiAgent {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(next() * items.length)];
  let fakeClaim: RoleId | null = null;
  let fakeCenter = 0;

  function nightChoice(k: SeatKnowledge, request: DecisionRequest): Choice {
    const seats = k.names.map((_, s) => s);
    const p = request.prompt;
    const wolves = knownWolves(k);
    switch (p.kind) {
      case 'seat': {
        let legal = seats.filter((s) => !p.exclude.includes(s));
        if (request.key !== 'heks-precommit-target' && request.key !== 'heks-target') {
          legal = legal.filter((s) => s !== request.seat);
        }
        // A wolf has no reason to look at or convert a known packmate.
        const preferred = legal.filter((s) => !wolves.includes(s));
        const seat = pick(preferred.length > 0 ? preferred : legal);
        return seat === undefined ? { kind: 'none' } : { kind: 'seat', seat };
      }
      case 'seat-or-center': {
        if (next() < 0.65) {
          const seat = pick(seats.filter((s) => !p.exclude.includes(s) && s !== request.seat));
          if (seat !== undefined) return { kind: 'seat', seat };
        }
        const first = Math.floor(next() * 3);
        return { kind: 'center', centerIndices: [first, (first + 1) % 3].slice(0, p.centerCount) };
      }
      case 'two-seats': {
        const legal = seats.filter((s) => !p.exclude.includes(s) && s !== request.seat);
        const a = pick(legal);
        const b = pick(legal.filter((s) => s !== a));
        return a === undefined || b === undefined ? { kind: 'none' } : { kind: 'seats', seats: [a, b] };
      }
      case 'center':
        return { kind: 'center', centerIndices: [Math.floor(next() * 3)].slice(0, p.count) };
      case 'dorpsgek': {
        const r = next();
        return { kind: 'dorpsgek', direction: r < 0.4 ? 'none' : r < 0.7 ? 'left' : 'right' };
      }
      case 'confirm':
        return { kind: 'bool', value: true };
    }
  }

  function truthfulClaim(k: SeatKnowledge): string {
    const now = believedRole(k);
    const parts = [now === k.dealtRole
      ? `Ik ben ${roleName(k.dealtRole)}.`
      : `Ik kreeg ${roleName(k.dealtRole)}, maar nu ben ik ${roleName(now)}.`];
    for (const info of k.privateInfo) {
      if (info.kind === 'saw-card' && info.slot < k.names.length) {
        const who = k.names[info.slot]!;
        parts.push(isWolfRole(info.role)
          ? `Ik zag bij ${who} een ${roleName(info.role)}: ${who} is een wolf!`
          : `Ik zag bij ${who} de kaart ${roleName(info.role)}.`);
      } else if (info.kind === 'saw-center') {
        parts.push(`Middenkaart ${info.centerIndex} was ${roleName(info.role)}.`);
      } else if (info.kind === 'copied-role') {
        parts.push(`Ik kopieerde ${k.names[info.fromSeat]} en werd ${roleName(info.role)}.`);
      } else if (info.kind === 'action-confirmed' && info.action?.kind === 'players-swapped') {
        parts.push(`Ik ruilde de kaarten van ${k.names[info.action.seats[0]]} en ${k.names[info.action.seats[1]]}.`);
      } else if (info.kind === 'action-confirmed' && info.action?.kind === 'heks-swapped') {
        parts.push(`Ik ruilde middenkaart ${info.action.centerIndex} met ${k.names[info.action.seat]}.`);
      } else if (info.kind === 'own-final-card') {
        parts.push(`Aan het eind had ik ${roleName(info.role)}.`);
      }
    }
    return parts.join(' ');
  }

  function fakeClaimText(k: SeatKnowledge): string {
    if (!fakeClaim) {
      const options = FAKE_CLAIMS.filter((r) => k.cards.includes(r));
      fakeClaim = pick(options.length > 0 ? options : ['dorpeling']) ?? 'dorpeling';
      fakeCenter = Math.floor(next() * 3);
    }
    switch (fakeClaim) {
      case 'leerlingziener':
        return `Ik ben de Leerlingziener. Middenkaart ${fakeCenter} was een Dorpeling, dus daar zit niks spannends.`;
      case 'heks':
        return `Ik ben de Heks. Ik zag middenkaart ${fakeCenter}, een Dorpeling, en heb die bij mezelf gelegd.`;
      case 'dorpsgek':
        return 'Ik ben de Dorpsgek en ik heb niets doorgeschoven. Jullie kaarten zijn van jullie zelf.';
      case 'medium':
        return 'Ik ben het Medium. Ik keek bij iemand en het was een wolf, daarom werd er niets omgedraaid. Ik zeg nog niet wie.';
      default:
        return 'Ik ben gewoon een Dorpeling, ik heb vannacht niets gedaan.';
    }
  }

  function suspicionFor(k: SeatKnowledge, chat: readonly PublicMessage[]): number[] {
    const fromChat = chatSuspicion(k.names, chat, k.seat);
    const fromClaims = claimSuspicion(k.names, k.cards, chat);
    const score = fromChat.map((v, s) => v + fromClaims[s]!);
    const team = believedTeam(k);
    const wolves = knownWolves(k);
    if (team === 'village') wolves.forEach((s) => { score[s]! += 5; });
    if (team === 'wolf') {
      wolves.forEach((s) => { score[s] = -10; });
      // Whoever points at me is the best target for a wolf.
      for (const msg of chat) {
        if (msg.seat === null || msg.seat === k.seat) continue;
        if (nameKeys(k.names[k.seat]!).some((key) => msg.text.toLowerCase().includes(key))) score[msg.seat]! += 1;
      }
    }
    score[k.seat] = Number.NEGATIVE_INFINITY;
    return score;
  }

  function topSuspect(k: SeatKnowledge, chat: readonly PublicMessage[]): SeatIndex {
    const score = suspicionFor(k, chat);
    let best: SeatIndex = (k.seat + 1) % k.names.length;
    let bestScore = Number.NEGATIVE_INFINITY;
    // Tie-break with the seeded RNG rather than seat order, so seat 0 is not always hanged.
    const order = k.names.map((_, s) => s).sort(() => next() - 0.5);
    for (const s of order) {
      if (score[s]! > bestScore) { best = s; bestScore = score[s]!; }
    }
    return best;
  }

  return {
    label: 'mock',

    async night(k, request): Promise<Turn<Choice>> {
      return { value: nightChoice(k, request), reasoning: 'Gescript: plausibele legale keuze.' };
    },

    async speak(k, ctx: SpeakContext): Promise<Turn<string | null>> {
      const team = believedTeam(k);
      if (ctx.round === 1) {
        if (ctx.mustTellTruth && team !== 'village') {
          return {
            value: 'Ik heb vannacht iets gezien, maar ik wacht nog even voor ik iets zeg.',
            reasoning: 'De Rechter koos mij; dit is waar en verraadt niets.',
          };
        }
        if (team === 'village') {
          return { value: truthfulClaim(k), reasoning: 'Dorp: eerlijk delen wat ik weet.' };
        }
        if (team === 'solo') {
          return {
            value: 'Ik ga niet zeggen wat ik ben. Als jullie me verdacht vinden, stem dan maar op mij.',
            reasoning: 'Looier: verdacht overkomen zodat ze mij ophangen.',
          };
        }
        return { value: fakeClaimText(k), reasoning: `Wolf: ik claim nep ${roleName(fakeClaim ?? 'dorpeling')}.` };
      }
      if (next() < 0.2) return { value: null, reasoning: 'Niets nieuws te zeggen.' };
      const suspect = topSuspect(k, ctx.chat);
      const who = k.names[suspect]!;
      const evidence = suspicionFor(k, ctx.chat)[suspect]! > 0;
      if (!evidence && team === 'village') {
        return {
          value: 'Ik heb nog geen echte verdachte. Wie heeft er iets bekeken of geruild? Zeg het nu, dan kunnen we claims vergelijken.',
          reasoning: 'Dorp: nog geen bewijs, dus vragen in plaats van gokken.',
        };
      }
      if (team === 'solo') {
        return { value: `Waarom kijkt iedereen naar ${who}? Ik zou eerder mij verdenken.`, reasoning: 'Looier: aandacht naar mezelf trekken.' };
      }
      if (team === 'wolf') {
        return {
          value: `${who} klinkt mij te zeker. Volgens mij is ${who} een wolf die ons op het verkeerde spoor zet.`,
          reasoning: `Wolf: verdenking afleiden naar ${who}.`,
        };
      }
      return {
        value: `Alles bij elkaar wijst het naar ${who}. Ik denk dat ${who} een wolf is.`,
        reasoning: `Dorp: ${who} is mijn grootste verdachte.`,
      };
    },

    async vote(k, chat): Promise<Turn<VoteDecision>> {
      const team = believedTeam(k);
      const score = suspicionFor(k, chat);
      const target = team === 'solo'
        ? (pick(k.names.map((_, s) => s).filter((s) => s !== k.seat)) ?? (k.seat + 1) % k.names.length)
        : topSuspect(k, chat);
      const beliefs: Record<number, number> = {};
      const finite = score.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
      const total = finite.reduce((a, b) => a + b, 0);
      k.names.forEach((_, s) => {
        if (s !== k.seat) beliefs[s] = total > 0 ? Math.round((finite[s]! / total) * 100) / 100 : 0;
      });
      return {
        value: { target, beliefs },
        reasoning: `Stem op ${k.names[target]} (hoogste verdenking vanuit team ${team}).`,
      };
    },
  };
}
