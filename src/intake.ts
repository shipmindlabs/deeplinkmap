/**
 * One door for every link, whichever way it arrived.
 *
 * A running app is handed links by an event; a starting app has to ask for the
 * one that opened it. Two delivery paths usually become two handlers, and two
 * handlers drift: one of them ends up missing a check the other has.
 *
 * They also overlap. A cold start can deliver the same link through both paths,
 * an event can fire twice for a single tap, and a notification reopened from
 * the tray repeats the URL it carried. Applied twice, that link pushes the same
 * screen twice — or replays whatever the screen does on arrival, which for a
 * one-time code or an order is not a cosmetic problem.
 *
 * So both paths meet in `deliver()`, and a link already seen within a short
 * window comes back as a duplicate instead of being applied again. A dropped
 * repeat is a decision like any other, and goes to the router's audit hook.
 */

import { report, type Audit, type LinkSource } from "./audit.ts";
import type { Match, Refusal, Router } from "./routes.ts";

export type Delivery<Name extends string = string> =
  | { readonly status: "matched"; readonly source: LinkSource; readonly match: Match<Name> }
  | { readonly status: "refused"; readonly source: LinkSource; readonly refusal: Refusal }
  | { readonly status: "duplicate"; readonly source: LinkSource; readonly url: string };

export type IntakeOptions = {
  /** How long a link is remembered as already seen. Defaults to three seconds. */
  readonly dedupeWithinMs?: number;
  readonly now?: () => Date;
};

/** The intake was given a window that could never tell a repeat from a tap. */
export class InvalidIntake extends Error {}

const DEFAULT_DEDUPE_WITHIN_MS = 3_000;

export class LinkIntake<Name extends string = string> {
  #router: Router<Name>;
  #seen = new Map<string, number>();
  #dedupeWithinMs: number;
  #now: () => Date;
  #audit: Audit<Name> | null;

  constructor(router: Router<Name>, options: IntakeOptions = {}) {
    const dedupeWithinMs = options.dedupeWithinMs ?? DEFAULT_DEDUPE_WITHIN_MS;
    // Zero remembers nothing, so every repeat is applied; a window with no end
    // makes a link tapped again an hour later do nothing at all. Both read as
    // dedupe and behave as something else, so neither is accepted.
    if (!Number.isFinite(dedupeWithinMs) || dedupeWithinMs < 1) {
      throw new InvalidIntake(
        `dedupeWithinMs ${dedupeWithinMs} is not a window a link can be remembered for`,
      );
    }
    this.#router = router;
    this.#dedupeWithinMs = dedupeWithinMs;
    this.#now = options.now ?? (() => new Date());
    // The hook is configured once, on the table that accepts and refuses. What
    // is dropped here goes to the same one, so one log holds every decision.
    this.#audit = router.audit;
  }

  /**
   * The link that opened the app, as `Linking.getInitialURL()` resolved it.
   * Usually there is none, and none is not a delivery.
   */
  start(url: string | null | undefined): Delivery<Name> | null {
    if (url === null || url === undefined) return null;
    return this.deliver(url, "cold");
  }

  /** Every link goes through here, whichever path handed it over. */
  deliver(url: string, source: LinkSource = "warm"): Delivery<Name> {
    const at = this.#now().getTime();
    this.#forget(at);

    // Links are compared as received: two different URLs are two links, even
    // when they end up on the same screen. Folding them together would suppress
    // a link somebody meant to send.
    if (this.#seen.has(url)) {
      if (this.#audit) {
        report(this.#audit, { decision: "duplicate", at: new Date(at), url, source });
      }
      return { status: "duplicate", source, url };
    }
    // The window is anchored to the first sighting, so a burst of repeats
    // cannot keep pushing it out and hide the link indefinitely.
    this.#seen.set(url, at);

    const resolution = this.#router.resolve(url, source);
    return resolution.ok
      ? { status: "matched", source, match: resolution.match }
      : { status: "refused", source, refusal: resolution.refusal };
  }

  /** Forget every link seen so far — signing out, or a deliberate retry. */
  clear(): void {
    this.#seen.clear();
  }

  #forget(at: number): void {
    for (const [url, seenAt] of this.#seen) {
      const elapsed = at - seenAt;
      // A clock that moved backwards — a timezone trip, an NTP correction —
      // would otherwise keep a link suppressed for as long as the correction.
      if (elapsed < 0 || elapsed > this.#dedupeWithinMs) this.#seen.delete(url);
    }
  }
}
