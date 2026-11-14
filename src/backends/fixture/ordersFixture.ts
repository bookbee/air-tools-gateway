/**
 * In-memory order store seeded from `fixtures/<tenant>/orders.json`.
 *
 * Loaded once at construction, so a restart resets it. `cancel` mutates it. A missing or
 * malformed fixture never stops startup: the backend reports not ready and every call fails
 * with `BackendError`, which the routes turn into 502.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { Logger } from "../../observability/logger.js";
import {
  BackendError,
  CANCELLABLE_STATUSES,
  ORDER_STATUSES,
  type CancelOutcome,
  type CancelRequest,
  type Order,
  type OrdersBackend,
  type Refund,
} from "../orders.js";

const REFUND_ETA_BUSINESS_DAYS = 3;

const money = z
  .object({
    amount: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const orderSchema = z
  .object({
    order_id: z.string().regex(/^[0-9]{4,12}$/),
    customer_id: z.string().min(1).max(128),
    placed_at: isoDate,
    status: z.enum(ORDER_STATUSES),
    total: money,
    expected_delivery: isoDate.nullable(),
    items: z
      .array(
        z.object({ name: z.string().min(1), qty: z.number().int().min(1), price: money }).strict(),
      )
      .min(1),
    tracking: z
      .object({ carrier: z.string(), status: z.string(), last_update: z.string().datetime() })
      .strict()
      .nullable(),
    returnable: z.boolean(),
  })
  .strict();

const fileSchema = z.object({ orders: z.array(orderSchema) }).strict();

interface Cancellation {
  readonly reference: string;
  readonly refund: Refund;
}

interface Row {
  order: Order;
  cancellation: Cancellation | null;
}

type TenantStore = Map<string, Row>;

function toOrder(raw: z.infer<typeof orderSchema>): Order {
  return {
    orderId: raw.order_id,
    customerId: raw.customer_id,
    placedAt: raw.placed_at,
    status: raw.status,
    total: raw.total,
    expectedDelivery: raw.expected_delivery,
    items: raw.items,
    tracking:
      raw.tracking === null
        ? null
        : {
            carrier: raw.tracking.carrier,
            status: raw.tracking.status,
            lastUpdate: raw.tracking.last_update,
          },
    returnable: raw.returnable,
  };
}

/** Callers get copies, so nothing outside can change the store. */
const copy = <T>(value: T): T => structuredClone(value);

export function loadFixtures(dir: string): Map<string, TenantStore> {
  const tenants = new Map<string, TenantStore>();
  for (const tenant of readdirSync(dir).sort()) {
    const file = join(dir, tenant, "orders.json");
    if (!statSync(join(dir, tenant)).isDirectory()) continue;
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`${file}: invalid fixture at ${where}`);
    }
    const store: TenantStore = new Map();
    for (const raw of parsed.data.orders) {
      if (store.has(raw.order_id)) throw new Error(`${file}: duplicate order_id ${raw.order_id}`);
      store.set(raw.order_id, { order: toOrder(raw), cancellation: null });
    }
    tenants.set(tenant, store);
  }
  return tenants;
}

export class FixtureOrdersBackend implements OrdersBackend {
  readonly #tenants: Map<string, TenantStore> | null;

  constructor(dir: string, log: Logger) {
    try {
      this.#tenants = loadFixtures(dir);
      log.info({ fixture_dir: dir, tenants: [...this.#tenants.keys()] }, "fixture.loaded");
    } catch (error) {
      this.#tenants = null;
      log.error({ err: error, fixture_dir: dir }, "fixture.load_failed");
    }
  }

  #store(tenant: string, signal: AbortSignal): TenantStore {
    signal.throwIfAborted();
    if (this.#tenants === null) throw new BackendError("fixture order store is not loaded");
    // A tenant with no fixture has no orders, rather than an error.
    return this.#tenants.get(tenant) ?? new Map<string, Row>();
  }

  async listRecent(tenant: string, customerId: string, limit: number, signal: AbortSignal) {
    const mine = [...this.#store(tenant, signal).values()]
      .map((row) => row.order)
      .filter((order) => order.customerId === customerId)
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt) || b.orderId.localeCompare(a.orderId));
    return { orders: copy(mine.slice(0, limit)), total: mine.length };
  }

  async get(tenant: string, customerId: string, orderId: string, signal: AbortSignal) {
    const row = this.#store(tenant, signal).get(orderId);
    if (row === undefined || row.order.customerId !== customerId) return null;
    return copy(row.order);
  }

  async cancel(
    tenant: string,
    customerId: string,
    orderId: string,
    request: CancelRequest,
    signal: AbortSignal,
  ): Promise<CancelOutcome> {
    const row = this.#store(tenant, signal).get(orderId);
    if (row === undefined || row.order.customerId !== customerId) return { kind: "not_found" };

    if (row.cancellation !== null) {
      return row.cancellation.reference === request.reference
        ? {
            kind: "already_cancelled",
            order: copy(row.order),
            refund: copy(row.cancellation.refund),
          }
        : { kind: "not_cancellable", status: row.order.status };
    }
    if (!CANCELLABLE_STATUSES.includes(row.order.status)) {
      return { kind: "not_cancellable", status: row.order.status };
    }

    // Check and change in one synchronous step: nothing can interleave.
    const refund: Refund = { ...row.order.total, etaBusinessDays: REFUND_ETA_BUSINESS_DAYS };
    row.order = { ...row.order, status: "cancelled", expectedDelivery: null };
    row.cancellation = { reference: request.reference, refund };
    return { kind: "cancelled", order: copy(row.order), refund: copy(refund) };
  }

  async ping(signal: AbortSignal) {
    signal.throwIfAborted();
    return this.#tenants !== null;
  }

  /** Test support: change an order's status as if the business system did. */
  setStatus(tenant: string, orderId: string, status: Order["status"]): void {
    const row = this.#tenants?.get(tenant)?.get(orderId);
    if (row === undefined) throw new Error(`no fixture order ${tenant}/${orderId}`);
    row.order = { ...row.order, status };
  }
}
