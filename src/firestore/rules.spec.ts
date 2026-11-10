import { readFileSync } from 'node:fs';
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

/**
 * Security rules tests, written as ATTACKS rather than happy paths.
 *
 * The threat model is a player at the table with devtools open, not a stranger
 * on the internet. Every test below is something one of Milan's friends could
 * plausibly try. Emergency referee recovery is explicitly allowed only as a
 * phrase-confirmed, trusted-group action; every other promotion remains denied.
 *
 * Run with:  npm run test:rules   (starts the emulator for you)
 */

const ROOM = 'room1';
const HOST = 'host-uid';
const REF = 'tablet-uid';    // the neutral tablet acts as referee
const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const CHARLIE = 'charlie-uid';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'dageraad-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => { await env?.cleanup(); });

/** Seed a room mid-night with Alice and Bob seated and dealt. */
async function seed(phase = 'night', nightWindowIndex = 0, currentRound = 1,
                    mode: 'practice' | 'official' = 'official') {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'rooms', ROOM), {
      hostUid: HOST,
      refereeUid: REF,
      phase,
      nightWindowIndex,
      nightForceAdvanceIndex: null,
      currentRound,
      mode,
      config: {},
      discussionMs: 15 * 60_000,
      discussionEndsAt: null,
      practiceSkipDiscussion: false,
      activeRoles: ['droomwolf', 'alphawolf', 'mystiekewolf', 'dubbelganger'],
      seating: [ALICE, BOB],
    });
    for (const uid of [ALICE, BOB]) {
      await setDoc(doc(db, 'rooms', ROOM, 'members', uid), {
        uid, joinedAtRound: 1, leftAtRound: null,
      });
    }
    await setDoc(doc(db, 'rooms', ROOM, 'members', CHARLIE), {
      uid: CHARLIE, joinedAtRound: 1, leftAtRound: null,
    });
    for (const uid of [ALICE, BOB]) {
      await setDoc(doc(db, 'rooms', ROOM, 'players', uid), {
        displayName: uid, seatIndex: uid === ALICE ? 0 : 1,
      });
    }
    await setDoc(doc(db, 'rooms', ROOM, 'private', ALICE), {
      originalRole: 'alphawolf', currentCard: 'c0', privateInfo: [],
    });
    await setDoc(doc(db, 'rooms', ROOM, 'private', BOB), {
      originalRole: 'mystiekewolf', currentCard: 'c1', privateInfo: [],
    });
    await setDoc(doc(db, 'rooms', ROOM, 'engine', 'state'), {
      slots: ['c0', 'c1', 'c2', 'c3', 'c4'],
      cardRole: { c0: 'alphawolf', c1: 'mystiekewolf' },
    });
    await setDoc(doc(db, 'rooms', ROOM, 'submissions', ALICE), {
      windowIndex: 0, choice: { kind: 'seat', seat: 1 },
    });
  });
}

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

beforeEach(async () => { await seed(); });

/* ==================================================================== */

describe('phrase-confirmed emergency control', () => {
  it('rejects a promotion that does not include the conscious phrase', async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM), { refereeUid: ALICE }),
    );
  });

  it('lets an active member consciously take both controls with the phrase', async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), 'rooms', ROOM), {
      hostUid: ALICE,
      refereeUid: ALICE,
      recoveryPhrase: 'referee',
    }));
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms', ROOM, 'private', BOB)));
  });

  it('refuses recovery when it changes game state too', async () => {
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), {
      hostUid: ALICE,
      refereeUid: ALICE,
      recoveryPhrase: 'referee',
      phase: 'voting',
    }));
  });

  it('keeps phase changes with the referee, not a separate host', async () => {
    await assertSucceeds(updateDoc(doc(as(REF), 'rooms', ROOM), { phase: 'voting' }));
    await seed();
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { phase: 'voting' }));
  });
});

describe('the shared discussion timer and practice shortcut', () => {
  it('does not let anybody change the room timer after creation', async () => {
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { discussionMs: 60_000 }));
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), { discussionMs: 60_000 }));
  });

  it('lets the referee open a practice vote during discussion', async () => {
    await seed('day', 0, 1, 'practice');
    await assertSucceeds(updateDoc(doc(as(REF), 'rooms', ROOM), { practiceSkipDiscussion: true }));
  });

  it('refuses that shortcut in an official room and from a player', async () => {
    await seed('day', 0, 1, 'official');
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), { practiceSkipDiscussion: true }));
    await seed('day', 0, 1, 'practice');
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), { practiceSkipDiscussion: true }));
  });

  it('keeps deck changes with the host and inside the lobby', async () => {
    await seed('lobby', 0, 0, 'practice');
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), {
      activeRoles: ['weerwolf', 'ziener', 'jager', 'dorpeling', 'dorpeling'],
    }));
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), {
      activeRoles: ['weerwolf'],
    }));
    await seed('night', 0, 1, 'practice');
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), {
      activeRoles: ['weerwolf'],
    }));
  });

  it('lets the host pause and resume while preserving a shifted deadline', async () => {
    await seed('day', 0, 1, 'practice');
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), { pausedAt: 1000 }));
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), {
      pausedAt: null,
      discussionEndsAt: 999_000,
    }));
  });

  it('does not let a player disguise a deadline rewrite as a pause', async () => {
    await seed('day', 0, 1, 'practice');
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), {
      pausedAt: 1000,
      discussionEndsAt: 999_000,
    }));
  });
});

