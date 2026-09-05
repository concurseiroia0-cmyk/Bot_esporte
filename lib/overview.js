/**
 * lib/overview.js — Monta o payload do dashboard a partir dos JSONs em data/.
 * Usado tanto pelo dashboard/server.js (local) quanto pela Vercel (/api/overview.js).
 * Na Vercel, os arquivos de data/ vêm do repositório (atualizados pelos robôs
 * no GitHub Actions e pushados de volta).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    } catch (e) {
        return fallback;
    }
}

function jogosPayload() {
    const payload = readJson('jogos-hoje.json', null);
    // Suporta dois formatos: { data_ref, jogos: [...] } ou array puro
    const jogos = Array.isArray(payload) ? payload : (payload && payload.jogos) || [];
    return {
        data_ref: (payload && payload.data_ref) || null,
        gerado_em: (payload && payload.gerado_em) || null,
        jogos: jogos.map(j => ({
            casa: j.casa, fora: j.fora, liga: j.liga, hora: j.hora,
            status: j.status || 'NS', placar: j.placar || '0-0',
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
    for (const dia of hist.dias || []) {
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
            desativada: ((estado && estado.desativadas) || []).some(d => d.nome === nome)
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
        desativadas: (estado && estado.desativadas) || []
    };
}

function overview() {
    return {
        jogos: jogosPayload(),
        sinais: sinaisPayload(),
        stats: statsPayload(),
        atualizado_em: new Date().toISOString()
    };
}

module.exports = { overview, jogosPayload, sinaisPayload, statsPayload, readJson };
