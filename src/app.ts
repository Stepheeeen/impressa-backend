import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import templateRoutes from "./routes/templateRoutes";
import authRoutes from "./routes/authRoutes";
import designRoutes from "./routes/designRoutes";
import orderRoutes from "./routes/orderRoutes";
import adminRoutes from "./routes/adminRoutes";

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

export default app;
