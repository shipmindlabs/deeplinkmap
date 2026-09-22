import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidIntake,
  LinkIntake,
  Router,
  type Delivery,
  type Match,
  type Refusal,
} from "../src/index.ts";

const router = new Router(
  [
    { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
    {
      name: "order",
      pattern: "/order/:id",
      params: { id: "number" },
      requiresAuth: true,
      accepts: ["universal", "scheme"],
    },
  ],
  { hosts: ["example.com"], schemes: ["myapp"] },
);

function applied(delivery: Delivery | null): Match {
  assert.equal(delivery?.status, "matched", `expected a match, got ${delivery?.status ?? "null"}`);
  return (delivery as { status: "matched"; match: Match }).match;
}

function refusalOf(delivery: Delivery | null): Refusal {
  assert.equal(delivery?.status, "refused", `expected a refusal, got ${delivery?.status ?? "null"}`);
  return (delivery as { status: "refused"; refusal: Refusal }).refusal;
}

function duplicated(delivery: Delivery | null): string {
  assert.equal(
    delivery?.status,
    "duplicate",
    `expected a duplicate, got ${delivery?.status ?? "null"}`,
  );
  return (delivery as { status: "duplicate"; url: string }).url;
}

function ticking() {
  let at = new Date("2026-08-16T10:00:00Z").getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

// Two delivery paths become two handlers, and two handlers drift until one of
// them is missing a check the other has.
test("a cold start and a url event go through the same entry point", () => {
  const intake = new LinkIntake(router);

  const cold = intake.start("https://example.com/order/5");
  assert.equal(applied(cold).params.id, 5);
  assert.equal(cold?.source, "cold");

  const warm = intake.deliver("myapp://order/7");
  assert.equal(applied(warm).params.id, 7);
  assert.equal(warm.source, "warm");
});

// A cold start can hand the same link over twice: once as the initial URL and
// once as an event. Applying it twice pushes the same screen twice.
test("a link delivered through both paths is applied once", () => {
  const intake = new LinkIntake(router);
  const url = "https://example.com/order/5";

  assert.equal(applied(intake.start(url)).params.id, 5);

  const again = intake.deliver(url);
  assert.equal(duplicated(again), url);
  assert.equal(again.source, "warm");
});

test("a different link is not suppressed by the one before it", () => {
  const intake = new LinkIntake(router);
  assert.equal(applied(intake.deliver("https://example.com/order/5")).params.id, 5);
  assert.equal(applied(intake.deliver("https://example.com/order/6")).params.id, 6);
  assert.equal(applied(intake.deliver("https://example.com/")).name, "home");
});

// Links are compared as received, so a link somebody meant to send is never
// folded into an earlier one.
test("two different URLs are two links, even to the same screen", () => {
  const intake = new LinkIntake(router);
  assert.equal(applied(intake.deliver("https://example.com/order/5")).params.id, 5);
  assert.equal(applied(intake.deliver("https://example.com/order/5?utm_source=x")).params.id, 5);
});

test("the same link after the window is a link again", () => {
  const clock = ticking();
  const intake = new LinkIntake(router, { dedupeWithinMs: 3_000, now: clock.now });
  const url = "https://example.com/order/5";

  assert.equal(applied(intake.deliver(url)).params.id, 5);
  clock.advance(3_000);
  duplicated(intake.deliver(url));

  clock.advance(1);
  assert.equal(applied(intake.deliver(url)).params.id, 5);
});

// The window is anchored to the first sighting: a link repeating in a loop must
// not keep pushing its own window out and disappear for good.
test("a repeat does not extend the window", () => {
  const clock = ticking();
  const intake = new LinkIntake(router, { dedupeWithinMs: 3_000, now: clock.now });
  const url = "myapp://order/5";

  applied(intake.start(url));
  for (let repeat = 0; repeat < 3; repeat++) {
    clock.advance(1_000);
    duplicated(intake.deliver(url));
  }

  clock.advance(1);
  assert.equal(applied(intake.deliver(url)).params.id, 5);
});

// A timezone trip or an NTP correction must not keep a link suppressed.
test("a clock that moves backwards does not keep a link suppressed", () => {
  const clock = ticking();
  const intake = new LinkIntake(router, { dedupeWithinMs: 3_000, now: clock.now });
  const url = "https://example.com/order/5";

  applied(intake.deliver(url));
  clock.advance(-3_600_000);
  assert.equal(applied(intake.deliver(url)).params.id, 5);
});

test("a refused link comes back through the same door, and only once", () => {
  const intake = new LinkIntake(router);
  const url = "https://evil.example.net/order/1";

  const refusal = refusalOf(intake.start(url));
  assert.equal(refusal.reason, "foreign-host");
  assert.equal(duplicated(intake.deliver(url)), url);
});

test("an app opened without a link has nothing to apply", () => {
  const intake = new LinkIntake(router);
  assert.equal(intake.start(null), null);
  assert.equal(intake.start(undefined), null);
});

test("clearing forgets what has been seen", () => {
  const intake = new LinkIntake(router);
  const url = "https://example.com/order/5";

  applied(intake.deliver(url));
  duplicated(intake.deliver(url));

  intake.clear();
  assert.equal(applied(intake.deliver(url)).params.id, 5);
});

// A window that drops nothing, or never forgets, reads as dedupe and behaves as
// something else.
test("a window that cannot dedupe is a construction error", () => {
  for (const dedupeWithinMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new LinkIntake(router, { dedupeWithinMs }),
      InvalidIntake,
      String(dedupeWithinMs),
    );
  }
});
