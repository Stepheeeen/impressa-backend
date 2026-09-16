import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import CheckIn from "../src/models/CheckIn";
import WalletTransaction from "../src/models/WalletTransaction";
import { lagosDay, previousLagosDay } from "../src/services/time";
import { auth, clearDatabase, createOrder, createUser, setRewardSettings, startDatabase, stopDatabase } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

beforeAll(startDatabase);
afterAll(stopDatabase);
// The games ship switched off, so the tests that exercise them turn them on.
beforeEach(async () => {
  await clearDatabase();
  await setRewardSettings({ checkInEnabled: true, scratchCardsEnabled: true });
});

async function customerWithOrder() {
  const customer = await createUser();
  await createOrder(customer.user._id, { status: "delivered" });
  return customer;
}

const checkIn = (token: string) => request(app).post("/api/rewards/check-in").set(auth(token));
const scratch = (token: string) => request(app).post("/api/rewards/scratch-cards").set(auth(token));

describe("daily check-in", () => {
  it("unlocks after the customer's first order", async () => {
    const { user, token } = await createUser();

    const locked = await checkIn(token).expect(403);
    expect(locked.body.error).toBe("Place your first order to unlock daily rewards.");

    await createOrder(user._id, { status: "paid" });
    await checkIn(token).expect(201);
  });

  it("adds the day's streak reward to the wallet", async () => {
    const { token } = await customerWithOrder();

    const res = await checkIn(token).expect(201);
    expect(res.body).toMatchObject({ streakDay: 1, amount: 20, message: "₦20 added to your wallet." });

    const wallet = await request(app).get("/api/wallet").set(auth(token)).expect(200);
    expect(wallet.body.balance).toBe(20);
    expect(wallet.body.transactions[0].label).toBe("Daily check-in");
  });

  it("continues yesterday's streak and restarts after a missed day", async () => {
    const regular = await customerWithOrder();
    await CheckIn.create({ user: regular.user._id, day: previousLagosDay(), streakDay: 3, amountKobo: 3000 });
    expect((await checkIn(regular.token).expect(201)).body).toMatchObject({ streakDay: 4, amount: 30 });

    const lapsed = await customerWithOrder();
    await CheckIn.create({ user: lapsed.user._id, day: lagosDay(new Date(Date.now() - 2 * DAY)), streakDay: 5, amountKobo: 5000 });
    expect((await checkIn(lapsed.token).expect(201)).body).toMatchObject({ streakDay: 1, amount: 20 });
  });

  it("allows one check-in a day, even when tapped twice at once", async () => {
    const { user, token } = await customerWithOrder();

    const statuses = (await Promise.all([checkIn(token), checkIn(token)])).map((res) => res.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(await CheckIn.countDocuments({ user: user._id })).toBe(1);
    expect(await WalletTransaction.countDocuments({ user: user._id, kind: "credit" })).toBe(1);
  });

  it("records the check-in but pays nothing once the monthly budget is used up", async () => {
    await setRewardSettings({ gamesMonthlyBudgetKobo: 1000 });
    const { token } = await customerWithOrder();

    const res = await checkIn(token).expect(201);
    expect(res.body).toMatchObject({ amount: 0, rewardsPaused: true });
  });

  it("can be switched off by the admin", async () => {
    await setRewardSettings({ checkInEnabled: false });
    const { token } = await customerWithOrder();
    await checkIn(token).expect(403);
  });

  it("is off until an admin switches it on", async () => {
    await clearDatabase();
    const { token } = await customerWithOrder();

    await checkIn(token).expect(403);
    await scratch(token).expect(403);
  });
});

describe("scratch cards", () => {
  it("pays the prize the server picks", async () => {
    await setRewardSettings({ scratchPrizes: [{ amountKobo: 5000, weight: 1 }] });
    const { token } = await customerWithOrder();

    const res = await scratch(token).expect(201);
    expect(res.body).toMatchObject({ amount: 50, remainingToday: 0, message: "You won ₦50! It's in your wallet." });
  });

  it("can land on no prize", async () => {
    await setRewardSettings({ scratchPrizes: [{ amountKobo: 0, weight: 1 }] });
    const { token } = await customerWithOrder();

    const res = await scratch(token).expect(201);
    expect(res.body).toMatchObject({ amount: 0, message: "No prize this time. Try again tomorrow." });
  });

  it("limits cards per day, even when claimed twice at once", async () => {
    const { token } = await customerWithOrder();
    const statuses = (await Promise.all([scratch(token), scratch(token)])).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("shows today's rewards status", async () => {
    const { token } = await customerWithOrder();
    await checkIn(token).expect(201);

    const res = await request(app).get("/api/rewards").set(auth(token)).expect(200);
    expect(res.body).toMatchObject({
      eligible: true,
      checkIn: { checkedInToday: true, streakDay: 1 },
      scratchCards: { remainingToday: 1 },
    });
  });
});
