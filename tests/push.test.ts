import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken(token: unknown) {
      return typeof token === "string" && /^Expo(nent)?PushToken\[.+\]$/.test(token);
    }
    chunkPushNotifications<T>(messages: T[]) {
      return [messages];
    }
    sendPushNotificationsAsync = sendMock;
  },
}));

import DeviceToken from "../src/models/DeviceToken";
import { sendOrderStatusPush } from "../src/services/push";
import { clearDatabase, createUser, startDatabase, stopDatabase } from "./helpers";

const ORDER_ID = "64b0c0ffee0000000000abcd";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  sendMock.mockReset();
});

async function customerWithDevices(tokens: string[]) {
  const { user } = await createUser();
  await DeviceToken.insertMany(tokens.map((token) => ({ user: user._id, token, platform: "android" })));
  return user;
}

describe("order status push", () => {
  it("tells the customer their order has shipped", async () => {
    const user = await customerWithDevices(["ExponentPushToken[phone-one]"]);
    sendMock.mockResolvedValue([{ status: "ok", id: "ticket-1" }]);

    await sendOrderStatusPush({ userId: user.id, orderId: ORDER_ID, status: "shipped" });

    expect(sendMock).toHaveBeenCalledWith([
      expect.objectContaining({
        to: "ExponentPushToken[phone-one]",
        title: "Your order is on its way",
        body: "Order #00ABCD has been shipped.",
        data: { type: "order", orderId: ORDER_ID },
      }),
    ]);
  });

  it("doesn't notify for statuses customers already know about", async () => {
    const user = await customerWithDevices(["ExponentPushToken[phone-one]"]);
    await sendOrderStatusPush({ userId: user.id, orderId: ORDER_ID, status: "paid" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("forgets devices whose app was uninstalled", async () => {
    const user = await customerWithDevices(["ExponentPushToken[kept]", "ExponentPushToken[uninstalled]"]);
    sendMock.mockResolvedValue([
      { status: "ok", id: "ticket-1" },
      { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
    ]);

    await sendOrderStatusPush({ userId: user.id, orderId: ORDER_ID, status: "delivered" });

    const remaining = await DeviceToken.find().lean();
    expect(remaining.map((device) => device.token)).toEqual(["ExponentPushToken[kept]"]);
  });
});
