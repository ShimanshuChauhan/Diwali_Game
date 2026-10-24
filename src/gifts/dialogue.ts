import type { DialogueCatalogue } from '../household/dialogue';

/**
 * Uncle and Aunty's answer to the gift box (issue #66): touched, a little
 * scolding about the trouble taken, and a return box pressed into the
 * player's hands for the family. One line each, said once per session.
 */
export const HOST_GIFT_DIALOGUE: DialogueCatalogue = {
  giftExchanged: {
    uncle: [{ text: 'Arre, iski kya zaroorat thi, beta! Mummy-Papa ko hamara dher saara pyaar dena.', gesture: 'namaste' }],
    aunty: [{ text: 'Khaali haath thodi jaane dungi! Yeh dabba ghar le jao — sabke liye hai.', gesture: 'offerMithai' }],
  },
};

/**
 * The family seeing the neighbours' return box on the sweets table, once
 * per session and only after aarti. Each member in their own voice.
 */
export const FAMILY_GIFT_DIALOGUE: DialogueCatalogue = {
  giftAcknowledged: {
    mother: [{ text: 'Aunty ne bheja? Kitni pyaari hai woh! Kal unhe phone karti hoon.', gesture: 'hug' }],
    grandmother: [{ text: 'Achhe padosi bhagwan ki den hain, beta. Jeete raho.', gesture: 'blessing' }],
    father: [{ text: 'Waah, lene-dene ka rishta nibha aaye! Shabaash, champion.', gesture: 'clap' }],
    sibling: [{ text: 'Ismein kya hai? Pehla tukda mera, pakka!', gesture: 'tease' }],
    grandfather: [{ text: 'Padosi se mel-jol bana rahe, yahi asli Diwali hai.', gesture: 'namaste' }],
  },
};
