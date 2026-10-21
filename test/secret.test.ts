import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidRoute,
  LinkIntake,
  Router,
  type AuditEvent,
  type Delivery,
  type Match,
  type Refusal,
  type Route,
} from "../src/index.ts";

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const routes: Route[] = [
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: "number" },
    accepts: ["universal", "scheme"],
  },
  // A token in a URL is what the link is for: it reaches the screen, and the
  // record of the decision gets everything except it.
  { name: "reset", pattern: "/reset/:token", params: { token: { kind: "uuid", secret: true } } },
  {
    name: "invite",
    pattern: "/invite",
    query: { code: { kind: "uuid", secret: true }, ref: "slug" },
    accepts: ["universal", "scheme"],
  },
];

function recording() {
  const events: AuditEvent[] = [];
  const router = new Router(routes, {
    hosts: ["example.com"],
    schemes: ["myapp"],
    audit: (event) => events.push(event),
  });
  return { router, events };
}

function matched(url: string, using: Router): Match {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  return (resolution as { ok: true; match: Match }).match;
}

function refused(url: string, using: Router): Refusal {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, false, `expected ${url} to be refused`);
  return (resolution as { ok: false; refusal: Refusal }).refusal;
}

function duplicated(delivery: Delivery | null): string {
  assert.equal(delivery?.status, "duplicate", "expected a duplicate");
  return (delivery as { status: "duplicate"; url: string }).url;
}

test("a secret parameter reaches the screen and not the record", () => {
  const { router, events } = recording();
  const match = matched(`https://example.com/reset/${token}`, router);

  assert.equal(match.params.token, token, "the screen is what the token was sent for");
  assert.equal(match.url, "https://example.com/reset/***");

  assert.equal(events.length, 1);
  const event = events[0] as Extract<AuditEvent, { decision: "accepted" }>;
  assert.equal(event.decision, "accepted");
  assert.equal(event.url, "https://example.com/reset/***");
  assert.equal(event.match.params.token, "***", "the event carries a masked match");
  assert.ok(!JSON.stringify(events).includes(token), "nothing written down holds the token");
});

// A detail says which value was refused, which for a secret is the value.
test("a secret value is masked in a bad-parameter detail", () => {
  const { router, events } = recording();
  const refusal = refused("https://example.com/reset/not-a-uuid-at-all", router);

  assert.equal(refusal.reason, "bad-parameter");
  assert.equal(refusal.detail, "token=*** is not a valid uuid");
  assert.equal(refusal.url, "https://example.com/reset/***");
  assert.ok(!JSON.stringify(events).includes("not-a-uuid-at-all"));
});

// The shape of the link decides what is masked, not the reason it was refused:
// a token refused at the door was still a token in a log.
test("a token refused before it reached its route is masked too", () => {
  const { router, events } = recording();

  assert.equal(refused(`myapp://reset/${token}`, router).url, `myapp://reset/***`);
  assert.equal(
    refused(`https://evil.example.net/reset/${token}`, router).url,
    "https://evil.example.net/reset/***",
  );
  assert.equal(
    refused(`http://example.com/reset/${token}`, router).url,
    "http://example.com/reset/***",
  );
  assert.deepEqual(
    events.map((event) => (event.decision === "refused" ? event.refusal.reason : event.decision)),
    ["form-not-accepted", "foreign-host", "insecure-scheme"],
  );
  assert.ok(!JSON.stringify(events).includes(token));
});

test("a repeat carrying a token is dropped and reported masked", () => {
  const { router, events } = recording();
  const intake = new LinkIntake(router);
  const url = `https://example.com/reset/${token}`;

  assert.equal(intake.start(url)?.status, "matched");
  assert.equal(duplicated(intake.deliver(url)), "https://example.com/reset/***");

  assert.equal(events.length, 2);
  assert.equal(events[1]?.decision, "duplicate");
  assert.equal(events[1]?.url, "https://example.com/reset/***");
  assert.ok(!JSON.stringify(events).includes(token));
});

// Masking a link for the record must not make two links look like one: the
// second token would then be dropped as a repeat of the first.
test("two different tokens are two links, not a repeat", () => {
  const { router } = recording();
  const intake = new LinkIntake(router);

  assert.equal(intake.deliver(`https://example.com/reset/${token}`).status, "matched");
  assert.equal(intake.deliver(`https://example.com/reset/${other}`).status, "matched");
  assert.equal(duplicated(intake.deliver(`https://example.com/reset/${other}`)), 
    "https://example.com/reset/***");
});

test("a secret query parameter is masked and the rest of the link kept", () => {
  const { router, events } = recording();
  const match = matched(
    `https://example.com/invite?ref=newsletter&code=${token}&utm_source=spam`,
    router,
  );

  assert.equal(match.query.code, token);
  assert.equal(match.query.ref, "newsletter");
  assert.equal(match.url, "https://example.com/invite?ref=newsletter&code=***&utm_source=spam");
  assert.ok(!JSON.stringify(events).includes(token));
});

test("a link to a route that keeps no secret is recorded as it arrived", () => {
  const { router } = recording();
  const url = "https://example.com/order/5?utm_campaign=x#top";

  assert.equal(matched(url, router).url, url);
  assert.equal(router.mask(url), url);
  assert.equal(router.mask("https://example.com/nothing/here"), "https://example.com/nothing/here");
  assert.equal(router.mask("not a url"), "not a url");
});

// A refusal names the set it refused against, so a value drawn from a set
// written down in the table was never secret.
test("a secret drawn from a declared set is a build-time error", () => {
  assert.throws(
    () =>
      new Router(
        [
          {
            name: "pick",
            pattern: "/pick/:choice",
            params: { choice: { kind: "string", secret: true, oneOf: ["a", "b"] } },
          },
        ],
        { hosts: ["example.com"] },
      ),
    InvalidRoute,
  );
});
