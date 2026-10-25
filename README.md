# deeplinkmap

A deep link is a URL anyone can send. It arrives from an email, a text message,
another app, a QR code on a poster — and it picks a screen. That makes the
routing table an authorisation boundary, and the usual chain of `startsWith`
checks is not one.

```console
$ npm run demo
  https://example.com/order/4711        -> order params={"id":4711} (sign in first)
  myapp://article/hello-world?ref=…     -> article params={"slug":"hello-world"} query={"ref":"newsletter"}
  https://app.example.com/article/hel…  -> article params={"slug":"hello-world"}
  https://example.com/receipt/3f25…/pdf -> receipt params={"id":"3f25…","format":"pdf"}
  https://example.com/                  -> home
  myapp://order/4711                    refused: form-not-accepted
  http://example.com/order/4711         refused: insecure-scheme
  https://example.com.evil.net/order/1  refused: foreign-host
  https://evil.example.net/order/1      refused: foreign-host
  otherapp://order/1                    refused: unknown-scheme
  https://example.com/order/abc         refused: bad-parameter
  https://example.com/admin/danger      refused: no-route
```

## Why the table is the boundary

Every other check an app makes about what somebody may see runs after a screen
has been chosen. A deep link chooses the screen. By the time a component asks
whether there is a session, the navigator has pushed it, its effects have fired,
and the parameters it was handed came from whoever sent the URL — which, for a
link in an email or behind a QR code on a poster, is anybody.

That decision gets made whether or not anything is written to make it. In a
chain of `startsWith` checks it is made by a prefix and a `params` object of
strings, spread across the branches of one function, and the four things a
boundary has to be able to say cannot be said there: what exists, who may reach
it, what happens when nothing fits, and what was decided.

A table can say all four. A route exists or it does not. It declares the kind of
every parameter, so a screen expecting an id is never handed `1 OR 1=1`, and the
doors it opens to, so a reset token does not arrive through a scheme any
installed app can register. A link matching nothing earns a refusal — a value,
returned whole — rather than the last screen that nearly fit. And every
decision, accepted or refused, goes to one hook.

The table itself is checked before a link ever reaches it. A placeholder nobody
declared, a constraint that refuses every value, a route open to a door the app
does not have: each throws when the router is built. A boundary nobody can read
is one nobody can review, and a gap in it is a gap in the only place links are
decided.

## What gets refused

**Parameters are validated before a screen sees them.** `:id` declared as
`number` reaches the screen as a number, and `/order/1 OR 1=1` never gets that
far. Every placeholder must declare its kind — `string`, `number`, `uuid` or
`slug` — and a route with an undeclared placeholder **fails at construction**,
because an undeclared one would arrive as an unvalidated string from a stranger.
A refusal is returned whole: no screen is ever handed a half-filled parameter
object.

**A link to a host this app does not own is refused**, and so is a link through
a door the route does not open to. Following the first is how an app becomes an
open redirect wearing a native UI.

**A link that matches nothing goes nowhere.** Opening "whatever matched last" is
how a stranger's link lands on a screen nobody meant to expose.

Query parameters are allow-listed too: declared ones are validated, everything
else is dropped rather than passed on.

## Hosts and schemes

The doors are not equally trustworthy. A universal link is one the operating
system checked against a host that serves `apple-app-site-association` or
`assetlinks.json` naming this app. A custom scheme is checked by nobody: any
installed app can also register `myapp://`, and any web page can link to it. An
http link is checked by nobody either, and anyone between the tap and the app
can rewrite where it points. So the door a link came through is part of what it
is allowed to do, and a route carrying a reset token or reaching a signed-in
screen can decline the unverified ones.

`allowInsecure` is therefore not a door. It lets an http link be read at all,
during local development, and that link arrives as its own form — `insecure` —
so a route opens to it only by saying so. A route open to `insecure` alone
without the flag can never be reached, and throws when the router is built.

| | |
|---|---|
| `hosts` | `example.com`, or `*.example.com` for exactly one label below it |
| `schemes` | custom schemes, e.g. `myapp`; `http`/`https` belong in `hosts` |
| `accepts` | `universal`, `scheme`, `insecure`, or several — per route, defaulting to `universal` |
| `allowInsecure` | let `http` links be read at all; off by default, and a route still has to accept `insecure` |

A host is compared whole: `example.com.evil.net` ends with the declared host and
is somebody else's site, which is exactly what a `startsWith`/`endsWith` check
lets in. An allow-list that cannot mean what it says — `*`, `*.com`, a URL where
a hostname belongs, a route open to no door at all — throws when the router is
built.

Refusal reasons: `unparseable`, `insecure-scheme`, `foreign-host`,
`unknown-scheme`, `form-not-accepted`, `no-route`, `bad-parameter`.

## Kinds and constraints

A kind says what a value looks like; a constraint says which of those values the
screen actually has.

