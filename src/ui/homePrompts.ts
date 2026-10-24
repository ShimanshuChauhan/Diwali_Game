import type {
  AartiRejection,
  AartiSnapshot,
  CrackerHandsRejection,
  DoorwayId,
  DoorwaySnapshot,
  GiftBoxId,
  GiftRejection,
  HandItem,
  HandItemKind,
  HomeInteractable,
  HouseholdMemberId,
  LocationId,
} from '../core/homes';
import { CRACKER_BLOCKED_TEXT, ITEM_REJECTION_TEXT } from '../homes/heldItems';
import { TRANSITION_REJECTION_TEXT } from '../homes/locations';
import { giftBoxAt, isFamilyMember } from '../interaction/homeActions';
import type { PromptLine } from './hudModel';

/**
 * Contextual prompts for the homes expansion: what E and click do at a door,
 * the puja, the sweets tray, a person or a return spot, given what the hands
 * hold and how far the evening has got. Plain data, like `text.ts`.
 */

/** What the homes prompts depend on, gathered by the game loop each frame. */
export interface HomePromptState {
  /** The carried plate, gift box or thali; null when the hands are free of them. */
  readonly hands: HandItem | null;
  /** A lit phuljhari must burn out before anything is picked up. */
  readonly sparklerLit?: boolean;
  /** The family tray is served after aarti. */
  readonly trayServed?: boolean;
  readonly aarti?: AartiSnapshot | null;
  /** The once-per-session neighbour exchange has happened. */
  readonly exchanged?: boolean;
  /** Where a door leads, for its wording. */
  readonly doorway?: (id: DoorwayId) => DoorwaySnapshot | undefined;
  /** The home whose open street door the player looks at from a few metres off. */
  readonly doorHint?: LocationId | null;
}

/** How prompts name the household; names are content choices of #61 and #65. */
export const MEMBER_LABELS: Readonly<Record<HouseholdMemberId, string>> = {
  mother: 'Mummy',
  father: 'Papa',
  sibling: 'Chhotu',
  grandmother: 'Dadi',
  grandfather: 'Dadaji',
  uncle: 'Uncle',
  aunty: 'Aunty',
};

export const GIFT_BOX_LABELS: Readonly<Record<GiftBoxId, string>> = {
  outbound: 'gift box',
  return: 'return gift',
};

/** Where each door leads, by destination. */
export const DOOR_PROMPTS: Readonly<Record<LocationId, string>> = {
  outdoors: 'E: Step outside',
  familyHome: 'E: Enter home',
  neighbourHome: 'E: Visit Uncle and Aunty',
};

/**
 * A quiet line while the player looks at an enterable home's open door from
 * a few metres off, naming whose it is; walking up turns it into the E prompt.
 */
export const DOOR_HINTS: Readonly<Record<Exclude<LocationId, 'outdoors'>, string>> = {
  familyHome: 'Your home: the door is open',
  neighbourHome: "Uncle and Aunty's home: the door is open",
};

/** Why each carried item keeps the player from joining aarti. */
const JOIN_BLOCKED_TEXT: Readonly<Record<Exclude<HandItemKind, 'thali'>, string>> = {
  sweetsPlate: 'Put the plate back on the sweets table before joining aarti',
  giftBox: 'Put the gift box down on its spot before joining aarti',
};

/** Which cracker-hands reason each carried item gives. */
export const HANDS_BLOCK: Readonly<Record<HandItemKind, CrackerHandsRejection>> = {
  sweetsPlate: 'carryingPlate',
  giftBox: 'carryingGift',
  thali: 'holdingThali',
};

/**
 * Player-facing wording for a refused aarti command. `handsFull` is null:
 * the hands report the specific item through `itemRejected` instead.
 */
export const AARTI_REJECTION_TEXT: Readonly<Record<AartiRejection, string | null>> = {
  ceremonyCompleted: 'Aarti is done for this evening',
  handsFull: null,
  alreadyParticipating: 'You are already taking part',
  notParticipating: 'Join aarti at the puja corner first',
  unknownSong: 'That aarti is not available',
  songUnavailable: 'The aarti recording is not ready — try again in a moment',
  wrongLocation: 'Aarti happens at the puja corner at home',
};

