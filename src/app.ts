import * as Sentry from "@sentry/node";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { corsOrigins, env } from "./config/env";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { apiLimiter } from "./middleware/rateLimit";
import templateRoutes from "./routes/templateRoutes";
import authRoutes from "./routes/authRoutes";
import designRoutes from "./routes/designRoutes";
import orderRoutes from "./routes/orderRoutes";
import adminRoutes from "./routes/adminRoutes";
import cartRoutes from "./routes/cartRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import dashboardRoutes from "./routes/dashboardRoutes";
import deviceRoutes from "./routes/deviceRoutes";
import appConfigRoutes from "./routes/appConfigRoutes";
import discoveryRoutes from "./routes/discoveryRoutes";
import rewardsRoutes from "./routes/rewardsRoutes";
import merchantRoutes from "./routes/merchantRoutes";
import marketplaceRoutes from "./routes/marketplaceRoutes";
import groupBuyRoutes from "./routes/groupBuyRoutes";
import sharedCartRoutes from "./routes/sharedCartRoutes";

const app = express();

app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet());
app.use(
	cors({
		// Requests without an Origin (the mobile app, Paystack webhooks) aren't subject to CORS.
		origin: (origin, callback) => {
			const allowed = !origin || env.NODE_ENV !== "production" || corsOrigins.includes(origin);
			callback(null, allowed);
		},
	})
);
app.use(
	express.json({
		limit: "100kb",
		// Paystack webhook signatures are computed over the exact bytes received.
		verify: (req: any, _res, buf) => {
			req.rawBody = buf;
		},
	})
);

app.get("/", (req, res) => res.send("Welcome to Impressa API"));
app.get("/health", (_req, res) => {
	const databaseUp = mongoose.connection.readyState === 1;
	res.status(databaseUp ? 200 : 503).json({ status: databaseUp ? "ok" : "unavailable", database: databaseUp ? "up" : "down" });
});

app.use("/api", apiLimiter);
app.use("/api/templates", templateRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/designs", designRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/pay", paymentRoutes);
app.use("/api/admin/dashboard", dashboardRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/app", appConfigRoutes);
app.use("/api", discoveryRoutes);
app.use("/api", rewardsRoutes);
app.use("/api", merchantRoutes);
app.use("/api", marketplaceRoutes);
app.use("/api", groupBuyRoutes);
app.use("/api", sharedCartRoutes);

app.use(notFound);
Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

export default app;
