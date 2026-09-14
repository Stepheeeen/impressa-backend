import MarketplaceSettings from "../models/MarketplaceSettings";

// Returns the marketplace settings, creating them with the default values the first time.
export async function getMarketplaceSettings() {
  const upsert = () =>
    MarketplaceSettings.findOneAndUpdate(
      { key: "marketplace" },
      { $setOnInsert: { key: "marketplace" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

  try {
    return await upsert();
  } catch (err: any) {
    if (err?.code === 11000) return upsert();
    throw err;
  }
}
