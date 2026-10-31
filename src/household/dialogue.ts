import type { Gesture, HouseholdMemberId, ReactionCause } from '../core/homes';

/** One variation of a member's reaction: what they say and how they move. */
export interface LineVariant {
  readonly text: string;
  readonly gesture: Gesture;
}

export type DialogueCatalogue = Readonly<
  Partial<Record<ReactionCause, Readonly<Partial<Record<HouseholdMemberId, readonly LineVariant[]>>>>>
>;

/**
 * The family's Hinglish lines, a small set per member and cause, each with
 * its gesture. Every member sounds like themselves: Mummy fond, Papa easy,
 * Dadi full of blessings, Dadaji formal, Chhotu teasing.
 *
 * Invitations are gentle encouragement, never hurry: nobody counts down or
 * says the family is waiting impatiently. Welcomes greet the player once the
 * family has settled with sweets after aarti. Sweets, gift and neighbour
 * reactions are added by the modules that own those moments (#63, #65, #66).
 */
export const FAMILY_DIALOGUE: DialogueCatalogue = {
  invite: {
    mother: [
      { text: 'Beta, aa jao. Thali taiyaar hai, jab mann ho tab shuru karenge.', gesture: 'wave' },
      { text: 'Aarti tumhare saath hi karenge, beta. Aaram se aao.', gesture: 'wave' },
    ],
    grandmother: [
      { text: 'Aaja beta, Lakshmi Mata ki aarti tere haath se hogi.', gesture: 'blessing' },
      { text: 'Diya jal raha hai, beta. Aa ke baith ja hamare paas.', gesture: 'wave' },
    ],
    father: [
      { text: 'Aao beta, puja wale kone mein aa jao jab free ho.', gesture: 'wave' },
      { text: 'Thali utha lo, beta. Sab yahin hain.', gesture: 'namaste' },
    ],
    sibling: [
      { text: 'Aa jao na! Ghanti main bajaunga, thali tum ghumana.', gesture: 'tease' },
      { text: 'Aarti ke baad mithai milegi, chalo na!', gesture: 'wave' },
    ],
    grandfather: [
      { text: 'Aao bachche, saath mein aarti karte hain.', gesture: 'namaste' },
      { text: 'Bhagwan ka aashirwad lene aao, beta.', gesture: 'blessing' },
    ],
  },
  welcome: {
    mother: [
      { text: 'Aarti ho gayi! Aao beta, mithai khao.', gesture: 'offerMithai' },
      { text: 'Aa gaye? Ladoo aur barfi rakhi hai, le lo.', gesture: 'offerMithai' },
    ],
    grandmother: [
      { text: 'Jeete raho, beta! Aao, mere paas baitho.', gesture: 'blessing' },
      { text: 'Khush raho, bachche. Mithai khayi?', gesture: 'blessing' },
    ],
    father: [
      { text: 'Aa gaye champion! Aaj ki shaam badi achhi rahi.', gesture: 'wave' },
      { text: 'Aao baitho, beta. Thodi baatein karte hain.', gesture: 'wave' },
    ],
    sibling: [
      { text: 'Sab ladoo main kha jaunga, jaldi aao! Mazaak tha.', gesture: 'tease' },
      { text: 'Itni der? Patakhe chhod ke aa gaye kya?', gesture: 'tease' },
    ],
    grandfather: [
      { text: 'Shubh Deepawali, beta. Aao, baitho.', gesture: 'namaste' },
      { text: 'Aaj ghar mein raunak hai. Aao bachche.', gesture: 'blessing' },
    ],
  },
};
