import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import Design from "../src/models/Design";
import { auth, clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

describe("orders", () => {
  it("answers a malformed id with 400 and keeps serving", async () => {
    const { token } = await createUser();
    await request(app).get("/api/orders/not-an-id").set(auth(token)).expect(400);
    await request(app).get("/api/orders/user/me").set(auth(token)).expect(200);
  });

  it("hides other customers' orders", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const order = await createOrder(owner.user._id);

    await request(app).get(`/api/orders/${order.id}`).set(auth(stranger.token)).expect(404);
    await request(app).get(`/api/orders/${order.id}`).set(auth(owner.token)).expect(200);
  });

  it("rejects an unknown order status", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const order = await createOrder(user._id);

    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "lost" }).expect(400);
    await request(app).patch(`/api/admin/orders/${order.id}`).set(auth(admin.token)).send({ status: "lost" }).expect(400);
  });

  it("counts shipped and delivered orders as revenue", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    await createOrder(user._id, { status: "paid", totalAmount: 1000 });
    await createOrder(user._id, { status: "shipped", totalAmount: 2000 });
    await createOrder(user._id, { status: "delivered", totalAmount: 3000 });

    const res = await request(app).get("/api/admin/dashboard").set(auth(admin.token)).expect(200);
    expect(res.body.totals.totalRevenue).toBe(6000);
  });
});

describe("designs", () => {
  it("hides other customers' designs", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const design = await Design.create({
      user: owner.user._id,
      title: "Birthday tee",
      itemType: "t-shirt",
      imageUrl: "https://res.cloudinary.com/demo/image/upload/tee.png",
      color: "white",
      size: "L",
    });

    await request(app).get(`/api/designs/${design.id}`).set(auth(stranger.token)).expect(404);
    await request(app).get(`/api/designs/${design.id}`).set(auth(owner.token)).expect(200);
  });
});

describe("app", () => {
  it("returns JSON for unknown routes", async () => {
    const res = await request(app).get("/api/nothing-here").expect(404);
    expect(res.body.error).toBe("Not found");
  });

  it("reports database health", async () => {
    await request(app).get("/health").expect(200);
  });
});
