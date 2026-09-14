import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/push")>();
  return { ...actual, notifyOrderStatus: vi.fn() };
});

import app from "../src/app";
import DeviceToken from "../src/models/DeviceToken";
import { notifyOrderStatus } from "../src/services/push";
import { auth, clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

const notifyMock = vi.mocked(notifyOrderStatus);
const TOKEN = "ExponentPushToken[xk2yQ7a8Bd3PqL0mN5rT1v]";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  notifyMock.mockClear();
});

describe("device registration", () => {
  it("moves a device to whoever signed in on it last", async () => {
    const first = await createUser();
    const second = await createUser();

    await request(app).post("/api/devices").set(auth(first.token)).send({ token: TOKEN, platform: "android" }).expect(200);
    await request(app).post("/api/devices").set(auth(second.token)).send({ token: TOKEN, platform: "android" }).expect(200);

    const devices = await DeviceToken.find().lean();
    expect(devices).toHaveLength(1);
    expect(String(devices[0].user)).toBe(second.user.id);
  });

  it("rejects something that isn't an Expo push token", async () => {
    const { token } = await createUser();
    await request(app).post("/api/devices").set(auth(token)).send({ token: "not-a-token", platform: "ios" }).expect(400);
  });

  it("only removes the signed-in customer's own device", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await request(app).post("/api/devices").set(auth(owner.token)).send({ token: TOKEN, platform: "ios" }).expect(200);

    await request(app).delete("/api/devices").set(auth(stranger.token)).send({ token: TOKEN }).expect(200);
    expect(await DeviceToken.countDocuments()).toBe(1);

    await request(app).delete("/api/devices").set(auth(owner.token)).send({ token: TOKEN }).expect(200);
    expect(await DeviceToken.countDocuments()).toBe(0);
  });

  it("removes devices when the account is deleted", async () => {
    const { token, password } = await createUser();
    await request(app).post("/api/devices").set(auth(token)).send({ token: TOKEN, platform: "ios" }).expect(200);

    await request(app).delete("/api/auth/me").set(auth(token)).send({ password }).expect(200);
    expect(await DeviceToken.countDocuments()).toBe(0);
  });
});

describe("order status notifications", () => {
  it("notifies the customer when an admin ships their order, once", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const order = await createOrder(user._id, { status: "paid" });

    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "shipped" }).expect(200);
    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "shipped" }).expect(200);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({ userId: user.id, orderId: order.id, status: "shipped" });
  });

  it("notifies through the admin panel's route too", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const order = await createOrder(user._id, { status: "shipped" });

    const res = await request(app)
      .patch(`/api/admin/orders/${order.id}`)
      .set(auth(admin.token))
      .send({ status: "delivered" })
      .expect(200);

    expect(res.body.order.status).toBe("delivered");
    expect(notifyMock).toHaveBeenCalledWith({ userId: user.id, orderId: order.id, status: "delivered" });
  });
});

describe("app config", () => {
  it("returns the minimum supported app versions", async () => {
    const res = await request(app).get("/api/app/config").expect(200);
    expect(res.body.minimumVersion).toEqual({ ios: "1.0.0", android: "1.0.0" });
    expect(res.body.storeUrl.android).toContain("com.impressa.app");
  });
});
