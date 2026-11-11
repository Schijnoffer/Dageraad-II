import { ROLES, roleDef, teamOf } from '../engine/roles.js';
import type { ConfirmedAction, DecisionRequest, PrivateInfo, RoleId } from '../engine/types.js';
import type { SeatKnowledge } from './types.js';

/**
 * The house rules, in words an LLM can play by. Mirrors README "House rules
 * encoded here" and engine/appliers.ts; when those change, change this.
 */

export function roleName(role: RoleId): string {
  return roleDef(role).nl;
}

const TEAM_NL = { village: 'dorp', wolf: 'wolven', solo: 'solo (Looier)' } as const;

export const ROLE_TEXT: Record<RoleId, string> = {
  schildwacht: 'Legt een schild op de kaart van een andere speler. Die kaart kan de rest van de nacht niet bekeken of verplaatst worden. Het schild is publiek zichtbaar.',
  droomwolf: 'Wolf. Ziet (huisregel) wie de andere wolven zijn.',
  weerwolf: 'Wolf. Ziet de andere wolven. Een wolf die alleen is mag één middenkaart bekijken.',
  alphawolf: 'Wolf. Ruilt blind de kaart van een andere speler met de aparte wolvenkaart in het midden: die speler is daarna een wolf (en weet het niet). Ziet niet wat ze wegnam.',
  mystiekewolf: 'Wolf. Bekijkt de kaart van één andere speler.',
  volgeling: 'Hoort bij de wolven maar is zelf geen wolf. Ziet wie de wolven zijn.',
  dubbelganger: 'Bekijkt de kaart van een andere speler, wordt die rol en voert meteen die actie uit (op het moment van de Dubbelganger). Speelt daarna voor het team van die rol.',
  vrijmetselaar: 'Ziet de andere Vrijmetselaars.',
  ziener: 'Bekijkt de kaart van één andere speler, of twee van de drie middenkaarten.',
  heks: 'Bekijkt één van de drie middenkaarten en MOET die ruilen met de kaart van een speler (mag zichzelf zijn). In de twee-rondenmodus kiest ze de ruilpartner al vóór ze de kaart ziet.',
  onderzoeker: 'Bekijkt één voor één tot twee spelerskaarten. Ziet ze een wolf of de Looier, dan stopt ze en wordt zelf die rol/dat team.',
  rechter: 'Kiest een speler. Die hoort (alleen hij) dat zijn eerste uitspraak overdag waar moet zijn.',
  leerlingziener: 'Bekijkt één van de drie middenkaarten.',
  onrustoker: 'Ruilt blind de kaarten van twee andere spelers.',
  dorpsgek: 'Mag alle spelerskaarten één plek naar links of rechts doorschuiven (eigen kaart en kaarten met een schild blijven liggen), of niets doen. Niemand anders hoort de richting.',
  dronkaard: 'Ruilt blind zijn eigen kaart met een middenkaart.',
  medium: 'Bekijkt de kaart van een andere speler. Is het geen wolf en geen Looier, dan wordt die kaart publiek opengelegd. Is het de Looier, dan MOET ze ruilen: zij wordt de Looier, de ander het Medium (die dat niet weet).',
  slapeloze: 'Ziet aan het eind van de nacht zijn eigen (mogelijk veranderde) kaart.',
  schoneslaapster: 'Ziet aan het eind van de nacht haar eigen (mogelijk veranderde) kaart.',
  bodyguard: 'Stemt niet: wijst bij de stemming iemand aan om te beschermen (niet zichzelf). Alle stemmen op die persoon vervallen.',
  jager: 'Als de Jager wordt opgehangen, sterft degene op wie hij stemde ook.',
  dorpeling: 'Geen nachtactie.',
  looier: 'Solo. Wint alleen als hij zelf wordt opgehangen. Zijn eigen stem telt niet.',
};

export const GENERAL_RULES = [
  'Dit is "Dageraad", een variant van One Night Ultimate Werewolf met huisregels. Er is precies één nacht, dan één discussie, dan één stemming.',
  'Er liggen evenveel kaarten als spelers plus drie in het midden (middenkaart 0, 1, 2). Met de Alfawolf in het spel ligt er nog een vierde, aparte wolvenkaart.',
  "'s Nachts handelen spelers op basis van de rol die ze GEDEALD kregen. Kaarten kunnen 's nachts verschuiven of geruild worden. Je team aan het eind wordt bepaald door de kaart die je bij DAGERAAD vasthoudt, ook als je dat zelf niet weet.",
  'Overdag praat iedereen openlijk. Liegen, bluffen en beschuldigen mag en hoort erbij. Alleen wat de Rechter oplegt (eerste uitspraak waar) is een verplichting.',
  'Stemming: iedereen stemt tegelijk op een ander (niet op zichzelf). Iedereen met het hoogste aantal stemmen wordt opgehangen (gelijkspel = allemaal). Als meer dan de helft vooraf besluit niet te stemmen, sterft niemand.',
  'Winnen: wordt de Looier opgehangen, dan wint alleen de Looier. Anders, als er minstens één wolf onder de spelers is: het dorp wint alleen als het één of meer wolven ophangt en niemand anders; anders winnen de wolven. Is er geen enkele wolf onder de spelers, dan wint het dorp alleen als niemand wordt opgehangen.',
  'Wolvenkaarten: Weerwolf, Alfawolf, Mystieke Wolf, Droomwolf. De Volgeling wint met de wolven maar is zelf geen wolf.',
];

