/**
 * The capabilities v1 serves (handoff §5): exactly these three, built over one backend.
 */
import type { OrdersBackend } from "../backends/orders.js";
import { ordersCancel } from "./orders/cancel.js";
import { ordersGet } from "./orders/get.js";
import { ordersListRecent } from "./orders/listRecent.js";
import type { OrderCapabilityOptions } from "./orders/shape.js";
import type { Capability } from "./types.js";

export function orderCapabilities(
  backend: OrdersBackend,
  options: OrderCapabilityOptions = {},
): Capability[] {
  return [
    ordersListRecent(backend, options),
    ordersGet(backend, options),
    ordersCancel(backend, options),
  ];
}
