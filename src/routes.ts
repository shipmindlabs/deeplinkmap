/**
 * Deep links, treated as what they are: untrusted input that arrives from
 * outside the app and picks a screen.
 *
 * A deep link is a URL anyone can send. It comes from an email, a text message,
 * another app, a QR code on a poster. The routing table is therefore an
 * authorisation boundary, and the usual implementation — a chain of
 * `startsWith` checks and a `params` object of whatever came after — has five
 * problems:
 *
 *   1. Parameters are strings from a stranger, passed straight into a screen
 *      that expects an id. `/order/DROP TABLE` reaches the query builder.
 *   2. The fallback is "open whatever we matched last", so a link that matches
 *      nothing lands somewhere arbitrary, often a screen the user should not
 *      see at all.
 *   3. A link that arrives while nobody is signed in is opened anyway, and the
 *      screen fails oddly rather than the app asking for a login first.
 *   4. Every link counts as equally trustworthy, although a universal link is
 *      one the operating system checked against a host this app owns, while a
 *      custom scheme is a namespace any installed app can also register and an
 *      http link was checked by nobody at all.
 *   5. Nothing is written down. A refused link leaves no trace, so an app being
 *      probed with links to hosts it does not own looks exactly like one that
 *      nobody is sending anything to.
 *
 * This module is a table with types, refusals and a record of both. It imports
 * nothing from React Native: `Linking` hands it a string.
 */

import { report, type Audit, type LinkSource } from "./audit.ts";

/** What a parameter is allowed to be. Anything else is refused. */
export type ParamKind = "string" | "number" | "uuid" | "slug";

/**
 * The door a link arrived through: a universal link the operating system
 * checked against a host this app owns, a custom scheme any installed app can
 * register, or a plain http link nothing verified at all.
 */
export type LinkForm = "universal" | "scheme" | "insecure";

export type ParamSpec = {
  readonly kind: ParamKind;
  /** Refuse anything shorter. Defaults to one character. */
  readonly minLength?: number;
  /** Refuse anything longer. Defaults to 128 characters. */
  readonly maxLength?: number;
  /** Closed range for a "number". Refused on any other kind. */
  readonly min?: number;
  readonly max?: number;
  /** The complete set of accepted values. Anything else is refused. */
  readonly oneOf?: readonly (string | number)[];
  /**
   * Keep the value out of every record of the decision: the link is reported
   * with this segment masked, in a refusal detail and in an audit event alike.
   * `match.params` still carries it, because the screen is what it was for.
   */
  readonly secret?: boolean;
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
  /**
   * Which doors this route opens to. Defaults to the router's `accepts`, which
   * itself defaults to universal links only.
   */
  readonly accepts?: readonly LinkForm[];
};

export type Match<Name extends string = string> = {
  readonly name: Name;
  readonly params: Readonly<Record<string, string | number>>;
  readonly query: Readonly<Record<string, string | number>>;
  readonly requiresAuth: boolean;
  /** The door this link came through. */
  readonly form: LinkForm;
  /** The link for logging, every secret value masked. Never for routing. */
  readonly url: string;
};

export type Refusal = {
  readonly reason:
    | "unparseable"
    | "insecure-scheme"
    | "foreign-host"
    | "unknown-scheme"
    | "form-not-accepted"
    | "no-route"
    | "bad-parameter";
  readonly detail: string;
  readonly url: string;
};

export type Resolution<Name extends string = string> =
  | { readonly ok: true; readonly match: Match<Name> }
  | { readonly ok: false; readonly refusal: Refusal };

