import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { readRoomOnce } from '../app/refereeRunner.js';
import { FirestoreBackend } from '../firestore/backend.js';
import type { SeatIndex } from '../engine/types.js';
import { createAiRoom, playAiRound } from './host.js';
import { scriptedAgent } from './scripted.js';
import { driveHuman, VirtualClock, type HumanPlayer } from './simulate.js';

/**
 * AI seats + humans in a REAL Firestore room, under the real security rules
 * (emulator). Run with `npm run test:rules`.
 */

const apps: FirebaseApp[] = [];
let serial = 0;

async function device(label: string): Promise<FirestoreBackend> {
  const n = ++serial;
  const app = initializeApp({ apiKey: `ai-${n}`, appId: `ai-${n}`, projectId: 'dageraad-rules-test' }, `ai-${label}-${n}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const credential = await signInAnonymously(auth);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return new FirestoreBackend(db, credential.user.uid);
}

afterAll(async () => { await Promise.all(apps.map((app) => deleteApp(app))); });

function stubHuman(name: string): HumanPlayer {
  return {
    name,
    async night({ request, names, seat }) {
      const others = names.map((_, s) => s).filter((s) => s !== seat);
      switch (request.prompt.kind) {
        case 'seat': return { kind: 'seat', seat: others[0]! };
        case 'two-seats': return { kind: 'seats', seats: [others[0]!, others[1]!] };
        case 'center': return { kind: 'center', centerIndices: [0] };
        case 'seat-or-center': return { kind: 'center', centerIndices: [0, 1] };
        case 'dorpsgek': return { kind: 'dorpsgek', direction: 'none' };
        case 'confirm': return { kind: 'bool', value: true };
      }
    },
    async speak() { return null; },
    async vote({ seat, names }) { return ((seat + 1) % names.length) as SeatIndex; },
  };
}

describe('AI table in a real Firestore room', () => {
  it('plays a full round: table device + 3 AI seats + 2 humans on their own devices', async () => {
    const tablet = await device('table');
    const roomId = await createAiRoom(tablet, { ais: 3, discussionMs: 60_000 });
    const humans = [await device('rieks'), await device('milan')];
    await humans[0]!.joinRoom(roomId, 'Rieks');
    await humans[1]!.joinRoom(roomId, 'Milan');

    const clock = new VirtualClock();
    const stops: (() => void)[] = [];
    const { log, run } = await playAiRound(tablet, roomId, {
      seed: 777, clock, rounds: 1, autoVote: true,
      agentFor: (i) => scriptedAgent(i + 1),
      onTable: (table) => {
        void readRoomOnce(tablet, roomId).then((room) => {
          humans.forEach((h, i) => {
            const seat = room.seating.indexOf(h.uid);
            stops.push(driveHuman(stubHuman(i === 0 ? 'Rieks' : 'Milan'), h, roomId, seat, table, clock));
          });
        });
      },
    });
    stops.forEach((stop) => stop());

    expect(run.day.missingVotes).toEqual([]);
    expect(run.resultsPersisted).toBe(false);
    const setup = log.events.find((e) => e.t === 'setup');
    expect(setup?.t === 'setup' && setup.seats.filter((s) => s.kind === 'ai')).toHaveLength(3);
    const room = await readRoomOnce(humans[0]!, roomId);
    expect(room.phase).toBe('results');
    expect(room.outcome).toBe(run.outcome);
  }, 90_000);
});
