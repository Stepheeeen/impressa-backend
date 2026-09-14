import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import Merchant from "../src/models/Merchant";
import ProductTemplate from "../src/models/ProductTemplate";
import { auth, clearDatabase, createMerchant, createParcel, createUser, startDatabase, stopDatabase } from "./helpers";

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

async function buyer(status: "paid" | "delivered" = "delivered") {
  const seller = await createMerchant();
  const customer = await createUser();
  const parcel = await createParcel({ merchant: seller.merchant, customerId: customer.user._id, status });
  const review = (body: object) =>
    request(app)
      .post("/api/reviews")
      .set(auth(customer.token))
      .send({ fulfilmentId: parcel.fulfilment.id, templateId: parcel.product.id, rating: 5, comment: "Beautiful fabric", ...body });
  return { seller, customer, ...parcel, review };
}

describe("reviews", () => {
  it("can only be left once the item has been delivered", async () => {
    const { review } = await buyer("paid");
    const res = await review({}).expect(409);
    expect(res.body.error).toBe("You can review items once they've been delivered.");
  });

  it("are one per item per order, and update the product and seller ratings", async () => {
    const { seller, product, review } = await buyer();

    await review({ rating: 4 }).expect(201);
    await review({ rating: 1 }).expect(409);

    expect(await ProductTemplate.findById(product.id)).toMatchObject({ ratingAverage: 4, ratingCount: 1 });
    expect(await Merchant.findById(seller.merchant.id)).toMatchObject({ ratingAverage: 4, ratingCount: 1 });
  });

  it("show the reviewer's first name only", async () => {
    const { product, review } = await buyer();
    await review({ comment: "Colours held up after washing" }).expect(201);

    const res = await request(app).get(`/api/templates/${product.id}/reviews`).expect(200);
    expect(res.body[0]).toMatchObject({ rating: 5, comment: "Colours held up after washing", authorName: "user" });
    expect(JSON.stringify(res.body)).not.toContain("@");
  });

  it("can be removed by an admin, which updates the rating", async () => {
    const admin = await createUser({ role: "admin" });
    const { product, review } = await buyer();
    await review({}).expect(201);
    const [posted] = (await request(app).get(`/api/templates/${product.id}/reviews`)).body;

    await request(app).delete(`/api/admin/reviews/${posted._id}`).set(auth(admin.token)).expect(200);

    expect(await ProductTemplate.findById(product.id)).toMatchObject({ ratingAverage: 0, ratingCount: 0 });
  });
});
