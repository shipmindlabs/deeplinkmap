/**
 * deeplinkmap — a deep link is untrusted input that picks a screen, so the
 * routing table is an authorisation boundary.
 */

export {
  InvalidLink,
  InvalidPolicy,
  InvalidRoute,
  Router,
  type LinkForm,
  type LinkOptions,
  type Match,
  type ParamKind,
  type ParamSpec,
  type Refusal,
  type Resolution,
  type Route,
  type RouterOptions,
} from "./routes.ts";

export { InvalidHold, PendingLink, type PendingOptions } from "./pending.ts";

export { InvalidIntake, LinkIntake, type Delivery, type IntakeOptions } from "./intake.ts";

export { type Audit, type AuditEvent, type LinkSource } from "./audit.ts";
