/** Vercel Serverless: GET /api/overview — busca dados frescos no GitHub (fallback local) */
const { overview, refreshRemote } = require('../lib/overview');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    await refreshRemote();
    res.status(200).json(overview());
};
