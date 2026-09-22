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

The two doors are not equally trustworthy. A universal link is one the operating
system checked against a host that serves `apple-app-site-association` or
`assetlinks.json` naming this app. A custom scheme is checked by nobody: any
installed app can also register `myapp://`, and any web page can link to it. So
the door a link came through is part of what it is allowed to do, and a route
carrying a reset token or reaching a signed-in screen can decline the unverified
one.

| | |
|---|---|
| `hosts` | `example.com`, or `*.example.com` for exactly one label below it |
| `schemes` | custom schemes, e.g. `myapp`; `http`/`https` belong in `hosts` |
| `accepts` | `universal`, `scheme` or both — per route, defaulting to `universal` |
| `allowInsecure` | accept `http` as well as `https`; off by default |

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
    // No accepts: a reset token only arrives through a verified link.
    { name: "reset", pattern: "/reset/:token", params: { token: "uuid" } },
  ],
  { schemes: ["myapp"], hosts: ["example.com", "*.example.com"] },
);

const intake = new LinkIntake(router);
const pending = new PendingLink();

function handle(delivery: Delivery | null) {
  if (delivery === null || delivery.status === "duplicate") return;
  if (delivery.status === "refused") return report(delivery.refusal);

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

## No React Native import

`Linking` hands this a string; that is the whole integration. So every case
above is tested in a plain runner without a device, and the same table works for
web URLs.

## What it is not

**Not a navigator.** It turns a URL into a name and validated parameters. Where
that name goes is your navigation library's business.

**Not link generation.** Building outbound links from a route name is the
obvious next thing and is not here yet.

**Not app-side link verification.** Whether iOS or Android will hand your app a
given universal link at all is decided by `apple-app-site-association` and
`assetlinks.json`, on your server. This validates what does arrive, and lets a
route say it wants only what came through that verified door.

**Not storage.** A hold lives in memory: a link parked before a login is gone if
the app is killed before signing in. What the intake remembers lives there too,
which is all a repeat-within-seconds window needs.

## Status

| | |
|---|---|
| Implemented | typed path parameters with four kinds, length bounds, numeric ranges and value sets, allow-listed query parameters, host allow-list with single-label wildcards, https by default, per-route link-form policy, refusal reasons, build-time checking of the table and the allow-lists, single-use pending links with a checked lifetime, one intake for cold starts and `url` events with a repeat window |
| Not yet | outbound link building, optional and wildcard segments, per-route rate limiting, a React hook wrapping `Linking` |

## Development

```bash
npm test        # node --test, no device
npm run demo
npm run typecheck
```

## License

MIT — built and maintained by [Shipmind Labs](https://shipmindlabs.com).
