import * as Sentry from "@sentry/node";
import { createDuePayouts, retryPayouts } from "../services/payouts";
import { closeUnescalatedReturns, escalateOverdueReturns } from "../services/returns";

const RUN_EVERY_MS = 60 * 60 * 1000;

export async function runMarketplaceJobs() {
  await escalateOverdueReturns();
  await closeUnescalatedReturns();
  await createDuePayouts();
  await retryPayouts();
}

// Runs inside the API process every hour. Each step is safe to run twice.
export function scheduleMarketplaceJobs() {
  const tick = () => {
    runMarketplaceJobs().catch((err) => {
      console.error("Marketplace jobs failed:", err);
      Sentry.captureException(err);
    });
  };

  tick();
  return setInterval(tick, RUN_EVERY_MS);
}