describe('a night action waits unless the referee consciously skips it', () => {
  it('lets only the referee skip the currently open night step', async () => {
    await seed('night', 3);
    await assertSucceeds(updateDoc(doc(as(REF), 'rooms', ROOM), {
      nightForceAdvanceIndex: 3,
    }));
  });

  it('refuses players, the host, and stale or future step numbers', async () => {
    await seed('night', 3);
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), {
      nightForceAdvanceIndex: 3,
    }));
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), {
      nightForceAdvanceIndex: 3,
    }));
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), {
      nightForceAdvanceIndex: 2,
    }));
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), {
      nightForceAdvanceIndex: 4,
    }));
  });

  it('cannot be armed outside the night', async () => {
    await seed('day', 3);
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), {
      nightForceAdvanceIndex: 3,
    }));
  });
});

describe('lobby seating', () => {
  it('lets a joining player add their own seat', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(CHARLIE), 'rooms', ROOM), {
      seating: [ALICE, BOB, CHARLIE],
    }));
  });

  it('lets a member rearrange seats to match the physical table', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(CHARLIE), 'rooms', ROOM), {
      seating: [BOB, ALICE, CHARLIE],
    }));
  });

  it('lets a lobby member clear a ghost seat so another phone can sit', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(CHARLIE), 'rooms', ROOM), {
      seating: [ALICE],
    }));
  });

  it('lets a joining member reclaim a seat held by another device', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(CHARLIE), 'rooms', ROOM), {
      seating: [ALICE, CHARLIE],
    }));
  });

  it('still refuses inventing a third party into the seating', async () => {
    await seed('lobby', 0, 0);
    await assertFails(updateDoc(doc(as(CHARLIE), 'rooms', ROOM), {
      seating: [ALICE, BOB, 'stranger-uid'],
    }));
  });
});

describe('secret cards', () => {
  it('a player cannot read another player\'s card', async () => {
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'private', ALICE)));
  });

  it('a player CAN read their own', async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms', ROOM, 'private', ALICE)));
  });

  it('a player cannot rewrite their own role', async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'private', ALICE), {
        originalRole: 'dorpeling',
      }),
    );
  });

  it('a player cannot fabricate a reveal for themselves', async () => {
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'private', ALICE), {
        privateInfo: [{ kind: 'saw-card', slot: 1, role: 'weerwolf' }],
      }),
    );
  });

  it('the referee can read and write everyone, which it must to resolve', async () => {
    await assertSucceeds(getDoc(doc(as(REF), 'rooms', ROOM, 'private', ALICE)));
    await assertSucceeds(getDoc(doc(as(REF), 'rooms', ROOM, 'private', BOB)));
    await assertSucceeds(
      updateDoc(doc(as(REF), 'rooms', ROOM, 'private', BOB), { currentCard: 'c9' }),
    );
  });
});

describe('the full deal', () => {
  it('is unreadable by players', async () => {
    await assertFails(getDoc(doc(as(ALICE), 'rooms', ROOM, 'engine', 'state')));
    await assertFails(getDoc(doc(as(HOST), 'rooms', ROOM, 'engine', 'state')));
  });

  it('is readable by the referee', async () => {
    await assertSucceeds(getDoc(doc(as(REF), 'rooms', ROOM, 'engine', 'state')));
  });
});

describe('night submissions', () => {
  it('cannot be read by another player — a target often reveals a role', async () => {
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'submissions', ALICE)));
  });

  it('can be written for the current window', async () => {
    await assertSucceeds(
      setDoc(doc(as(BOB), 'rooms', ROOM, 'submissions', BOB), {
        windowIndex: 0, choice: { kind: 'seat', seat: 0 },
      }),
    );
  });

  it('cannot be written for a window that has already closed', async () => {
    await seed('night', 1); // room has moved on to window 1
    await assertFails(
      setDoc(doc(as(BOB), 'rooms', ROOM, 'submissions', BOB), {
        windowIndex: 0, choice: { kind: 'seat', seat: 0 },
      }),
    );
  });

  it('cannot be submitted on somebody else\'s behalf', async () => {
    await assertFails(
      setDoc(doc(as(BOB), 'rooms', ROOM, 'submissions', ALICE), {
        windowIndex: 0, choice: { kind: 'seat', seat: 0 },
      }),
    );
  });

  it('cannot be deleted to hide what you did', async () => {
    await assertFails(deleteDoc(doc(as(ALICE), 'rooms', ROOM, 'submissions', ALICE)));
  });
});

describe('voting', () => {
  beforeEach(async () => { await seed('voting'); });

  it('rejects a self-vote at the rules level, not just in the UI', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: ALICE, abstain: false,
      }),
    );
  });

  it('accepts a normal vote', async () => {
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false,
      }),
    );
  });

  it('refuses changing a named vote after it is cast', async () => {
    const ref = doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE);
    await assertSucceeds(setDoc(ref, {
      round: 1, target: BOB, abstain: false,
    }));
    await assertFails(updateDoc(ref, { target: BOB, readyToVote: true }));
  });

  it('refuses abstaining once the ballot is open', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: true,
      }),
    );
  });

  it('lets the referee cast one missing vote through the takeover path', async () => {
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false, readyToVote: false,
        castAt: 1, takeoverPhrase: 'takeover',
      }),
    );
  });

  it('refuses emergency voting with the wrong phrase or by a player', async () => {
    const payload = {
      round: 1, target: BOB, abstain: false, readyToVote: false,
      castAt: 1, takeoverPhrase: 'wrong',
    };
    await assertFails(setDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE), payload));
    await assertFails(setDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE), {
      ...payload, takeoverPhrase: 'takeover',
    }));
  });

  it('never lets emergency control overwrite a final human vote', async () => {
    const vote = doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE);
    await assertSucceeds(setDoc(vote, {
      round: 1, target: BOB, abstain: false,
    }));
    await assertFails(setDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE), {
      round: 1, target: BOB, abstain: false, readyToVote: false,
      castAt: 2, takeoverPhrase: 'takeover',
    }));
  });

  it('refuses an emergency self-vote', async () => {
    await assertFails(setDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE), {
      round: 1, target: ALICE, abstain: false, readyToVote: false,
      castAt: 1, takeoverPhrase: 'takeover',
    }));
  });

  it('keeps votes hidden from other players while voting is open', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false,
      });
    });
    // Otherwise the last person to vote sees the tally before deciding.
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE)));
  });

  it('opens votes to everyone once the results are in', async () => {
    await seed('results');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false,
      });
    });
    await assertSucceeds(getDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE)));
  });

  it('cannot be cast before the voting phase', async () => {
    await seed('night');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false,
      }),
    );
  });
});

