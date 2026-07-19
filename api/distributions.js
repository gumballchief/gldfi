const { getDistributions } = require("./_chain");

/** GET /api/distributions?limit=10 — recent distribution events, newest first. */
module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10), 1), 50);

  const data = await getDistributions(limit);

  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  res.setHeader("Content-Type", "application/json");
  res.status(200).end(JSON.stringify(data));
};
