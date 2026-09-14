import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/push")>();
  return { ...actual, notifyOrderStatus: vi.fn() };
});

import app from "../src/app";
import Order from "../src/models/Order";
import { notifyOrderStatus } from "../src/services/push";
import { auth, clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

const notifyMock = vi.mocked(notifyOrderStatus);

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  notifyMock.mockClear();
});

async function paidOrderAndAdmin(status: "paid" | "delivered" = "paid") {
  const admin = await createUser({ role: "admin" });
  const { user } = await createUser();
  const order = await createOrder(user._id, { status });
  const track = (tracking: Record<string, unknown>) =>
    request(app).patch(`/api/orders/${order.id}/tracking`).set(auth(admin.token)).send({ tracking });
  return { admin, user, order, track };
}

describe("order tracking from the admin panel", () => {
  it("marks the order shipped when it's in transit, and notifies the customer once", async () => {
    const { user, order, track } = await paidOrderAndAdmin();

    const res = await track({ status: "in-transit", code: "GIG-2291-LAG" }).expect(200);
    await track({ status: "in-transit", code: "GIG-2291-LAG" }).expect(200);

    expect(res.body.order.status).toBe("shipped");
    expect(res.body.order.tracking).toMatchObject({ status: "in-transit", code: "GIG-2291-LAG" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({ userId: user.id, orderId: order.id, status: "shipped" });
  });

  it("marks the order delivered", async () => {
    const { track } = await paidOrderAndAdmin();
    const res = await track({ status: "delivered" }).expect(200);
    expect(res.body.order.status).toBe("delivered");
  });

  it("records processing and failed stages without changing the order status", async () => {
    const { track } = await paidOrderAndAdmin();

    expect((await track({ status: "processing" }).expect(200)).body.order.status).toBe("paid");
    expect((await track({ status: "failed" }).expect(200)).body.order.status).toBe("paid");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("never moves a delivered order back to shipped", async () => {
    const { order, track } = await paidOrderAndAdmin("delivered");

    await track({ status: "in-transit" }).expect(200);

    expect((await Order.findById(order.id))?.status).toBe("delivered");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("clears the tracking code when it's emptied", async () => {
    const { order, track } = await paidOrderAndAdmin();
    await track({ status: "processing", code: "GIG-2291-LAG" }).expect(200);
    await track({ status: "", code: "" }).expect(200);

    const saved = await Order.findById(order.id).lean();
    expect(saved?.tracking?.code).toBeUndefined();
    expect(saved?.tracking?.status).toBeUndefined();
  });

  it("rejects an unknown stage and requires an admin", async () => {
    const { order, track } = await paidOrderAndAdmin();
    await track({ status: "lost-in-space" }).expect(400);

    const customer = await createUser();
    await request(app)
      .patch(`/api/orders/${order.id}/tracking`)
      .set(auth(customer.token))
      .send({ tracking: { status: "delivered" } })
      .expect(403);
  });
});
