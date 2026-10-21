/**
 * Binds gateway tools for Echo Ops (grows at M2 — see SPEC §9 catalog).
 */
import type { GatewayClient } from "../../core/gateway/gateway-client.js";
import type { ToolDef } from "../../core/types.js";
import { createGatewayHealthTool } from "../../tools/gateway/health.js";

export function createEchoOpsTools(client: GatewayClient): ToolDef<any>[] {
  return [createGatewayHealthTool(client)];
}