describe('the abstain toggle during the discussion (§7, revised 2026-08-26)', () => {
  beforeEach(async () => { await seed('day'); });

  it('accepts an abstain while the room is still discussing', async () => {
    // The toggle is live from the first second and a majority counts at ANY
    // moment — which happens in phase 'day'. A voting-only rule would silently
    // reject every abstain and the whole mechanic would appear to do nothing.
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: true,
      }),
    );
  });

  it('accepts switching the abstain back off — it is a show of hands', async () => {
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false,
      }),
    );
  });

  it('still refuses a named target during the discussion', async () => {
    // Letting somebody lock a target in early would quietly turn a simultaneous
    // vote into a first-mover one, even though nobody can read it yet.
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false,
      }),
    );
  });

  it('still refuses a self-vote, in either phase', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: ALICE, abstain: true,
      }),
    );
  });

  it('keeps abstains unreadable by other players', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: true,
      });
    });
    // The public count reaches the table via the room document, written by the
    // referee — never by players reading each other's votes.
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE)));
    await assertSucceeds(getDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE)));
  });
});

describe('obsolete per-player result documents are denied', () => {
  beforeEach(async () => { await seed('results'); });

  it('refuses the old result path, even to the referee', async () => {
    // The append-only round record is now the single source of truth. Per-player
    // documents were keyed only by uid, so a second round could not be published.
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'results', ALICE), {
        finalRole: 'alphawolf', won: false,
      }),
    );
  });

  it('also refuses a player writing their own result', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'results', ALICE), {
        finalRole: 'dorpeling', won: true,
      }),
    );
  });

  it('refuses updates and deletes to a legacy result document', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'results', ALICE), {
        finalRole: 'alphawolf', won: false,
      });
    });
    await assertFails(
      updateDoc(doc(as(REF), 'rooms', ROOM, 'results', ALICE), { won: true }),
    );
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'results', ALICE), { won: true }),
    );
    await assertFails(deleteDoc(doc(as(REF), 'rooms', ROOM, 'results', ALICE)));
  });
});

describe('profiles', () => {
  it('are readable by everyone — the stats-on-tap cover traffic needs it', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'profiles', ALICE), { displayName: 'Alice' });
    });
    await assertSucceeds(getDoc(doc(as(BOB), 'profiles', ALICE)));
  });

  it('can only be edited by their owner', async () => {
    await assertFails(
      setDoc(doc(as(BOB), 'profiles', ALICE), { displayName: 'hacked' }),
    );
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'profiles', ALICE), { displayName: 'Alice' }),
    );
  });

  it('reject smuggled-in stats fields — stats live only in results docs', async () => {
    await assertFails(
      setDoc(doc(as(ALICE), 'profiles', ALICE), {
        displayName: 'Alice', wins: 999,
      }),
    );
  });
});

describe('calibration telemetry', () => {
  it('accepts a timing sample', async () => {
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'calibration', 's1'), {
        role: 'dubbelganger', key: 'doppel-view', latencyMs: 4200,
        outcome: 'submitted', paused: false, sessionId: 'abc',
      }),
    );
  });

  it('rejects a sample carrying who was playing the role', async () => {
    // Samples are keyed by role NAME only. Attaching a uid would turn the
    // calibration collection into a public record of who played what.
    await assertFails(
      setDoc(doc(as(ALICE), 'calibration', 's2'), {
        role: 'dubbelganger', key: 'doppel-view', latencyMs: 4200,
        outcome: 'submitted', paused: false, sessionId: 'abc', playerUid: ALICE,
      }),
    );
  });

  it('is append-only', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'calibration', 's3'), {
        role: 'heks', key: 'heks-target', latencyMs: 1,
        outcome: 'submitted', paused: false, sessionId: 'x',
      });
    });
    await assertFails(
      updateDoc(doc(as(ALICE), 'calibration', 's3'), { latencyMs: 99999 }),
    );
  });
});

describe('signed-out access', () => {
  it('is denied everywhere', async () => {
    await assertFails(getDoc(doc(anon(), 'rooms', ROOM)));
    await assertFails(getDoc(doc(anon(), 'rooms', ROOM, 'private', ALICE)));
    await assertFails(getDoc(doc(anon(), 'profiles', ALICE)));
  });
});

describe('unknown collections are denied by default', () => {
  it('rejects writes to a path the rules never mention', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'anything', 'x'), { a: 1 }));
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'somethingNew', 'x'), { a: 1 }),
    );
  });
});

/* ==================================================================== */

