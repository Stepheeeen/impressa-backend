import { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env";

const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? "");
const clientIpAndEmail = (req: Request) =>
  `${clientIp(req)}:${String(req.body?.email ?? "").trim().toLowerCase()}`;

type LimiterOptions = {
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
};

const limiter = ({ windowMs, limit, message, keyGenerator = clientIp, skipSuccessfulRequests = false }: LimiterOptions) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
    skip: () => env.NODE_ENV === "test",
  });

const MINUTE = 60 * 1000;

// Nigerian mobile networks put many customers behind a single IP address, so account
// endpoints key on IP plus email and the IP-only limits are deliberately generous.
export const apiLimiter = limiter({
  windowMs: MINUTE,
  limit: 300,
  message: "Too many requests. Wait a minute and try again.",
});

export const loginLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: clientIpAndEmail,
  skipSuccessfulRequests: true,
  message: "Too many sign-in attempts. Try again in 15 minutes.",
});

export const registerLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 20,
  message: "Too many accounts created from this network. Try again later.",
});

export const passwordResetLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 5,
  keyGenerator: clientIpAndEmail,
  message: "Too many password reset requests. Try again in an hour.",
});
