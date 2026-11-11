# AI players (experimental)

LLM and scripted players for Dageraad. This module lives only on the
`cursor/ai-players-b6bb` branch. Nothing in the app imports it, so it is not
part of the Vite build.

## Commands

```bash
npm run ai:sim  -- --players 7 --ai mock                    # AI vs AI, headless
npm run ai:sim  -- --village openai --wolves anthropic --games 10 --swap
npm run ai:play -- --ais 5 --name Rieks --ai mock           # you vs AIs in the terminal
npm run ai:host -- --ais 3 --ai anthropic [--emulator]      # AI seats in a real room with humans
```

Runs are written to `ai-runs/` (gitignored). Each run has `transcript.md`, an
omniscient replay with private reasoning; `events.jsonl`; and `result.json`,
with token usage and cost.

## Providers (`--ai SPEC`)

| Spec | Env |
|---|---|
| `mock` | none (deterministic, seeded) |
| `anthropic[:model]` | `ANTHROPIC_API_KEY` |
| `openai[:model]` | `OPENAI_API_KEY` |
| `compat:model` | `AI_BASE_URL`, `AI_API_KEY` (any OpenAI-compatible API) |
| `auto` (default) | Anthropic if its key is set, else OpenAI, else mock |

Keys are read from the environment only. They are never logged and never put
in a prompt.

## Layout

- `table.ts`: `AiTable`. It sits beside the referee on the table device and
  captures what the referee releases to each seat. From that it builds a
  `SeatKnowledge` per seat. **`SeatKnowledge` is the anti-leak boundary:** it
  has no field for the night state. An agent never sees more than its own
  phone would. AI night decisions start when the window opens. If one is still
  running when the window closes, it is answered by the scripted fallback after
  `nightGraceMs`, so a slow model cannot stretch the night (a timing leak).
- `llmagent.ts`: prompts (Dutch) and JSON parsing. It retries once, then falls
  back to the scripted agent.
- `llm.ts`: OpenAI and Anthropic clients over plain `fetch`, plus the price
  table.
- `scripted.ts`: the deterministic mock agent.
- `rules.ts`: rules text per role.
- `choices.ts`: validates model output against the prompt.
- `simulate.ts`: full games on `MemoryWorld` with a virtual clock.
- `host.ts`: practice rooms on a real `Backend` (Firestore).
- `replay.ts`: the Markdown replay.

## Engine changes outside this folder

These are kept to the minimum:

- `Bot.choose` may return a Promise. `referee.ts` awaits it.
- `BotSeats.vote` is optional. It lets an AI pick its own ballot. Without it,
  bots vote at random as before, with the same call order on `random()`.

AI seats exist only in practice rooms, so stats and calibration never see
them.
