import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidLink,
  Router,
  type LinkForm,
  type LinkOptions,
  type Match,
  type Route,
} from "../src/index.ts";

const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const receipt = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: { kind: "number", min: 1 } },
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
  {
    name: "receipt",
    pattern: "/receipt/:id/:format",
    params: { id: "uuid", format: { kind: "string", oneOf: ["pdf", "html"] } },
  },
  { name: "file", pattern: "/file/:name", params: { name: "string" } },
  { name: "reset", pattern: "/reset/:token", params: { token: { kind: "uuid", secret: true } } },
  { name: "pair", pattern: "/pair", accepts: ["scheme"] },
];

const router = new Router(routes, {
  hosts: ["example.com", "*.example.com"],
  schemes: ["myapp"],
});

/**
 * The whole point of building a link from the table: the table reads it back as
 * the route and the parameters it was built from.
 */
function readsBack(
  name: string,
  params: Record<string, string | number> = {},
  options: LinkOptions = {},
  using: Router = router,
): Match {
  const url = using.link(name, params, options);
  const resolution = using.resolve(url);
  assert.equal(resolution.ok, true, `expected ${url} to resolve`);
  const match = (resolution as { ok: true; match: Match }).match;
  assert.equal(match.name, name, url);
  assert.deepEqual(match.params, params, url);
  assert.deepEqual(match.query, options.query ?? {}, url);
  if (options.form) assert.equal(match.form, options.form, url);
  return match;
}

test("a link built from the table reads back as the same route and parameters", () => {
  readsBack("home");
  readsBack("order", { id: 4711 });
  readsBack("article", { slug: "hello-world" });
  readsBack("article", { slug: "hello-world" }, { query: { ref: "newsletter", page: 3 } });
  readsBack("receipt", { id: receipt, format: "pdf" });
  readsBack("reset", { token });
  readsBack("pair", {}, { form: "scheme" });
  readsBack("order", { id: 7 }, { form: "scheme" });
});

// A value is encoded on the way out and decoded on the way in, so what the
// screen gets back is what the link was built with.
test("a value needing encoding survives the round trip", () => {
  const name = "notes 2026.txt";
  assert.equal(router.link("file", { name }), "https://example.com/file/notes%202026.txt");
  assert.equal(readsBack("file", { name }).params.name, name);
});

test("a universal link points at the first exact host in the allow-list", () => {
  assert.equal(router.link("order", { id: 1 }), "https://example.com/order/1");

  const wildcardFirst = new Router(routes, {
    hosts: ["*.example.com", "example.com"],
    schemes: ["myapp"],
  });
  assert.equal(wildcardFirst.link("order", { id: 1 }), "https://example.com/order/1");
});

// A wildcard matches a range of subdomains rather than naming one, so there is
// no address in it to send anybody.
test("a link to a wildcard host cannot be built", () => {
  const wildcarded = new Router(
    [{ name: "order", pattern: "/order/:id", params: { id: "number" } }],
    { hosts: ["*.example.com"] },
  );
  assert.throws(() => wildcarded.link("order", { id: 1 }), InvalidLink);
});

test("a scheme link points at the first declared scheme", () => {
  const several = new Router(routes, {
    hosts: ["example.com"],
    schemes: ["myapp", "myapp-dev"],
  });
  assert.equal(several.link("pair"), "myapp://pair");
  assert.equal(several.link("order", { id: 1 }, { form: "scheme" }), "myapp://order/1");
});

// A universal link went through a door the operating system checked; a custom
// scheme is one any installed app can register.
test("the default door is the most verified one the route opens to", () => {
  assert.equal(router.link("home"), "https://example.com/");
  assert.equal(router.link("order", { id: 1 }), "https://example.com/order/1");
  assert.equal(router.link("pair"), "myapp://pair", "a scheme-only route has one door");

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
  assert.equal(local.link("dev", { id: 1 }), "https://localhost/dev/1");
  assert.equal(local.link("dev", { id: 1 }, { form: "insecure" }), "http://localhost/dev/1");
});

test("a form the route does not accept is not a link that can be built", () => {
  assert.throws(() => router.link("reset", { token }, { form: "scheme" }), InvalidLink);
  assert.throws(() => router.link("pair", {}, { form: "universal" }), InvalidLink);
  assert.throws(() => router.link("article", { slug: "x" }, { form: "insecure" }), InvalidLink);
  assert.throws(() => router.link("order", { id: 1 }, { form: "nope" as LinkForm }), InvalidLink);
});

test("a form the router has no door for is not a link that can be built", () => {
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
  assert.throws(() => hostOnly.link("order", { id: 1 }, { form: "scheme" }), InvalidLink);

  const secure = new Router([{ name: "dev", pattern: "/dev", accepts: ["universal", "insecure"] }], {
    hosts: ["example.com"],
  });
  assert.throws(() => secure.link("dev", {}, { form: "insecure" }), InvalidLink);
});

// A value nobody checked on the way out is refused on the way back in, inside
// an email somebody has already been sent.
test("a value the table would refuse on arrival is refused on the way out", () => {
  assert.throws(() => router.link("order", { id: 0 }), InvalidLink);
  assert.throws(() => router.link("order", { id: "abc" }), InvalidLink);
  assert.throws(() => router.link("article", { slug: "Not A Slug" }), InvalidLink);
  assert.throws(() => router.link("article", { slug: "a".repeat(200) }), InvalidLink);
  assert.throws(() => router.link("receipt", { id: receipt, format: "csv" }), InvalidLink);
  assert.throws(() => router.link("receipt", { id: "not-a-uuid", format: "pdf" }), InvalidLink);
  assert.throws(() => router.link("file", { name: "a/b" }), InvalidLink);
  assert.throws(
    () => router.link("article", { slug: "x" }, { query: { page: "lots" } }),
    InvalidLink,
  );
});

test("a route, a placeholder or a query parameter that is not there is refused", () => {
  assert.throws(() => router.link("admin"), InvalidLink);
  assert.throws(() => router.link("order"), InvalidLink);
  assert.throws(() => router.link("order", { id: 1, extra: 2 }), InvalidLink);
  assert.throws(() => router.link("receipt", { id: receipt }), InvalidLink);
  // An undeclared query parameter is dropped on arrival, so a link carrying one
  // loses part of itself on the way.
  assert.throws(
    () => router.link("article", { slug: "x" }, { query: { utm_source: "spam" } }),
    InvalidLink,
  );
});

test("a secret value is not written into the error that refuses it", () => {
  assert.throws(
    () => router.link("reset", { token: "not-a-uuid-at-all" }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidLink);
      assert.match(error.message, /\*\*\*/);
      assert.ok(!error.message.includes("not-a-uuid-at-all"));
      return true;
    },
  );
});

test("a built link carrying a token is recorded masked like any other", () => {
  assert.equal(router.link("reset", { token }), `https://example.com/reset/${token}`);

  const match = readsBack("reset", { token });
  assert.equal(match.params.token, token, "the screen is what the token was sent for");
  assert.equal(match.url, "https://example.com/reset/***");
});
