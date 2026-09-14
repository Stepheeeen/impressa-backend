import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Merchant, { MerchantStatus } from "../src/models/Merchant";
import Order, { OrderStatus } from "../src/models/Order";
import ProductTemplate from "../src/models/ProductTemplate";
import RewardSettings from "../src/models/RewardSettings";
import User from "../src/models/User";

let mongo: MongoMemoryReplSet | undefined;

// A single-node replica set, because wallet operations use transactions (as on Atlas in production).
export async function startDatabase() {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongo.getUri());
  // Build unique indexes before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function stopDatabase() {
  await mongoose.disconnect();
  await mongo?.stop();
}

export async function clearDatabase() {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
}

const suffix = () => crypto.randomBytes(4).toString("hex");

export async function createUser(overrides: { email?: string; password?: string; role?: "user" | "admin" } = {}) {
  const password = overrides.password ?? "correct-horse-battery";
  const id = suffix();
  const user = await User.create({
    username: `user_${id}`,
    email: overrides.email ?? `user_${id}@example.com`,
    password: await bcrypt.hash(password, 4),
    role: overrides.role ?? "user",
  });
  const token = jwt.sign({ id: user.id, role: user.role, tv: user.tokenVersion }, process.env.JWT_SECRET!, {
    expiresIn: "1h",
  });
  return { user, password, token };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function createProduct(overrides: Record<string, unknown> = {}) {
  return ProductTemplate.create({
    title: "Luxury Dress",
    itemType: "dress",
    category: "fashion & clothings",
    imageUrls: ["https://res.cloudinary.com/demo/image/upload/dress.jpg"],
    price: 9000,
    sizes: ["M", "L", "XL"],
    colors: ["red", "black"],
    ...overrides,
  });
}

export async function createMerchant(
  overrides: { status?: MerchantStatus; deliveryFeeKobo?: number; commissionPercent?: number | null } = {}
) {
  const owner = await createUser();
  const merchant = await Merchant.create({
    user: owner.user._id,
    businessName: `Adire House ${suffix()}`,
    phone: "0803 123 4567",
    email: owner.user.email,
    state: "Ogun",
    address: "12 Itoku Market Road, Abeokuta",
    idDocument: { publicId: "merchant-ids/test-id", format: "jpg" },
    bank: {
      bankCode: "058",
      bankName: "Guaranty Trust Bank",
      accountName: "ADIRE HOUSE LTD",
      accountNumberLast4: "4321",
      recipientCode: "RCP_test123",
    },
    deliveryFeeKobo: overrides.deliveryFeeKobo ?? 200_000,
    status: overrides.status ?? "approved",
    commissionPercent: overrides.commissionPercent ?? null,
  });
  return { owner, merchant };
}

export function setRewardSettings(values: Record<string, unknown>) {
  return RewardSettings.updateOne({ key: "rewards" }, { $set: values }, { upsert: true, setDefaultsOnInsert: true });
}

export function createOrder(
  userId: unknown,
  overrides: { status?: OrderStatus; totalAmount?: number; paymentRef?: string } = {}
) {
  return Order.create({
    user: userId,
    itemType: "Luxury Dress",
    quantity: 1,
    totalAmount: overrides.totalAmount ?? 10500,
    deliveryAddress: { address: "12 Admiralty Way, Lekki", state: "Lagos", country: "Nigeria", phone: "08012345678" },
    paymentRef: overrides.paymentRef ?? `ref_${suffix()}`,
    status: overrides.status ?? "paid",
    email: "buyer@example.com",
  });
}

export function signedWebhook(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(body).digest("hex");
  return { body, signature };
}
