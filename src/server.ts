import app from "./app";
import mongoose from "mongoose";

const PORT = process.env.PORT || 5000;
const MONGO_URI = "mongodb+srv://stephenon56:2gv3duVLaGrelwgT@impressa-cluster.3lp6ud5.mongodb.net/";

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => console.error("MongoDB connection error:", err));
