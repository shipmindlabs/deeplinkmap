# deeplinkmap

A deep link is a URL anyone can send. It arrives from an email, a text message,
another app, a QR code on a poster — and it picks a screen. That makes the
routing table an authorisation boundary, and the usual chain of `startsWith`
checks is not one.

```console
$ npm run demo
  https://example.com/order/4711        -> order params={"id":4711} (sign in first)
  myapp://article/hello-world?ref=…     -> article params={"slug":"hello-world"} query={"ref":"newsletter"}
  https://example.com/order/abc         refused: bad-parameter
  https://example.com/order/1%20OR%201%3D1  refused: bad-parameter
  https://evil.example.net/order/1      refused: foreign-host
  otherapp://order/1                    refused: unknown-scheme
  https://example.com/admin/danger      refused: no-route
  https://example.com/                  -> home
```

## Three refusals

**Parameters are validated before a screen sees them.** `:id` declared as
`number` reaches the screen as a number, and `/order/1 OR 1=1` never gets that
far. Every placeholder must declare its kind — `string`, `number`, `uuid` or
`slug` — and a route with an undeclared placeholder **fails at construction**,
because an undeclared one would arrive as an unvalidated string from a stranger.

**A link to a host this app does not own is refused.** Following one is how an
app becomes an open redirect wearing a native UI.

**A link that matches nothing goes nowhere.** Opening "whatever matched last" is
how a stranger's link lands on a screen nobody meant to expose.

Query parameters are allow-listed too: declared ones are validated, everything
else is dropped rather than passed on.

## Use

```ts
const router = new Router(
  [
    { name: "order", pattern: "/order/:id", params: { id: "number" }, requiresAuth: true },
    { name: "article", pattern: "/article/:slug", params: { slug: "slug" }, query: { ref: "slug" } },
  ],
  { schemes: ["myapp"], hosts: ["example.com"] },
);

Linking.addEventListener("url", ({ url }) => {
  const resolution = router.resolve(url);
  if (!resolution.ok) return report(resolution.refusal);

  if (resolution.match.requiresAuth && !session) {
    pending.hold(resolution.match);   // resume after signing in
    return navigate("SignIn");
  }
  navigate(resolution.match.name, resolution.match.params);
});
```

## The link that arrives too early

Two moments break naive deep linking, and they are the same shape. A cold start
opens the app *and* delivers a link, so it resolves before the navigator exists.
A link to a screen behind a login arrives before there is a session.

`PendingLink` holds the destination and replays it once, when the app can
actually go there. Held links expire — a link acted on twenty minutes late
navigates someone away from whatever they started doing instead.

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
`assetlinks.json`, on your server. This validates what does arrive.

## Status

| | |
|---|---|
| Implemented | typed path parameters with four kinds and a length limit, allow-listed query parameters, host and scheme allow-lists, refusal reasons, build-time route checking, pending links with expiry |
| Not yet | outbound link building, optional and wildcard segments, per-route rate limiting, a React hook wrapping `Linking` |

## Development

```bash
npm test        # node --test, no device
npm run demo
npm run typecheck
```

## License

MIT
