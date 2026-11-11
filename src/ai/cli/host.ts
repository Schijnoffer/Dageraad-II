/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import type { Backend } from '../../app/backend.js';
import { readRoomOnce } from '../../app/refereeRunner.js';
import { firebaseConfig } from '../../firebase/config.js';
import { connect } from '../../firestore/client.js';
import { FirestoreBackend } from '../../firestore/backend.js';
import { agentFromSpec } from '../agents.js';
import { createAiRoom, playAiRound } from '../host.js';
import { renderReplay, toJsonl } from '../replay.js';
import type { AiTable } from '../table.js';

/**
 * AI seats in a real room, with humans on their phones.
 *
 *   ANTHROPIC_API_KEY=… npm run ai:host -- --ais 3 --ai anthropic
 *
 * This terminal is the TABLE DEVICE (referee, no seat). It prints a room
 * code; humans open the normal Dageraad link on their phones and join with
 * it. Lines you type here are what the humans say out loud ("Rieks: ik ben de
 * Ziener"), so the AIs can hear them. /stem opens the ballot, /stop quits.
 *
 * Practice rooms only, so nothing reaches anyone's all-time stats.
 */

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), 'true');
    else { out.set(a.slice(2), next); i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  const ais = Number(a.get('ais') ?? 3);
  const spec = a.get('ai') ?? 'auto';
  const rounds = Number(a.get('rounds') ?? 2);
  const discussionMinutes = Number(a.get('minutes') ?? 8);
  const appUrl = a.get('url') ?? `https://${firebaseConfig.projectId}.web.app`;

  const backend: Backend = a.has('emulator') ? await emulatorBackend() : await liveBackend();

  const roomId = a.get('room') ?? await createAiRoom(backend, { ais, discussionMs: discussionMinutes * 60_000 });
  console.log(`\nKamer: ${roomId}  →  ${appUrl}/#/${roomId}`);
  console.log(`${ais} AI-spelers zitten klaar (${spec}). Laat iedereen meedoen via de app.`);

  const rl = createInterface({ input: process.stdin });
  let table: AiTable | null = null;
  let waitingForStart: (() => void) | null = null;
  let quit = false;

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) { waitingForStart?.(); return; }
    if (text === '/stop') { quit = true; waitingForStart?.(); return; }
    if (text === '/stem') { void backend.forcePracticeVote(roomId).catch((e) => console.log(String(e))); return; }
    if (text === '/start') { waitingForStart?.(); return; }
    if (!table) { console.log('(Nog geen ronde bezig. Enter of /start om te delen.)'); return; }
    const m = /^([^:]{1,30}):\s*(.+)$/.exec(text);
    const [name, said] = m ? [m[1]!.trim(), m[2]!] : ['Tafel', text];
    const seat = table.seatNames().findIndex((n) => n.toLowerCase() === name.toLowerCase());
    void table.humanMessage(name, said, seat >= 0 ? seat : null);
  });

  for (let round = 1; !quit; round++) {
    console.log('\nDruk Enter (of /start) als iedereen zit. /stop om te stoppen.');
    await new Promise<void>((resolve) => { waitingForStart = resolve; });
    waitingForStart = null;
    if (quit) break;
    const room = await readRoomOnce(backend, roomId);
    console.log(`Ronde ${round}: ${room.seating.length} spelers. Delen…`);
    const seed = Date.now() % 1_000_000;
    const { log, run } = await playAiRound(backend, roomId, {
      seed, rounds,
      agentFor: (i) => agentFromSpec(spec, seed * 97 + i, process.env),
      onTable: (t) => { table = t; },
      onPhase: (phase) => {
        if (phase === 'night') console.log('Nacht. De AI-spelers kiezen hun acties.');
        if (phase === 'day') {
          console.log('Dag. Typ wat mensen zeggen als "Naam: tekst". /stem opent de stemming.');
        }
        if (phase === 'voting') console.log('Stemming open. AI-spelers stemmen.');
      },
      onPublic: (m) => console.log(`  ${m.name}: ${m.text}`),
    });
    table = null;
    console.log(`\nUitslag: ${run.outcome} · winnaars: ${run.results.winningTeams.join(', ') || 'niemand'}`);
    const dir = join('ai-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-host-${roomId}-r${round}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.md'), renderReplay(log, `Dageraad — kamer ${roomId}, ronde ${round}`));
    writeFileSync(join(dir, 'events.jsonl'), toJsonl(log));
    console.log(`Replay: ${dir}/transcript.md`);
  }
  rl.close();
  process.exit(0);
}

async function liveBackend(): Promise<Backend> {
  console.log('Verbinden met Firebase (anoniem)…');
  const connection = await connect(firebaseConfig);
  return new FirestoreBackend(connection.db, connection.uid);
}

/** Local Firestore + Auth emulators (`firebase emulators:start --only firestore,auth`). */
async function emulatorBackend(): Promise<Backend> {
  console.log('Verbinden met de lokale Firebase-emulator…');
  const app = initializeApp({ apiKey: 'emulator', appId: 'emulator', projectId: 'dageraad-rules-test' }, 'ai-host');
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const credential = await signInAnonymously(auth);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return new FirestoreBackend(db, credential.user.uid);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
