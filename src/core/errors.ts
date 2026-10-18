/**
 * Gateway error type + status classification (SPEC §11).
 *
 * Backoff/retry behavior lands in M1 (llm-client) and M5 (hardening);
 * this module only names and classifies failures.
 */

export type GatewayErrorKind =
  | "auth" // 401 — fatal, fail fast
  | "budget" // 402 — fatal, stop the run
  | "validation" // 400 — fatal, surface detail
  | "quota" // 429 — backoff + retry (honor Retry-After)
  | "unavailable" // 503 — backoff, then abort
  | "transient" // 5xx / timeout — limited retries with jitter
  | "network" // connection failure
  | "unknown";

export class GatewayError extends Error {
  readonly status: number;
  readonly kind: GatewayErrorKind;
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(opts: {
    message: string;
    status: number;
    kind?: GatewayErrorKind;
    retryAfterMs?: number;
    detail?: unknown;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GatewayError";
    this.status = opts.status;
    this.kind = opts.kind ?? classifyStatus(opts.status);
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail;
  }

  /** Fatal errors stop the run; the rest may be retried (SPEC §11). */
  get fatal(): boolean {
    return this.kind === "auth" || this.kind === "budget" || this.kind === "validation";
  }
}

export function classifyStatus(status: number): GatewayErrorKind {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 402:
      return "budget";
    case 400:
    case 422:
      return "validation";
    case 429:
      return "quota";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "transient" : "unknown";
  }
}

/** Parse `Retry-After` (seconds) into milliseconds, if present. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
