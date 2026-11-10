// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  ROOM_MODES, renderAllTime, renderFriendPicker, renderModePicker,
  renderPracticeBadge,
} from './alltime.js';
import { t } from './i18n.js';
import type { FriendProfile } from '../app/friend.js';
import type { AllTimeStanding } from '../stats/alltime.js';

/**
 * The screens that decide whose history this is and whether tonight is in it.
 *
 * Both have one failure mode that matters and it is silent: somebody's history
 * quietly forking because they typed their name slightly differently, or a
 * test evening quietly landing in a record with no delete path.
 */

const profile = (id: string, displayName: string): FriendProfile =>
  ({ id, displayName, createdAt: 0 });

const picker = (over: Partial<Parameters<typeof renderFriendPicker>[0]> = {}) =>
  renderFriendPicker({
    lang: 'nl', profiles: [profile('f:1', 'Milan'), profile('f:2', 'Sanne')],
    typed: '', ...over,
  });

describe('picking who you are', () => {
  it('offers the existing friends before a text field', () => {
    // Typing your own name from scratch every evening eventually produces a
    // typo, and a typo with a fresh id is a silently forked history.
    const el = picker();
    const list = el.querySelector('.friends__list')!;
    const field = el.querySelector('.join__name')!;
    const kids = Array.from(el.children);
    expect(kids.indexOf(list)).toBeLessThan(kids.indexOf(field));
    expect(list.querySelectorAll('[data-friend-id]')).toHaveLength(2);
  });

  it('lists them alphabetically', () => {
    const ids = Array.from(picker({
      profiles: [profile('f:3', 'Zoe'), profile('f:1', 'Ann')],
    }).querySelectorAll<HTMLElement>('[data-friend-id]')).map((b) => b.dataset.friendId);
    expect(ids).toEqual(['f:1', 'f:3']);
  });

  it('offers the last-used profile as the one-tap path', () => {
    const el = picker({ rememberedId: 'f:2' });
    const last = el.querySelector<HTMLElement>('.friends__friend--last')!;
    expect(last.dataset.friendId).toBe('f:2');
    expect(last.textContent).toContain('Sanne');
  });

  it('hands back the profile that was tapped', () => {
    let picked: FriendProfile | null = null;
    const el = picker({ onPick: (p) => { picked = p; } });
    el.querySelector<HTMLButtonElement>('[data-friend-id="f:1"]')!.click();
    expect(picked!.id).toBe('f:1');
  });

  it('will not create a nameless friend', () => {
    const create = (typed: string) =>
      picker({ typed }).querySelector<HTMLButtonElement>('.btn--primary')!;
    expect(create('').disabled).toBe(true);
    expect(create('   ').disabled).toBe(true);
    expect(create('Joris').disabled).toBe(false);
  });

  it('keeps typing local while enabling the create button', () => {
    let typed = '';
    const el = picker({ onTyped: (value) => { typed = value; } });
    const field = el.querySelector<HTMLInputElement>('.join__name')!;
    const create = el.querySelector<HTMLButtonElement>('.btn--primary')!;
    field.value = 'M';
    field.dispatchEvent(new Event('input'));
    expect(typed).toBe('M');
    expect(create.disabled).toBe(false);
  });

  it('creates from what was typed after render, not the captured initial value', () => {
    let created = '';
    const el = picker({ onCreate: (name) => { created = name; } });
    const field = el.querySelector<HTMLInputElement>('.join__name')!;
    const create = el.querySelector<HTMLButtonElement>('.btn--primary')!;

    field.value = '  Joris  ';
    field.dispatchEvent(new Event('input'));
    create.click();

    expect(created).toBe('Joris');
  });

  it('reuses a previously used name instead of forking a second profile', () => {
    let picked: FriendProfile | null = null;
    let created = '';
    const el = picker({
      onPick: (profile) => { picked = profile; },
      onCreate: (name) => { created = name; },
    });
    const field = el.querySelector<HTMLInputElement>('.join__name')!;
    const create = el.querySelector<HTMLButtonElement>('.btn--primary')!;

    field.value = '  milan ';
    field.dispatchEvent(new Event('input'));
    expect(create.textContent).toContain('Milan');
    create.click();

    expect(picked!.id).toBe('f:1');
    expect(created).toBe('');
  });

  it('trims the new name before creating it', () => {
    let created = '';
    const el = picker({ typed: '  Joris ', onCreate: (n) => { created = n; } });
    el.querySelector<HTMLButtonElement>('.btn--primary')!.click();
    expect(created).toBe('Joris');
  });

  it('offers a room-only guest without creating a permanent profile', () => {
    let guest = false;
    const el = picker({ onGuest: () => { guest = true; } });
    el.querySelector<HTMLButtonElement>('.friends__guest')!.click();
    expect(guest).toBe(true);
    expect(el.textContent).toContain('Eenmalig spelen (geen statistieken)');
    expect(el.textContent).toContain('nieuwe telefoon');
  });

  it('explains why it is asking, so it does not read as a signup', () => {
    for (const lang of ['nl', 'en'] as const) {
      const sub = t(lang, 'friend.sub').toLowerCase();
      expect(sub).toMatch(lang === 'nl' ? /andere telefoon/ : /different\s+phone/);
    }
  });
});

