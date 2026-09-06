import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidRoute, PendingLink, Router, type Match, type Route } from "../src/index.ts";

const routes: Route[] = [
  { name: "home", pattern: "/" },
  { name: "order", pattern: "/order/:id", params: { id: "number" }, requiresAuth: true },
  {
    name: "article",
    pattern: "/article/:slug",
    params: { slug: "slug" },
    query: { ref: "slug", page: "number" },
  },
  { name: "reset", pattern: "/reset/:token", params: { token: "uuid" } },
];

const router = new Router(routes, { schemes: ["myapp"], hosts: ["example.com"] });

const constrained = new Router(
  [
    { name: "page", pattern: "/page/:n", params: { n: { kind: "number", min: 1, max: 99 } } },
    {
      name: "receipt",
      pattern: "/receipt/:format",
      params: { format: { kind: "string", oneOf: ["pdf", "html"] } },
    },
    {
      name: "search",
      pattern: "/search",
      query: { q: { kind: "string", minLength: 3, maxLength: 20 } },
    },
  ],
  { hosts: ["example.com"] },
);

function matched(url: string, using: Router = router): Match {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  return (resolution as { ok: true; match: Match }).match;
}

function refused(url: string, using: Router = router) {
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, false, `expected ${url} to be refused`);
  return (resolution as { ok: false; refusal: { reason: string; detail: string } }).refusal;
}

test("a link resolves to a screen with typed parameters", () => {
  const match = matched("https://example.com/order/4711");
  assert.equal(match.name, "order");
  assert.equal(match.params.id, 4711);
  assert.equal(typeof match.params.id, "number", "the screen gets a number, not a string");
  assert.equal(match.requiresAuth, true);
});

test("a custom scheme puts the first segment where it belongs", () => {
  const match = matched("myapp://order/12");
  assert.equal(match.name, "order");
  assert.equal(match.params.id, 12);
});

// A parameter is a string from a stranger. Passing it through unchecked is how
// a routing table becomes an injection point.
test("a parameter of the wrong shape is refused", () => {
  for (const url of [
    "https://example.com/order/abc",
    "https://example.com/order/4711x",
    "https://example.com/order/" + encodeURIComponent("1 OR 1=1"),
    "https://example.com/reset/not-a-uuid",
    "https://example.com/article/Not A Slug",
  ]) {
    assert.equal(refused(url).reason, "bad-parameter", url);
  }
});

