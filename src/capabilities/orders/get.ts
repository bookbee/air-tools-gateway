import type { OrdersBackend } from "../../backends/orders.js";
import { Problem } from "../../http/problems.js";
import type { ReadCapability } from "../types.js";
import {
  DEFAULT_TIMEOUT_MS,
  ORDER_ID_SCHEMA,
  orderDetail,
  type OrderCapabilityOptions,
} from "./shape.js";

/** One answer for "missing" and "not yours": the same Problem, built the same way. */
export const orderNotFound = () => new Problem("not_found", "No such order.");

export function ordersGet(
  backend: OrdersBackend,
  options: OrderCapabilityOptions = {},
): ReadCapability {
  return {
    name: "orders.get",
    kind: "read",
    version: 1,
    // Verbatim from the contract's inventory example; the planner reads it.
    description:
      "One order by its number, with its items, status, delivery tracking and whether it can still be cancelled or returned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["order_id"],
      properties: { order_id: ORDER_ID_SCHEMA },
    },
    requiresSubject: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,

    async run(ctx, args) {
      const { order_id } = args as { order_id: string };
      const order = await backend.get(ctx.tenant, ctx.subject!, order_id, ctx.signal);
      if (order === null) throw orderNotFound();
      return { data: orderDetail(order), truncated: false, asOf: ctx.now };
    },
  };
}
