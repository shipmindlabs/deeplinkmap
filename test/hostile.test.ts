import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Router,
  type AuditEvent,
  type Match,
  type Refusal,
  type Route,
} from "../src/index.ts";

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: { kind: "number", min: 1, max: 1_000_000 } },
    accepts: ["universal", "scheme"],
  },
  {
    name: "article",
    pattern: "/article/:slug",
    params: { slug: "slug" },
    query: { ref: "slug" },
    accepts: ["universal", "scheme"],
  },
  {
    name: "file",
    pattern: "/file/:name",
    params: { name: "string" },
    accepts: ["universal", "scheme"],
  },
  // A token in a URL only arrives through a door the operating system checked.
  { name: "reset", pattern: "/reset/:token", params: { token: "uuid" } },
];

const router = new Router(routes, {
  hosts: ["example.com", "*.example.com"],
  schemes: ["myapp"],
});

function matched(url: string, using: Router = router): Match {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  return (resolution as { ok: true; match: Match }).match;
}

function refused(url: string, using: Router = router): Refusal {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, false, `expected ${url} to be refused`);
  return (resolution as { ok: false; refusal: Refusal }).refusal;
}

/**
 * Links as a stranger sends them, each with the reason it earns. A hardening
 * table is only useful if it names the reason: a probe refused for the wrong
 * one is a check passing by accident.
 */
const hostile: readonly (readonly [string, Refusal["reason"]])[] = [
  // Hosts that merely end with, contain or read like a host this app owns.
  ["https://example.com.evil.net/order/1", "foreign-host"],
  ["https://example.com.evil.net./order/1", "foreign-host"],
  ["https://evil.example.net/order/1", "foreign-host"],
  ["https://notexample.com/order/1", "foreign-host"],
  ["https://EXAMPLE.COM.EVIL.NET/order/1", "foreign-host"],
  ["https://a.b.example.com/order/1", "foreign-host"],
  ["https://127.0.0.1/order/1", "foreign-host"],
  ["https://evil.net/order/1?from=example.com", "foreign-host"],
  // Userinfo puts our host in front of somebody else's.
  ["https://example.com@evil.net/order/1", "foreign-host"],
  ["https://user:pass@evil.net/order/1", "foreign-host"],

  // Doors this app does not have, however the scheme is written.
  ["http://example.com/order/1", "insecure-scheme"],
  ["HTTP://example.com/order/1", "insecure-scheme"],
  ["otherapp://order/1", "unknown-scheme"],
  ["myapp2://order/1", "unknown-scheme"],
  ["javascript:alert(document.cookie)", "unknown-scheme"],
  ["data:text/html;base64,PHNjcmlwdD4=", "unknown-scheme"],
  ["file:///etc/passwd", "unknown-scheme"],
  [`MyApp://reset/${token}`, "form-not-accepted"],

  // Not links at all.
  ["", "unparseable"],
  ["//example.com/order/1", "unparseable"],
  ["example.com/order/1", "unparseable"],
  ["https://", "unparseable"],

  // Traversal, raw and encoded. What the URL parser normalises away lands on
  // no route; what survives arrives as a parameter and is refused as one.
  ["https://example.com/order/../admin/danger", "no-route"],
  ["https://example.com/order/%2e%2e%2fadmin", "bad-parameter"],
  ["https://example.com/article/..%2Fadmin", "bad-parameter"],
  ["https://example.com/file/%2Fetc%2Fpasswd", "bad-parameter"],
  ["myapp://order/..%2Fadmin", "bad-parameter"],
  // A custom scheme has no verified host, so a hostname is just a segment.
  ["myapp://evil.com/order/1", "no-route"],
  ["https://example.com/order/5/extra", "no-route"],
  ["https://example.com/order/", "no-route"],

  // Values too long, too large, or out of range for the screen behind them.
  [`https://example.com/article/${"a".repeat(300)}`, "bad-parameter"],
  [`https://example.com/file/${"x".repeat(129)}`, "bad-parameter"],
  [`https://example.com/order/${"9".repeat(40)}`, "bad-parameter"],
  ["https://example.com/order/1000001", "bad-parameter"],
  ["https://example.com/order/-1", "bad-parameter"],
  [`https://example.com/article/hello-world?ref=${"a".repeat(200)}`, "bad-parameter"],

  // Payloads smuggled through a placeholder.
  ["https://example.com/order/5%00", "bad-parameter"],
  ["https://example.com/order/5%0d%0aSet-Cookie:%20session=x", "bad-parameter"],
  [`https://example.com/order/${encodeURIComponent("1; DROP TABLE orders")}`, "bad-parameter"],
  ["https://example.com/reset/00000000-0000-0000-0000-00000000000z", "bad-parameter"],
];

