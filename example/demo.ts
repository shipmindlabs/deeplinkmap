/**
 * Eleven links arrive from outside the app. Five are fine.
 *
 *   npm run demo
 */

import { PendingLink, Router, type Route } from "../src/index.ts";

const routes: Route[] = [
  { name: "home", pattern: "/" },
  {
    name: "order",
    pattern: "/order/:id",
    params: { id: { kind: "number", min: 1 } },
    requiresAuth: true,
  },
  {
    name: "article",
    pattern: "/article/:slug",
    params: { slug: "slug" },
    query: { ref: "slug" },
  },
  {
    name: "receipt",
    pattern: "/receipt/:id/:format",
    params: { id: "uuid", format: { kind: "string", oneOf: ["pdf", "html"] } },
  },
];

const router = new Router(routes, { schemes: ["myapp"], hosts: ["example.com"] });

const receipt = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const arriving = [
  "https://example.com/order/4711",
  "myapp://article/hello-world?ref=newsletter&utm_source=spam",
  `https://example.com/receipt/${receipt}/pdf`,
  "https://example.com/order/abc",
  "https://example.com/order/1%20OR%201%3D1",
  "https://example.com/order/-3",
  `https://example.com/receipt/${receipt}/csv`,
  "https://evil.example.net/order/1",
  "otherapp://order/1",
  "https://example.com/admin/danger",
  "https://example.com/",
];

for (const url of arriving) {
  const resolution = router.resolve(url);
  if (resolution.ok) {
    const { name, params, query, requiresAuth } = resolution.match;
    const parts = [
      `-> ${name}`,
      Object.keys(params).length ? `params=${JSON.stringify(params)}` : "",
      Object.keys(query).length ? `query=${JSON.stringify(query)}` : "",
      requiresAuth ? "(sign in first)" : "",
    ].filter(Boolean);
    console.log(`  ${url.padEnd(52)} ${parts.join(" ")}`);
  } else {
    console.log(`  ${url.padEnd(52)} refused: ${resolution.refusal.reason}`);
  }
}

console.log("\na link arriving before the app is ready");
const pending = new PendingLink();
const cold = router.resolve("https://example.com/order/4711");
if (cold.ok) {
  pending.hold(cold.match);
  console.log(`  held while signing in : ${pending.waiting}`);
  console.log(`  resumed after login   : ${pending.take()?.name}`);
  console.log(`  delivered again       : ${pending.take() === null ? "no" : "yes"}`);
}