export type RouterOptions<Name extends string = string> = {
  /** Custom schemes this app answers to, e.g. ["myapp"]. */
  readonly schemes?: readonly string[];
  /**
   * Hosts allowed for https links: "example.com", or "*.example.com" for one
   * label below it. A link to any other host is refused.
   */
  readonly hosts?: readonly string[];
  /** The doors routes open to when they do not say. Defaults to ["universal"]. */
  readonly accepts?: readonly LinkForm[];
  /**
   * Let an http link be read at all. Off by default; for local development.
   * The flag is not a door: an http link arrives as the "insecure" form, so a
   * route only opens to one by saying `accepts: ["insecure"]`.
   */
  readonly allowInsecure?: boolean;
  /** Called with every decision this table makes, accepted or refused. */
  readonly audit?: Audit<Name>;
  readonly now?: () => Date;
};

/** How an outbound link differs from the bare path its route describes. */
export type LinkOptions = {
  /** Query parameters, each declared by the route and checked like a path one. */
  readonly query?: Readonly<Record<string, string | number>>;
  /** Which door to build for. Defaults to the most verified one the route opens to. */
  readonly form?: LinkForm;
};

/** The table describes routes that cannot be read, or that can never open. */
export class InvalidRoute extends Error {}

/** The host or scheme allow-list cannot mean what it says. */
export class InvalidPolicy extends Error {}

/** The requested link is not one this table could read back. */
export class InvalidLink extends Error {}

