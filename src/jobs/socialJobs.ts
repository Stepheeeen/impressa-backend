import * as Sentry from "@sentry/node";
import { closeExpiredGroupBuys } from "../services/groupBuys";

const RUN_EVERY_MS = 5 * 60 * 1000;

export async function runSocialJobs() {
  await closeExpiredGroupBuys();
}

// Closes group buys within a few minutes of their deadline. Runs inside the API process; safe to run twice.
export function scheduleSocialJobs() {
  const tick = () => {
    runSocialJobs().catch((err) => {
      console.error("Social buying jobs failed:", err);
      Sentry.captureException(err);
    });
  };

  tick();
  return setInterval(tick, RUN_EVERY_MS);
}
