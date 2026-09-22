/**
 * Twelve links arrive from outside the app. Five are fine.
 *
 *   npm run demo
 */

import { LinkIntake, PendingLink, Router, type Delivery, type Route } from "../src/index.ts";

const routes: Route[] = [
  { name: "home", pattern: "/", accepts: ["universal", "scheme"] },
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
    accepts: ["universal", "scheme"],
  },
  {
    name: "receipt",
    pattern: "/receipt/:id/:format",
    params: { id: "uuid", format: { kind: "string", oneOf: ["pdf", "html"] } },
  },
];

const router = new Router(routes, {
  schemes: ["myapp"],
  hosts: ["example.com", "*.example.com"],
});

const receipt = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const arriving = [
  "https://example.com/order/4711",
  "myapp://article/hello-world?ref=newsletter&utm_source=spam",
  "https://app.example.com/article/hello-world",
  `https://example.com/receipt/${receipt}/pdf`,
  "https://example.com/",
  "myapp://order/4711",
  "http://example.com/order/4711",
  "https://example.com.evil.net/order/1",
  "https://evil.example.net/order/1",
  "otherapp://order/1",
  "https://example.com/order/abc",
  "https://example.com/admin/danger",
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

function show(delivery: Delivery | null): string {
  if (delivery === null) return "nothing to apply";
  if (delivery.status === "matched") return `-> ${delivery.match.name} (${delivery.source})`;
  if (delivery.status === "refused") return `refused: ${delivery.refusal.reason}`;
  return "duplicate, not applied again";
}

console.log("\none door, cold start and url event alike");
const intake = new LinkIntake(router);
const opened = "https://example.com/article/hello-world";
console.log(`  cold start            : ${show(intake.start(opened))}`);
console.log(`  url event, same link  : ${show(intake.deliver(opened))}`);
console.log(`  url event, other link : ${show(intake.deliver("https://example.com/"))}`);
console.log(`  opened with no link   : ${show(intake.start(null))}`);
