import RewardSettings from "../models/RewardSettings";

// Returns the reward settings, creating them with the default values the first time.
export async function getRewardSettings() {
  const upsert = () =>
    RewardSettings.findOneAndUpdate(
      { key: "rewards" },
      { $setOnInsert: { key: "rewards" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

  try {
    return await upsert();
  } catch (err: any) {
    // Two first requests at once can race to create the document; the loser just reads it.
    if (err?.code === 11000) return upsert();
    throw err;
  }
}
