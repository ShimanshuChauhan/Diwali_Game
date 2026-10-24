import type { GameAction } from '../core/actions';
import type { Interactable } from '../core/contracts';
import {
  FAMILY_MEMBERS,
  type AartiCeremonyModule,
  type CommandResult,
  type FamilyMemberId,
  type GiftBoxId,
  type GiftExchangeModule,
  type HeldItemsModule,
  type HomeId,
  type HouseholdMemberId,
  type HouseholdModule,
  type ItemRejection,
  type LocationsModule,
} from '../core/homes';

/**
 * The modules E and click reach at and inside homes. Each is optional so the
 * routing works while the expansion is built piece by piece; a missing one
 * just leaves its actions doing nothing.
 */
export interface HomeActionContext {
  readonly locations?: Pick<LocationsModule, 'requestTransition'>;
  readonly ceremony?: Pick<AartiCeremonyModule, 'snapshot' | 'join' | 'leave'>;
  readonly hands?: Pick<
    HeldItemsModule,
    'hands' | 'eat' | 'pickUpPlate' | 'returnPlate' | 'offer' | 'returnTo'
  >;
  readonly gifts?: Pick<GiftExchangeModule, 'pickUp' | 'putBack' | 'exchange' | 'placeOnTable'>;
  readonly household?: Pick<HouseholdModule, 'react'>;
  /** Uncle and Aunty's mithai table next door, never gated on aarti (`NeighbourHosts`). */
  readonly hosts?: { eatMithai(): CommandResult<ItemRejection> };
}

const FAMILY: readonly HouseholdMemberId[] = FAMILY_MEMBERS;

/** Each home's gift spot holds its own box: the outbound one at home, the return one next door. */
export function giftBoxAt(home: HomeId): GiftBoxId {
  return home === 'familyHome' ? 'outbound' : 'return';
}

export function isFamilyMember(id: HouseholdMemberId): id is FamilyMemberId {
  return FAMILY.includes(id);
}

/**
 * Route E (`interact`) and click (`place`) for the homes expansion, ahead
 * of the cracker controls. Returns true when the action was used here; on
 * false the caller passes it on to diyas and crackers unchanged.
 *
 * - Taking part in aarti, E leaves and click is the thali's (hold to circle,
 *   #60); neither reaches the crackers.
 * - Door: E asks for the transition.
 * - Puja: E joins or rejoins aarti.
 * - Tray: E puts the plate back, sets the return box on the table, or eats;
 *   click with free hands takes a plate. Next door, the tray is Uncle and
 *   Aunty's mithai: E eats there at any time and there is no plate to take.
 * - Return spot: E puts the carried box back, or picks the resting one up.
 * - Person: E offers the plate to a family member, gives the gift box to the
 *   neighbours, or greets them.
 *
 * Refusals are reported by the module that refuses (`transitionRejected`,
 * `aartiRejected`, `itemRejected`, `giftRejected`), which the HUD shows.
 */
export function applyHomeAction(action: GameAction, target: Interactable | null, ctx: HomeActionContext): boolean {
  if (action.type !== 'interact' && action.type !== 'place') return false;
  if (ctx.ceremony?.snapshot.participating) {
    if (action.type === 'interact') ctx.ceremony.leave();
    return true;
  }
  if (!target) return false;
  const held = ctx.hands?.hands ?? null;

  if (action.type === 'place') {
    if (target.kind !== 'tray' || held) return false;
    if (target.id === 'familyHome') ctx.hands?.pickUpPlate();
    return true;
  }

  switch (target.kind) {
    case 'cracker':
    case 'diya':
      return false;
    case 'door':
      ctx.locations?.requestTransition(target.id);
      return true;
    case 'puja':
      ctx.ceremony?.join();
      return true;
    case 'tray':
      if (target.id === 'neighbourHome') ctx.hosts?.eatMithai();
      else if (held?.kind === 'sweetsPlate') ctx.hands?.returnPlate();
      else if (held?.kind === 'giftBox' && held.box === 'return') ctx.gifts?.placeOnTable();
      else ctx.hands?.eat();
      return true;
    case 'returnSpot': {
      if (held?.kind === 'giftBox') {
        // The gift module knows nothing of spots, so only its own spot hands it over.
        if (giftBoxAt(target.home) === held.box && ctx.gifts) ctx.gifts.putBack(held.box);
        else ctx.hands?.returnTo({ item: target.item, home: target.home });
      } else {
        ctx.gifts?.pickUp(giftBoxAt(target.home));
      }
      return true;
    }
    case 'person':
      if (isFamilyMember(target.id)) {
        ctx.hands?.offer(target.id);
      } else if (held?.kind === 'giftBox' && held.box === 'outbound' && ctx.gifts) {
        ctx.gifts.exchange();
      } else {
        ctx.household?.react(target.id, 'welcome');
      }
      return true;
  }
}
