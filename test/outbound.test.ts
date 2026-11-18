import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidLink,
  Router,
  type AuditEvent,
  type LinkOptions,
  type Match,
  type Route,
} from "../src/index.ts";

/**
 * The edges of a link built from the table.
 *
 * An outbound link is the one place where this table writes a URL instead of
 * reading one, so the two have to agree about every character: a value is
 * encoded on the way out and decoded on the way in, and anything the specs
 * would refuse on arrival is refused here, where nobody has been sent it yet.
 * The cases below are the ones where writing and reading a URL most easily
 * disagree — separators inside a value, form encoding in a query string, a
 * door the router has no address for, and a token that must stay out of the
 * error that refuses it.
 */

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const receipt = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: { kind: "number", min: 1, max: 1_000_000 } },
    accepts: ["universal", "scheme"],
  },
  { name: "file", pattern: "/file/:name", params: { name: "string" } },
  {
    name: "search",
    pattern: "/search",
    query: { q: "string", page: { kind: "number", min: 1, max: 99 } },
    accepts: ["universal", "scheme"],
  },
  {
    name: "invite",
    pattern: "/invite/:id",
    params: { id: "uuid" },
    query: { code: { kind: "uuid", secret: true } },
  },
  { name: "pair", pattern: "/pair", accepts: ["scheme"] },
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

/** The promise of building from the table: it reads back what it was given. */
function readsBack(
  name: string,
  params: Record<string, string | number> = {},
  options: LinkOptions = {},
): Match {
  const url = router.link(name, params, options);
  const match = matched(url);
  assert.equal(match.name, name, url);
  assert.deepEqual(match.params, params, url);
  assert.deepEqual(match.query, options.query ?? {}, url);
  if (options.form) assert.equal(match.form, options.form, url);
  return match;
}

const outbound: readonly (readonly [string, Record<string, string | number>, LinkOptions])[] = [
  ["home", {}, {}],
  ["order", { id: 4711 }, {}],
  ["order", { id: 4711 }, { form: "scheme" }],
  ["file", { name: "notes.txt" }, {}],
  ["search", {}, {}],
  ["search", {}, { query: { q: "deep links", page: 2 } }],
  ["search", {}, { form: "scheme", query: { page: 99 } }],
  ["invite", { id: receipt }, { query: { code: token } }],
  ["pair", {}, {}],
];

test("every link this table builds is one it reads back the same way", () => {
  for (const [name, params, options] of outbound) readsBack(name, params, options);
});

// Were a value interpolated rather than encoded, each of these would arrive as
// something other than itself: structure the sender never wrote.
test("a path value is encoded, not left to be read as structure", () => {
  const values = ["a&b", "a=b", "a b", "a%2Fb", "a:b", "a@b", ":name", "100%", "h\u00e9llo"];
  for (const name of values) {
    assert.equal(readsBack("file", { name }).params.name, name, name);
  }

  assert.equal(router.link("file", { name: "a&b" }), "https://example.com/file/a%26b");
  assert.equal(router.link("file", { name: "100%" }), "https://example.com/file/100%25");
});

// A query string is form-encoded, where a space is a plus and a plus is not.
test("a query value that reads like more query is still one value", () => {
  const url = router.link("search", {}, { query: { q: "a b&page=99" } });
  assert.equal(url, "https://example.com/search?q=a+b%26page%3D99");
  assert.deepEqual(matched(url).query, { q: "a b&page=99" });

  const plus = router.link("search", {}, { query: { q: "a+b" } });
  assert.equal(plus, "https://example.com/search?q=a%2Bb");
  assert.equal(matched(plus).query.q, "a+b");
});

// The separators the string kind refuses are the ones a path is split on, so
// no encoding of them makes a value that survives the trip back.
test("a value that would split the link it sits in cannot be built", () => {
  for (const name of ["a/b", "a?b", "a#b"]) {
    assert.throws(() => router.link("file", { name }), InvalidLink, name);
  }
  assert.throws(
    () => router.link("file", { name: "a?b" }),
    /:name="a\?b" is not a valid string/,
  );
});

test("an empty value is not a value, on the way out either", () => {
  assert.throws(() => router.link("file", { name: "" }), InvalidLink);
  assert.throws(() => router.link("search", {}, { query: { q: "" } }), InvalidLink);
});