const PATTERNS: Record<ParamKind, RegExp> = {
  string: /^[^/?#]+$/,
  number: /^-?\d+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/i,
};

const DEFAULT_MIN_LENGTH = 1;
const DEFAULT_MAX_LENGTH = 128;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;

const FORMS: readonly LinkForm[] = ["universal", "scheme", "insecure"];

const FORM_NAMES: Record<LinkForm, string> = {
  universal: "universal",
  scheme: "custom-scheme",
  insecure: "insecure http",
};

/** What a secret value is reported as: unchanged by a path or a query string. */
const MASK = "***";

type HostPattern = { readonly host: string; readonly wildcard: boolean };
type Entry<Name extends string> = {
  readonly route: Route<Name>;
  readonly accepts: ReadonlySet<LinkForm>;
  /** Placeholders whose value is masked wherever this link is reported. */
  readonly secrets: ReadonlySet<string>;
  /** Query parameters whose value is masked wherever this link is reported. */
  readonly secretQuery: ReadonlySet<string>;
  readonly hides: boolean;
};

function spec(value: ParamSpec | ParamKind): ParamSpec {
  return typeof value === "string" ? { kind: value } : value;
}

export class Router<Name extends string = string> {
  #entries: Entry<Name>[];
  #hosts: HostPattern[];
  #schemes: string[];
  #allowInsecure: boolean;
  #audit: Audit<Name> | null;
  #hides: boolean;
  #now: () => Date;

  constructor(routes: readonly Route<Name>[], options: RouterOptions<Name> = {}) {
    this.#hosts = (options.hosts ?? []).map(compileHost);
    this.#schemes = (options.schemes ?? []).map(compileScheme);
    this.#allowInsecure = options.allowInsecure ?? false;
    this.#audit = options.audit ?? null;
    this.#now = options.now ?? (() => new Date());
    const fallback = accepted(options.accepts ?? ["universal"], "the router");

    const names = new Set<string>();
    const entries: Entry<Name>[] = [];
    for (const route of routes) {
      if (names.has(route.name)) {
        throw new InvalidRoute(`route "${route.name}" is declared twice`);
      }
      names.add(route.name);

      const declared = placeholders(route.pattern);
      const repeated = declared.find((name, index) => declared.indexOf(name) !== index);
      if (repeated) {
        throw new InvalidRoute(
          `route "${route.name}" has :${repeated} in its pattern more than once`,
        );
      }
      // Every placeholder must be declared. An undeclared one would otherwise
      // arrive as an unvalidated string, which is the hole this closes.
      for (const placeholder of declared) {
        if (!route.params?.[placeholder]) {
          throw new InvalidRoute(
            `route "${route.name}" has :${placeholder} in its pattern but does not declare it`,
          );
        }
      }
      const secrets = new Set<string>();
      for (const [key, declaration] of Object.entries(route.params ?? {})) {
        if (!declared.includes(key)) {
          throw new InvalidRoute(
            `route "${route.name}" declares "${key}" but its pattern has no :${key}`,
          );
        }
        const parameter = spec(declaration);
        check(route.name, `:${key}`, parameter);
        if (parameter.secret) secrets.add(key);
      }
      const secretQuery = new Set<string>();
      for (const [key, declaration] of Object.entries(route.query ?? {})) {
        const parameter = spec(declaration);
        check(route.name, `?${key}`, parameter);
        if (parameter.secret) secretQuery.add(key);
      }

      const accepts = route.accepts ? accepted(route.accepts, `route "${route.name}"`) : fallback;
      const shut = unreachable(accepts, this.#hosts, this.#schemes, this.#allowInsecure);
      if (shut) throw new InvalidRoute(`route "${route.name}" can never open: ${shut}`);

      entries.push({
        route,
        accepts,
        secrets,
        secretQuery,
        hides: secrets.size > 0 || secretQuery.size > 0,
      });
    }
    this.#entries = entries;
    this.#hides = entries.some((entry) => entry.hides);
  }

  /**
   * The hook every decision is reported to, so an intake in front of this
   * table can report the links it drops to the same one.
   */
  get audit(): Audit<Name> | null {
    return this.#audit;
  }

  /**
   * Resolve a link to a screen, or say why not. Either way the decision is
   * reported to the audit hook before it is handed back.
   *
   * `source` is the delivery path a link came through, which `LinkIntake`
   * passes on. It is recorded and never routed on.
   */
  resolve(url: string, source: LinkSource | null = null): Resolution<Name> {
    const resolution = this.#decide(url);
    if (this.#audit) {
      const at = this.#now();
      // The event carries the link and the parameters as the record may hold
      // them, which is masked wherever a route declared a value secret.
      report(
        this.#audit,
        resolution.ok
          ? {
              decision: "accepted",
              at,
              url: resolution.match.url,
              source,
              match: this.#loggable(resolution.match),
            }
          : {
              decision: "refused",
              at,
              url: resolution.refusal.url,
              source,
              refusal: resolution.refusal,
            },
      );
    }
    return resolution;
  }

  /**
   * Build a link to one of these routes.
   *
   * A link assembled by hand is a second copy of the table written in string
   * concatenation: it drifts when a pattern changes, and a value nobody
   * checked on the way out is refused on the way back in — inside an email
   * somebody has already been sent. So an outbound link comes from the table
   * that reads it. Values pass the same specs, the route has to accept the
   * form the link is built in, a universal link uses the first exact host and
   * a scheme link the first declared scheme. Anything else throws
   * `InvalidLink` here rather than being refused on arrival.
   */
  link(
    name: Name,
    params: Readonly<Record<string, string | number>> = {},
    options: LinkOptions = {},
  ): string {
    const entry = this.#entries.find((candidate) => candidate.route.name === name);
    if (!entry) throw new InvalidLink(`no route named "${name}" is in this table`);
    const route = entry.route.name;

    const form = this.#outbound(entry, options.form);
    const origin = this.#origin(form);
    if (origin === null) {
      // A wildcard stands for hosts the app may not have, so it is not an
      // address to send anybody to.
      const missing =
        form === "scheme"
          ? "the router declares no scheme"
          : form === "insecure" && !this.#allowInsecure
            ? "the router does not allow insecure links"
            : "the router declares no host that is not a wildcard";
      throw new InvalidLink(
        `no ${FORM_NAMES[form]} link to route "${route}" can be built: ${missing}`,
      );
    }

    const spare = new Set(Object.keys(params));
    const segments = entry.route.pattern
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (!segment.startsWith(":")) return segment;
        const key = segment.slice(1);
        spare.delete(key);
        if (!Object.hasOwn(params, key)) {
          throw new InvalidLink(`route "${route}" needs a value for :${key}`);
        }
        const raw = String(params[key]);
        enforce(route, `:${key}`, raw, spec(entry.route.params![key]!), entry.secrets.has(key));
        return encodeURIComponent(raw);
      });
    if (spare.size > 0) {
      throw new InvalidLink(
        `route "${route}" has no ${[...spare].map((key) => `:${key}`).join(", ")} in its pattern`,
      );
    }

    // Declared query parameters only: an undeclared one is dropped when the
    // link arrives, so building one builds a link that loses part of itself.
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      const declaration = entry.route.query?.[key];
      if (!declaration) {
        throw new InvalidLink(`route "${route}" does not declare the query parameter ?${key}`);
      }
      const raw = String(value);
      enforce(route, `?${key}`, raw, spec(declaration), entry.secretQuery.has(key));
      search.append(key, raw);
    }

    const query = search.size > 0 ? `?${search}` : "";
    return `${origin}${segments.join("/")}${query}`;
  }

  /**
   * The link as it may be written down: every value a route declared `secret`
   * replaced by a mask. `LinkIntake` uses this for the repeats it drops, which
   * never reach the table at all.
   *
   * The shape of the link decides, not the reason it was refused: a token that
   * came through a door its route does not open to, or addressed to a host
   * this app does not own, is a token either way.
   */
  mask(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // No route claims a segment of a link nothing could parse, and none
      // matched it either.
      return url;
    }
    return this.#mask(parsed, url);
  }

  #mask(parsed: URL, url: string): string {
    if (!this.#hides) return url;
    const path = pathOf(parsed);
    for (const entry of this.#entries) {
      // The first pattern a path fits is the one that would route it, so the
      // masked link and the routed link never disagree about which segment is
      // the secret one.
      if (!capture(entry.route.pattern, path)) continue;
      return entry.hides ? redact(parsed, entry) : url;
    }
    return url;
  }

  /** The match as a log may hold it, with every secret value masked. */
  #loggable(match: Match<Name>): Match<Name> {
    const entry = this.#entries.find((candidate) => candidate.route.name === match.name);
    if (!entry?.hides) return match;
    return {
      ...match,
      params: covered(match.params, entry.secrets),
      query: covered(match.query, entry.secretQuery),
    };
  }

  /** The door an outbound link is built in: the caller's, checked, or the best. */
  #outbound(entry: Entry<Name>, chosen: LinkForm | undefined): LinkForm {
    const open = FORMS.filter((form) => entry.accepts.has(form));
    if (chosen === undefined) {
      // Without a choice, the most verified door this route opens to that the
      // router can address at all.
      return open.find((form) => this.#origin(form) !== null) ?? open[0]!;
    }
    if (!FORMS.includes(chosen)) {
      throw new InvalidLink(`unknown link form ${JSON.stringify(chosen)}`);
    }
    if (!entry.accepts.has(chosen)) {
      throw new InvalidLink(`route "${entry.route.name}" does not accept ${FORM_NAMES[chosen]} links`);
    }
    return chosen;
  }

  /**
   * Where a link in this form starts, or null when the router has no such
   * door: the first exact host for an http link, the first declared scheme for
   * a custom one.
   */
  #origin(form: LinkForm): string | null {
    if (form === "scheme") {
      if (this.#schemes.length === 0) return null;
      return `${this.#schemes[0]}://`;
    }
    if (form === "insecure" && !this.#allowInsecure) return null;
    const exact = this.#hosts.find((pattern) => !pattern.wildcard);
    if (exact === undefined) return null;
    return `${form === "insecure" ? "http" : "https"}://${exact.host}/`;
  }

  #decide(url: string): Resolution<Name> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse("unparseable", "not a URL", url);
    }

    // Every decision below reports this link rather than the one that arrived.
    // A reset token is a parameter like any other, and a log of every decision
    // must not become a second copy of every token that was sent.
    const shown = this.#mask(parsed, url);

    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    let form: LinkForm;
    if (scheme === "https" || scheme === "http") {
      // An http link is not a universal link: nothing verified it, and anyone
      // between the tap and the app can rewrite where it points. The flag only
      // lets it be read; it arrives as its own form, so turning the flag on for
      // local development cannot widen a route written for verified links.
      if (scheme === "http") {
        if (!this.#allowInsecure) {
          return refuse("insecure-scheme", "http links are not accepted, only https", shown);
        }
        form = "insecure";
      } else {
        form = "universal";
      }
      // An https link to a host this app does not own is somebody else's link.
      // Following it is how an app becomes an open redirect with a native UI.
      const hostname = bareHost(parsed.hostname);
      if (!this.#hosts.some((pattern) => hostAllows(pattern, hostname))) {
        return refuse("foreign-host", `${parsed.hostname} is not one of this app's hosts`, shown);
      }
    } else if (this.#schemes.includes(scheme)) {
      form = "scheme";
    } else {
      return refuse("unknown-scheme", `${scheme}: is not one of this app's schemes`, shown);
    }

    const path = pathOf(parsed);

    for (const { route, accepts, secrets, secretQuery } of this.#entries) {
      const captured = capture(route.pattern, path);
      if (!captured) continue;

      // The door is part of the decision. A universal link was checked against
      // a host this app owns; a custom scheme is a namespace any installed app
      // can register, and an http link was checked by nobody, so a route
      // holding a token or a session says which doors it opens to.
      if (!accepts.has(form)) {
        return refuse(
          "form-not-accepted",
          `route "${route.name}" does not accept ${FORM_NAMES[form]} links`,
          shown,
        );
      }

      // Nothing is handed back until every parameter has passed. A refusal
      // halfway through leaves the caller with a refusal, not half a screen.
      const params: Record<string, string | number> = {};
      for (const [key, raw] of Object.entries(captured)) {
        const declaration = spec(route.params![key]!);
        const checked = validate(raw, declaration);
        if (checked === null) {
          // A value refused is still the value that was sent, and a detail is
          // written down like everything else here.
          const got = secrets.has(key) ? MASK : `"${raw}"`;
          return refuse("bad-parameter", `${key}=${got} is not ${describe(declaration)}`, shown);
        }
        params[key] = checked;
      }

      // Query parameters are allow-listed. Anything undeclared is dropped
      // rather than passed on: a screen that reads an unexpected parameter is
      // reading a stranger's input.
      const query: Record<string, string | number> = {};
      for (const [key, declaration] of Object.entries(route.query ?? {})) {
        const declared = spec(declaration);
        const raw = parsed.searchParams.get(key);
        if (raw === null) continue;
        const checked = validate(raw, declared);
        if (checked === null) {
          const got = secretQuery.has(key) ? MASK : `"${raw}"`;
          return refuse("bad-parameter", `?${key}=${got} is not ${describe(declared)}`, shown);
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
          form,
          url: shown,
        },
      };
    }

    // No route matched. Refusing is the point: opening "whatever matched last"
    // is how a stranger's link lands on a screen nobody meant to expose.
    return refuse("no-route", `nothing matches ${path}`, shown);
  }
}

