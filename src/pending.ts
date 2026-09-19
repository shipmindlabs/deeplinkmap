/**
 * The link that arrived before the app was ready for it.
 *
 * Two moments break naive deep linking. A cold start opens the app *and*
 * delivers a link, so the link is resolved before the navigator exists. And a
 * link to a screen behind a login arrives while nobody is signed in, so the
 * screen either fails oddly or, worse, renders with no session.
 *
 * Both are the same shape: hold the destination, replay it when the app can
 * actually go there — once, and only while it is still what the person meant.
 */

import type { Match } from "./routes.ts";

export type PendingOptions = {
  /** How long a held link stays relevant. Defaults to ten minutes. */
  readonly expiresAfterMs?: number;
  readonly now?: () => Date;
};

/** The hold was given a lifetime that could never replay a link. */
export class InvalidHold extends Error {}

const DEFAULT_EXPIRES_AFTER_MS = 10 * 60_000;

export class PendingLink<Name extends string = string> {
  #held: { match: Match<Name>; at: number } | null = null;
  #expiresAfterMs: number;
  #now: () => Date;

  constructor(options: PendingOptions = {}) {
    const expiresAfterMs = options.expiresAfterMs ?? DEFAULT_EXPIRES_AFTER_MS;
    // Zero drops every link the moment it is held; a lifetime with no end is
    // the replay-much-later surprise this exists to prevent. Both read as a
    // hold and behave as something else, so neither is accepted.
    if (!Number.isFinite(expiresAfterMs) || expiresAfterMs < 1) {
      throw new InvalidHold(
        `expiresAfterMs ${expiresAfterMs} is not a lifetime a link can be held for`,
      );
    }
    this.#expiresAfterMs = expiresAfterMs;
    this.#now = options.now ?? (() => new Date());
  }

  get waiting(): boolean {
    return this.#fresh() !== null;
  }

  /** Hold a destination. A newer link replaces an older one. */
  hold(match: Match<Name>): void {
    this.#held = { match, at: this.#now().getTime() };
  }

  /**
   * Take the held destination, if there is a fresh one.
   *
   * The hold is released before the destination is handed back, so a link is
   * applied once: a second call, a remounted screen, a login that fires twice
   * get nothing. Links expire because a link acted on twenty minutes late is a
   * surprise: the person tapped it, waited, gave up, and started using the app
   * for something else. Navigating them away then is worse than dropping it.
   */
  take(): Match<Name> | null {
    const match = this.#fresh();
    this.#held = null;
    return match;
  }

  /** Drop whatever is held — signing out, or a destination gone stale. */
  clear(): void {
    this.#held = null;
  }

  /** The held link while it is still fresh, dropping it once it is not. */
  #fresh(): Match<Name> | null {
    if (!this.#held) return null;
    const elapsed = this.#now().getTime() - this.#held.at;
    // A clock that moved backwards — a timezone trip, an NTP correction —
    // would otherwise extend the hold instead of ending it.
    if (elapsed < 0 || elapsed > this.#expiresAfterMs) {
      this.#held = null;
      return null;
    }
    return this.#held.match;
  }
}
