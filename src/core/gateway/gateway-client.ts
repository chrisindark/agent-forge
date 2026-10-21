/**
 * Typed HTTP client for the Echo Gate gateway API.
 *
 * Gateway-specific behavior (headers, health endpoints, later `cache_info`)
 * is isolated here so the harness runtime stays provider-agnostic (SPEC §5).
 */
import { GatewayError, parseRetryAfterMs } from "../errors.js";

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Health checks are cheap; LLM calls get generous ones (SPEC §2.2). */
  timeoutMs?: number;
}

export interface ServiceCheck {
  ok: boolean;
  status: number;
  detail?: string;
}

export interface GatewayHealth {
  ready: ServiceCheck;
  worker: ServiceCheck;
  celery: ServiceCheck;
  /** Subsystem names not reporting ok — the "which dependency is degraded" answer. */
  degraded: string[];
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Health triage across the three health endpoints (SPEC §3.1.1). */
  async health(signal?: AbortSignal): Promise<GatewayHealth> {
    const [ready, worker, celery] = await Promise.all([
      this.check("/api/v1/health/ready", signal),
      this.check("/api/v1/health/worker", signal),
      this.check("/api/v1/health/celery", signal),
    ]);
    const checks = { ready, worker, celery };
    const degraded = (
      Object.entries(checks) as [keyof GatewayHealth & string, ServiceCheck][]
    )
      .filter(([, c]) => !c.ok)
      .map(([name]) => name);
    return { ...checks, degraded };
  }

  /** GET with auth headers and GatewayError mapping. */
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "GET" }, signal);
  }

  async request<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const { data } = await this.requestDetailed<T>(path, init, signal);
    return data;
  }

  /** Like `request`, but also exposes response headers (e.g. `X-Cache`). */
  async requestDetailed<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ data: T; headers: Headers }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          "X-API-Key": this.apiKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new GatewayError({
          message: `Gateway request timed out after ${this.timeoutMs}ms: ${path}`,
          status: 0,
          kind: "network",
          cause: err,
        });
      }
      throw new GatewayError({
        message: `Gateway unreachable: ${(err as Error).message}`,
        status: 0,
        kind: "network",
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw new GatewayError({
        message: `Gateway ${init.method ?? "GET"} ${path} returned ${res.status}`,
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get("Retry-After")),
        detail,
      });
    }

    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    return { data: (await res.json()) as T, headers: res.headers };
  }

  private async check(path: string, signal?: AbortSignal): Promise<ServiceCheck> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { "X-API-Key": this.apiKey },
        signal,
      });
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, detail: await safeText(res) };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        detail: (err as Error).message,
      };
    }
  }
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.slice(0, 2000);
  } catch {
    return undefined;
  }
}
