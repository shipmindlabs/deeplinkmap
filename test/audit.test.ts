import { test } from "node:test";
import assert from "node:assert/strict";

import { LinkIntake, Router, type AuditEvent, type Route } from "../src/index.ts";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: "number" },
    requiresAuth: true,
    accepts: ["universal", "scheme"],
  },
  { name: "reset", pattern: "/reset/:token", params: { token: "uuid" } },
];

function recording(also: (event: AuditEvent) => void = () => {}) {
  const events: AuditEvent[] = [];
  const router = new Router(routes, {
    hosts: ["example.com"],
    schemes: ["myapp"],
    audit: (event) => {
      events.push(event);
      also(event);
    },
  });
  return { router, events };
}

function accepted(event: AuditEvent | undefined): Extract<AuditEvent, { decision: "accepted" }> {
  assert.equal(event?.decision, "accepted", `expected accepted, got ${event?.decision ?? "none"}`);
  return event as Extract<AuditEvent, { decision: "accepted" }>;
}

function refused(event: AuditEvent | undefined): Extract<AuditEvent, { decision: "refused" }> {
  assert.equal(event?.decision, "refused", `expected refused, got ${event?.decision ?? "none"}`);
  return event as Extract<AuditEvent, { decision: "refused" }>;
}

function duplicate(event: AuditEvent | undefined): Extract<AuditEvent, { decision: "duplicate" }> {
  assert.equal(event?.decision, "duplicate", `expected duplicate, got ${event?.decision ?? "none"}`);
  return event as Extract<AuditEvent, { decision: "duplicate" }>;
}

test("an accepted link is reported with the route it chose", () => {
  const { router, events } = recording();

  router.resolve("https://example.com/order/5?utm_source=x");

  assert.equal(events.length, 1);
  const event = accepted(events[0]);
  assert.equal(event.url, "https://example.com/order/5?utm_source=x");
  assert.equal(event.match.name, "order");
  assert.equal(event.match.params.id, 5);
  assert.equal(event.match.form, "universal");
  assert.equal(event.source, null, "nothing delivered it: the router was asked directly");
});

// A refusal nobody sees is a boundary nobody can review: a run of foreign-host
// refusals is somebody probing the app with links it does not own.
test("a refused link is reported with the reason it was refused", () => {
  const { router, events } = recording();

  router.resolve("https://evil.example.net/order/1");

  const event = refused(events[0]);
  assert.equal(event.url, "https://evil.example.net/order/1");
  assert.equal(event.refusal.reason, "foreign-host");
  assert.match(event.refusal.detail, /evil\.example\.net/);
});

test("every decision is reported, exactly once each", () => {
  const { router, events } = recording();
  const arriving = [
    "https://example.com/order/5",
    "https://example.com/",
    "myapp://reset/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "http://example.com/order/1",
    "https://example.com.evil.net/order/1",
    "otherapp://order/1",
    "https://example.com/order/abc",
    "https://example.com/admin/danger",
    "not a url",
  ];

  for (const url of arriving) router.resolve(url);

  assert.equal(events.length, arriving.length);
  assert.deepEqual(
    events.map((event) => event.url),
    arriving,
  );
  assert.deepEqual(
    events.map((event) => event.decision),
    [
      "accepted",
      "accepted",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
      "refused",
    ],
  );
});

// A log that cannot say which door a link came through cannot tell a tap on a
// verified link from a custom-scheme link any installed app could have sent.
test("the door a link was delivered through is part of the record", () => {
  const { router, events } = recording();
  const intake = new LinkIntake(router);

  intake.start("https://example.com/order/5");
  intake.deliver("myapp://order/7");
  intake.deliver("https://evil.example.net/order/1");

  assert.equal(accepted(events[0]).source, "cold");
  assert.equal(accepted(events[1]).source, "warm");
  assert.equal(refused(events[2]).source, "warm");
});

test("a repeat that is never applied is still recorded", () => {
  const { router, events } = recording();
  const intake = new LinkIntake(router);
  const url = "https://example.com/order/5";

  intake.start(url);
  intake.deliver(url);

  assert.equal(events.length, 2);
  accepted(events[0]);
  const event = duplicate(events[1]);
  assert.equal(event.url, url);
  assert.equal(event.source, "warm");
});

// The decision is made before the event is written, and a logger that throws
// must not take down a Linking handler on a link anyone can send.
test("a hook that throws loses its event and nothing else", () => {
  const { router } = recording(() => {
    throw new Error("the log is full");
  });
  const intake = new LinkIntake(router);
  const url = "https://example.com/order/5";

  assert.equal(intake.start(url)?.status, "matched");
  assert.equal(intake.deliver(url).status, "duplicate");
  assert.equal(router.resolve("https://evil.example.net/order/1").ok, false);
});

test("the decision is timestamped by the router's clock", () => {
  const events: AuditEvent[] = [];
  const at = new Date("2026-08-16T10:00:00Z");
  const router = new Router(routes, {
    hosts: ["example.com"],
    schemes: ["myapp"],
    now: () => at,
    audit: (event) => events.push(event),
  });

  router.resolve("https://example.com/order/5");
  assert.equal(accepted(events[0]).at.toISOString(), "2026-08-16T10:00:00.000Z");
});

test("a table with no hook routes exactly as before", () => {
  const router = new Router(routes, { hosts: ["example.com"], schemes: ["myapp"] });
  const intake = new LinkIntake(router);

  assert.equal(router.audit, null);
  assert.equal(intake.start("https://example.com/order/5")?.status, "matched");
  assert.equal(intake.deliver("https://example.com/order/5").status, "duplicate");
});