test("an attacker-shaped link is refused with the reason it earns", () => {
  for (const [url, reason] of hostile) {
    assert.equal(refused(url).reason, reason, url);
  }
});

// An app being probed with links to hosts it does not own must not look like
// one nobody is sending anything to.
test("every refusal of a hostile link is written down", () => {
  const events: AuditEvent[] = [];
  const audited = new Router(routes, {
    hosts: ["example.com", "*.example.com"],
    schemes: ["myapp"],
    audit: (event) => events.push(event),
  });

  for (const [url] of hostile) audited.resolve(url, "warm");

  assert.equal(events.length, hostile.length);
  assert.deepEqual(
    events.map((event) => (event.decision === "refused" ? event.refusal.reason : event.decision)),
    hostile.map(([, reason]) => reason),
  );
  assert.ok(
    events.every((event) => event.source === "warm"),
    "the door every probe came through is part of the record",
  );
});

// A scheme is case-insensitive, so writing it oddly is not a way around the
// policy attached to it: the refusal above for MyApp://reset is the other half.
test("a mixed-case scheme is the same scheme", () => {
  assert.equal(matched("HTTPS://EXAMPLE.COM/order/5").params.id, 5);
  assert.equal(matched("HTTPS://EXAMPLE.COM/order/5").form, "universal");
  assert.equal(matched("MyApp://order/5").form, "scheme");
  assert.equal(matched("MYAPP://ORDER/5").name, "order");
  assert.equal(matched(`HTTPS://example.com/reset/${token}`).name, "reset");
});

test("an allow-list written in mixed case means what it says", () => {
  const shouting = new Router(routes, { hosts: ["Example.Com."], schemes: ["MyApp"] });
  assert.equal(matched("https://example.com/order/5", shouting).params.id, 5);
  assert.equal(matched("myapp://order/5", shouting).form, "scheme");
  assert.equal(refused("https://app.example.com/order/5", shouting).reason, "foreign-host");
});

// A screen that reads an unexpected parameter is reading a stranger's input.
test("extra parameters never reach a screen", () => {
  const article = matched(
    "https://example.com/article/hello-world?ref=newsletter&utm_source=spam&admin=1",
  );
  assert.deepEqual(article.query, { ref: "newsletter" });

  // A route declaring no query takes none, including one shaped like its path.
  const order = matched("https://example.com/order/5?id=9&requiresAuth=false");
  assert.equal(order.params.id, 5);
  assert.deepEqual(order.query, {});
});

test("a declared query parameter repeated takes one value", () => {
  const match = matched("https://example.com/article/hello-world?ref=newsletter&ref=spam");
  assert.deepEqual(match.query, { ref: "newsletter" });
});

test("a fragment is not part of the route", () => {
  const url = "https://example.com/order/5#/admin/danger";
  const match = matched(url);
  assert.equal(match.name, "order");
  assert.equal(match.params.id, 5);
  assert.equal(match.url, url, "the link is kept whole for the log");
});

test("a length bound is a boundary, not a suggestion", () => {
  const name = "x".repeat(128);
  assert.equal(matched(`https://example.com/file/${name}`).params.name, name);
  assert.equal(refused(`https://example.com/file/${name}x`).reason, "bad-parameter");
});
