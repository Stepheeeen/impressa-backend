import * as Sentry from "@sentry/node";
import Order, { OrderStatus } from "../models/Order";
import { notifyOrderStatus } from "./push";
import { awardCashback } from "./rewards";

// Updates an order's status and records it in the history. Notifies the customer unless told not to
// (marketplace orders notify per parcel instead). Returns null if the order doesn't exist.
export async function changeOrderStatus(orderId: string, status: OrderStatus, { notify = true }: { notify?: boolean } = {}) {
  // Only matches when the status actually changes, so repeated clicks don't add history or send duplicate notifications.
  const changed = await Order.findOneAndUpdate(
    { _id: orderId, status: { $ne: status } },
    { $set: { status }, $push: { statusHistory: { status, at: new Date() } } },
    { new: true }
  );

  if (!changed) return Order.findById(orderId);

  if (notify) notifyOrderStatus({ userId: String(changed.user), orderId: String(changed._id), status });

  if (status === "delivered") {
    // Cashback must never block the status update; a failure is logged for follow-up.
    await awardCashback(String(changed._id)).catch((err) => {
      console.error(`Cashback for order ${changed._id} failed:`, err);
      Sentry.captureException(err);
    });
  }

  return changed;
}
