import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

// Unset NODE_ENV counts as production, so a misconfigured host fails safe instead of running with dev defaults.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGO_URI: z.string().min(1, "MONGO_URI is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  PAYSTACK_SECRET_KEY: z.string().min(1, "PAYSTACK_SECRET_KEY is required"),
  // Comma-separated browser origins allowed to call the API, e.g. https://impressa.ng,https://admin.impressa.ng
  CORS_ORIGINS: z.string().default(""),
  // Base URL of the website, used for links in emails.
  APP_URL: z.url().default("http://localhost:3000"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Impressa <no-reply@localhost>"),
  SENTRY_DSN: z.string().optional(),
  // Number of proxies in front of the app (Render's load balancer), so rate limits see the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

const REQUIRED_IN_PRODUCTION = ["CORS_ORIGINS", "APP_URL", "RESEND_API_KEY", "EMAIL_FROM"] as const;

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }

  if (parsed.data.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`Missing required production environment variables: ${missing.join(", ")}`);
      process.exit(1);
    }
    if (parsed.data.JWT_SECRET.length < 32) {
      console.warn("JWT_SECRET is shorter than 32 characters. Rotate it to a longer random value.");
    }
  }

  return parsed.data;
}

export const env = loadEnv();

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
