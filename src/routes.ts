/**
 * Deep links, treated as what they are: untrusted input that arrives from
 * outside the app and picks a screen.
 *
 * A deep link is a URL anyone can send. It comes from an email, a text message,
 * another app, a QR code on a poster. The routing table is therefore an
 * authorisation boundary, and the usual implementation — a chain of
 * `startsWith` checks and a `params` object of whatever came after — has three
 * problems:
 *
 *   1. Parameters are strings from a stranger, passed straight into a screen
 *      that expects an id. `/order/DROP TABLE` reaches the query builder.
 *   2. The fallback is "open whatever we matched last", so a link that matches
 *      nothing lands somewhere arbitrary, often a screen the user should not
 *      see at all.
 *   3. A link that arrives while nobody is signed in is opened anyway, and the
 *      screen fails oddly rather than the app asking for a login first.
 *
 * This module is a table with types and refusals. It imports nothing from React
 * Native: `Linking` hands it a string.
 */

/** What a parameter is allowed to be. Anything else is refused. */
export type ParamKind = "string" | "number" | "uuid" | "slug";

export type ParamSpec = {
  readonly kind: ParamKind;
  /** Refuse anything longer. Defaults to 128 characters. */
  readonly maxLength?: number;
};

export type Route<Name extends string = string> = {
  readonly name: Name;
  /** A path with :placeholders, e.g. "/order/:id". */
  readonly pattern: string;
  /** Every placeholder must be declared, or the route is rejected at build time. */
  readonly params?: Readonly<Record<string, ParamSpec | ParamKind>>;
  /** Query parameters that are allowed through. Anything else is dropped. */
  readonly query?: Readonly<Record<string, ParamSpec | ParamKind>>;
  /** When true, an unauthenticated app should sign in first and resume after. */
  readonly requiresAuth?: boolean;
};

export type Match<Name extends string = string> = {
  readonly name: Name;
  readonly params: Readonly<Record<string, string | number>>;
  readonly query: Readonly<Record<string, string | number>>;
  readonly requiresAuth: boolean;
  /** The link as received, for logging. Never for routing. */
  readonly url: string;
};

export type Refusal = {
  readonly reason:
    | "unparseable"
    | "foreign-host"
    | "unknown-scheme"
    | "no-route"
    | "bad-parameter";
  readonly detail: string;
  readonly url: string;
};

export type Resolution<Name extends string = string> =
  | { readonly ok: true; readonly match: Match<Name> }
  | { readonly ok: false; readonly refusal: Refusal };

export type RouterOptions = {
  /** Custom schemes this app answers to, e.g. ["myapp"]. */
  readonly schemes?: readonly string[];
  /** Hosts allowed for https links. A link to any other host is refused. */
  readonly hosts?: readonly string[];
};

export class InvalidRoute extends Error {}

