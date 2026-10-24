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
  const upper = view.line ? gesturePose(view.line.gesture, t) : upperBody(view.activity, view, t);
  return { ...lower, ...upper, lean: (upper.lean ?? 0) + (options.stoop ?? 0) };
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
    case 'serving':
      return gesturePose('offerMithai', t);
    case 'seated':
      return view.talking ? seatedTalk(t) : seatedListen(t);
    case 'greeting':
      return gesturePose('namaste', t);
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

/** The upper body for a spoken line's gesture. */
export function gesturePose(gesture: Gesture, t: number): Upper {
  switch (gesture) {
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
      // Both hands forward over the tray, offering.
      return { lean: 0.15, headPitch: -0.15, leftArm: 1.05, rightArm: 1.05, leftElbow: 0.55, rightElbow: 0.55, leftSpread: -0.15, rightSpread: -0.15 };
    case 'cheekPinch':
      return { lean: 0.1, leftArm: 0.1, leftElbow: 0.3, leftSpread: 0.08, rightArm: 1.3, rightElbow: 0.9, rightSpread: -0.1 };
  }
}