describe('the seed a latecomer starts on cannot be typed', () => {
  // THE GAP THIS CLOSES. A player arriving mid-evening starts level with
  // whoever is currently last, so they join at the back of the pack rather
  // than below it. That number used to live in a `seeded` field on their own
  // member document — a document they own and can write. `seeded: 9999` from
  // devtools won the evening outright, and no rule in this file could tell
  // that write apart from an honest one: rules answer "may you write this",
  // never "was 9999 the correct floor at round four", which needs the whole
  // evening replayed. So the field is gone; the seed is derived from
  // joinedAtRound plus the append-only rounds (session.ts).

  const CARL = 'carl-uid';

  it('refuses a member document carrying a seed at all', async () => {
    // If this ever passes, the scoreboard is decorative.
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5, leftAtRound: null, seeded: 9999,
      }),
    );
  });

  it('refuses any field the schema does not name, seed-shaped or not', async () => {
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5, leftAtRound: null, points: 9999,
      }),
    );
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5, leftAtRound: null, wins: 12,
      }),
    );
  });

  it('accepts an honest join at the round actually being played', async () => {
    await seed('day', 0, 4);
    await assertSucceeds(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5, leftAtRound: null,
      }),
    );
  });

  it('refuses a join claiming a round the evening has not reached', async () => {
    // joinedAtRound is now the ONLY input a joiner has to their own seed, so
    // claiming round 99 is the same attack as the old seeded: 9999 — it seeds
    // you against a floor that does not exist yet.
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 99, leftAtRound: null,
      }),
    );
  });

  it('refuses a join backdated to an earlier round', async () => {
    // The mirror image, and worth blocking too: backdating would credit
    // somebody with an evening they were not at.
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 1, leftAtRound: null,
      }),
    );
  });

  it('refuses a joinedAtRound that is not a whole number', async () => {
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5.0001, leftAtRound: null,
      }),
    );
  });

  it('refuses a member document whose uid is not its own id', async () => {
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', CARL), {
        uid: ALICE, joinedAtRound: 5, leftAtRound: null,
      }),
    );
  });

  it('refuses joining on somebody else\'s behalf', async () => {
    await seed('day', 0, 4);
    await assertFails(
      setDoc(doc(as(CARL), 'rooms', ROOM, 'members', ALICE), {
        uid: ALICE, joinedAtRound: 5, leftAtRound: null,
      }),
    );
  });

  it('lets the host add somebody whose phone died', async () => {
    await seed('day', 0, 4);
    await assertSucceeds(
      setDoc(doc(as(HOST), 'rooms', ROOM, 'members', CARL), {
        uid: CARL, joinedAtRound: 5, leftAtRound: null,
      }),
    );
  });

  it('refuses to let an existing member re-seed themselves later', async () => {
    // Alice joined at round 1 on a floor of zero. Moving her joinedAtRound to
    // round 4 would re-seed her at the current floor — the same points-grab as
    // the old forgeable field, wearing a different hat.
    await seed('day', 0, 4);
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        joinedAtRound: 5,
      }),
    );
  });

  it('refuses to let a seed be smuggled in on an update', async () => {
    await seed('day', 0, 4);
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        seeded: 9999,
      }),
    );
  });

  it('refuses to let anyone delete a membership', async () => {
    // The rounds you played happened. Deleting the document that says you were
    // here is the tidiest way to rewrite an evening, so nobody may.
    await seed('day', 0, 4);
    await assertFails(deleteDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE)));
    await assertFails(deleteDoc(doc(as(HOST), 'rooms', ROOM, 'members', ALICE)));
    await assertFails(deleteDoc(doc(as(REF), 'rooms', ROOM, 'members', ALICE)));
  });
});

describe('going home, and coming back', () => {
  it('accepts leaving at the round now being played', async () => {
    await seed('day', 0, 4);
    await assertSucceeds(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        leftAtRound: 4,
      }),
    );
  });

  it('refuses backdating a departure to erase rounds you played', async () => {
    await seed('day', 0, 4);
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        leftAtRound: 2,
      }),
    );
  });

  it('lets somebody come back without changing what they joined on', async () => {
    await seed('day', 0, 4);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'members', ALICE), {
        uid: ALICE, joinedAtRound: 1, leftAtRound: 3,
      });
    });
    await assertSucceeds(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        leftAtRound: null,
      }),
    );
  });

  it('refuses a return that also moves the join round', async () => {
    // Coming back must re-use the original joinedAtRound, or stepping out for
    // one round becomes a way to top your score up off the bottom of the table.
    await seed('day', 0, 4);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'members', ALICE), {
        uid: ALICE, joinedAtRound: 1, leftAtRound: 3,
      });
    });
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
        uid: ALICE, joinedAtRound: 5, leftAtRound: null,
      }),
    );
  });

  it('refuses to send somebody else home', async () => {
    await seed('day', 0, 4);
    await assertFails(
      updateDoc(doc(as(BOB), 'rooms', ROOM, 'members', ALICE), {
        leftAtRound: 4,
      }),
    );
  });

  it('lets the referee mark a failed device as departed', async () => {
    await seed('day', 0, 4);
    await assertSucceeds(updateDoc(doc(as(REF), 'rooms', ROOM, 'members', ALICE), {
      leftAtRound: 4,
    }));
  });

  it('does not let host or referee rewrite a player profile while removing them', async () => {
    await seed('day', 0, 4);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'members', ALICE), {
        uid: ALICE, joinedAtRound: 1, leftAtRound: null,
        friendId: 'friend-alice', friendName: 'Alice',
      });
    });
    for (const actor of [HOST, REF]) {
      await assertFails(updateDoc(doc(as(actor), 'rooms', ROOM, 'members', ALICE), {
        leftAtRound: 4,
        friendId: 'friend-attacker',
        friendName: 'Attacker',
      }));
    }
  });

  it('lets a player correct only their own profile while still in the lobby', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
      friendId: 'friend-alice', friendName: 'Alice',
    }));
  });

  it('does not let another player correct your profile', async () => {
    await seed('lobby', 0, 0);
    await assertFails(updateDoc(doc(as(BOB), 'rooms', ROOM, 'members', ALICE), {
      friendId: 'friend-alice', friendName: 'Alice',
    }));
  });

  it('freezes profile identity once the round starts', async () => {
    await seed('night', 0, 1);
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
      friendId: 'friend-alice', friendName: 'Alice',
    }));
  });

  it('lets a player explicitly become a guest in the lobby', async () => {
    await seed('lobby', 0, 0);
    await assertSucceeds(updateDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE), {
      friendId: '', friendName: 'Bezoeker',
    }));
  });
});

