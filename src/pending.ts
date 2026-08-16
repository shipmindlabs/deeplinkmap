/**
 * The link that arrived before the app was ready for it.
 *
 * Two moments break naive deep linking. A cold start opens the app *and*
 * delivers a link, so the link is resolved before the navigator exists. And a
 * link to a screen behind a login arrives while nobody is signed in, so the
 * screen either fails oddly or, worse, renders with no session.
 *
 * Both are the same shape: hold the destination, replay it when the app can
 * actually go there.
 */

import type { Match } from "./routes.ts";

export type PendingOptions = {
  /** How long a held link stays relevant. Defaults to ten minutes. */
  readonly expiresAfterMs?: number;
  readonly now?: () => Date;
};

export class PendingLink<Name extends string = string> {
  #held: { match: Match<Name>; at: number } | null = null;
  #expiresAfterMs: number;
  #now: () => Date;

  constructor(options: PendingOptions = {}) {
    this.#expiresAfterMs = options.expiresAfterMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => new Date());
  }

  get waiting(): boolean {
    return this.#held !== null && !this.#expired();
  }

  /** Hold a destination. A newer link replaces an older one. */
  hold(match: Match<Name>): void {
    this.#held = { match, at: this.#now().getTime() };
  }

  /**
   * Take the held destination, if there is a fresh one.
   *
   * Links expire because a link acted on twenty minutes late is a surprise: the
   * person tapped it, waited, gave up, and started using the app for something
   * else. Navigating them away then is worse than dropping it.
   */
  take(): Match<Name> | null {
    if (!this.#held || this.#expired()) {
      this.#held = null;
      return null;
    }
    const { match } = this.#held;
    this.#held = null;
    return match;
  }

  clear(): void {
    this.#held = null;
  }

  #expired(): boolean {
    if (!this.#held) return true;
    return this.#now().getTime() - this.#held.at > this.#expiresAfterMs;
  }
}
