import "./instrument";
import * as Sentry from "@sentry/node";
import mongoose from "mongoose";
import app from "./app";
import { env } from "./config/env";
import { scheduleWalletJobs } from "./jobs/walletJobs";
import Order from "./models/Order";

// If existing duplicate orders block the unique paymentRef index, keep serving (order creation still
// checks for an existing order) but make the failure loud. `yarn check:payments` lists the duplicates.
Order.on("index", (err) => {
  if (err) {
    console.error("Order indexes failed to build. Run `yarn check:payments`.", err);
    Sentry.captureException(err);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  Sentry.captureException(reason);
});

async function start() {
  await mongoose.connect(env.MONGO_URI);
  console.log("MongoDB connected");

  const server = app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });

  // Expires wallet credit, settles checkout holds, sends expiry reminders and checks the ledger.
  const walletJobs = scheduleWalletJobs();

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(walletJobs);
    server.close(() => {
      mongoose.connection.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
