import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import templateRoutes from "./routes/templateRoutes";
import authRoutes from "./routes/authRoutes";
import designRoutes from "./routes/designRoutes";
import orderRoutes from "./routes/orderRoutes";
import adminRoutes from "./routes/adminRoutes";
import cartRoutes from "./routes/cartRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import dashboardRoutes from "./routes/dashboardRoutes";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Welcome to Impressa API"));

app.use("/api/templates", templateRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/designs", designRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/pay", paymentRoutes);
app.use("/api/admin/dashboard", dashboardRoutes);

export default app;
