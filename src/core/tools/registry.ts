/**
 * Tool registry (SPEC §8): collects tools and emits the OpenAI `tools` array.
 */
import type { JSONSchema, OpenAIToolDef, ToolDef } from "../types.js";
import { z } from "zod";

export class ToolRegistry {
  // `any` here is deliberate: handlers are contravariant in their args, so a
  // homogeneous collection needs an erased type. Validation happens in the
  // executor via each tool's own zod schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDef<any>>();

  /** Register a tool. Throws on duplicate names (a silent overwrite is a bug). */
  register<A>(tool: ToolDef<A>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    validateToolShape(tool);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef<any>[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The `tools[]` array sent with each chat completion. */
  toOpenAI(): OpenAIToolDef[] {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? toJsonSchema(t),
      },
    }));
  }
}

/** Convenience: build and register in one call. */
export function registerTool<A>(
  registry: ToolRegistry,
  tool: ToolDef<A>,
): ToolRegistry {
  return registry.register(tool);
}

function validateToolShape(tool: ToolDef<any>): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
    throw new Error(
      `Invalid tool name "${tool.name}" (must match [a-zA-Z0-9_-]{1,64})`,
    );
  }
  if (!tool.description.trim()) {
    throw new Error(`Tool "${tool.name}" needs a description — the model picks tools by it.`);
  }
}

/**
 * Derive the model-facing JSON Schema from the zod schema (zod v4).
 * The zod schema stays authoritative for validation at execution time.
 */
export function toJsonSchema(tool: ToolDef<any>): JSONSchema {
  const schema = z.toJSONSchema(tool.schema, { io: "input" }) as JSONSchema;
  // OpenAI function parameters must be an object schema with a type.
  if (!schema["type"]) schema["type"] = "object";
  return schema;
}
