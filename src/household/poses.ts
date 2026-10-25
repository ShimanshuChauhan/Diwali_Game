import type { Gesture, HouseholdActivity } from '../core/homes';
import type { FigurePose } from '../people/figure';
import type { HouseholdMemberView } from './household';

/** Per-figure adjustments that do not change with the activity. */
export interface PoseOptions {
  /** Body drop (metres, before scaling) that puts the hips on the seat. */
  readonly seatBob?: number;
  /** Extra forward lean, e.g. a grandparent's stoop. */
  readonly stoop?: number;
}

type Upper = Pick<
  FigurePose,
  'lean' | 'headPitch' | 'headYaw' | 'leftArm' | 'rightArm' | 'leftSpread' | 'rightSpread' | 'leftElbow' | 'rightElbow'
>;
type Lower = Pick<FigurePose, 'bob' | 'leftLeg' | 'rightLeg' | 'leftKnee' | 'rightKnee'>;

/** Hands folded at the chest: forearms up, palms meeting on the midline. */
const NAMASTE: Upper = {
  leftArm: 0.3,
  rightArm: 0.3,
  leftElbow: 1.7,
  rightElbow: 1.7,
  leftSpread: -0.8,
  rightSpread: -0.8,
};

/**
 * Body pose for a household member, `t` seconds into an offset clock. Every
 * gesture is a large arm movement read from the silhouette alone, so it
 * stays legible on Low: folded hands for prayer, forearms meeting for claps,
 * a raised hand for the bell, an arm up to wave.
 *
 * A line being spoken shows its gesture with the upper body; legs keep to
 * the activity, so a seated member gestures from their seat.
 */
export function householdPose(view: HouseholdMemberView, t: number, options: PoseOptions = {}): FigurePose {
  const lower = lowerBody(view, t, options);
  const gesture = shownGesture(view);
  const upper = gesture ? gesturePose(gesture, t, view.activityTime) : upperBody(view.activity, view, t);
  return { ...lower, ...upper, lean: (upper.lean ?? 0) + (options.stoop ?? 0) };
}

/**
 * The gift handover's arm movements (#66). Only the handover activities
 * make them, never a spoken line, so a gift box is in a host's hands only
 * while `GiftExchange` has it there.
 */
export type HandoverGesture = 'receiveGift' | 'setGiftAside' | 'giveGift';

const HANDOVER_GESTURES: Readonly<Partial<Record<HouseholdActivity, HandoverGesture>>> = {
  receivingGift: 'receiveGift',
  settingGiftAside: 'setGiftAside',
  givingGift: 'giveGift',
};

/** Something a household member holds between both palms. */
export type HeldProp = 'plate' | 'outboundBox' | 'returnBox';

type GestureView = Pick<HouseholdMemberView, 'line' | 'activity'>;

/**
 * The gesture the upper body is showing: a handover step's, whatever is
 * being said meanwhile (the box stays in both hands); else the spoken
 * line's; else the one an activity is made of (serving the tray offers its
 * mithai, greeting folds the hands); or null while an activity moves the
 * arms its own way.
 */
export function shownGesture(view: GestureView): Gesture | HandoverGesture | null {
  const handover = HANDOVER_GESTURES[view.activity];
  if (handover) return handover;
  if (view.line) return view.line.gesture;
  if (view.activity === 'serving') return 'offerMithai';
  if (view.activity === 'greeting') return 'namaste';
  return null;
}

/**
 * What `view` holds, if anything, read off the gesture so the prop comes
 * and goes with the pose — never left in hands doing something else, nor
 * missing from them: a plate of mithai while offering it; the family's
 * gift box from taking it until it is set down; the return box while it is
 * held out to the player.
 */
export function heldProp(view: GestureView): HeldProp | null {
  switch (shownGesture(view)) {
    case 'offerMithai':
      return 'plate';
    case 'receiveGift':
    case 'setGiftAside':
      return 'outboundBox';
    case 'giveGift':
      return 'returnBox';
    default:
      return null;
  }
}

/** True while `view` holds out a plate of mithai. */
export function holdsPlate(view: GestureView): boolean {
  return heldProp(view) === 'plate';
}

/**
 * Standing members face the player while talking to them or handing them
 * something, but for setting the box down, when they face their own way:
 * the side table.
 */
export function facesViewer(view: GestureView): boolean {
  const handover = HANDOVER_GESTURES[view.activity];
  if (handover) return handover !== 'setGiftAside';
  return view.line !== null;
}

