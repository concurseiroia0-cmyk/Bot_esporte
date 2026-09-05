/** Vercel Serverless: GET /api/overview — lê data/*.json do repo */
const { overview } = require('../lib/overview');

module.exports = (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(overview());
};