function refuse(reason: Refusal["reason"], detail: string, url: string): Resolution<never> {
  return { ok: false, refusal: { reason, detail, url } };
}

/**
 * A value on its way out is checked by the spec that would refuse it on the
 * way back in: a link nobody can read is still a link somebody was sent.
 */
function enforce(
  route: string,
  where: string,
  raw: string,
  declaration: ParamSpec,
  hidden: boolean,
): void {
  if (validate(raw, declaration) !== null) return;
  const got = hidden ? MASK : JSON.stringify(raw);
  throw new InvalidLink(`route "${route}" ${where}=${got} is not ${describe(declaration)}`);
}

/** The same values, with the secret ones replaced. */
function covered(
  values: Readonly<Record<string, string | number>>,
  secrets: ReadonlySet<string>,
): Readonly<Record<string, string | number>> {
  if (secrets.size === 0) return values;
  const shown: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    shown[key] = secrets.has(key) ? MASK : value;
  }
  return shown;
}

/**
 * The link with every secret value masked. It is rebuilt from the parsed URL
 * rather than edited as text, so a declared query parameter is masked however
 * many times it appears and userinfo nobody routes on does not travel on.
 */
function redact<Name extends string>(parsed: URL, entry: Entry<Name>): string {
  const wanted = entry.route.pattern.split("/").filter(Boolean);
  const kept = pathOf(parsed)
    .split("/")
    .filter(Boolean)
    .map((segment, index) => {
      const declared = wanted[index] ?? "";
      return declared.startsWith(":") && entry.secrets.has(declared.slice(1)) ? MASK : segment;
    });

  const query = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    query.append(key, entry.secretQuery.has(key) ? MASK : value);
  }
  const search = query.size > 0 ? `?${query}` : "";
  const path = kept.join("/");

  return overHttp(parsed)
    ? `${parsed.protocol}//${parsed.host}/${path}${search}${parsed.hash}`
    : `${parsed.protocol}//${path}${search}${parsed.hash}`;
}

