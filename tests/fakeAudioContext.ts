/**
 * Minimal stand-in for the Web Audio API, enough for the audio engine to
 * build its graphs headless. Tracks started/stopped sources so tests can
 * count real sounding voices, and lets tests move the clock.
 */
class FakeParam {
  value: number;
  readonly events: { method: string; args: number[] }[] = [];
  constructor(value = 0) {
    this.value = value;
  }
  private record(method: string, args: number[]): this {
    for (const arg of args) {
      if (!Number.isFinite(arg)) throw new TypeError(`${method}: non-finite argument`);
    }
    this.events.push({ method, args });
    return this;
  }
  setValueAtTime(v: number, t: number) {
    return this.record('setValueAtTime', [v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    return this.record('linearRampToValueAtTime', [v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError('exponential ramp target must be positive');
    return this.record('exponentialRampToValueAtTime', [v, t]);
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.value = v;
    return this.record('setTargetAtTime', [v, t, c]);
  }
  setValueCurveAtTime(values: Float32Array, t: number, duration: number) {
    if (values.length < 2) throw new RangeError('curve needs at least two values');
    for (const v of values) if (!Number.isFinite(v)) throw new TypeError('setValueCurveAtTime: non-finite value');
    return this.record('setValueCurveAtTime', [t, duration]);
  }
  cancelScheduledValues(t: number) {
    return this.record('cancelScheduledValues', [t]);
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  constructor(readonly ctx: FakeAudioContext) {}
  connect<T>(target: T): T {
    this.outputs.push(target);
    return target;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
}

class FakeConvolver extends FakeNode {
  buffer: unknown = null;
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly ratio = new FakeParam(12);
}

class FakePanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

export class FakeSource extends FakeNode {
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  buffer: unknown = null;
  loop = false;
  type = 'sine';
  readonly playbackRate = new FakeParam(1);
  readonly frequency = new FakeParam(440);
  start(when = 0): void {
    if (this.startedAt !== null) throw new Error('InvalidStateError: start called twice');
    if (!Number.isFinite(when)) throw new TypeError('start: non-finite');
    this.startedAt = when;
    this.ctx.sources.push(this);
  }
  stop(when = 0): void {
    if (this.startedAt === null) throw new Error('InvalidStateError: stop before start');
    if (!Number.isFinite(when)) throw new TypeError('stop: non-finite');
    this.stoppedAt = when;
  }
  /** Still sounding at the context's current time. */
  get sounding(): boolean {
    return this.stoppedAt === null || this.stoppedAt > this.ctx.currentTime;
  }
}

class FakeBuffer {
  private readonly data: Float32Array;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly sampleRate = 8000;
  readonly sources: FakeSource[] = [];
  readonly destination = new FakeNode(this);
  readonly gains: FakeGain[] = [];
  readonly panners: FakePanner[] = [];
  readonly listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(-1),
    upX: new FakeParam(),
    upY: new FakeParam(1),
    upZ: new FakeParam(),
  };
  /** Set to make `resume()` reject, as a blocked autoplay would. */
  rejectResume = false;

  async resume(): Promise<void> {
    if (this.rejectResume) throw new Error('NotAllowedError');
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  createGain(): FakeGain {
    const gain = new FakeGain(this);
    this.gains.push(gain);
    return gain;
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter(this);
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver(this);
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }
  createPanner(): FakePanner {
    const panner = new FakePanner(this);
    this.panners.push(panner);
    return panner;
  }
  createOscillator(): FakeSource {
    return new FakeSource(this);
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  /** Sources still playing now. */
  soundingSources(): FakeSource[] {
    return this.sources.filter((source) => source.sounding);
  }

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
