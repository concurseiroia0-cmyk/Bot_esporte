/**
 * dashboard/server.js — Site/painel simples (sem dependências externas)
 * Usa apenas http nativo do Node. Serve:
 *   GET /        → página HTML do dashboard
 *   GET /api/... → dados em JSON (jogos, sinais, estatísticas)
 *
 * Ativado com DASHBOARD=true no .env (o index.js sobe junto).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { readJson } = require('../lib/common');

const PORT = process.env.DASHBOARD_PORT || 3000;
const PAGE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    try {
        // API endpoints
        if (url.pathname === '/api/jogos') {
            return json(res, jogosPayload());
        }
        if (url.pathname === '/api/sinais') {
            return json(res, sinaisPayload());
        }
        if (url.pathname === '/api/stats') {
            return json(res, statsPayload());
        }
        if (url.pathname === '/api/overview') {
            return json(res, {
                jogos: jogosPayload(),
                sinais: sinaisPayload(),
                stats: statsPayload(),
                atualizado_em: new Date().toISOString()
            });
        }

        // Página
        if (url.pathname === '/' || url.pathname === '/index.html') {
            const html = fs.readFileSync(PAGE, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
});

// ---------------------------------------------------------------------------
function jogosPayload() {
    const payload = readJson('jogos-hoje.json', null);
    if (!payload || !payload.jogos) return { data_ref: null, jogos: [] };
    return {
        data_ref: payload.data_ref,
        gerado_em: payload.gerado_em,
        jogos: payload.jogos.map(j => ({
            casa: j.casa, fora: j.fora, liga: j.liga, hora: j.hora,
            status: j.status, placar: j.placar,
            odd_casa_pre: j.odd_casa_pre, odd_fora_pre: j.odd_fora_pre,
            odd_over25_pre: j.odd_over25_pre, favorito_pre: j.favorito_pre,
            sinais: (j.sinais_enviados || []).length
        }))
    };
}

function sinaisPayload() {
    const hoje = readJson('sinais-hoje.json', { lista: [] });
    const hist = readJson('historico.json', { dias: [] });

    const deHoje = (hoje.lista || []).map(s => ({ ...s, dia: hoje.data }));
    const deHist = [];
    for (const dia of hist.dias) {
        for (const s of dia.lista || []) deHist.push({ ...s, dia: dia.data });
    }

    const todos = [...deHist, ...deHoje].sort(
        (a, b) => new Date(b.data_envio) - new Date(a.data_envio)
    );

    return { total: todos.length, lista: todos.slice(0, 100) };
}

function statsPayload() {
    const sinais = sinaisPayload().lista;
    const estado = readJson('estrategias-estado.json', { desativadas: [] });

    const porEstrategia = {};
    for (const s of sinais) {
        if (!['GREEN', 'RED'].includes(s.status)) continue;
        porEstrategia[s.estrategia] = porEstrategia[s.estrategia] || { green: 0, red: 0 };
        porEstrategia[s.estrategia][s.status.toLowerCase()]++;
    }

    const lista = Object.entries(porEstrategia).map(([nome, r]) => {
        const total = r.green + r.red;
        return {
            nome,
            green: r.green, red: r.red, total,
            taxa: total ? +(r.green / total * 100).toFixed(1) : 0,
            desativada: (estado.desativadas || []).some(d => d.nome === nome)
        };
    }).sort((a, b) => b.total - a.total);

    const totalG = sinais.filter(s => s.status === 'GREEN').length;
    const totalR = sinais.filter(s => s.status === 'RED').length;

    return {
        geral: {
            total_sinais: sinais.length,
            green: totalG, red: totalR,
            taxa_geral: (totalG + totalR) ? +(totalG / (totalG + totalR) * 100).toFixed(1) : 0,
            pendentes: sinais.filter(s => s.status === 'PENDENTE').length
        },
        por_estrategia: lista,
        desativadas: estado.desativadas || []
    };
}

function json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

if (require.main === module) {
    server.listen(PORT, () => console.log(`🖥️  Dashboard: http://localhost:${PORT}`));
}

module.exports = { server, PORT };
