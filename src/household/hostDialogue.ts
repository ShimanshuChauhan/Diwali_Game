import type { DialogueCatalogue } from './dialogue';

/**
 * Uncle and Aunty's Hinglish lines. They have known the player since they
 * were small: Uncle recognises them at the door and asks after the family,
 * Aunty presses mithai on them. Every visit is welcome — with or without a
 * gift, before or after aarti — so nothing here mentions a gift or asks why
 * the player came. The special gift exchange is #66's.
 *
 * `welcome` is the greeting on arrival and when the player greets them;
 * `ateSweets` answers eating from their table.
 */
export const HOST_DIALOGUE: DialogueCatalogue = {
  welcome: {
    uncle: [
      { text: 'Arre, aao beta, aao! Ghar pe sab kaise hain? Mummy-Papa theek?', gesture: 'namaste' },
      { text: 'Arre wah, hamara beta aaya! Dadi ki tabiyat kaisi hai ab?', gesture: 'wave' },
      { text: 'Aao aao! Ghar pe aarti ki taiyaari ho gayi? Dadaji ko pranaam kehna.', gesture: 'namaste' },
      { text: 'Phir aa gaye? Achha kiya! Chhotu ne patakhe chhode ki nahi abhi tak?', gesture: 'tease' },
    ],
    aunty: [
      { text: 'Beta, kaju katli khao, maine khud banayi hai!', gesture: 'offerMithai' },
      { text: 'Mithai liye bina nahi jaane dungi! Ek ladoo toh lo.', gesture: 'offerMithai' },
      { text: 'Mummy ko bolna besan ladoo ki recipe bhej rahi hoon. Lo, chakh ke batao!', gesture: 'offerMithai' },
    ],
  },
  ateSweets: {
    aunty: [
      { text: 'Aur lo, aur lo! Diwali pe koi ginti nahi hoti.', gesture: 'offerMithai' },
      { text: 'Kitne bade ho gaye ho! Khao, khao.', gesture: 'cheekPinch' },
      { text: 'Achhi hai na? Ghar ke liye bhi pack kar doon?', gesture: 'offerMithai' },
    ],
    uncle: [
      { text: 'Shabaash! Ab ek gulab jamun bhi ho jaye.', gesture: 'wave' },
      { text: 'Aunty ki mithai ka jawab nahi, hai na?', gesture: 'tease' },
    ],
  },
};

/** Lines that replace a greeting once aarti is over at home. */
export const HOST_DIALOGUE_AFTER_AARTI: DialogueCatalogue = {
  welcome: {
    uncle: [
      { text: 'Aao beta! Ghar pe aarti ho gayi? Sabko hamari taraf se Shubh Deepawali kehna.', gesture: 'namaste' },
      { text: 'Arre, aarti ke baad aaye ho. Papa ko kehna kal chai pe aayenge.', gesture: 'wave' },
      { text: 'Aao bachche! Dadi ne aashirwad diya? Ab hamara bhi le lo.', gesture: 'blessing' },
    ],
    aunty: [
      { text: 'Aarti ho gayi na? Ab toh mithai banti hai. Lo beta!', gesture: 'offerMithai' },
      { text: 'Ghar pe bhi mithai khayi hogi, par meri wali alag hai. Lo!', gesture: 'offerMithai' },
    ],
  },
};