function lowerBody(view: HouseholdMemberView, t: number, options: PoseOptions): Lower {
  if (view.activity === 'seated') {
    // Thighs forward along the seat, shins hanging to the floor.
    return { bob: options.seatBob ?? -0.43, leftLeg: 1.5, rightLeg: 1.5, leftKnee: 1.5, rightKnee: 1.5 };
  }
  if (view.walking) {
    const step = Math.sin(t * 6);
    return {
      bob: Math.abs(Math.cos(t * 6)) * 0.022,
      leftLeg: step * 0.42,
      rightLeg: -step * 0.42,
      leftKnee: Math.max(0, -step) * 0.65,
      rightKnee: Math.max(0, step) * 0.65,
    };
  }
  return { bob: Math.sin(t * 1.5) * 0.004 };
}

function upperBody(activity: HouseholdActivity, view: HouseholdMemberView, t: number): Upper {
  switch (activity) {
    case 'praying': {
      // Folded hands and a slow bow toward the shrine.
      const bow = 0.5 + 0.5 * Math.sin(t * 0.8);
      return { ...NAMASTE, lean: 0.06 + 0.1 * bow, headPitch: -0.1 - 0.15 * bow };
    }
    case 'clapping':
      return clapping(t);
    case 'ringingBell': {
      // The bell hand up and forward, shaking; the other hand folded at the chest.
      const shake = Math.sin(t * 18) * 0.12;
      return {
        headPitch: 0.15,
        leftArm: 0.45,
        leftElbow: 1.9,
        leftSpread: -0.3,
        rightArm: 2.2,
        rightElbow: 0.35 + shake,
        rightSpread: 0.15 + shake * 0.5,
      };
    }
    case 'seated':
      return view.talking ? seatedTalk(t) : seatedListen(t);
    case 'gathered':
    case 'idle':
    default: {
      const breath = Math.sin(t * 1.5);
      if (view.walking) {
        const step = Math.sin(t * 6);
        return { leftArm: -step * 0.3, rightArm: step * 0.3, leftElbow: 0.2, rightElbow: 0.2, leftSpread: 0.05, rightSpread: 0.05 };
      }
      // Waiting by the shrine: hands loosely together in front, glancing about.
      return {
        headYaw: Math.sin(t * 0.35) * 0.3,
        leftArm: 0.2,
        rightArm: 0.2,
        leftElbow: 0.9 + breath * 0.03,
        rightElbow: 0.9 + breath * 0.03,
        leftSpread: -0.12,
        rightSpread: -0.12,
      };
    }
  }
}

/** Forearms forward, palms meeting about twice a second. */
function clapping(t: number): Upper {
  const open = 0.5 + 0.5 * Math.sin(t * Math.PI * 4);
  return {
    headPitch: -0.05,
    leftArm: 0.45,
    rightArm: 0.45,
    leftElbow: 1.4,
    rightElbow: 1.4,
    leftSpread: -0.6 + 0.55 * open,
    rightSpread: -0.6 + 0.55 * open,
  };
}

/** Hands on the lap, head turning gently toward whoever is talking. */
function seatedListen(t: number): Upper {
  return {
    lean: 0.05,
    headYaw: Math.sin(t * 0.3) * 0.35,
    headPitch: Math.sin(t * 0.9) * 0.03,
    leftArm: 0.55,
    rightArm: 0.55,
    leftElbow: 0.55,
    rightElbow: 0.55,
    leftSpread: 0.05,
    rightSpread: 0.05,
  };
}

/** Talking with one hand while seated, nodding along. */
function seatedTalk(t: number): Upper {
  const gesture = Math.max(0, Math.sin(t * 1.6));
  return {
    headPitch: Math.sin(t * 2.2) * 0.07,
    headYaw: Math.sin(t * 0.6) * 0.2,
    leftArm: 0.55,
    leftElbow: 0.55,
    leftSpread: 0.05,
    rightArm: 0.6 + 0.4 * gesture,
    rightElbow: 0.6 + 0.9 * gesture + Math.sin(t * 7) * 0.1 * gesture,
    rightSpread: 0.12,
  };
}

/** Both hands out at chest height, forearms level: taking the box from the player, or holding the return box out. */
const BOX_OUT: Upper = { lean: 0.14, headPitch: -0.12, leftArm: 1.05, rightArm: 1.05, leftElbow: 0.5, rightElbow: 0.5, leftSpread: -0.2, rightSpread: -0.2 };
/** The box drawn in against the chest, forearms level under it. */
const BOX_HELD: Upper = { lean: 0.06, headPitch: -0.05, leftArm: 0.35, rightArm: 0.35, leftElbow: 1.25, rightElbow: 1.25, leftSpread: -0.22, rightSpread: -0.22 };
/**
 * Bent over the side table in front, the box low on both palms: setting the
 * family's box down on his left, or bringing the return box up from beside
 * the table on his right (the spreads shift both hands about 14 cm to that side).
 */