export function rolesInPlayText(cards: readonly RoleId[]): string {
  const unique = [...new Set(cards)];
  return unique.map((role) => {
    const count = cards.filter((c) => c === role).length;
    const def = ROLES[role];
    return `- ${def.nl}${count > 1 ? ` (${count}x)` : ''} [team ${TEAM_NL[teamOf(role)]}]: ${ROLE_TEXT[role]}`;
  }).join('\n');
}

export function seatLabel(k: Pick<SeatKnowledge, 'names'>, seat: number): string {
  return `${k.names[seat] ?? `stoel ${seat}`} (stoel ${seat})`;
}

function slotLabel(k: SeatKnowledge, slot: number): string {
  if (slot < k.names.length) return seatLabel(k, slot);
  return `middenkaart ${slot - k.names.length}`;
}

function confirmedText(k: SeatKnowledge, action: ConfirmedAction): string {
  switch (action.kind) {
    case 'shielded': return `Je legde een schild op ${seatLabel(k, action.seat)}.`;
    case 'alpha-placed': return `Je legde de wolvenkaart bij ${seatLabel(k, action.seat)} (blind).`;
    case 'judged': return `Je koos ${seatLabel(k, action.seat)} als Rechter.`;
    case 'heks-swapped': return `Je ruilde middenkaart ${action.centerIndex} met de kaart van ${seatLabel(k, action.seat)}.`;
    case 'players-swapped': return `Je ruilde blind de kaarten van ${seatLabel(k, action.seats[0])} en ${seatLabel(k, action.seats[1])}.`;
    case 'drank': return `Je ruilde je eigen kaart blind met middenkaart ${action.centerIndex}.`;
    case 'shifted': return `Je schoof ${action.count} kaarten naar ${action.direction === 'left' ? 'links' : 'rechts'}.`;
    case 'took-looier': return `Je zag de Looier bij ${seatLabel(k, action.seat)} en moest ruilen: JIJ bent nu de Looier.`;
  }
}

/** One private receipt, in words, as true "at that moment of the night". */
export function describeInfo(k: SeatKnowledge, info: PrivateInfo): string {
  switch (info.kind) {
    case 'saw-card': return `Je zag bij ${slotLabel(k, info.slot)}: ${roleName(info.role)}.`;
    case 'saw-center': return `Je zag middenkaart ${info.centerIndex}: ${roleName(info.role)}.`;
    case 'saw-wolves': return info.seats.length === 0
      ? 'Je zag geen andere wolven onder de spelers.'
      : `De wolven (naast jou): ${info.seats.map((s) => seatLabel(k, s)).join(', ')}.`;
    case 'saw-masons': return info.seats.length === 0
      ? 'Je zag geen andere Vrijmetselaars.'
      : `Mede-Vrijmetselaars: ${info.seats.map((s) => seatLabel(k, s)).join(', ')}.`;
    case 'copied-role': return `Je kopieerde ${seatLabel(k, info.fromSeat)}: je bent nu ${roleName(info.role)}.`;
    case 'judged': return 'De Rechter koos jou: je EERSTE uitspraak overdag moet waar zijn.';
    case 'card-locked': return 'Jouw kaart werd vastgehouden terwijl de Dorpsgek de rest doorschoof.';
    case 'own-final-card': return `Aan het eind van de nacht zag je je eigen kaart: ${roleName(info.role)}.`;
    case 'became-role': return `Je bent zelf ${roleName(info.role)} geworden.`;
    case 'action-confirmed':
      return info.action ? confirmedText(k, info.action) : `Actie uitgevoerd${info.detail ? `: ${info.detail}` : ''}.`;
    case 'action-blocked': return info.reason === 'shielded'
      ? 'Je actie werd geblokkeerd door een schild.'
      : 'Je actie had geen geldig doel.';
    case 'did-not-rotate': return 'Je schoof niets door.';
    case 'no-action': return 'Je deed niets.';
  }
}