describe('round records are the scoreboard, so they are append-only', () => {
  const ROUND = { round: 4, activeRoles: ['weerwolf'], seatCount: 4,
    outcome: 'eliminated', results: [], recordedAt: 1 };

  it('the referee can record the round that was just played', async () => {
    await seed('results', 0, 4);
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '4'), ROUND),
    );
  });

  it('a player cannot record a round — that is writing your own score', async () => {
    await seed('results', 0, 4);
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'rounds', '4'), ROUND),
    );
  });

  it('not even the host can', async () => {
    await seed('results', 0, 4);
    await assertFails(
      setDoc(doc(as(HOST), 'rooms', ROOM, 'rounds', '4'), ROUND),
    );
  });

  it('refuses a record filed under an id that is not its round number', async () => {
    // Create-only stops a round being overwritten; binding the id is what
    // stops the same round being recorded twice under a second name.
    await seed('results', 0, 4);
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'rounds', 'extra'), ROUND),
    );
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '5'), ROUND),
    );
  });

  it('refuses a record for a round the evening is not on', async () => {
    await seed('results', 0, 4);
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '9'), { ...ROUND, round: 9 }),
    );
  });

  it('refuses extra fields — a round carries results, not totals', async () => {
    await seed('results', 0, 4);
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '4'), { ...ROUND, points: 99 }),
    );
  });

  it('cannot be edited or deleted afterwards, by anyone', async () => {
    await seed('results', 0, 4);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'rounds', '4'), ROUND);
    });
    await assertFails(
      updateDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '4'), { outcome: 'won' }),
    );
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM, 'rounds', '4'), { outcome: 'won' }),
    );
    await assertFails(deleteDoc(doc(as(REF), 'rooms', ROOM, 'rounds', '4')));
    await assertFails(deleteDoc(doc(as(HOST), 'rooms', ROOM, 'rounds', '4')));
  });

  it('is readable by everyone — the scoreboard is built from it client-side', async () => {
    await seed('results', 0, 4);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'rounds', '4'), ROUND);
    });
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms', ROOM, 'rounds', '4')));
    await assertSucceeds(getDoc(doc(as(BOB), 'rooms', ROOM, 'members', ALICE)));
  });
});

describe('the round counter only ever goes forward', () => {
  it('the referee can advance it, which is the legitimate case', async () => {
    await seed('results', 0, 4);
    await assertSucceeds(
      updateDoc(doc(as(REF), 'rooms', ROOM), { currentRound: 5 }),
    );
  });

  it('nobody can wind it back', async () => {
    // Rewinding would let a member be admitted again against a floor the
    // evening has already moved past — the derived seed's one soft spot.
    await seed('results', 0, 4);
    await assertFails(
      updateDoc(doc(as(REF), 'rooms', ROOM), { currentRound: 2 }),
    );
    await assertFails(
      updateDoc(doc(as(HOST), 'rooms', ROOM), { currentRound: 2 }),
    );
  });

  it('cannot skip ahead and manufacture a later join boundary', async () => {
    await seed('results', 0, 4);
    await assertFails(
      updateDoc(doc(as(REF), 'rooms', ROOM), { currentRound: 99 }),
    );
  });
});

/* ==================================================================== */

describe('whether an evening counts is decided once', () => {
  it('a room may be created either way', async () => {
    await env.clearFirestore();
    for (const mode of ['practice', 'official'] as const) {
      await assertSucceeds(
        setDoc(doc(as(HOST), 'rooms', `R${mode}`), {
          hostUid: HOST, refereeUid: REF, phase: 'lobby', mode,
          currentRound: 0,
          discussionMs: 15 * 60_000,
          discussionEndsAt: null,
          practiceSkipDiscussion: false,
        }),
      );
    }
  });

  it('refuses a missing or unreasonable discussion timer', async () => {
    await env.clearFirestore();
    const base = {
      hostUid: HOST, refereeUid: REF, phase: 'lobby', mode: 'practice',
      currentRound: 0, discussionEndsAt: null, practiceSkipDiscussion: false,
    };
    await assertFails(setDoc(doc(as(HOST), 'rooms', 'NO-TIMER'), base));
    await assertFails(setDoc(doc(as(HOST), 'rooms', 'TOO-LONG'), {
      ...base, discussionMs: 121 * 60_000,
    }));
    await assertSucceeds(setDoc(doc(as(HOST), 'rooms', 'ONE-MINUTE'), {
      ...base, discussionMs: 60_000,
    }));
  });

  it('refuses a room that does not say which it is', async () => {
    await env.clearFirestore();
    await assertFails(
      setDoc(doc(as(HOST), 'rooms', 'RX'), {
        hostUid: HOST, refereeUid: REF, phase: 'lobby', currentRound: 0,
      }),
    );
  });

  it('refuses promoting a practice evening to official afterwards', async () => {
    // The one that matters. A room that could be promoted would let a good
    // night be retconned into the record — and a bad one quietly demoted.
    await seed('results', 0, 4, 'practice');
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { mode: 'official' }));
    await assertFails(updateDoc(doc(as(REF), 'rooms', ROOM), { mode: 'official' }));
    await assertFails(updateDoc(doc(as(ALICE), 'rooms', ROOM), { mode: 'official' }));
  });

  it('refuses demoting an official evening too', async () => {
    await seed('results', 0, 4, 'official');
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { mode: 'practice' }));
  });

  it('still lets the referee move the phase, which is the legitimate case', async () => {
    await seed('day', 0, 4, 'official');
    await assertSucceeds(updateDoc(doc(as(REF), 'rooms', ROOM), { phase: 'voting' }));
  });
});

