import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidHold, PendingLink, Router, type Match } from "../src/index.ts";

const router = new Router(
  [{ name: "order", pattern: "/order/:id", params: { id: "number" }, requiresAuth: true }],
  { hosts: ["example.com"] },
);

function matched(url: string): Match {
  const resolution = router.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  return (resolution as { ok: true; match: Match }).match;
}

// A cold start delivers the link before the navigator exists; a link behind a
// login arrives before there is a session.
test("a link arriving before a session is parked and replayed after it", () => {
  const pending = new PendingLink();
  assert.equal(pending.waiting, false);
  assert.equal(pending.take(), null);

  const arriving = matched("https://example.com/order/5");
  assert.equal(arriving.requiresAuth, true);
  pending.hold(arriving);
  assert.equal(pending.waiting, true);

  const resumed = pending.take();
  assert.equal(resumed?.name, "order");
  assert.equal(resumed?.params.id, 5);
});

// Applying a held link twice opens a screen the person asked for once, from a
// login that fired twice or a screen that remounted.
test("a held link is applied once and cannot be applied again", () => {
  const pending = new PendingLink();
  pending.hold(matched("https://example.com/order/5"));

  assert.equal(pending.take()?.params.id, 5);
  assert.equal(pending.take(), null);
  assert.equal(pending.waiting, false);
});

test("a newer link replaces an older one", () => {
  const pending = new PendingLink();
  pending.hold(matched("https://example.com/order/1"));
  pending.hold(matched("https://example.com/order/2"));
  assert.equal(pending.take()?.params.id, 2);
  assert.equal(pending.take(), null);
});

// A link acted on twenty minutes late navigates someone away from what they
// are doing now.
test("a held link is dropped once its lifetime is over", () => {
  let at = new Date("2026-08-16T10:00:00Z").getTime();
  const pending = new PendingLink({ expiresAfterMs: 60_000, now: () => new Date(at) });

  pending.hold(matched("https://example.com/order/5"));
  at += 30_000;
  assert.equal(pending.waiting, true);

  at += 60_000;
  assert.equal(pending.waiting, false);
  assert.equal(pending.take(), null);
});

test("an expired link is gone, not merely hidden", () => {
  let at = new Date("2026-08-16T10:00:00Z").getTime();
  const pending = new PendingLink({ expiresAfterMs: 60_000, now: () => new Date(at) });

  pending.hold(matched("https://example.com/order/5"));
  at += 120_000;
  assert.equal(pending.waiting, false);

  at -= 120_000;
  assert.equal(pending.waiting, false, "a clock moving back does not bring a dropped link back");
  assert.equal(pending.take(), null);
});

// A timezone trip or an NTP correction must not extend a hold.
test("a clock that moves backwards ends the hold", () => {
  let at = new Date("2026-08-16T10:00:00Z").getTime();
  const pending = new PendingLink({ expiresAfterMs: 60_000, now: () => new Date(at) });

  pending.hold(matched("https://example.com/order/5"));
  at -= 3_600_000;
  assert.equal(pending.take(), null);
});

test("signing out drops what was held", () => {
  const pending = new PendingLink();
  pending.hold(matched("https://example.com/order/5"));
  pending.clear();
  assert.equal(pending.waiting, false);
  assert.equal(pending.take(), null);
});

// A lifetime that drops every link at once, or never drops one at all, reads
// as a hold and behaves as something else.
test("a lifetime that cannot hold a link is a construction error", () => {
  for (const expiresAfterMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new PendingLink({ expiresAfterMs }), InvalidHold, String(expiresAfterMs));
  }
});
