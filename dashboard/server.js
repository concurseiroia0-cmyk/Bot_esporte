/**
 * dashboard/server.js — Servidor local do painel (sem dependências externas)
 *   GET /            → página HTML
 *   GET /api/overview → mesma resposta da Vercel (usa lib/overview compartilhada)
 *
 * Na Vercel a página é servida como estático e /api/overview é serverless —
 * mesmo contrato, então o front funciona nos dois sem alteração.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { overview } = require('../lib/overview');

const PORT = process.env.DASHBOARD_PORT || 3000;
const PAGE = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/overview') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(overview()));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(PAGE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
});

if (require.main === module) {
    server.listen(PORT, () => console.log(`🖥️  Dashboard: http://localhost:${PORT}`));
}

module.exports = { server, PORT };
