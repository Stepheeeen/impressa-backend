import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import Banner from "../src/models/Banner";
import Order from "../src/models/Order";
import PriceBand from "../src/models/PriceBand";
import ProductTemplate from "../src/models/ProductTemplate";
import { auth, clearDatabase, createOrder, createProduct, createUser, startDatabase, stopDatabase } from "./helpers";

const IMAGE = "https://res.cloudinary.com/dlyu92juc/image/upload/banner.jpg";
const DAY = 24 * 60 * 60 * 1000;

beforeAll(startDatabase);
afterAll(stopDatabase);
beforeEach(clearDatabase);

describe("banners", () => {
  it("shows only live banners, in order", async () => {
    await Banner.create([
      { title: "Second", imageUrl: IMAGE, sortOrder: 2 },
      { title: "First", imageUrl: IMAGE, sortOrder: 1 },
      { title: "Switched off", imageUrl: IMAGE, active: false },
      { title: "Upcoming", imageUrl: IMAGE, startsAt: new Date(Date.now() + DAY) },
      { title: "Ended", imageUrl: IMAGE, endsAt: new Date(Date.now() - DAY) },
    ]);

    const res = await request(app).get("/api/banners").expect(200);
    expect(res.body.map((banner: { title: string }) => banner.title)).toEqual(["First", "Second"]);
  });

  it("can only be managed by admins", async () => {
    const customer = await createUser();
    const banner = { title: "Weekend sale", imageUrl: IMAGE };

    await request(app).post("/api/admin/banners").send(banner).expect(401);
    await request(app).post("/api/admin/banners").set(auth(customer.token)).send(banner).expect(403);
  });

  it("links to a category", async () => {
    const admin = await createUser({ role: "admin" });
    const res = await request(app)
      .post("/api/admin/banners")
      .set(auth(admin.token))
      .send({ title: "New dresses", imageUrl: IMAGE, linkType: "category", linkValue: "luxury dress", startsAt: "", endsAt: "" })
      .expect(201);
    expect(res.body.banner.startsAt).toBeNull();
  });

  it("rejects a link to a product that doesn't exist", async () => {
    const admin = await createUser({ role: "admin" });
    const res = await request(app)
      .post("/api/admin/banners")
      .set(auth(admin.token))
      .send({ title: "Featured bag", imageUrl: IMAGE, linkType: "product", linkValue: new mongoose.Types.ObjectId().toString() })
      .expect(400);
    expect(res.body.error).toBe("That product doesn't exist.");
  });

  it("rejects an end date before the start date", async () => {
    const admin = await createUser({ role: "admin" });
    const res = await request(app)
      .post("/api/admin/banners")
      .set(auth(admin.token))
      .send({ title: "Sale", imageUrl: IMAGE, startsAt: "2026-12-10", endsAt: "2026-12-01" })
      .expect(400);
    expect(res.body.error).toBe("The end date must be after the start date.");
  });
});

describe("price bands", () => {
  it("rejects a maximum that isn't above the minimum", async () => {
    const admin = await createUser({ role: "admin" });
    await request(app)
      .post("/api/admin/price-bands")
      .set(auth(admin.token))
      .send({ label: "Odd band", minPrice: 15000, maxPrice: 5000 })
      .expect(400);
  });

  it("filters products from the minimum up to, not including, the maximum", async () => {
    await Promise.all([4999, 5000, 14999, 15000].map((price) => createProduct({ title: `₦${price}`, price })));

    const res = await request(app).get("/api/templates?minPrice=5000&maxPrice=15000").expect(200);
    expect(res.body.map((product: { price: number }) => product.price).sort()).toEqual([14999, 5000].sort());
  });

  it("still returns every product when no filter is given", async () => {
    await Promise.all([createProduct(), createProduct()]);
    const res = await request(app).get("/api/templates").expect(200);
    expect(res.body).toHaveLength(2);
  });

  it("won't delete a band that a banner links to", async () => {
    const admin = await createUser({ role: "admin" });
    const band = await PriceBand.create({ label: "Under ₦5,000", minPrice: 0, maxPrice: 5000 });
    await Banner.create({ title: "Budget picks", imageUrl: IMAGE, linkType: "priceBand", linkValue: band.id });

    await request(app).delete(`/api/admin/price-bands/${band.id}`).set(auth(admin.token)).expect(409);
  });
});

describe("home feed", () => {
  it("returns banners, price bands, featured products and categories together", async () => {
    await Banner.create({ title: "Weekend sale", imageUrl: IMAGE });
    await PriceBand.create([
      { label: "₦5,000 – ₦15,000", minPrice: 5000, maxPrice: 15000, sortOrder: 2 },
      { label: "Under ₦5,000", minPrice: 0, maxPrice: 5000, sortOrder: 1 },
    ]);
    await createProduct({ title: "Featured dress", isFeatured: true, category: "Luxury Dress" });
    await createProduct({ title: "Plain bag", category: "bags" });

    const res = await request(app).get("/api/home").expect(200);

    expect(res.body.banners).toHaveLength(1);
    expect(res.body.priceBands.map((band: { label: string }) => band.label)).toEqual(["Under ₦5,000", "₦5,000 – ₦15,000"]);
    expect(res.body.featured.map((product: { title: string }) => product.title)).toEqual(["Featured dress"]);
    expect(res.body.categories.sort()).toEqual(["bags", "luxury dress"]);
  });

  it("falls back to the latest in-stock products when none are featured", async () => {
    await createProduct({ title: "In stock" });
    await createProduct({ title: "Sold out", inStock: false });

    const res = await request(app).get("/api/home").expect(200);
    expect(res.body.featuredIsFallback).toBe(true);
    expect(res.body.featured.map((product: { title: string }) => product.title)).toEqual(["In stock"]);
  });
});

describe("product videos", () => {
  it("accepts an https video and removes it when cleared", async () => {
    const admin = await createUser({ role: "admin" });
    const product = await createProduct();
    const videoUrl = "https://res.cloudinary.com/dlyu92juc/video/upload/v1/dress.mp4";

    await request(app).put(`/api/templates/${product.id}/edit`).set(auth(admin.token)).send({ videoUrl }).expect(200);
    expect((await ProductTemplate.findById(product.id))?.videoUrl).toBe(videoUrl);

    await request(app).put(`/api/templates/${product.id}/edit`).set(auth(admin.token)).send({ videoUrl: "" }).expect(200);
    expect((await ProductTemplate.findById(product.id))?.videoUrl).toBeNull();
  });

  it("rejects a video link that isn't https", async () => {
    const admin = await createUser({ role: "admin" });
    const product = await createProduct();
    await request(app)
      .put(`/api/templates/${product.id}/edit`)
      .set(auth(admin.token))
      .send({ videoUrl: "http://example.com/dress.mp4" })
      .expect(400);
  });
});

describe("order status history", () => {
  it("records each change once, with its time", async () => {
    const admin = await createUser({ role: "admin" });
    const { user } = await createUser();
    const order = await createOrder(user._id, { status: "paid" });

    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "shipped" }).expect(200);
    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "shipped" }).expect(200);
    await request(app).patch(`/api/orders/${order.id}/status`).set(auth(admin.token)).send({ status: "delivered" }).expect(200);

    const saved = await Order.findById(order.id).lean();
    expect(saved?.statusHistory?.map((entry) => entry.status)).toEqual(["shipped", "delivered"]);
    expect(saved?.statusHistory?.[0].at).toBeInstanceOf(Date);
  });
});
