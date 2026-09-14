import * as Sentry from "@sentry/node";
import { env } from "./config/env";

// Must be imported before anything else in server.ts so Sentry can instrument Express.
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    sendDefaultPii: false,
  });
}