test("a number is the same link however it was written, and is bounded", () => {
  assert.equal(router.link("order", { id: "7" }), router.link("order", { id: 7 }));
  assert.equal(matched(router.link("order", { id: "7" })).params.id, 7);

  for (const id of [1.5, "7 ", "9007199254740993", 1_000_001, 0]) {
    assert.throws(() => router.link("order", { id }), InvalidLink, String(id));
  }
  assert.throws(() => router.link("search", {}, { query: { page: 0 } }), InvalidLink);
  assert.throws(() => router.link("search", {}, { query: { page: 100 } }), InvalidLink);
  assert.throws(
    () => router.link("search", {}, { query: { utm_source: "spam" } }),
    /does not declare the query parameter \?utm_source/,
  );
});

// Without a chosen door, the most verified one the route opens to that the
// router can actually address: a wildcard names no host to send anybody to.
test("the default door skips a form the router has no address for", () => {
  const wildcardOnly = new Router(routes, { hosts: ["*.example.com"], schemes: ["myapp"] });

  const url = wildcardOnly.link("order", { id: 1 });
  assert.equal(url, "myapp://order/1");
  assert.equal(matched(url, wildcardOnly).form, "scheme");

  const search = wildcardOnly.link("search", {}, { query: { page: 2 } });
  assert.equal(search, "myapp://search?page=2");
  assert.deepEqual(matched(search, wildcardOnly).query, { page: 2 });

  // A route with only the universal door left has nowhere to point.
  assert.throws(
    () => wildcardOnly.link("file", { name: "notes.txt" }),
    /no host that is not a wildcard/,
  );
});

// A refusal here is read by whoever is building the link, so it says which
// door was missing rather than only that one was.
test("a door the router cannot address names what is missing", () => {
  const hostOnly = new Router(
    [
      {
        name: "order",
        pattern: "/order/:id",
        params: { id: "number" },
        accepts: ["universal", "scheme"],
      },
    ],
    { hosts: ["example.com"] },
  );
  assert.throws(() => hostOnly.link("order", { id: 1 }, { form: "scheme" }), /declares no scheme/);

  const secure = new Router([{ name: "dev", pattern: "/dev", accepts: ["universal", "insecure"] }], {
    hosts: ["example.com"],
  });
  assert.throws(() => secure.link("dev", {}, { form: "insecure" }), /does not allow insecure links/);

  const wildcarded = new Router([{ name: "dev", pattern: "/dev", accepts: ["insecure"] }], {
    hosts: ["*.example.com"],
    allowInsecure: true,
  });
  assert.throws(
    () => wildcarded.link("dev", {}, { form: "insecure" }),
    /no host that is not a wildcard/,
  );
});

// The flag is not a door: a link built for local development arrives as the
// form it was built in, and a route only opens to it by saying so.
test("an insecure link built for development arrives as the insecure form", () => {
  const local = new Router(
    [
      {
        name: "dev",
        pattern: "/dev/:id",
        params: { id: "number" },
        accepts: ["universal", "insecure"],
      },
    ],
    { hosts: ["localhost"], allowInsecure: true },
  );

  const url = local.link("dev", { id: 1 }, { form: "insecure" });
  assert.equal(url, "http://localhost/dev/1");
  assert.equal(matched(url, local).form, "insecure");
});

// A detail names the value it refused, which for a secret is the secret.
test("a secret query value is not written into the error that refuses it", () => {
  assert.throws(
    () => router.link("invite", { id: receipt }, { query: { code: "not-a-uuid-at-all" } }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidLink);
      assert.match(error.message, /\?code=\*\*\*/);
      assert.ok(!error.message.includes("not-a-uuid-at-all"));
      return true;
    },
  );
});

// Building a link decides nothing about a link somebody sent, so there is no
// decision to write down — and the link that comes back is recorded masked
// like any other.
test("building a link is not a decision the audit hook hears about", () => {
  const events: AuditEvent[] = [];
  const audited = new Router(routes, {
    hosts: ["example.com"],
    schemes: ["myapp"],
    audit: (event) => events.push(event),
  });

  const url = audited.link("invite", { id: receipt }, { query: { code: token } });
  assert.equal(events.length, 0, "the table was asked to build, not to decide");

  assert.equal(audited.resolve(url).ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.url, `https://example.com/invite/${receipt}?code=***`);
  assert.ok(!JSON.stringify(events).includes(token));

  assert.throws(() => audited.link("order", { id: 0 }), InvalidLink);
  assert.equal(events.length, 1, "a link refused where it was built never reached the table");
});
