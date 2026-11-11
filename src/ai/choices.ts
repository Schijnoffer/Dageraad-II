import type { Choice, DecisionRequest } from '../engine/types.js';

/**
 * Turn a model's JSON answer into a LEGAL engine Choice, or null.
 *
 * The engine already ignores nonsense, but an illegal answer silently becoming
 * "did nothing" would hide a broken prompt. Returning null lets the caller log
 * the fallback instead.
 */
export function toChoice(
  raw: Record<string, unknown>,
  request: DecisionRequest,
  seatCount: number,
): Choice | null {
  const p = request.prompt;
  const isSeat = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < seatCount;
  const centers = (v: unknown, count: number): number[] | null => {
    const list = Array.isArray(v) ? v : typeof v === 'number' ? [v] : null;
    if (!list) return null;
    const unique = [...new Set(list.map(Number))];
    if (unique.length !== count) return null;
    if (!unique.every((c) => Number.isInteger(c) && c >= 0 && c <= 2)) return null;
    return unique;
  };

  switch (p.kind) {
    case 'seat': {
      if (raw.seat === null && p.optional) return { kind: 'none' };
      const seat = Number(raw.seat);
      if (!isSeat(seat) || p.exclude.includes(seat)) return null;
      return { kind: 'seat', seat };
    }
    case 'seat-or-center': {
      if (raw.center !== undefined && raw.center !== null) {
        const c = centers(raw.center, p.centerCount);
        return c ? { kind: 'center', centerIndices: c } : null;
      }
      const seat = Number(raw.seat);
      if (!isSeat(seat) || p.exclude.includes(seat)) return null;
      return { kind: 'seat', seat };
    }
    case 'two-seats': {
      if (!Array.isArray(raw.seats) || raw.seats.length !== 2) return null;
      const [a, b] = raw.seats.map(Number) as [number, number];
      if (!isSeat(a) || !isSeat(b) || a === b) return null;
      if (p.exclude.includes(a) || p.exclude.includes(b)) return null;
      return { kind: 'seats', seats: [a, b] };
    }
    case 'center': {
      const c = centers(raw.center, p.count);
      return c ? { kind: 'center', centerIndices: c } : null;
    }
    case 'dorpsgek': {
      const direction = raw.direction;
      if (direction !== 'left' && direction !== 'right' && direction !== 'none') return null;
      const choice: Choice = { kind: 'dorpsgek', direction };
      const designated = Number(raw.designatedSeat);
      if (p.variant === 'designate' && direction !== 'none'
        && isSeat(designated) && designated !== request.seat) {
        choice.designatedSeat = designated;
      }
      return choice;
    }
    case 'confirm':
      return typeof raw.value === 'boolean' ? { kind: 'bool', value: raw.value } : null;
  }
}

/** Pull the first JSON object out of a model reply, tolerating code fences and chatter. */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
