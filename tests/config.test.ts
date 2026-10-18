import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/core/config.js";

const baseEnv = { GATEWAY_API_KEY: "eg_test_key" };

describe("loadConfig", () => {
  it("applies SPEC §10 defaults", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.GATEWAY_URL).toBe("http://localhost:8000");
    expect(cfg.AGENT_PROVIDER).toBe("groq");
    expect(cfg.AGENT_MODEL).toBe("openai/gpt-oss-20b");
    expect(cfg.MAX_STEPS).toBe(8);
    expect(cfg.TEMPERATURE).toBe(0.2);
    expect(cfg.MAX_TOKENS).toBe(1024);
    expect(cfg.TOOL_TIMEOUT_MS).toBe(10_000);
    expect(cfg.RUN_BUDGET_TOKENS).toBe(50_000);
    expect(cfg.AGENT_USER_ID).toBe("ops-agent");
  });

  it("coerces numeric strings from the environment", () => {
    const cfg = loadConfig({ ...baseEnv, MAX_STEPS: "3", TEMPERATURE: "0" });
    expect(cfg.MAX_STEPS).toBe(3);
    expect(cfg.TEMPERATURE).toBe(0);
  });

  it("strips trailing slashes from GATEWAY_URL", () => {
    const cfg = loadConfig({ ...baseEnv, GATEWAY_URL: "http://localhost:8000///" });
    expect(cfg.GATEWAY_URL).toBe("http://localhost:8000");
  });

  it("fails fast without GATEWAY_API_KEY", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/GATEWAY_API_KEY/);
  });

  it("reports every invalid field at once", () => {
    try {
      loadConfig({ ...baseEnv, MAX_STEPS: "0", TEMPERATURE: "9" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.join(" ")).toMatch(/MAX_STEPS/);
      expect((err as ConfigError).issues.join(" ")).toMatch(/TEMPERATURE/);
    }
  });
});
