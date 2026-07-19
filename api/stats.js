const { getStats } = require("./_chain");

/**
 * GET /api/stats
 *
 * Returns live protocol figures, or `deployed:false` when nothing is deployed
 * yet. Callers MUST branch on that flag — rendering zeros from an unconfigured
 * protocol as if they were measurements is exactly the dishonesty this whole
 * page has been built to avoid.
 */
module.exports = async (req, res) => {
  const stats = await getStats();

  // Short cache: the protocol only changes once every ~15 minutes, but stale
  // data on a money page is worse than an extra origin hit.
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  res.setHeader("Content-Type", "application/json");
  res.status(200).end(JSON.stringify(stats));
};
