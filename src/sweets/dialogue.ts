import { FAMILY_DIALOGUE, type DialogueCatalogue } from '../household/dialogue';

/**
 * The family's Hinglish reactions to the sweets after aarti (issue #63): a
 * small set per member for the player eating from the tray (`ateSweets`) and
 * for being offered the sharing plate (`sweetsOffered`), each with its
 * gesture. Members keep their voices from the invitations: Mummy fond and
 * feeding, Papa easy and cheering, Dadi blessing and hugging, Dadaji formal,
 * Chhotu teasing. No member shares a line or a set of gestures with another.
 */
export const SWEETS_DIALOGUE: DialogueCatalogue = {
  ateSweets: {
    mother: [
      { text: 'Aur lo beta, ek ladoo se kya hoga!', gesture: 'offerMithai' },
      { text: 'Pet bhar ke khao, aaj koi rok-tok nahi.', gesture: 'cheekPinch' },
      { text: 'Kaju katli bhi chakho, maine khud banayi hai.', gesture: 'offerMithai' },
    ],
    father: [
      { text: 'Waah, kya baat hai! Ek aur ho jaye.', gesture: 'clap' },
      { text: 'Diet kal se, beta — aaj Diwali hai!', gesture: 'wave' },
      { text: 'Halwai wale bhaiya ki barfi hai, ekdum fresh.', gesture: 'clap' },
    ],
    grandmother: [
      { text: 'Khao beta, khoob khao. Sehat bane.', gesture: 'blessing' },
      { text: 'Itna dubla ho gaya hai, aur le.', gesture: 'hug' },
      { text: 'Mithai khane se mann bhi meetha rehta hai.', gesture: 'blessing' },
    ],
    grandfather: [
      { text: 'Ladoo ka prasad hai, beta. Pehle bhog lag chuka.', gesture: 'namaste' },
      { text: 'Hamare zamane mein ghar ka ghee hota tha.', gesture: 'blessing' },
      { text: 'Dheere khao, bachche, aaram se.', gesture: 'namaste' },
    ],
    sibling: [
      { text: 'Oye! Mere hisse ka ladoo mat khana!', gesture: 'tease' },
      { text: 'Kitne kha liye? Main Mummy ko bata dunga!', gesture: 'tease' },
      { text: 'Gulab jamun mera hai, haath mat lagana.', gesture: 'tease' },
    ],
  },
  sweetsOffered: {
    mother: [
      { text: 'Arre, pehle tum khao! Achha, ek le leti hoon.', gesture: 'cheekPinch' },
      { text: 'Mera pyaara bachcha, kitna khayal rakhta hai.', gesture: 'hug' },
      { text: 'Bas beta, main toh bana-bana ke hi thak gayi.', gesture: 'cheekPinch' },
    ],
    father: [
      { text: 'Thank you, champion! Ek barfi chalegi.', gesture: 'wave' },
      { text: 'Waah, ladoo laaye ho! Bas ek, sugar check karwani hai.', gesture: 'clap' },
      { text: 'Achha, Papa ki yaad aayi? Laao.', gesture: 'wave' },
    ],
    grandmother: [
      { text: 'Jeeta reh, mera laal. Bhagwan sab khushiyan de.', gesture: 'blessing' },
      { text: 'Itne pyaar se laaya hai, toh zaroor khaungi.', gesture: 'hug' },
      { text: 'Sau saal jiyo, beta. Aadha tu kha le.', gesture: 'blessing' },
    ],
    grandfather: [
      { text: 'Dhanyavaad, beta. Sanskaar achhe hain tumhare.', gesture: 'namaste' },
      { text: 'Bade-bujurgon ko pehle — bahut achhe.', gesture: 'blessing' },
      { text: 'Khush raho. Ek peda de do bas.', gesture: 'namaste' },
    ],
    sibling: [
      { text: 'Sab mera? Thank you! Mazaak, ek hi lunga.', gesture: 'tease' },
      { text: 'Pehli baar mujhe pehle diya! Kuch chahiye kya?', gesture: 'tease' },
      { text: 'Yaay! Ab tumhe patakhe mein se ek anar milega.', gesture: 'clap' },
    ],
  },
};

/** The family's whole catalogue: invitations and welcomes plus the sweets reactions. */
export const FAMILY_SWEETS_DIALOGUE: DialogueCatalogue = { ...FAMILY_DIALOGUE, ...SWEETS_DIALOGUE };
