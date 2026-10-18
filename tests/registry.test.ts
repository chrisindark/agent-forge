import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/core/tools/registry.js";
import type { ToolDef } from "../src/core/types.js";

function greetTool(): ToolDef<{ name: string }> {
  return {
    name: "greet",
    description: "Greet someone by name",
    schema: z.object({ name: z.string() }),
    handler: async ({ name }) => `hello ${name}`,
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry().register(greetTool());
    expect(registry.has("greet")).toBe(true);
    expect(registry.get("greet")?.name).toBe("greet");
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry().register(greetTool());
    expect(() => registry.register(greetTool())).toThrow(/already registered/);
  });

  it("rejects invalid tool names", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "bad name!",
        description: "x",
        schema: z.object({}),
        handler: async () => null,
      }),
    ).toThrow(/Invalid tool name/);
  });

  it("rejects tools without a description", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: "no_desc",
        description: "   ",
        schema: z.object({}),
        handler: async () => null,
      }),
    ).toThrow(/description/);
  });

  it("emits the OpenAI tools array with JSON Schema derived from zod", () => {
    const tools = new ToolRegistry().register(greetTool()).toOpenAI();
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "greet",
          description: "Greet someone by name",
          parameters: expect.objectContaining({ type: "object" }),
        },
      },
    ]);
    const params = tools[0]!.function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties).toHaveProperty("name");
    expect(params.required).toContain("name");
  });
});