export function knowledgeText(k: SeatKnowledge): string {
  const lines: string[] = [];
  lines.push(`Je bent ${seatLabel(k, k.seat)}. Je kreeg de kaart: ${roleName(k.dealtRole)} (team ${TEAM_NL[teamOf(k.dealtRole)]}).`);
  lines.push(`Jouw rol: ${ROLE_TEXT[k.dealtRole]}`);
  if (k.privateInfo.length === 0) lines.push("Wat je 's nachts te weten kwam: niets.");
  else {
    lines.push("Wat je 's nachts te weten kwam (waar op dat moment; kaarten kunnen daarna nog verschoven zijn):");
    for (const info of k.privateInfo) lines.push(`- ${describeInfo(k, info)}`);
  }
  const view = k.publicView;
  if (view) {
    const revealed = Object.entries(view.revealed);
    if (revealed.length > 0) {
      lines.push('Publiek zichtbaar (open kaarten): ' + revealed
        .map(([slot, role]) => `${slotLabel(k, Number(slot))} = ${roleName(role)}`).join('; '));
    }
    const own = view.revealed[k.seat];
    if (own) lines.push(`LET OP: jouw eigen kaart ligt open voor iedereen: ${roleName(own)}. Dat is nu jouw kaart (team ${TEAM_NL[teamOf(own)]}).`);
    if (view.shielded.length > 0) {
      lines.push('Publiek zichtbaar (schilden): ' + view.shielded.map((s) => slotLabel(k, s)).join(', '));
    }
  }
  return lines.join('\n');
}

export function seatingText(k: Pick<SeatKnowledge, 'names'>): string {
  return k.names.map((name, seat) => `stoel ${seat}: ${name}`).join('\n')
    + '\n(Links/rechts doorschuiven volgt de stoelnummers rond de tafel.)';
}

const KEY_TEXT: Record<string, string> = {
  shield: 'Kies een andere speler om een schild op te leggen.',
  'alpha-target': 'Kies een andere speler die blind de wolvenkaart krijgt.',
  'mystic-view': 'Kies een andere speler wiens kaart je bekijkt.',
  seer: 'Bekijk de kaart van één andere speler OF twee middenkaarten.',
  'apprentice-center': 'Kies één middenkaart om te bekijken.',
  judge: 'Kies een speler wiens eerste uitspraak overdag waar moet zijn.',
  'heks-precommit-target': 'Kies NU al met wiens kaart je straks de middenkaart ruilt (mag jezelf).',
  'heks-center': 'Kies welke middenkaart je bekijkt (je moet die daarna ruilen).',
  'heks-target': 'Kies met wiens kaart je de bekeken middenkaart ruilt (mag jezelf).',
  troublemaker: 'Kies twee andere spelers wier kaarten je blind ruilt.',
  drunk: 'Kies een middenkaart waarmee je je eigen kaart blind ruilt.',
  dorpsgek: 'Kies of je alle spelerskaarten naar links of rechts doorschuift, of niets doet.',
  'medium-target': 'Kies een andere speler wiens kaart je bekijkt.',
  'pi-first': 'Kies de eerste speler wiens kaart je bekijkt.',
  'pi-second': 'Kies eventueel een tweede speler om te bekijken.',
  'doppel-view': 'Kies een andere speler wiens rol je kopieert.',
  'lone-wolf-center': 'Je bent de enige wolf: kies een middenkaart om te bekijken.',
};

export function requestText(k: SeatKnowledge, request: DecisionRequest): string {
  const lines = [
    `Nachtactie als ${roleName(request.actingAs)}: ${KEY_TEXT[request.key] ?? request.key}`,
  ];
  if (request.seen) lines.push(`Wat je hiervoor zag: ${describeInfo(k, request.seen)}`);
  const p = request.prompt;
  const seats = k.names.map((_, s) => s);
  switch (p.kind) {
    case 'seat': {
      const legal = seats.filter((s) => !p.exclude.includes(s));
      lines.push(`Toegestane stoelen: ${legal.join(', ')}.${p.optional ? ' Je mag ook null kiezen.' : ''}`);
      lines.push('Antwoord-JSON: {"thinking": "...", "seat": <stoelnummer>}');
      break;
    }
    case 'seat-or-center': {
      const legal = seats.filter((s) => !p.exclude.includes(s));
      lines.push(`Toegestane stoelen: ${legal.join(', ')}. Of precies ${p.centerCount} middenkaarten uit 0, 1, 2.`);
      lines.push('Antwoord-JSON: {"thinking": "...", "seat": <stoelnummer>} OF {"thinking": "...", "center": [i, j]}');
      break;
    }
    case 'two-seats': {
      const legal = seats.filter((s) => !p.exclude.includes(s));
      lines.push(`Toegestane stoelen: ${legal.join(', ')}.`);
      lines.push('Antwoord-JSON: {"thinking": "...", "seats": [a, b]}');
      break;
    }
    case 'center':
      lines.push(`Kies ${p.count} uit middenkaart 0, 1, 2.`);
      lines.push('Antwoord-JSON: {"thinking": "...", "center": [i]}');
      break;
    case 'dorpsgek':
      lines.push(p.variant === 'designate'
        ? 'Antwoord-JSON: {"thinking": "...", "direction": "left"|"right"|"none", "designatedSeat": <optioneel stoelnummer>}'
        : 'Antwoord-JSON: {"thinking": "...", "direction": "left"|"right"|"none"}');
      break;
    case 'confirm':
      lines.push('Antwoord-JSON: {"thinking": "...", "value": true|false}');
      break;
  }
  return lines.join('\n');
}
