/**
 * orders.cancel — write, risk low.
 *
 * prepare: owned and in {confirmed, packed}, else 404 / 422 invalid_state. Changes nothing.
 * perform: one conditional cancel at the backend, under the proposal id as its reference, so
 *          running it again after a timeout reports the first outcome instead of refunding
 *          twice (handoff §7.7).
 */
import type { Order, OrdersBackend } from "../../backends/orders.js";
import { Problem } from "../../http/problems.js";
import type { WriteCapability } from "../types.js";
import { orderNotFound } from "./get.js";
import {
  DEFAULT_TIMEOUT_MS,
  formatMoney,
  isCancellable,
  ORDER_ID_SCHEMA,
  type OrderCapabilityOptions,
} from "./shape.js";

export const CANCEL_REASONS = [
  "changed_mind",
  "ordered_by_mistake",
  "found_cheaper",
  "delivery_too_slow",
  "other",
] as const;

const REFUND_ETA_BUSINESS_DAYS = 3;

function notCancellable(status: Order["status"]): Problem {
  const detail =
    status === "cancelled"
      ? "The order is already cancelled."
      : status === "delivered"
        ? "The order has already been delivered."
        : "The order has already shipped.";
  return new Problem("invalid_state", detail, {
    title: "Not possible in the order's current state",
  });
}

export function ordersCancel(
  backend: OrdersBackend,
  options: OrderCapabilityOptions = {},
): WriteCapability {
  return {
    name: "orders.cancel",
    kind: "write",
    version: 1,
    risk: "low",
    // Verbatim from the contract's inventory example; the planner reads it.
    description:
      "Cancel an order that has not shipped yet. Prepaid orders are refunded to the original payment method. Propose first; the customer must confirm.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["order_id"],
      properties: {
        order_id: ORDER_ID_SCHEMA,
        reason: { type: "string", enum: [...CANCEL_REASONS] },
      },
    },
    requiresSubject: true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,

    async prepare(ctx, args) {
      const { order_id } = args as { order_id: string };
      const order = await backend.get(ctx.tenant, ctx.subject!, order_id, ctx.signal);
      if (order === null) throw orderNotFound();
      if (!isCancellable(order)) throw notCancellable(order.status);
      return {
        summary: `Cancel order ${order.orderId} (${formatMoney(order.total)}). The refund goes to your original payment method within ${REFUND_ETA_BUSINESS_DAYS} business days.`,
        preview: {
          order_id: order.orderId,
          refund: { amount: order.total.amount, currency: order.total.currency },
        },
      };
    },

    async perform(ctx, args) {
      const { order_id } = args as { order_id: string };
      const outcome = await backend.cancel(
        ctx.tenant,
        ctx.subject!,
        order_id,
        { reference: ctx.proposalId, now: ctx.now },
        ctx.signal,
      );
      switch (outcome.kind) {
        case "cancelled":
        case "already_cancelled":
          return {
            result: {
              order_id: outcome.order.orderId,
              refund: {
                amount: outcome.refund.amount,
                currency: outcome.refund.currency,
                eta_business_days: outcome.refund.etaBusinessDays,
              },
            },
          };
        case "not_cancellable":
          return { rejected: "invalid_state" };
        case "not_found":
          return { rejected: "not_found" };
      }
    },
  };
}
