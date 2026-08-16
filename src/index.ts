/**
 * deeplinkmap — a deep link is untrusted input that picks a screen, so the
 * routing table is an authorisation boundary.
 */

export {
  InvalidRoute,
  Router,
  type Match,
  type ParamKind,
  type ParamSpec,
  type Refusal,
  type Resolution,
  type Route,
  type RouterOptions,
} from "./routes.ts";

export { PendingLink, type PendingOptions } from "./pending.ts";