| | |
|---|---|
| `kind` | `string`, `number`, `uuid`, `slug` |
| `minLength` / `maxLength` | length bounds, `1` and `128` by default |
| `min` / `max` | closed range, `number` only |
| `oneOf` | the complete set of accepted values |
| `secret` | the value reaches the screen and no record of the decision |

A constraint that refuses everything — `min` above `max`, a `oneOf` value its
own kind rejects, `min` on a slug, a repeated or duplicated route — throws
`InvalidRoute` when the table is built, rather than sending links quietly
nowhere in the field.

## Use

```ts
const router = new Router(
  [
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
    // No accepts: a reset token only arrives through a verified link, and
    // secret keeps it out of every record of the decision.
    { name: "reset", pattern: "/reset/:token", params: { token: { kind: "uuid", secret: true } } },
  ],
  { schemes: ["myapp"], hosts: ["example.com", "*.example.com"] },
);

const intake = new LinkIntake(router);
const pending = new PendingLink();

function handle(delivery: Delivery | null) {
  if (delivery === null || delivery.status === "duplicate") return;
  if (delivery.status === "refused") return;   // the audit hook has it

  const { match } = delivery;
  if (match.requiresAuth && !session) {
    pending.hold(match);              // resume after signing in
    return navigate("SignIn");
  }
  navigate(match.name, match.params);
}

Linking.getInitialURL().then((url) => handle(intake.start(url)));
Linking.addEventListener("url", ({ url }) => handle(intake.deliver(url)));

// after a successful sign-in
const resumed = pending.take();
if (resumed) navigate(resumed.name, resumed.params);
```

## One door, cold or warm

A running app is handed links by an event; a starting app has to ask for the one
that opened it. Two delivery paths usually become two handlers, and two handlers
drift: one of them ends up missing a check the other has.

They also overlap. A cold start can deliver the same link through both paths, an
event can fire twice for a single tap, a notification reopened from the tray
repeats the URL it carried. Applied twice, that link pushes the same screen
twice — or replays whatever the screen does on arrival, which for a one-time
code or an order is not a cosmetic problem.

`LinkIntake` is the single door. Both paths call it, and a link already seen
within a short window comes back as a duplicate instead of being applied again.

| | |
|---|---|
| `start(url)` | the cold-start link, as `getInitialURL()` resolved it; `null` when there was none |
| `deliver(url)` | a link that arrived while the app was running |
| `clear()` | forget every link seen so far |
| `dedupeWithinMs` | how long a link is remembered, three seconds by default |

A delivery is `matched`, `refused` or `duplicate`, and each carries `source` —
`"cold"` or `"warm"` — so a log says which door a link came through.

The window is anchored to when a link was first seen, so a link repeating in a
loop cannot keep pushing its own window out and disappear for good. Links are
compared as received: two different URLs are two links, even when they end up on
the same screen.

## Every decision, written down

Usually a refused link leaves no trace, so an app being probed with links to
hosts it does not own looks exactly like one nobody is sending anything to. The
`audit` hook on the router is called with every decision the table makes, and
`LinkIntake` reports the repeats it drops to that same hook, so one log holds
every decision rather than only the ones that happened to go one way.

```ts
const router = new Router(routes, {
  hosts: ["example.com"],
  audit: (event) => {
    if (event.decision === "refused") {
      log.warn("deep link refused", { reason: event.refusal.reason, url: event.url });
    }
  },
});
```

| | |
|---|---|
| `decision` | `accepted`, `refused` or `duplicate` |
| `url` | the link, with every secret value masked |
| `source` | `cold`, `warm`, or `null` when the router was asked directly |
| `match` | on `accepted`: the route, its validated parameters — masked too — and the door |
| `refusal` | on `refused`: the reason and its detail |
| `at` | when the decision was made |

The refusals are the interesting half. A run of `foreign-host` is somebody
probing the app with links it does not own; a `bad-parameter` on a route that
worked last week is a link generator that drifted; `form-not-accepted` on a
reset route is a token arriving through a door any installed app can register.

A hook that throws loses its event and nothing else. The decision is already
made by then, and a logger that fails must not turn a link anyone can send into
a crash inside a `Linking` handler.

## A token is not written down

A reset link is a token in a URL, and the point of writing every decision down
is that afterwards there is a record of it. Together those two make the log a
second copy of every token that was sent — longer-lived than the link, usually,
and somewhere nobody meant to keep one.

A parameter declared `secret` stays out of that record. The value still reaches
`match.params`, because the screen is what the link was for. Everywhere the link
is reported it arrives with that segment masked: the audit event, the
`bad-parameter` detail that otherwise names the value it refused, `match.url`,
and the repeat the intake drops before the table is asked at all.

```ts
{ name: "reset", pattern: "/reset/:token", params: { token: { kind: "uuid", secret: true } } }
```

```
https://example.com/reset/***     accepted, and the screen still gets the token
token=*** is not a valid uuid     bad-parameter
```

