import * as Sentry from "@sentry/node";
import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { env } from "../config/env";
import DeviceToken from "../models/DeviceToken";
import type { OrderStatus } from "../models/Order";

const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

export const isPushToken = (token: unknown): token is string => Expo.isExpoPushToken(token);

// Same "Order #XXXXXX" the app shows.
export const orderNumber = (orderId: string) => orderId.slice(-6).toUpperCase();

const STATUS_MESSAGES: Partial<Record<OrderStatus, { title: string; body: (number: string) => string }>> = {
  shipped: { title: "Your order is on its way", body: (number) => `Order #${number} has been shipped.` },
  delivered: { title: "Your order has been delivered", body: (number) => `Order #${number} has been delivered. Enjoy!` },
};

type OrderStatusPush = { userId: string; orderId: string; status: OrderStatus };

export async function sendOrderStatusPush({ userId, orderId, status }: OrderStatusPush) {
  const template = STATUS_MESSAGES[status];
  if (!template) return;

  const devices = await DeviceToken.find({ user: userId }).lean();
  const messages: ExpoPushMessage[] = devices
    .filter((device) => isPushToken(device.token))
    .map((device) => ({
      to: device.token,
      title: template.title,
      body: template.body(orderNumber(orderId)),
      data: { type: "order", orderId },
      sound: "default",
      channelId: "orders",
    }));
  if (messages.length === 0) return;

  const tickets: ExpoPushTicket[] = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
  }

  // Tickets come back in message order. DeviceNotRegistered means the app was uninstalled.
  const staleTokens = tickets.flatMap((ticket, index) =>
    ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? [messages[index].to as string] : []
  );
  if (staleTokens.length > 0) {
    await DeviceToken.deleteMany({ token: { $in: staleTokens } });
  }

  const failures = tickets.filter((ticket) => ticket.status === "error");
  if (failures.length > staleTokens.length) {
    console.error(`Order ${orderId} push had ${failures.length} failed ticket(s):`, failures);
  }
}

// A failed notification must never fail the status update that triggered it.
export function notifyOrderStatus(push: OrderStatusPush) {
  sendOrderStatusPush(push).catch((err) => {
    console.error(`Order ${push.orderId} push failed:`, err);
    Sentry.captureException(err);
  });
}