const BOX_ASIDE = (side: 1 | -1): Upper => ({
  lean: 0.9,
  headPitch: 0.1,
  leftArm: 0.9,
  rightArm: 0.9,
  leftElbow: 0.6,
  rightElbow: 0.6,
  leftSpread: -0.22 - 0.3 * side,
  rightSpread: -0.22 + 0.3 * side,
});
const BOX_DOWN_LEFT = BOX_ASIDE(-1);
const BOX_UP_RIGHT = BOX_ASIDE(1);

/** Seconds the handover gestures take to reach each pose. */
const HANDOVER_TIMING = { take: 0.25, drawIn: 0.5, lower: 0.5, lift: 0.3, offer: 0.4 } as const;

/**
 * The upper body for a gesture: a spoken line's, or a handover step's.
 * `since` is seconds into the gesture, for the handover's reaches; the
 * spoken gestures loop on `t` alone.
 */
export function gesturePose(gesture: Gesture | HandoverGesture, t: number, since = Infinity): Upper {
  switch (gesture) {
    case 'receiveGift': {
      // Out at arm's length, taking it; drawn in to the chest; then a grateful nod over it.
      const { take, drawIn } = HANDOVER_TIMING;
      if (since < take + drawIn) return blend(BOX_OUT, BOX_HELD, (since - take) / drawIn);
      const nod = Math.max(0, Math.sin((since - take - drawIn) * 3));
      return { ...BOX_HELD, lean: (BOX_HELD.lean ?? 0) + 0.12 * nod, headPitch: -0.05 - 0.2 * nod };
    }
    case 'setGiftAside':
      return blend(BOX_HELD, BOX_DOWN_LEFT, since / HANDOVER_TIMING.lower);
    case 'giveGift': {
      // Up from the side table to the chest, then out to the player, held there.
      const { lift, offer } = HANDOVER_TIMING;
      if (since < lift) return blend(BOX_UP_RIGHT, BOX_HELD, since / lift);
      return blend(BOX_HELD, BOX_OUT, (since - lift) / offer);
    }
    case 'wave': {
      // Right hand up beside the head, waving the player over.
      const wave = Math.sin(t * 7) * 0.35;
      return { headPitch: 0.05, leftArm: 0.1, leftElbow: 0.25, leftSpread: 0.08, rightArm: 0.3, rightSpread: 2.4, rightElbow: 0.6 + wave };
    }
    case 'namaste':
      return { ...NAMASTE, lean: 0.08, headPitch: -0.12 };
    case 'blessing': {
      // Right palm raised forward over the player, lifting a little.
      const lift = Math.sin(t * 2.5) * 0.12;
      return { headPitch: 0.05, leftArm: 0.1, leftElbow: 0.3, leftSpread: 0.08, rightArm: 1.55 + lift, rightElbow: 0.45, rightSpread: 0.1 };
    }
    case 'hug':
      return { lean: 0.08, leftArm: 1.2, rightArm: 1.2, leftSpread: 0.9, rightSpread: 0.9, leftElbow: 0.5, rightElbow: 0.5 };
    case 'tease': {
      // A wagging finger and a cheeky head tilt.
      const wag = Math.sin(t * 10) * 0.18;
      return {
        headYaw: 0.25,
        headPitch: 0.08 + Math.sin(t * 5) * 0.05,
        leftArm: 0.1,
        leftElbow: 0.25,
        leftSpread: 0.25,
        rightArm: 0.75,
        rightElbow: 1.8,
        rightSpread: 0.2 + wag,
      };
    }
    case 'clap':
      return clapping(t);
    case 'offerMithai':
      // Both hands forward, forearms level and close together, holding up a plate of mithai.
      return { lean: 0.15, headPitch: -0.15, leftArm: 0.8, rightArm: 0.8, leftElbow: 0.8, rightElbow: 0.8, leftSpread: -0.25, rightSpread: -0.25 };
    case 'cheekPinch':
      return { lean: 0.1, leftArm: 0.1, leftElbow: 0.3, leftSpread: 0.08, rightArm: 1.3, rightElbow: 0.9, rightSpread: -0.1 };
  }
}

const UPPER_KEYS = ['lean', 'headPitch', 'headYaw', 'leftArm', 'rightArm', 'leftSpread', 'rightSpread', 'leftElbow', 'rightElbow'] as const;

/** From `a` to `b` by `k` (clamped, eased), joint by joint; an omitted joint is at rest. */
function blend(a: Upper, b: Upper, k: number): Upper {
  const x = Math.min(1, Math.max(0, k));
  const e = x * x * (3 - 2 * x);
  const out: { -readonly [K in keyof Upper]: Upper[K] } = {};
  for (const key of UPPER_KEYS) out[key] = (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * e;
  return out;
}
