import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import ProductTemplate from "../src/models/ProductTemplate";
import { auth, clearDatabase, createProduct, createUser, startDatabase, stopDatabase } from "./helpers";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

describe("cart pricing", () => {
  it("ignores the price sent by the client", async () => {
    const { token } = await createUser();
    const product = await createProduct({ price: 9000 });

    await request(app)
      .post("/api/cart/add")
      .set(auth(token))
      .send({ templateId: product.id, quantity: 2, price: 1, size: "M" })
      .expect(200);

    const res = await request(app).get("/api/cart").set(auth(token)).expect(200);
    expect(res.body.items[0].unitPrice).toBe(9000);
    expect(res.body.subtotal).toBe(18000);
    expect(res.body.deliveryFee).toBe(1500);
  });

  it("accepts the payload the website's product page sends", async () => {
    const { token } = await createUser();
    const product = await createProduct({ sizes: [], colors: [] });

    await request(app)
      .post("/api/cart/add")
      .set(auth(token))
      .send({
        templateId: product.id,
        itemType: "dress",
        quantity: 1,
        price: 9000,
        imageUrl: "https://res.cloudinary.com/demo/image/upload/dress.jpg",
        options: { size: null, color: null },
        size: null,
        color: null,
        title: "Luxury Dress",
      })
      .expect(200);
  });

  it("uses the product's current price after it changes", async () => {
    const { token } = await createUser();
    const product = await createProduct({ price: 9000 });
    await request(app).post("/api/cart/add").set(auth(token)).send({ templateId: product.id }).expect(200);

    await ProductTemplate.updateOne({ _id: product._id }, { price: 12000 });

    const res = await request(app).get("/api/cart").set(auth(token)).expect(200);
    expect(res.body.subtotal).toBe(12000);
  });

  it("rejects custom designs", async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post("/api/cart/add")
      .set(auth(token))
      .send({ designId: "64b0c0ffee0000000000abcd", itemType: "t-shirt", price: 100 })
      .expect(400);
    expect(res.body.error).toBe("Custom designs can't be ordered yet.");
  });

  it("rejects out-of-stock products", async () => {
    const { token } = await createUser();
    const product = await createProduct({ inStock: false });
    await request(app).post("/api/cart/add").set(auth(token)).send({ templateId: product.id }).expect(400);
  });

  it("rejects a size the product doesn't come in", async () => {
    const { token } = await createUser();
    const product = await createProduct();
    await request(app).post("/api/cart/add").set(auth(token)).send({ templateId: product.id, size: "XXS" }).expect(400);
  });

  it("rejects quantities above the limit", async () => {
    const { token } = await createUser();
    const product = await createProduct();
    await request(app).post("/api/cart/add").set(auth(token)).send({ templateId: product.id, quantity: 500 }).expect(400);
  });

  it("returns 400 for a malformed cart item id", async () => {
    const { token } = await createUser();
    await request(app).post("/api/cart/update").set(auth(token)).send({ id: "abc", quantity: 2 }).expect(400);
    await request(app).delete("/api/cart/remove/abc").set(auth(token)).expect(400);
  });
});