describe('the shared address book', () => {
  const FRIEND = { id: 'f:milan', displayName: 'Milan', createdAt: 1 };

  it('lets anybody add a friend, because it is an address book', async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as(ALICE), 'friends', 'f:milan'), FRIEND));
  });

  it('refuses a friend whose id does not match its document', async () => {
    // Otherwise two ids point at one row and two histories silently merge.
    await seed();
    await assertFails(
      setDoc(doc(as(ALICE), 'friends', 'f:milan'), { ...FRIEND, id: 'f:someone' }),
    );
  });

  it('refuses a score smuggled onto a friend', async () => {
    await seed();
    await assertFails(
      setDoc(doc(as(ALICE), 'friends', 'f:milan'), { ...FRIEND, points: 9999 }),
    );
    await assertFails(
      setDoc(doc(as(ALICE), 'friends', 'f:milan'), { ...FRIEND, wins: 40 }),
    );
  });

  it('refuses a nameless friend', async () => {
    await seed();
    await assertFails(
      setDoc(doc(as(ALICE), 'friends', 'f:milan'), { ...FRIEND, displayName: '' }),
    );
  });

  it('allows a rename but never moves the id', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'friends', 'f:milan'), FRIEND);
    });
    await assertSucceeds(
      updateDoc(doc(as(BOB), 'friends', 'f:milan'), { displayName: 'Milan M' }),
    );
    await assertFails(
      updateDoc(doc(as(BOB), 'friends', 'f:milan'), { id: 'f:other' }),
    );
  });

  it('never lets a friend be deleted', async () => {
    // The history rows would survive and point at nobody.
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'friends', 'f:milan'), FRIEND);
    });
    await assertFails(deleteDoc(doc(as(ALICE), 'friends', 'f:milan')));
  });
});

describe('the all-time record cannot be forged', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    roomId: ROOM, round: 4, friendId: 'f:milan', name: 'Milan', seat: 0,
    originalRole: 'ziener', finalRole: 'ziener', won: true,
    voteOutcome: 'correct', suspicionAccuracy: null, recordedAt: 1,
    ...over,
  });
  const id = (roomId = ROOM, round = 4, friendId = 'f:milan') =>
    `${roomId}_${round}_${friendId}`;
  const seedRound = async () => env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'rounds', '4'), {
      round: 4, activeRoles: ['ziener'], seatCount: 2,
      outcome: 'eliminated', results: [], recordedAt: 1,
    });
  });

  it('the referee of an official evening can record it', async () => {
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertSucceeds(setDoc(doc(as(REF), 'history', id()), entry()));
  });

  it('a player cannot write their own history row', async () => {
    // This is a player writing their own all-time scoreboard.
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertFails(setDoc(doc(as(ALICE), 'history', id()), entry()));
  });

  it('not even the host can', async () => {
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertFails(setDoc(doc(as(HOST), 'history', id()), entry()));
  });

  it('a PRACTICE evening reaches the record through nobody', async () => {
    // The whole point of the mode. Testing must never touch real history, and
    // this is checked against the room rather than trusted from the write.
    await seed('results', 0, 4, 'practice');
    await seedRound();
    await assertFails(setDoc(doc(as(REF), 'history', id()), entry()));
  });

  it('refuses a row filed under an id that is not its own room/round/friend', async () => {
    // Create-only stops a row being overwritten; binding the id is what stops
    // the same round being counted twice under another name.
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertFails(setDoc(doc(as(REF), 'history', 'anything'), entry()));
    await assertFails(setDoc(doc(as(REF), 'history', id(ROOM, 9)), entry()));
    await assertFails(
      setDoc(doc(as(REF), 'history', id(ROOM, 4, 'f:someone')), entry()),
    );
  });

  it('refuses a smuggled points field', async () => {
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertFails(
      setDoc(doc(as(REF), 'history', id()), entry({ points: 9999 })),
    );
  });

  it('refuses a row with no friend to belong to', async () => {
    await seed('results', 0, 4, 'official');
    await seedRound();
    await assertFails(
      setDoc(doc(as(REF), 'history', `${ROOM}_4_`), entry({ friendId: '' })),
    );
  });

  it('refuses a history row when no matching finished round exists', async () => {
    await seed('results', 0, 4, 'official');
    await assertFails(setDoc(doc(as(REF), 'history', id()), entry()));
  });

  it('is immutable once written, by anybody', async () => {
    await seed('results', 0, 4, 'official');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'history', id()), entry());
    });
    await assertFails(updateDoc(doc(as(REF), 'history', id()), { won: false }));
    await assertFails(updateDoc(doc(as(ALICE), 'history', id()), { won: false }));
    await assertFails(deleteDoc(doc(as(REF), 'history', id())));
    await assertFails(deleteDoc(doc(as(HOST), 'history', id())));
  });

  it('is readable by everyone, because the table is the whole point', async () => {
    await seed('results', 0, 4, 'official');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'history', id()), entry());
    });
    await assertSucceeds(getDoc(doc(as(ALICE), 'history', id())));
  });
});

describe('a member carries a friend label and nothing worth points', () => {
  it('accepts a join carrying who this person is', async () => {
    await seed('day', 0, 4, 'official');
    await assertSucceeds(
      setDoc(doc(as('carl-uid'), 'rooms', ROOM, 'members', 'carl-uid'), {
        uid: 'carl-uid', joinedAtRound: 5, leftAtRound: null,
        friendId: 'f:carl', friendName: 'Carl',
      }),
    );
  });

  it('still refuses a seed alongside it', async () => {
    await seed('day', 0, 4, 'official');
    await assertFails(
      setDoc(doc(as('carl-uid'), 'rooms', ROOM, 'members', 'carl-uid'), {
        uid: 'carl-uid', joinedAtRound: 5, leftAtRound: null,
        friendId: 'f:carl', friendName: 'Carl', seeded: 9999,
      }),
    );
  });
});

