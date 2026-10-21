/**
 * Environment-driven configuration (SPEC §10).
 *
 * Secrets come from the environment or a local `.env` — never committed.
 */
import { z } from "zod";

const EnvSchema = z.object({
  GATEWAY_URL: z.url().default("http://localhost:8000"),
  GATEWAY_API_KEY: z.string().min(1, "GATEWAY_API_KEY is required"),

  AGENT_PROVIDER: z.string().default("groq"),
  AGENT_MODEL: z.string().default("openai/gpt-oss-20b"),
  AGENT_TENANT_ID: z.string().optional(),
  AGENT_USER_ID: z.string().default("ops-agent"),
  /** Optional; binds a cache scope. */
  AGENT_SESSION_ID: z.string().optional(),

  MAX_STEPS: z.coerce.number().int().positive().default(8),
  TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Optional hard stop on total run tokens. */
  RUN_BUDGET_TOKENS: z.coerce.number().int().positive().default(50_000),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export type EnvLike = Record<string, string | undefined>;

/**
 * Load and validate config from an env-like record (defaults to `process.env`).
 * Throws a readable `ConfigError` listing every invalid field at once.
 */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const key = i.path.join(".") || "(root)";
      return `${key}: ${i.message}`;
    });
    throw new ConfigError(issues);
  }
  const cfg = parsed.data;
  // Normalize so path joins in the client are predictable.
  cfg.GATEWAY_URL = cfg.GATEWAY_URL.replace(/\/+$/, "");
  return cfg;
}
