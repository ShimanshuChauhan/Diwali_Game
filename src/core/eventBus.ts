/**
 * Minimal typed publish/subscribe bus. `Events` maps each event name to its
 * payload type, so emit and subscribe are checked at compile time.
 *
 * Listeners run synchronously in subscription order. The listener list is
 * snapshotted per emit, so subscribing or unsubscribing during an emit takes
 * effect from the next emit.
 */
export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  /** Subscribe to an event. Returns a function that removes this listener. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  /** Subscribe for a single delivery. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as Listener<Events[K]>)(payload);
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Listeners across every event, e.g. to check repeated visits do not leak subscriptions. */
  totalListenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /** Remove every listener, e.g. when a session is torn down. */
  clear(): void {
    this.listeners.clear();
  }
}
