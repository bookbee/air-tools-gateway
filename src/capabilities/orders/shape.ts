/**
 * Order → the small, flat shapes a customer conversation needs (contract rule 9). No internal
 * ids, no raw backend payload, no other customer's data.
 */
import { CANCELLABLE_STATUSES, type Money, type Order } from "../../backends/orders.js";

export const ORDER_ID_SCHEMA = { type: "string", pattern: "^[0-9]{4,12}$" } as const;

export const DEFAULT_TIMEOUT_MS = 2000;

export interface OrderCapabilityOptions {
  /** Per-call deadline; tests shorten it. */
  readonly timeoutMs?: number;
}

const money = (m: Money) => ({ amount: m.amount, currency: m.currency });

export const isCancellable = (order: Order) => CANCELLABLE_STATUSES.includes(order.status);

export function orderSummary(order: Order) {
  return {
    order_id: order.orderId,
    placed_at: order.placedAt,
    status: order.status,
    total: money(order.total),
    expected_delivery: order.expectedDelivery,
    cancellable: isCancellable(order),
  };
}

export function orderDetail(order: Order) {
  return {
    order_id: order.orderId,
    placed_at: order.placedAt,
    status: order.status,
    total: money(order.total),
    expected_delivery: order.expectedDelivery,
    items: order.items.map((item) => ({
      name: item.name,
      qty: item.qty,
      price: money(item.price),
    })),
    tracking:
      order.tracking === null
        ? null
        : {
            carrier: order.tracking.carrier,
            status: order.tracking.status,
            last_update: order.tracking.lastUpdate,
          },
    cancellable: isCancellable(order),
    returnable: order.returnable,
  };
}

/** "₹1,240.00" for INR; other currencies fall back to Intl's own symbol. */
export function formatMoney(m: Money): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: m.currency }).format(
    Number(m.amount),
  );
}