export const GIFT_REJECTION_TEXT: Readonly<Record<GiftRejection, string>> = {
  notHolding: 'You are not carrying the gift box',
  handsFull: ITEM_REJECTION_TEXT.handsFull,
  alreadyExchanged: 'Uncle and Aunty already have your gift',
  alreadyDelivered: 'The family already has the return gift',
  wrongLocation: 'That belongs somewhere else',
  outOfReach: ITEM_REJECTION_TEXT.outOfReach,
};

const go = (text: string): PromptLine => ({ text, blocked: false });
const no = (text: string): PromptLine => ({ text, blocked: true });

/** The hint line for `home`'s open door, if the player is looking at one. */
export function doorHintLine(home: LocationId | null | undefined): PromptLine | null {
  return home && home !== 'outdoors' ? { text: DOOR_HINTS[home], blocked: false, hint: true } : null;
}

/** True for the targets this module words, rather than the cracker prompts. */
export function isHomeInteractable(target: { readonly kind: string }): target is HomeInteractable {
  return target.kind !== 'cracker' && target.kind !== 'diya';
}

/** The prompt lines for a home target; empty when it offers nothing right now. */
export function homePromptLines(target: HomeInteractable, state: HomePromptState): PromptLine[] {
  const held = state.hands;
  switch (target.kind) {
    case 'door': {
      const doorway = state.doorway?.(target.id);
      // The plate never leaves the family home; the thali cannot reach a door.
      if (held?.kind === 'sweetsPlate' && doorway?.location === 'familyHome') {
        return [no(TRANSITION_REJECTION_TEXT.carryingPlate)];
      }
      return [go(doorway ? DOOR_PROMPTS[doorway.destination] : 'E: Use the door')];
    }

    case 'puja': {
      const aarti = state.aarti;
      if (aarti?.participating) return [go('Hold click: Circle the thali'), go('E: Leave aarti')];
      if (aarti?.state === 'completed') return [];
      if (held && held.kind !== 'thali') return [no(JOIN_BLOCKED_TEXT[held.kind])];
      if (state.sparklerLit) return [no(ITEM_REJECTION_TEXT.sparklerLit)];
      return [go(aarti?.state === 'running' ? 'E: Rejoin aarti' : 'E: Join aarti')];
    }

    case 'tray': {
      // Uncle and Aunty's mithai: any time, whatever the hour of the evening.
      if (target.id === 'neighbourHome') {
        return held ? [no(CRACKER_BLOCKED_TEXT[HANDS_BLOCK[held.kind]])] : [go('E: Have mithai')];
      }
      if (held?.kind === 'sweetsPlate') return [go('E: Put the plate back')];
      if (held?.kind === 'giftBox' && held.box === 'return') {
        return [go(`E: Place the ${GIFT_BOX_LABELS.return} on the sweets table`)];
      }
      if (!state.trayServed) return [no(ITEM_REJECTION_TEXT.trayNotServed)];
      if (held) return [no(CRACKER_BLOCKED_TEXT[HANDS_BLOCK[held.kind]])];
      return [
        go('E: Eat sweets'),
        state.sparklerLit ? no(ITEM_REJECTION_TEXT.sparklerLit) : go('Click: Take a plate to share'),
      ];
    }

    case 'returnSpot': {
      const box = giftBoxAt(target.home);
      const label = GIFT_BOX_LABELS[box];
      if (held?.kind === 'giftBox') {
        return held.box === box ? [go(`E: Put the ${label} back`)] : [no(ITEM_REJECTION_TEXT.wrongReturnSpot)];
      }
      if (held) return [no(ITEM_REJECTION_TEXT.handsFull)];
      if (state.sparklerLit) return [no(ITEM_REJECTION_TEXT.sparklerLit)];
      return [go(`E: Pick up the ${label}`)];
    }

    case 'person': {
      const name = MEMBER_LABELS[target.id];
      if (isFamilyMember(target.id)) return held?.kind === 'sweetsPlate' ? [go(`E: Offer sweets to ${name}`)] : [];
      if (held?.kind === 'giftBox' && held.box === 'outbound' && !state.exchanged) {
        return [go(`E: Give the ${GIFT_BOX_LABELS.outbound} to ${name}`)];
      }
      return [go(`E: Greet ${name}`)];
    }
  }
}