What is masked follows the shape of the link, not the reason it was refused: a
token addressed to a host this app does not own, or arriving through a door its
route does not open to, was a token either way. The intake still compares links
as they arrived, so two different tokens remain two links and the second is not
dropped as a repeat of the first. `router.mask(url)` applies the same masking to
a link you are about to log yourself.

A value drawn from a set written down in the table is not a secret in the first
place, so `secret` together with `oneOf` throws when the router is built: the
refusal names that set whatever the value was.

## The link that arrives too early

Two moments break naive deep linking, and they are the same shape. A cold start
opens the app *and* delivers a link, so it resolves before the navigator exists.
A link to a screen behind a login arrives before there is a session.

`PendingLink` parks the destination and replays it once. `take()` releases the
hold before it hands the destination back, so the link is applied a single time:
a login that fires twice, a remounted screen or a stray second call gets
`null` rather than the screen again. `clear()` drops a hold on signing out, and a
newer link replaces an older one.

| | |
|---|---|
| `hold(match)` | park a destination, replacing whatever was parked |
| `take()` | the destination once, or `null` — never the same one twice |
| `waiting` | whether a fresh destination is still parked |
| `clear()` | drop it |
| `expiresAfterMs` | how long a hold lasts, ten minutes by default |

Held links expire, because a link acted on twenty minutes late navigates someone
away from whatever they started doing instead — and an expired hold is dropped
rather than kept out of sight. A lifetime that could never do that, zero or
endless, throws `InvalidHold`.

## Wiring it to React Navigation

The table decides; a navigator obeys. Keeping that one-way, with React
Navigation, takes a navigation ref and two functions.

```ts
// navigation.ts — the one file that knows a navigator exists
import { createNavigationContainerRef } from "@react-navigation/native";

export const nav = createNavigationContainerRef();
```

```ts
// links.ts
import { LinkIntake, PendingLink, type Delivery, type Match } from "deeplinkmap";
import { nav } from "./navigation.ts";
import { router } from "./routes.ts";

const intake = new LinkIntake(router);
const pending = new PendingLink();

function go(match: Match) {
  // A cold-start link resolves before the navigator mounts; a link behind a
  // login arrives before there is a session. Both park.
  if (!nav.isReady() || (match.requiresAuth && !session)) {
    pending.hold(match);
    if (nav.isReady()) nav.navigate("SignIn" as never);
    return;
  }
  // Where a name from the table meets a typed navigator: one file, two casts.
  nav.navigate(match.name as never, match.params as never);
}

/** Both of Linking's paths end up here. */
export function handle(delivery: Delivery | null) {
  // A refusal and a repeat are decisions too; the audit hook already has them.
  if (delivery?.status !== "matched") return;
  go(delivery.match);
}

/** The navigator became ready, or somebody signed in. */
export function resume() {
  const match = pending.take();
  if (match) go(match);
}
```

```tsx
<NavigationContainer ref={nav} onReady={resume}>
```

The `linking` prop stays off. React Navigation's own `linking` config is a
second table turning URLs into screens: it maps a path to a screen, hands the
segments on as strings, has no notion of a host this app does not own, and its
answer to an unmatched link is still a screen. Two tables deciding the same
links means the unchecked one answers some of them.

Route names are screen names here, which leaves no mapping to keep correct.
Where they have to differ, one record in this file is the whole translation.

## No React Native import

This imports nothing — not `Linking`, not React Navigation. `Linking` hands it a
string and `navigate` takes a name and an object, so the integration above is
ordinary values on both sides. That is why every case here is tested in a plain
runner, without a device or a navigator, and why the same table works for web
URLs.

## What it is not

**Not a navigator.** It turns a URL into a name and validated parameters. Where
that name goes is your navigation library's business.

**Not link generation.** Building outbound links from a route name is the
obvious next thing and is not here yet.

**Not app-side link verification.** Whether iOS or Android will hand your app a
given universal link at all is decided by `apple-app-site-association` and
`assetlinks.json`, on your server. This validates what does arrive, and lets a
route say it wants only what came through that verified door.

**Not a log.** The audit hook hands events to whatever you already log with; it
keeps nothing, batches nothing and writes nowhere.

**Not storage.** A hold lives in memory: a link parked before a login is gone if
the app is killed before signing in. What the intake remembers lives there too,
which is all a repeat-within-seconds window needs.

## Status

| | |
|---|---|
| Implemented | typed path parameters with four kinds, length bounds, numeric ranges and value sets, allow-listed query parameters, host allow-list with single-label wildcards, https by default with http as its own opt-in link form, per-route link-form policy, refusal reasons, build-time checking of the table and the allow-lists, single-use pending links with a checked lifetime, one intake for cold starts and `url` events with a repeat window, an audit hook carrying every decision — accepted, refused, or dropped as a repeat — and secret parameters masked in every record of one |
| Not yet | outbound link building, optional and wildcard segments, per-route rate limiting, a React hook wrapping `Linking` |

## Development

```bash
npm test        # node --test, no device
npm run demo
npm run typecheck
```

## License

MIT — built and maintained by [Shipmind Labs](https://shipmindlabs.com).