const PATTERNS: Record<ParamKind, RegExp> = {
  string: /^[^/?#]+$/,
  number: /^-?\d+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/i,
};

const DEFAULT_MAX_LENGTH = 128;

function spec(value: ParamSpec | ParamKind): ParamSpec {
  return typeof value === "string" ? { kind: value } : value;
}

export class Router<Name extends string = string> {
  #routes: Route<Name>[];
  #options: RouterOptions;

  constructor(routes: readonly Route<Name>[], options: RouterOptions = {}) {
    for (const route of routes) {
      // Every placeholder must be declared. An undeclared one would otherwise
      // arrive as an unvalidated string, which is the hole this closes.
      for (const placeholder of placeholders(route.pattern)) {
        if (!route.params?.[placeholder]) {
          throw new InvalidRoute(
            `route "${route.name}" has :${placeholder} in its pattern but does not declare it`,
          );
        }
      }
      for (const declared of Object.keys(route.params ?? {})) {
        if (!placeholders(route.pattern).includes(declared)) {
          throw new InvalidRoute(
            `route "${route.name}" declares "${declared}" but its pattern has no :${declared}`,
          );
        }
      }
    }
    this.#routes = [...routes];
    this.#options = options;
  }

  /** Resolve a link to a screen, or say why not. */
  resolve(url: string): Resolution<Name> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse("unparseable", "not a URL", url);
    }

    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    if (scheme === "http" || scheme === "https") {
      const hosts = this.#options.hosts ?? [];
      // An https link to a host this app does not own is somebody else's link.
      // Following it is how an app becomes an open redirect with a native UI.
      if (!hosts.some((host) => host.toLowerCase() === parsed.hostname.toLowerCase())) {
        return refuse("foreign-host", `${parsed.hostname} is not one of this app's hosts`, url);
      }
    } else if (!(this.#options.schemes ?? []).includes(scheme)) {
      return refuse("unknown-scheme", `${scheme}: is not one of this app's schemes`, url);
    }

    // For a custom scheme, "myapp://order/7" puts "order" in the host.
    const path =
      scheme === "http" || scheme === "https"
        ? parsed.pathname
        : "/" + [parsed.hostname, parsed.pathname.replace(/^\//, "")].filter(Boolean).join("/");

    for (const route of this.#routes) {
      const captured = capture(route.pattern, path);
      if (!captured) continue;

      const params: Record<string, string | number> = {};
      for (const [key, raw] of Object.entries(captured)) {
        const checked = validate(raw, spec(route.params![key]!));
        if (checked === null) {
          return refuse("bad-parameter", `${key}="${raw}" is not a valid ${describe(route, key)}`, url);
        }
        params[key] = checked;
      }

      // Query parameters are allow-listed. Anything undeclared is dropped
      // rather than passed on: a screen that reads an unexpected parameter is
      // reading a stranger's input.
      const query: Record<string, string | number> = {};
      for (const [key, declaration] of Object.entries(route.query ?? {})) {
        const raw = parsed.searchParams.get(key);
        if (raw === null) continue;
        const checked = validate(raw, spec(declaration));
        if (checked === null) {
          return refuse("bad-parameter", `?${key}="${raw}" is not valid`, url);
        }
        query[key] = checked;
      }

      return {
        ok: true,
        match: {
          name: route.name,
          params,
          query,
          requiresAuth: route.requiresAuth ?? false,
          url,
        },
      };
    }

    // No route matched. Refusing is the point: opening "whatever matched last"
    // is how a stranger's link lands on a screen nobody meant to expose.
    return refuse("no-route", `nothing matches ${path}`, url);
  }
}

function refuse(reason: Refusal["reason"], detail: string, url: string): Resolution<never> {
  return { ok: false, refusal: { reason, detail, url } };
}

function describe(route: Route, key: string): string {
  return spec(route.params![key]!).kind;
}

function placeholders(pattern: string): string[] {
  return pattern
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/** Match a path against a pattern, returning the captured placeholders. */
function capture(pattern: string, path: string): Record<string, string> | null {
  const wanted = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (wanted.length !== got.length) return null;

  const captured: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const actual = got[index]!;
    if (segment.startsWith(":")) {
      // decodeURIComponent throws on a malformed sequence like "%zz", and a
      // parser of untrusted input must never throw — an uncaught URIError in a
      // Linking handler takes the whole app down on a link anyone can send.
      // Undecodable means unmatchable; the kind check will refuse the raw text.
      try {
        captured[segment.slice(1)] = decodeURIComponent(actual);
      } catch {
        captured[segment.slice(1)] = actual;
      }
      continue;
    }
    if (segment.toLowerCase() !== actual.toLowerCase()) return null;
  }
  return captured;
}

function validate(raw: string, declaration: ParamSpec): string | number | null {
  const maxLength = declaration.maxLength ?? DEFAULT_MAX_LENGTH;
  if (raw.length === 0 || raw.length > maxLength) return null;
  if (!PATTERNS[declaration.kind].test(raw)) return null;
  if (declaration.kind === "number") {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  return raw;
}