/* ==================================================================== */

describe('a night prompt reaches exactly one seat', () => {
  // pendingDecisions is how a player learns what it is being asked: the
  // questions come from the deal, and the deal never leaves the referee. It
  // rides on the private document, so the property to prove is that it
  // inherits that document's privacy rather than quietly widening it.

  const prompt = [{
    seat: 0, actingAs: 'ziener', step: 1, key: 'ziener-target',
    prompt: { kind: 'seat', exclude: [], optional: false },
    dependsOnReveal: false,
  }];

  it('the referee can publish one to a seat', async () => {
    await seed('night');
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'private', ALICE),
        { pendingDecisions: prompt }, { merge: true }),
    );
  });

  it('a player cannot read somebody else\'s question', async () => {
    // Knowing WHAT another seat is being asked is knowing what role it has.
    await seed('night');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'private', ALICE),
        { originalRole: 'ziener', pendingDecisions: prompt }, { merge: true });
    });
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'private', ALICE)));
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms', ROOM, 'private', ALICE)));
  });

  it('a player cannot write themselves a question', async () => {
    // Forging a prompt is forging a turn.
    await seed('night');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'private', ALICE),
        { pendingDecisions: prompt }, { merge: true }),
    );
  });

  it('a player cannot plant one on somebody else', async () => {
    await seed('night');
    await assertFails(
      setDoc(doc(as(BOB), 'rooms', ROOM, 'private', ALICE),
        { pendingDecisions: prompt }, { merge: true }),
    );
  });

  it('not even the host may publish prompts', async () => {
    // The host runs the room; the referee runs the night. Only one of them
    // holds the deal.
    await seed('night');
    await assertFails(
      setDoc(doc(as(HOST), 'rooms', ROOM, 'private', ALICE),
        { pendingDecisions: prompt }, { merge: true }),
    );
  });

  it('the referee can clear it, which is how a stale question disappears', async () => {
    await seed('night');
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'private', ALICE),
        { pendingDecisions: [] }, { merge: true }),
    );
  });
});

describe('what the table can see', () => {
  // revealedSlots is the public face-up state, republished by the referee
  // after every window so a reveal follows its card. It lives on the room
  // document, which everybody reads — so the thing to prove is that only the
  // referee writes it.

  it('the referee can publish it', async () => {
    await seed('night');
    await assertSucceeds(
      updateDoc(doc(as(REF), 'rooms', ROOM), {
        revealedSlots: { 2: 'ziener' }, shieldedSeats: [1],
      }),
    );
  });

  it('a player cannot flip a card face up', async () => {
    // Claiming a card is publicly revealed is claiming to know what it is.
    await seed('night');
    await assertFails(
      updateDoc(doc(as(ALICE), 'rooms', ROOM), { revealedSlots: { 0: 'weerwolf' } }),
    );
  });

  it('a player cannot shield a seat either', async () => {
    await seed('night');
    await assertFails(
      updateDoc(doc(as(BOB), 'rooms', ROOM), { shieldedSeats: [0, 1, 2] }),
    );
  });

  it('everybody can read it, because it is what is on the table', async () => {
    await seed('night');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'rooms', ROOM), {
        revealedSlots: { 2: 'ziener' },
      });
    });
    await assertSucceeds(getDoc(doc(as(ALICE), 'rooms', ROOM)));
    await assertSucceeds(getDoc(doc(as(BOB), 'rooms', ROOM)));
  });

  it('publishing it still cannot smuggle the referee role across', async () => {
    // The load-bearing rule holds regardless of what else is in the write.
    await seed('night');
    await assertFails(
      updateDoc(doc(as(REF), 'rooms', ROOM), {
        revealedSlots: { 2: 'ziener' }, refereeUid: ALICE,
      }),
    );
  });
});

/* ==================================================================== */

describe('asking to open the ballot early', () => {
  // A decision about the CLOCK rather than the outcome. It rides on the vote
  // document, so the properties to prove are that it inherits a vote's privacy
  // and cannot be used to smuggle a target in before voting opens.

  it('refuses asking to vote and abstaining at the same time', async () => {
    await seed('day');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: true, readyToVote: true,
      }),
    );
  });

  it('is accepted during the discussion', async () => {
    await seed('day');
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: true,
      }),
    );
  });

  it('can be withdrawn, because it is a show of hands', async () => {
    await seed('day');
    await assertSucceeds(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: false,
      }),
    );
  });

  it('cannot smuggle a target in during the discussion', async () => {
    // The refusal that matters. Asking to vote must not become a way to lock
    // a target in early — that would quietly turn a simultaneous vote into a
    // first-mover one.
    await seed('day');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false, readyToVote: true,
      }),
    );
  });

  it('still refuses a self-vote alongside it', async () => {
    await seed('voting');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: ALICE, abstain: false, readyToVote: true,
      }),
    );
  });

  it('cannot be asked on somebody else\'s behalf', async () => {
    await seed('day');
    await assertFails(
      setDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: true,
      }),
    );
  });

  it('stays as private as the vote it rides on', async () => {
    // Who asked is information about how confident somebody is feeling. Only
    // the count is ever public, and the count lives on the room document.
    await seed('day');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: true,
      });
    });
    await assertFails(getDoc(doc(as(BOB), 'rooms', ROOM, 'votes', ALICE)));
    await assertSucceeds(getDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE)));
  });

  it('refuses a field the vote schema does not name', async () => {
    await seed('day');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: true, points: 99,
      }),
    );
  });

  it('cannot be cast before the day begins', async () => {
    await seed('night');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: null, abstain: false, readyToVote: true,
      }),
    );
  });
});

