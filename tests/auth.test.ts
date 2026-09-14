import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/email", () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import app from "../src/app";
import Cart from "../src/models/Cart";
import Order from "../src/models/Order";
import User from "../src/models/User";
import { sendPasswordResetEmail } from "../src/services/email";
import { auth, clearDatabase, createOrder, createUser, startDatabase, stopDatabase } from "./helpers";

const emailMock = vi.mocked(sendPasswordResetEmail);

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(async () => {
  await clearDatabase();
  emailMock.mockClear();
});

describe("admin registration", () => {
  const newAdmin = { username: "ops_lead", email: "ops@impressa.test", password: "a-long-admin-password" };

  it("requires a signed-in admin", async () => {
    const customer = await createUser();
    const admin = await createUser({ role: "admin" });

    await request(app).post("/api/auth/register-admin").send(newAdmin).expect(401);
    await request(app).post("/api/auth/register-admin").set(auth(customer.token)).send(newAdmin).expect(403);
    await request(app).post("/api/auth/register-admin").set(auth(admin.token)).send(newAdmin).expect(201);

    expect(await User.countDocuments({ role: "admin" })).toBe(2);
  });
});

describe("sign-up and sign-in", () => {
  it("rejects short passwords", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ username: "adaobi", email: "ada@example.com", password: "short" })
      .expect(400);
    expect(res.body.error).toBe("Password must be at least 8 characters.");
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    const { user } = await createUser();

    const unknown = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever-123" });
    const wrong = await request(app).post("/api/auth/login").send({ email: user.email, password: "not-the-password" });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toBe(wrong.body.error);
  });

  it("matches older accounts' emails regardless of case", async () => {
    const { password } = await createUser({ email: "Ada.Obi@Example.com" });
    await request(app).post("/api/auth/login").send({ email: "ada.obi@example.com", password }).expect(200);
  });

  it("never returns password fields", async () => {
    const { token } = await createUser();
    const res = await request(app).get("/api/auth/me").set(auth(token)).expect(200);
    expect(res.body.password).toBeUndefined();
    expect(res.body.tokenVersion).toBeUndefined();
  });
});

describe("password reset", () => {
  it("resets the password once and ends existing sessions", async () => {
    const { user, token: oldToken } = await createUser();

    await request(app).post("/api/auth/forgot-password").send({ email: user.email }).expect(200);
    expect(emailMock).toHaveBeenCalledTimes(1);
    const resetUrl = new URL(emailMock.mock.calls[0][1]);
    expect(resetUrl.origin).toBe("https://impressa.test");
    const resetToken = resetUrl.searchParams.get("token");

    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: resetToken, password: "a-brand-new-password" })
      .expect(200);

    await request(app).get("/api/auth/me").set(auth(oldToken)).expect(401);
    await request(app).post("/api/auth/login").send({ email: user.email, password: "a-brand-new-password" }).expect(200);
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: resetToken, password: "another-new-password" })
      .expect(400);
  });

  it("responds the same way for an unknown email without sending anything", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "nobody@example.com" }).expect(200);
    expect(res.body.message).toContain("If an account exists");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("account deletion", () => {
  it("waits until every order has been delivered", async () => {
    const { user, token, password } = await createUser();
    await createOrder(user._id, { status: "shipped" });

    await request(app).delete("/api/auth/me").set(auth(token)).send({ password }).expect(409);
    expect(await User.exists({ _id: user._id })).toBeTruthy();
  });

  it("requires the correct password", async () => {
    const { token } = await createUser();
    await request(app).delete("/api/auth/me").set(auth(token)).send({ password: "not-the-password" }).expect(400);
  });

  it("deletes the account and removes contact details from past orders", async () => {
    const { user, token, password } = await createUser();
    const order = await createOrder(user._id, { status: "delivered" });
    await Cart.create({ user: user._id, items: [] });

    await request(app).delete("/api/auth/me").set(auth(token)).send({ password }).expect(200);

    expect(await User.exists({ _id: user._id })).toBeNull();
    expect(await Cart.exists({ user: user._id })).toBeNull();
    const kept = await Order.findById(order._id).lean();
    expect(kept?.totalAmount).toBe(order.totalAmount);
    expect(kept?.deliveryAddress.phone).toBe("Deleted");
    expect(kept?.email).toBeUndefined();
  });
});