test("a well-formed uuid and slug get through", () => {
  assert.equal(
    matched("https://example.com/reset/3f2504e0-4f89-41d3-9a0c-0305e82c3301").params.token,
    "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  );
  assert.equal(matched("https://example.com/article/hello-world").params.slug, "hello-world");
});

test("an absurdly long parameter is refused before it reaches a screen", () => {
  assert.equal(refused(`https://example.com/article/${"a".repeat(500)}`).reason, "bad-parameter");
});

// A kind says what a value looks like; a constraint says which of those values
// this screen actually has.
test("a number outside its declared range is refused", () => {
  assert.equal(matched("https://example.com/page/7", constrained).params.n, 7);
  assert.equal(refused("https://example.com/page/0", constrained).reason, "bad-parameter");
  assert.equal(refused("https://example.com/page/100", constrained).reason, "bad-parameter");
});

test("a value outside the declared set is refused", () => {
  assert.equal(matched("https://example.com/receipt/pdf", constrained).params.format, "pdf");
  const refusal = refused("https://example.com/receipt/csv", constrained);
  assert.equal(refusal.reason, "bad-parameter");
  assert.match(refusal.detail, /"pdf"/);
});

test("a query parameter carries its own constraints", () => {
  assert.equal(matched("https://example.com/search?q=deep", constrained).query.q, "deep");
  assert.equal(refused("https://example.com/search?q=ab", constrained).reason, "bad-parameter");
  assert.deepEqual(matched("https://example.com/search", constrained).query, {});
});

// An https link to a host this app does not own is somebody else's link.
// Following it is how an app becomes an open redirect with a native UI.
test("a link to a foreign host is refused", () => {
  const refusal = refused("https://evil.example.net/order/1");
  assert.equal(refusal.reason, "foreign-host");
  assert.match(refusal.detail, /evil\.example\.net/);
});

test("a scheme this app does not answer to is refused", () => {
  assert.equal(refused("otherapp://order/1").reason, "unknown-scheme");
});

// Opening "whatever matched last" is how a stranger's link lands on a screen
// nobody meant to expose.
test("a link matching nothing is refused rather than routed somewhere", () => {
  assert.equal(refused("https://example.com/admin/danger").reason, "no-route");
  assert.equal(refused("https://example.com/order/1/extra").reason, "no-route");
});

test("something that is not a URL at all is refused", () => {
  assert.equal(refused("not a url").reason, "unparseable");
});

// A parser of untrusted input must never throw: an uncaught URIError in a
// Linking handler takes the whole app down on a link anyone can send.
test("a malformed percent-sequence is refused, not thrown", () => {
  assert.equal(refused("https://example.com/order/%zz").reason, "bad-parameter");
  assert.equal(refused("https://example.com/order/%E0%A4%A").reason, "bad-parameter");
});

// A screen that reads an unexpected query parameter is reading a stranger's
// input.
test("undeclared query parameters are dropped, declared ones validated", () => {
  const match = matched("https://example.com/article/hello-world?ref=newsletter&utm_source=spam");
  assert.deepEqual(match.query, { ref: "newsletter" });

  assert.equal(refused("https://example.com/article/hello-world?page=lots").reason, "bad-parameter");
  assert.equal(matched("https://example.com/article/hello-world?page=3").query.page, 3);
});

test("the root route matches the root", () => {
  assert.equal(matched("https://example.com/").name, "home");
  assert.equal(matched("myapp://").name, "home");
});

// A placeholder nobody declared would arrive as an unvalidated string, so the
// table refuses to be built at all.
test("an undeclared placeholder is a build-time error", () => {
  assert.throws(
    () => new Router([{ name: "bad", pattern: "/thing/:id" }]),
    InvalidRoute,
  );
  assert.throws(
    () => new Router([{ name: "bad", pattern: "/thing", params: { id: "number" } }]),
    InvalidRoute,
  );
});

// A constraint that refuses everything describes a route that can never open.
test("a constraint that contradicts itself is a build-time error", () => {
  const impossible = [
    { name: "range", pattern: "/a/:n", params: { n: { kind: "number", min: 10, max: 1 } } },
    { name: "bounded-slug", pattern: "/b/:n", params: { n: { kind: "slug", min: 1 } } },
    { name: "wrong-set", pattern: "/c/:n", params: { n: { kind: "number", oneOf: ["pdf"] } } },
    {
      name: "lengths",
      pattern: "/d/:n",
      params: { n: { kind: "string", minLength: 9, maxLength: 4 } },
    },
    { name: "empty-set", pattern: "/e/:n", params: { n: { kind: "string", oneOf: [] } } },
    { name: "query", pattern: "/f", query: { q: { kind: "number", min: 3, max: 2 } } },
  ] satisfies Route[];

  for (const route of impossible) {
    assert.throws(() => new Router([route]), InvalidRoute, route.name);
  }
});

test("a table that cannot be read unambiguously is a build-time error", () => {
  assert.throws(
    () => new Router([{ name: "twins", pattern: "/a/:id/:id", params: { id: "number" } }]),
    InvalidRoute,
  );
  assert.throws(
    () =>
      new Router([
        { name: "twice", pattern: "/a" },
        { name: "twice", pattern: "/b" },
      ]),
    InvalidRoute,
  );
});

test("the original link is kept for logging but not for routing", () => {
  const match = matched("https://example.com/order/9?utm_campaign=x");
  assert.equal(match.url, "https://example.com/order/9?utm_campaign=x");
  assert.deepEqual(match.query, {});
});

// A cold start delivers the link before the navigator exists; a link behind a
// login arrives before there is a session.
test("a link can be held and replayed once the app can act on it", () => {
  const pending = new PendingLink();
  assert.equal(pending.waiting, false);
  assert.equal(pending.take(), null);

  pending.hold(matched("https://example.com/order/5"));
  assert.equal(pending.waiting, true);

  const resumed = pending.take();
  assert.equal(resumed?.name, "order");
  assert.equal(pending.take(), null, "a held link is delivered once");
});

test("a newer link replaces an older one", () => {
  const pending = new PendingLink();
  pending.hold(matched("https://example.com/order/1"));
  pending.hold(matched("https://example.com/order/2"));
  assert.equal(pending.take()?.params.id, 2);
});

// A link acted on twenty minutes late navigates someone away from what they
// are doing now.
test("a held link expires", () => {
  let at = new Date("2026-08-16T10:00:00Z").getTime();
  const pending = new PendingLink({ expiresAfterMs: 60_000, now: () => new Date(at) });

  pending.hold(matched("https://example.com/order/5"));
  at += 30_000;
  assert.equal(pending.waiting, true);

  at += 60_000;
  assert.equal(pending.waiting, false);
  assert.equal(pending.take(), null);
});