function overHttp(parsed: URL): boolean {
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  return scheme === "https" || scheme === "http";
}

/**
 * The path a pattern is matched against. For a custom scheme,
 * "myapp://order/7" puts "order" in the host, so the host is a segment.
 */
function pathOf(parsed: URL): string {
  if (overHttp(parsed)) return parsed.pathname;
  return "/" + [parsed.hostname, parsed.pathname.replace(/^\//, "")].filter(Boolean).join("/");
}

function accepted(forms: readonly LinkForm[], where: string): ReadonlySet<LinkForm> {
  if (forms.length === 0) {
    throw new InvalidPolicy(`${where} accepts no link form, so no link can open`);
  }
  for (const form of forms) {
    if (!FORMS.includes(form)) {
      throw new InvalidPolicy(`${where} accepts unknown link form ${JSON.stringify(form)}`);
    }
  }
  return new Set(forms);
}

/**
 * A route open only to doors the app does not have — universal links with no
 * declared host, custom-scheme links with no declared scheme, http links the
 * router never allowed — is a route no link can reach. Saying so here beats a
 * link quietly going nowhere later.
 */
function unreachable(
  accepts: ReadonlySet<LinkForm>,
  hosts: readonly HostPattern[],
  schemes: readonly string[],
  allowInsecure: boolean,
): string | null {
  const missing: string[] = [];
  if (accepts.has("universal")) {
    if (hosts.length > 0) return null;
    missing.push("declares no hosts");
  }
  if (accepts.has("scheme")) {
    if (schemes.length > 0) return null;
    missing.push("declares no schemes");
  }
  if (accepts.has("insecure")) {
    if (allowInsecure && hosts.length > 0) return null;
    missing.push(allowInsecure ? "declares no hosts" : "does not allow insecure links");
  }
  return `the router ${[...new Set(missing)].join(" and ")}`;
}

function compileHost(raw: string): HostPattern {
  const fail = (detail: string): never => {
    throw new InvalidPolicy(`host ${JSON.stringify(raw)} ${detail}`);
  };

  const value = bareHost(raw.trim());
  if (value === "") fail("is empty");
  if (value === "*") fail("would allow every host, which is not an allow-list");
  if (/[:/?#@\\]/.test(value)) fail("is not a bare hostname");

  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  if (host.includes("*")) fail("may only wildcard its first label");
  if (wildcard && !host.includes(".")) fail("wildcards a whole top-level domain");
  if (host === "" || !host.split(".").every((label) => LABEL.test(label))) {
    fail("is not a hostname");
  }
  return { host, wildcard };
}

function compileScheme(raw: string): string {
  const fail = (detail: string): never => {
    throw new InvalidPolicy(`scheme ${JSON.stringify(raw)} ${detail}`);
  };

  const value = raw.trim().toLowerCase();
  if (value === "") fail("is empty");
  if (value === "http" || value === "https") fail("is decided by the host allow-list, not here");
  if (!SCHEME.test(value)) fail("is not a URL scheme");
  return value;
}

/**
 * A wildcard covers one label and no more, and a host is compared whole:
 * "example.com.evil.net" ends with the declared host and belongs to somebody
 * else, which is exactly what an endsWith check lets in.
 */
function hostAllows(pattern: HostPattern, hostname: string): boolean {
  if (!pattern.wildcard) return hostname === pattern.host;
  const suffix = `.${pattern.host}`;
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

function bareHost(value: string): string {
  const lowered = value.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/**
 * A constraint that refuses everything — a maximum below its minimum, a value
 * set its own kind rejects — describes a route that can never open. Saying so
 * when the table is built beats a link mysteriously going nowhere in the field.
 */
function check(route: string, where: string, declaration: ParamSpec): void {
  const fail = (detail: string): never => {
    throw new InvalidRoute(`route "${route}" parameter ${where} ${detail}`);
  };

  if (!(declaration.kind in PATTERNS)) fail(`has unknown kind "${declaration.kind}"`);

  const minLength = declaration.minLength ?? DEFAULT_MIN_LENGTH;
  const maxLength = declaration.maxLength ?? DEFAULT_MAX_LENGTH;
  if (minLength < 1) fail(`has minLength ${minLength}, below one`);
  if (maxLength < minLength) fail(`has maxLength ${maxLength} below minLength ${minLength}`);

  const bounded = declaration.min !== undefined || declaration.max !== undefined;
  if (bounded && declaration.kind !== "number") {
    fail(`has min/max, which only apply to a number, not a ${declaration.kind}`);
  }
  if (
    declaration.min !== undefined &&
    declaration.max !== undefined &&
    declaration.min > declaration.max
  ) {
    fail(`has min ${declaration.min} above max ${declaration.max}`);
  }

  if (declaration.oneOf) {
    // A refusal names the set it refused against, and a value drawn from a set
    // written in the table is not a secret in the first place.
    if (declaration.secret) {
      fail("is secret and lists the complete set of values it is drawn from in oneOf");
    }
    if (declaration.oneOf.length === 0) fail("has an empty oneOf, so nothing can match");
    for (const value of declaration.oneOf) {
      if (validate(String(value), { ...declaration, oneOf: undefined }) === null) {
        fail(`lists ${JSON.stringify(value)} in oneOf, which its own kind and limits refuse`);
      }
    }
  }
}

function describe(declaration: ParamSpec): string {
  if (declaration.oneOf) {
    return `one of ${declaration.oneOf.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  if (declaration.min !== undefined || declaration.max !== undefined) {
    return `a number from ${declaration.min ?? "any"} to ${declaration.max ?? "any"}`;
  }
  return `a valid ${declaration.kind}`;
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
  const minLength = declaration.minLength ?? DEFAULT_MIN_LENGTH;
  const maxLength = declaration.maxLength ?? DEFAULT_MAX_LENGTH;
  if (raw.length < minLength || raw.length > maxLength) return null;
  if (!PATTERNS[declaration.kind].test(raw)) return null;

  let value: string | number = raw;
  if (declaration.kind === "number") {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) return null;
    if (declaration.min !== undefined && parsed < declaration.min) return null;
    if (declaration.max !== undefined && parsed > declaration.max) return null;
    value = parsed;
  }

  if (declaration.oneOf && !declaration.oneOf.includes(value)) return null;
  return value;
}
