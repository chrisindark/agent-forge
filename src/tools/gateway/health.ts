/**
 * `gateway_health` tool — health triage across Echo Gate's three health
 * endpoints (SPEC §3.1.1, §9).
 */
import { z } from "zod";
import type { ToolDef } from "../../core/types.js";
import type { GatewayClient, GatewayHealth } from "../../core/gateway/gateway-client.js";

const ArgsSchema = z.object({});

export interface GatewayHealthResult extends GatewayHealth {
  healthy: boolean;
}

export function createGatewayHealthTool(client: GatewayClient): ToolDef<{}> {
  return {
    name: "gateway_health",
    description:
      "Check the health of the Echo Gate gateway and its backing services. " +
      "Returns readiness, background worker (Celery), and queue (worker/celery) status; " +
      "the `degraded` array names any subsystem not reporting ok.",
    schema: ArgsSchema,
    handler: async (_args, ctx): Promise<GatewayHealthResult> => {
      const health = await client.health(ctx.signal);
      return { ...health, healthy: health.degraded.length === 0 };
    },
  };
}
