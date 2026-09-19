import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidPolicy,
  InvalidRoute,
  Router,
  type LinkForm,
  type Match,
  type Route,
} from "../src/index.ts";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: "number" },
    requiresAuth: true,
    accepts: ["universal", "scheme"],
  },
  {
    name: "article",
    pattern: "/article/:slug",
    params: { slug: "slug" },
    query: { ref: "slug", page: "number" },
    accepts: ["universal", "scheme"],
  },
  // A reset link is a token in a URL: it may only arrive through a link the
  // operating system checked against a host this app owns.
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

const wildcarded = new Router([{ name: "order", pattern: "/order/:id", params: { id: "number" } }], {
  hosts: ["example.com", "*.example.com"],
});

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

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
  assert.equal(match.form, "universal");
});

test("a custom scheme puts the first segment where it belongs", () => {
  const match = matched("myapp://order/12");
  assert.equal(match.name, "order");
  assert.equal(match.params.id, 12);
  assert.equal(match.form, "scheme");
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
  assert.equal(matched(`https://example.com/reset/${token}`).params.token, token);
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

test("a wildcard host covers one label and no more", () => {
  assert.equal(matched("https://app.example.com/order/1", wildcarded).name, "order");
  assert.equal(matched("https://example.com/order/1", wildcarded).name, "order");
  assert.equal(refused("https://a.b.example.com/order/1", wildcarded).reason, "foreign-host");
});

// A host that merely ends with, or reads like, the declared one belongs to
// somebody else. This is what a startsWith/endsWith check hands the app to.
test("a host that only looks like ours is refused", () => {
  for (const url of [
    "https://example.com.evil.net/order/1",
    "https://evil-example.com/order/1",
    "https://example.com@evil.net/order/1",
    "https://notexample.com/order/1",
  ]) {
    assert.equal(refused(url, wildcarded).reason, "foreign-host", url);
  }
});

test("the same host written differently is still ours", () => {
  assert.equal(matched("https://EXAMPLE.com/order/1", wildcarded).name, "order");
  assert.equal(matched("https://example.com./order/1", wildcarded).name, "order");
});

// http is not a universal link: nothing verified it, and anyone between the tap
// and the app can rewrite where it points.
test("an http link is refused unless the app opts in", () => {
  assert.equal(refused("http://example.com/order/1").reason, "insecure-scheme");

  const local = new Router([{ name: "order", pattern: "/order/:id", params: { id: "number" } }], {
    hosts: ["localhost"],
    allowInsecure: true,
  });
  assert.equal(matched("http://localhost/order/1", local).name, "order");
  assert.equal(refused("http://example.com/order/1", local).reason, "foreign-host");
});

test("a scheme this app does not answer to is refused", () => {
  assert.equal(refused("otherapp://order/1").reason, "unknown-scheme");
});

// Any installed app can register myapp://, so a route reached by a token only
// opens to a link the operating system checked against one of our hosts.
test("a route not open to custom schemes refuses one", () => {
  assert.equal(matched(`https://example.com/reset/${token}`).name, "reset");
  const refusal = refused(`myapp://reset/${token}`);
  assert.equal(refusal.reason, "form-not-accepted");
  assert.match(refusal.detail, /custom-scheme/);
});

test("routes open to universal links only unless they say otherwise", () => {
  const strict = new Router([{ name: "home", pattern: "/" }], {
    schemes: ["myapp"],
    hosts: ["example.com"],
  });
  assert.equal(matched("https://example.com/", strict).name, "home");
  assert.equal(refused("myapp://", strict).reason, "form-not-accepted");
});

test("a route can be open to custom schemes only", () => {
  const paired = new Router([{ name: "pair", pattern: "/pair", accepts: ["scheme"] }], {
    schemes: ["myapp"],
    hosts: ["example.com"],
  });
  assert.equal(matched("myapp://pair", paired).name, "pair");
  assert.equal(refused("https://example.com/pair", paired).reason, "form-not-accepted");
});

test("the router sets the default door for its routes", () => {
  const schemeOnly = new Router([{ name: "home", pattern: "/" }], {
    schemes: ["myapp"],
    accepts: ["scheme"],
  });
  assert.equal(matched("myapp://", schemeOnly).name, "home");
  assert.equal(refused("https://example.com/", schemeOnly).reason, "foreign-host");
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
  const hosts = { hosts: ["example.com"] };
  assert.throws(() => new Router([{ name: "bad", pattern: "/thing/:id" }], hosts), InvalidRoute);
  assert.throws(
    () => new Router([{ name: "bad", pattern: "/thing", params: { id: "number" } }], hosts),
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
    assert.throws(() => new Router([route], { hosts: ["example.com"] }), InvalidRoute, route.name);
  }
});

test("a table that cannot be read unambiguously is a build-time error", () => {
  const hosts = { hosts: ["example.com"] };
  assert.throws(
    () => new Router([{ name: "twins", pattern: "/a/:id/:id", params: { id: "number" } }], hosts),
    InvalidRoute,
  );
  assert.throws(
    () =>
      new Router(
        [
          { name: "twice", pattern: "/a" },
          { name: "twice", pattern: "/b" },
        ],
        hosts,
      ),
    InvalidRoute,
  );
});

// An allow-list that cannot mean what it says is worse than none: it reads as a
// boundary while letting links through, or refusing every one of them.
test("a host or scheme that cannot be an allow-list is a build-time error", () => {
  for (const host of [
    "",
    "*",
    "*.com",
    "a.*.example.com",
    "https://example.com",
    "example.com:8080",
    "exa mple.com",
  ]) {
    assert.throws(() => new Router([], { hosts: [host] }), InvalidPolicy, host);
  }
  for (const scheme of ["", "http", "https", "my app", "myapp://", "1app"]) {
    assert.throws(() => new Router([], { schemes: [scheme] }), InvalidPolicy, scheme);
  }
});

test("a route with no door it can open is a build-time error", () => {
  assert.throws(() => new Router([{ name: "home", pattern: "/" }]), InvalidRoute);
  assert.throws(
    () =>
      new Router([{ name: "home", pattern: "/", accepts: ["scheme"] }], {
        hosts: ["example.com"],
      }),
    InvalidRoute,
  );
  assert.throws(
    () => new Router([{ name: "home", pattern: "/", accepts: [] }], { hosts: ["example.com"] }),
    InvalidPolicy,
  );
  assert.throws(
    () =>
      new Router([{ name: "home", pattern: "/", accepts: ["myapp" as LinkForm] }], {
        hosts: ["example.com"],
      }),
    InvalidPolicy,
  );
});

test("the original link is kept for logging but not for routing", () => {
  const match = matched("https://example.com/order/9?utm_campaign=x");
  assert.equal(match.url, "https://example.com/order/9?utm_campaign=x");
  assert.deepEqual(match.query, {});
});