describe('whether tonight counts', () => {
  it('offers practice first, and that is the recommendation', () => {
    // The failure we can afford is a real evening not counting. The one we
    // cannot is a test round in a record with no delete path.
    expect(ROOM_MODES).toEqual(['practice', 'official']);
    const modes = Array.from(
      renderModePicker({ lang: 'nl', mode: 'practice' })
        .querySelectorAll<HTMLElement>('[data-room-mode]'),
    ).map((b) => b.dataset.roomMode);
    expect(modes).toEqual(['practice', 'official']);
  });

  it('marks the chosen one for a screen reader too', () => {
    const el = renderModePicker({ lang: 'nl', mode: 'official' });
    const official = el.querySelector<HTMLElement>('[data-room-mode="official"]')!;
    const practice = el.querySelector<HTMLElement>('[data-room-mode="practice"]')!;
    expect(official.getAttribute('aria-checked')).toBe('true');
    expect(practice.getAttribute('aria-checked')).toBe('false');
    expect(el.getAttribute('role')).toBe('radiogroup');
  });

  it('says the choice is permanent, in both languages', () => {
    // True at the database level: the rules refuse to let mode change.
    for (const lang of ['nl', 'en'] as const) {
      const text = t(lang, 'mode.official.explain').toLowerCase();
      expect(text).toMatch(lang === 'nl' ? /niet meer omzetten/ : /cannot switch it later/);
    }
  });

  it('says plainly that practice does not count', () => {
    for (const lang of ['nl', 'en'] as const) {
      expect(t(lang, 'mode.practice.explain').toLowerCase())
        .toMatch(lang === 'nl' ? /tellen niet mee/ : /do not count/);
    }
  });

  it('badges a practice room all evening, announced', () => {
    // Said while it is being played, not afterwards. role=status so it is not
    // conveyed by placement alone.
    const badge = renderPracticeBadge('nl');
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.textContent).toMatch(/telt niet mee/i);
  });
});

describe('the all-time table', () => {
  const row = (over: Partial<AllTimeStanding> = {}): AllTimeStanding => ({
    friendId: 'f:1', name: 'Milan', points: 12, rounds: 5, wins: 3,
    evenings: 2, soloWins: 0, ...over,
  });

  it('says so honestly when nothing counts yet', () => {
    // Before the first official evening this is correct, not an error.
    const el = renderAllTime({ lang: 'nl', rows: [] });
    expect(el.textContent).toMatch(/nog geen enkele avond/i);
    expect(el.querySelectorAll('.alltime__row')).toHaveLength(0);
  });

  it('shows a row per friend, in the order it was given', () => {
    const el = renderAllTime({
      lang: 'nl',
      rows: [row({ friendId: 'f:1' }), row({ friendId: 'f:2', name: 'Sanne' })],
    });
    expect(Array.from(el.querySelectorAll<HTMLElement>('.alltime__row'))
      .map((r) => r.dataset.friendId)).toEqual(['f:1', 'f:2']);
  });

  it('highlights you, so you can find yourself without reading every line', () => {
    const el = renderAllTime({ lang: 'nl', rows: [row(), row({ friendId: 'f:2' })], ownFriendId: 'f:2' });
    const own = el.querySelectorAll('.alltime__row--own');
    expect(own).toHaveLength(1);
    expect((own[0] as HTMLElement).dataset.friendId).toBe('f:2');
  });

  it('mentions solo wins only when there are any', () => {
    // A column of zeroes says nothing and costs a line of width on a phone.
    expect(renderAllTime({ lang: 'nl', rows: [row({ soloWins: 0 })] }).textContent)
      .not.toMatch(/solo/);
    expect(renderAllTime({ lang: 'nl', rows: [row({ soloWins: 2 })] }).textContent)
      .toMatch(/2 solo/);
  });

  it('shows evenings and rounds as different numbers', () => {
    // Turning up often and playing a lot are different things worth seeing.
    const el = renderAllTime({ lang: 'nl', rows: [row({ rounds: 9, evenings: 3 })] });
    expect(el.textContent).toMatch(/9 potjes/);
    expect(el.textContent).toMatch(/3 avonden/);
  });
});
