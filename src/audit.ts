/**
 * Every decision, written down.
 *
 * A deep link picks a screen, so the routing table is an authorisation
 * boundary — and a boundary nobody can look at afterwards is one nobody can
 * check. The refusals are the interesting half: a run of `foreign-host` is
 * somebody probing the app with links it does not own, and a `bad-parameter`
 * on a route that worked last week is a link generator that drifted.
 *
 * The hook is set on the `Router`, where a link is accepted or refused, and
 * `LinkIntake` reports the deliveries it drops to that same hook, so one log
 * holds every decision rather than the ones that happened to go one way.
 */

import type { Match, Refusal } from "./routes.ts";

/** The door a link came through: the cold start, or a running app. */
export type LinkSource = "cold" | "warm";

export type AuditEvent<Name extends string = string> =
  | {
      readonly decision: "accepted";
      readonly at: Date;
      /** The link as received. */
      readonly url: string;
      /** The delivery path, or null when the router was asked directly. */
      readonly source: LinkSource | null;
      readonly match: Match<Name>;
    }
  | {
      readonly decision: "refused";
      readonly at: Date;
      readonly url: string;
      readonly source: LinkSource | null;
      readonly refusal: Refusal;
    }
  | {
      readonly decision: "duplicate";
      readonly at: Date;
      readonly url: string;
      readonly source: LinkSource;
    };

/** Where decisions go: a logger, a counter, a security event stream. */
export type Audit<Name extends string = string> = (event: AuditEvent<Name>) => void;

export function report<Name extends string>(audit: Audit<Name>, event: AuditEvent<Name>): void {
  try {
    audit(event);
  } catch {
    // The decision was made before the event was written, and a logger that
    // throws must not turn a link anyone can send into a crash inside a
    // Linking handler. The event is lost; the link is not.
  }
}
