// Lists payment references that already have more than one order. Run before deploying the unique paymentRef index.
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri);
  const duplicates = await mongoose.connection
    .collection("orders")
    .aggregate<{ _id: string; count: number; orderIds: unknown[] }>([
      { $group: { _id: "$paymentRef", count: { $sum: 1 }, orderIds: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (duplicates.length === 0) {
    console.log("No duplicate payment references. Safe to deploy the unique index.");
  } else {
    console.error(`${duplicates.length} payment reference(s) have more than one order:`);
    for (const duplicate of duplicates) {
      console.error(`  ${duplicate._id}: orders ${duplicate.orderIds.join(", ")}`);
    }
    process.exitCode = 1;
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
