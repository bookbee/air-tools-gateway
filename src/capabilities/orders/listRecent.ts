import type { OrdersBackend } from "../../backends/orders.js";
import type { ReadCapability } from "../types.js";
import { DEFAULT_TIMEOUT_MS, orderSummary, type OrderCapabilityOptions } from "./shape.js";

export function ordersListRecent(
  backend: OrdersBackend,
  options: OrderCapabilityOptions = {},
): ReadCapability {
  return {
    name: "orders.list_recent",
    kind: "read",
    version: 1,
    // Verbatim from the contract's inventory example; the planner reads it.
    description:
      'The customer\'s most recent orders, newest first, with status, total and expected delivery date. Use for "where is my order", "my recent orders", or to find which order the customer means.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } },
    },
    requiresSubject: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,

    async run(ctx, args) {
      const { limit } = args as { limit: number };
      const { orders, total } = await backend.listRecent(
        ctx.tenant,
        ctx.subject!,
        limit,
        ctx.signal,
      );
      return {
        data: { orders: orders.map(orderSummary) },
        // The customer has more orders than were returned.
        truncated: total > orders.length,
        asOf: ctx.now,
      };
    },
  };
}
