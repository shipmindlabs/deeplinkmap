import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidPolicy, Router, type Match, type Refusal, type Route } from "../src/index.ts";

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** Two hosts that read as example.com: a Cyrillic "a", and a capital "I". */
const cyrillic = "ex\u0430mple.com";
const capitalEye = "exampIe.com";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: { kind: "number", min: 1 } },
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
  { name: "reset", pattern: "/reset/:token", params: { token: { kind: "uuid", secret: true } } },
];

const router = new Router(routes, {
  hosts: ["example.com", "*.example.com"],
  schemes: ["myapp"],
});

function matched(url: string): Match {
  const resolution = router.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  return (resolution as { ok: true; match: Match }).match;
}

function refused(url: string): Refusal {
  const resolution = router.resolve(url);
  assert.equal(resolution.ok, false, `expected ${url} to be refused`);
  return (resolution as { ok: false; refusal: Refusal }).refusal;
}

/**
 * Links two URL parsers read differently, each written so that the reading
 * this table must not take would reach a screen: were %2F a separator, the
 * first link below would be /order/5 and a screen would open.
 */
const separators: readonly (readonly [string, Refusal["reason"]])[] = [
  ["https://example.com/order%2F5", "no-route"],
  ["myapp://order%2F5", "no-route"],
  ["https://example.com/file/a%2Fb", "bad-parameter"],
  ["https://example.com/file/..%2F..%2Fadmin", "bad-parameter"],
  // Split on %3F the slug would be hello-world and ref a stranger's value.
  ["https://example.com/article/hello-world%3Fref=spam", "bad-parameter"],
  // Split on %23 the slug would be hello-world and the rest a fragment.
  ["https://example.com/article/hello-world%23ref", "bad-parameter"],
];

test("an encoded separator never splits a segment", () => {
  for (const [url, reason] of separators) assert.equal(refused(url).reason, reason, url);

  // The whole segment reaches the check, separator and all.
  assert.match(
    refused("https://example.com/article/hello-world%3Fref=spam").detail,
    /hello-world\?ref=spam/,
  );

  // A separator that arrived as one still splits.
  const match = matched("https://example.com/article/hello-world?ref=newsletter#top");
  assert.equal(match.params.slug, "hello-world");
  assert.deepEqual(match.query, { ref: "newsletter" });
});

// Decoding twice is how %252F becomes a separator one layer too late.
test("a value is decoded exactly once", () => {
  assert.equal(matched("https://example.com/file/a%252Fb").params.name, "a%2Fb");
  assert.equal(refused("https://example.com/order/%2535").reason, "bad-parameter");
  assert.equal(refused("https://example.com/article/%252e%252e%252fadmin").reason, "bad-parameter");

  const url = router.link("file", { name: "a%2Fb" });
  assert.equal(url, "https://example.com/file/a%252Fb");
  assert.equal(matched(url).params.name, "a%2Fb");
});

// One parser keeps the first value of a repeated key and another the last. The
// screen is handed the first, and the rest never arrive at all.
test("a repeated query key is read once", () => {
  const url = "https://example.com/article/hello-world?ref=newsletter";
  assert.deepEqual(matched(`${url}&ref=spam`).query, { ref: "newsletter" });
  assert.deepEqual(matched(`${url}&ref=Not%20A%20Slug`).query, { ref: "newsletter" });

  const refusal = refused("https://example.com/article/hello-world?ref=Not%20A%20Slug&ref=x");
  assert.equal(refusal.reason, "bad-parameter");
  assert.match(refusal.detail, /\?ref=/);
});

/** Authorities putting a host this app owns where it is not the host. */
const authorities: readonly (readonly [string, Refusal["reason"]])[] = [
  ["https://example.com@evil.net/order/1", "foreign-host"],
  ["https://example.com:8443@evil.net/order/1", "foreign-host"],
  ["https://app.example.com@evil.net/order/1", "foreign-host"],
  ["https://user:pass@example.com.evil.net/order/1", "foreign-host"],
  // Past the first slash it is a path rather than userinfo, and no route is
  // there to take it.
  ["https://example.com/@evil.net/order/1", "no-route"],
];

test("userinfo that reads like a host is not the host", () => {
  for (const [url, reason] of authorities) assert.equal(refused(url).reason, reason, url);

  const refusal = refused("https://example.com@evil.net/order/1");
  assert.match(refusal.detail, /evil\.net/);
  assert.ok(!refusal.detail.includes("example.com"), "the detail names the host, not the userinfo");

  // Userinfo nobody routes on does not travel into the record either.
  assert.equal(
    refused(`https://example.com@evil.net/reset/${token}`).url,
    "https://evil.net/reset/***",
  );
});

test("an allow-list cannot carry userinfo or a port", () => {
  assert.throws(() => new Router([], { hosts: ["example.com@evil.net"] }), InvalidPolicy);
  assert.throws(() => new Router([], { hosts: ["example.com:8443"] }), InvalidPolicy);
});

test("a host that reads like this app's host is a foreign host", () => {
  for (const url of [
    `https://${cyrillic}/order/1`,
    `https://app.${cyrillic}/order/1`,
    `https://${capitalEye}/order/1`,
  ]) {
    assert.equal(refused(url).reason, "foreign-host", url);
  }

  // The refusal names the host as the parser saw it, so a log can tell apart
  // two hosts a person reading them cannot.
  const refusal = refused(`https://${cyrillic}/order/1`);
  assert.match(refusal.detail, /xn--/);
  assert.ok(!refusal.detail.includes("example.com"));

  assert.equal(refused("https://example.com/article/hell\u043E-world").reason, "bad-parameter");
});

test("a trailing dot is the same host, written differently", () => {
  assert.equal(matched("https://example.com./order/1").params.id, 1);
  assert.equal(matched("https://app.example.com./order/1").name, "order");
  assert.equal(refused("https://example.com.evil.net./order/1").reason, "foreign-host");
  assert.equal(matched(`https://example.com./reset/${token}`).url, "https://example.com./reset/***");
});

test("a port is not part of the host a link is compared against", () => {
  const match = matched("https://example.com:8443/order/1");
  assert.equal(match.name, "order");
  assert.equal(match.form, "universal");
  assert.equal(match.url, "https://example.com:8443/order/1", "the record keeps the port");

  assert.equal(refused("https://evil.net:8443/order/1").reason, "foreign-host");
  assert.equal(refused("https://example.com:abc/order/1").reason, "unparseable");
  assert.equal(
    matched(`https://example.com:8443/reset/${token}`).url,
    "https://example.com:8443/reset/***",
  );
});

// A custom scheme puts the first segment where a host goes, so a port written
// after it is not that segment: dropping it would route a link to a screen it
// never named.
test("a port is not part of a segment either", () => {
  assert.equal(refused("myapp://order:5/1").reason, "no-route");
  assert.equal(refused("myapp://order:8080/1").reason, "no-route");
  assert.equal(refused("myapp://order./1").reason, "no-route");
});
