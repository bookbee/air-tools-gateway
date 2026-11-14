/**
 * The orders backend interface. v1 is served by the in-memory fixture; a real order system
 * gets an HTTP adapter behind the same interface later.
 *
 * Ownership is part of every query: a lookup takes (tenant, customer) and returns null for an
 * order that is missing *or* belongs to someone else, so the two can never be told apart.
 *
 * A backend reports failure by throwing: `BackendError` for a failed call, or the signal's
 * abort reason when the caller's deadline passes. Neither message ever reaches a response.
 */

export const ORDER_STATUSES = [
  "confirmed",
  "packed",
  "in_transit",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** States an order can still be cancelled from. */
export const CANCELLABLE_STATUSES: readonly OrderStatus[] = ["confirmed", "packed"];

/** A decimal amount as a string ("1240.00"), never a float. */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export interface OrderItem {
  readonly name: string;
  readonly qty: number;
  readonly price: Money;
}

export interface Tracking {
  readonly carrier: string;
  readonly status: string;
  /** ISO 8601 date-time. */
  readonly lastUpdate: string;
}

export interface Order {
  readonly orderId: string;
  readonly customerId: string;
  /** ISO 8601 date. */
  readonly placedAt: string;
  readonly status: OrderStatus;
  readonly total: Money;
  readonly expectedDelivery: string | null;
  readonly items: readonly OrderItem[];
  readonly tracking: Tracking | null;
  readonly returnable: boolean;
}

export interface Refund extends Money {
  readonly etaBusinessDays: number;
}

export type CancelOutcome =
  | { readonly kind: "cancelled"; readonly order: Order; readonly refund: Refund }
  /** Already cancelled under this same reference: the earlier outcome, nothing changed now. */
  | { readonly kind: "already_cancelled"; readonly order: Order; readonly refund: Refund }
  | { readonly kind: "not_cancellable"; readonly status: OrderStatus }
  | { readonly kind: "not_found" };

export interface CancelRequest {
  /** Idempotency reference for the change (the proposal id). */
  readonly reference: string;
  readonly now: Date;
}

export interface OrdersBackend {
  /** The customer's orders, newest first, at most `limit`; `total` counts them all. */
  listRecent(
    tenant: string,
    customerId: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ orders: readonly Order[]; total: number }>;

  /** One order, or null when it is missing or not this customer's. */
  get(
    tenant: string,
    customerId: string,
    orderId: string,
    signal: AbortSignal,
  ): Promise<Order | null>;

  /**
   * Cancel if (and only if) the order is the customer's and in a cancellable state, as one
   * atomic step. Repeating it with the same reference returns `already_cancelled`.
   */
  cancel(
    tenant: string,
    customerId: string,
    orderId: string,
    request: CancelRequest,
    signal: AbortSignal,
  ): Promise<CancelOutcome>;

  /** Readiness: true when the backend can serve. */
  ping(signal: AbortSignal): Promise<boolean>;
}

/** A backend call failed. `message` is for logs only. */
export class BackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendError";
  }
}