describe('AI players, and the narrow capability that answers for them', () => {
  const BOT = 'bot-room1-1';

  /** A practice lobby with one AI player already in it. */
  async function withBot(phase = 'lobby') {
    await seed(phase, 0, phase === 'lobby' ? 0 : 1, 'practice');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'rooms', ROOM, 'players', BOT), {
        displayName: 'AI Bram', avatar: null, joinedAt: 1, isBot: true,
      });
      await setDoc(doc(db, 'rooms', ROOM, 'members', BOT), {
        uid: BOT, joinedAtRound: 1, leftAtRound: null, friendId: '', friendName: 'AI Bram',
      });
    });
  }

  const botPlayer = { displayName: 'AI Fleur', avatar: null, joinedAt: 1, isBot: true };

  /* ---------------------------- creating one ---------------------------- */

  it('lets the controlling browser add one to a practice lobby', async () => {
    await seed('lobby', 0, 0, 'practice');
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'players', 'bot-room1-9'), botPlayer),
    );
  });

  it('refuses a player marking their OWN document as a bot', async () => {
    // The attack this rule exists for. A human flagged isBot is a human the
    // controlling browser is then allowed to vote on behalf of.
    await seed('lobby', 0, 0, 'practice');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'players', ALICE), {
        displayName: 'Alice', avatar: null, joinedAt: 1, isBot: true,
      }),
    );
  });

  it('refuses a bot created by anybody but the controlling browser', async () => {
    await seed('lobby', 0, 0, 'practice');
    await assertFails(
      setDoc(doc(as(HOST), 'rooms', ROOM, 'players', 'bot-room1-9'), botPlayer),
    );
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'players', 'bot-room1-9'), botPlayer),
    );
  });

  it('refuses a bot in an official evening, by anybody at all', async () => {
    // Official rounds are the append-only input to every all-time statistic
    // and there is no delete path: an invented player in one is permanent.
    await seed('lobby', 0, 0, 'official');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'players', 'bot-room1-9'), botPlayer),
    );
  });

  it('refuses a bot added once the cards are dealt', async () => {
    await seed('night', 0, 1, 'practice');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'players', 'bot-room1-9'), botPlayer),
    );
  });

  it('refuses a bot membership for a uid that is not a bot', async () => {
    await seed('lobby', 0, 0, 'practice');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'members', CHARLIE), {
        uid: CHARLIE, joinedAtRound: 1, leftAtRound: null, friendId: '', friendName: 'AI',
      }),
    );
  });

  /* ---------------------------- removing one ---------------------------- */

  it('lets the controlling browser remove one, player and membership both', async () => {
    await withBot();
    await assertSucceeds(deleteDoc(doc(as(REF), 'rooms', ROOM, 'members', BOT)));
    await assertSucceeds(deleteDoc(doc(as(REF), 'rooms', ROOM, 'players', BOT)));
  });

  it('refuses removing a HUMAN membership, which is history', async () => {
    // The rule that replaced `allow delete: if false`. A round somebody played
    // happened, and the scoreboard is rebuilt from these documents.
    await withBot();
    await assertFails(deleteDoc(doc(as(REF), 'rooms', ROOM, 'members', ALICE)));
    await assertFails(deleteDoc(doc(as(HOST), 'rooms', ROOM, 'members', ALICE)));
    await assertFails(deleteDoc(doc(as(ALICE), 'rooms', ROOM, 'members', ALICE)));
  });

  it('refuses removing a bot once the game has started', async () => {
    await withBot('night');
    await assertFails(deleteDoc(doc(as(REF), 'rooms', ROOM, 'members', BOT)));
  });

  it('refuses a player removing a bot', async () => {
    await withBot();
    await assertFails(deleteDoc(doc(as(ALICE), 'rooms', ROOM, 'members', BOT)));
  });

  /* --------------------------- voting for one --------------------------- */

  it('lets the controlling browser cast a bot vote once the ballot is open', async () => {
    await withBot('voting');
    await assertSucceeds(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: ALICE, abstain: false, castAt: 1,
      }),
    );
  });

  it('REFUSES the controlling browser casting a vote for a human', async () => {
    // The single most important refusal in this file. If this ever succeeds,
    // the referee decides everyone's vote while the table is still arguing.
    await withBot('voting');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', ALICE), {
        round: 1, target: BOB, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a bot vote in an official evening', async () => {
    await seed('voting', 0, 1, 'official');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'players', BOT), {
        displayName: 'AI Bram', avatar: null, joinedAt: 1, isBot: true,
      });
    });
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: ALICE, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a bot naming itself', async () => {
    await withBot('voting');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: BOT, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a bot target during the discussion, exactly as for a human', async () => {
    await withBot('day');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: ALICE, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a bot vote before the day begins', async () => {
    await withBot('night');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: ALICE, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a player voting on a bot\'s behalf', async () => {
    await withBot('voting');
    await assertFails(
      setDoc(doc(as(ALICE), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: BOB, abstain: false, castAt: 1,
      }),
    );
  });

  it('refuses a field the vote schema does not name, bot or not', async () => {
    await withBot('voting');
    await assertFails(
      setDoc(doc(as(REF), 'rooms', ROOM, 'votes', BOT), {
        round: 1, target: ALICE, abstain: false, castAt: 1, points: 99,
      }),
    );
  });

  /* ------------------------------- privacy ------------------------------ */

  it('gives a bot no reading of anybody\'s role', async () => {
    // A bot has no login, so there is nothing to authenticate as — but the
    // property worth stating is that adding one changed no read boundary.
    await withBot('night');
    await assertFails(getDoc(doc(as(ALICE), 'rooms', ROOM, 'private', BOB)));
    await assertFails(getDoc(doc(as(HOST), 'rooms', ROOM, 'private', ALICE)));
  });
});
