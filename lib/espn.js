/**
 * lib/espn.js — Fonte RESERVA de jogos ao vivo + estatísticas (sem chave, sem cota)
 *
 * Usado pelo scanner quando a cota da api-football esgotar. A ESPN cobre:
 *   posse, finalizações, chutes no gol, escanteios, faltas, cartões ✅
 *   ataques perigosos ❌ → estimado (documentado abaixo)
 *
 * Endpoints:
 *   scoreboard: https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard
 *   summary:    https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/summary?event={id}
 *
 * Aviso: API não documentada oficialmente (usada pelo site da ESPN). Se mudar,
 * este módulo é o único ponto a ajustar — o scanner não sabe da fonte.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// Liga api-football (id) → slug ESPN
const SLUGS = {
    71: 'bra.1',
    72: 'bra.2',
    39: 'eng.1',
    140: 'esp.1',
    135: 'ita.1',
    78: 'ger.1',
    61: 'fra.1',
    88: 'ned.1',
    94: 'por.1',
    2: 'uefa.champions',
    3: 'uefa.europa',
    13: 'conmebol.libertadores',
    11: 'conmebol.sudamericana'
};

let slugInvalidos = {}; // slug -> true (404 confirmado; evita repetir)

function normalizar(nome) {
    return String(nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[m][n];
}

function tokens(nome) {
    return normalizar(nome)
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 4); // descarta 'pr', 'sc', 'sp' etc.
}

/** true se dois nomes de time se referem ao mesmo clube */
function nomesIguais(a, b) {
    const na = normalizar(a), nb = normalizar(b);
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = tokens(a), tb = tokens(b);
    for (const x of ta) {
        for (const y of tb) {
            if (x === y || levenshtein(x, y) <= 2) return true;
        }
    }
    return false;
}

function extrairMinuto(status) {
    const t = status && status.type;
    if (!t) return null;
    const detail = t.shortDetail || t.detail || '';
    const dig = (detail.match(/\d+/g) || []).map(Number);
    if (t.state === 'in' && dig.length) return dig[0];
    if (t.state === 'in' && /halftime|interval/i.test(detail)) return 45;
    return null;
}

/**
 * Busca jogos AO VIVO na ESPN em todas as ligas monitoradas.
 * Retorna [ { casa, fora, minuto, placarCasa, placarFora, eventoId, ligaId } ]
 */
async function buscarJogosAoVivoESPN() {
    const ligas = Object.entries(SLUGS).filter(([, slug]) => !slugInvalidos[slug]);
    const resultados = await Promise.all(ligas.map(async ([ligaId, slug]) => {
        try {
            const { data } = await axios.get(`${ESPN_BASE}/${slug}/scoreboard`, { timeout: 15000 });
            const vivos = [];
            for (const ev of data.events || []) {
                const c = ev.competitions && ev.competitions[0];
                if (!c) continue;
                const state = c.status && c.status.type && c.status.type.state;
                if (state !== 'in') continue; // só ao vivo
                const minuto = extrairMinuto(c.status);
                if (minuto === null) continue;
                const [h, a] = c.competitors || [];
                if (!h || !a) continue;
                vivos.push({
                    casa: h.team.displayName,
                    fora: a.team.displayName,
                    minuto,
                    placarCasa: parseInt(h.score, 10) || 0,
                    placarFora: parseInt(a.score, 10) || 0,
                    eventoId: ev.id,
                    ligaId: parseInt(ligaId, 10)
                });
            }
            return vivos;
        } catch (e) {
            if (e.response && e.response.status === 404) {
                slugInvalidos[slug] = true;
                console.error(`   📡 ESPN ${slug}: não existe (404), desativado.`);
            } else {
                console.error(`   📡 ESPN ${slug}: ${e.message}`);
            }
            return [];
        }
    }));
    return resultados.flat();
}

/** Encontra o jogo ESPN que corresponde a um jogo mapeado (aceita casa/fora trocados) */
function casarJogoESPN(jogo, vivos) {
    for (const v of vivos) {
        if (String(v.ligaId) !== String(jogo.liga_id)) continue;
        if (nomesIguais(v.casa, jogo.casa) && nomesIguais(v.fora, jogo.fora)) {
            return { ...v, invertido: false };
        }
        if (nomesIguais(v.fora, jogo.casa) && nomesIguais(v.casa, jogo.fora)) {
            return { ...v, invertido: true };
        }
    }
    return null;
}

/**
 * Estatísticas ao vivo de um evento ESPN, no MESMO formato do extractStats()
 * da api-football: { casa, fora, total }.
 * Ataques perigosos: a ESPN não fornece → estimativa documentada:
 *   ataques_perigosos ≈ 2.5 × finalizações + 2 × escanteios
 */
async function buscarStatsESPN(eventoId, slug) {
    const url = `${ESPN_BASE}/${slug}/summary?event=${eventoId}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const box = data.boxscore;
    if (!box || !box.teams || box.teams.length < 2) return null;

    const map = (t) => {
        const s = {};
        for (const st of t.statistics || []) s[st.name] = parseFloat(st.displayValue) || 0;
        const finalizacoes = s.totalShots || 0;
        const escanteios = s.wonCorners || 0;
        return {
            chutes_total: finalizacoes,
            chutes_gol: s.shotsOnTarget || 0,
            chutes_fora: Math.max(0, finalizacoes - (s.shotsOnTarget || 0)),
            posse: s.possessionPct || 0,
            escanteios,
            faltas: s.foulsCommitted || 0,
            cartoes_amarelos: s.yellowCards || 0,
            cartoes_vermelhos: s.redCards || 0,
            cartoes: (s.yellowCards || 0) + (s.redCards || 0),
            finalizacoes,
            ataques_perigosos: Math.round(finalizacoes * 2.5 + escanteios * 2),
            ataques: 0,
            defesas: s.saves || 0
        };
    };

    const casa = map(box.teams[0]);
    const fora = map(box.teams[1]);

    if (casa.posse + fora.posse === 100) { /* ok */ }
    else if (casa.posse > 0 && fora.posse === 0) fora.posse = 100 - casa.posse;
    else if (fora.posse > 0 && casa.posse === 0) casa.posse = 100 - fora.posse;

    return {
        casa, fora,
        total: {
            chutes_gol: casa.chutes_gol + fora.chutes_gol,
            finalizacoes: casa.finalizacoes + fora.finalizacoes,
            escanteios: casa.escanteios + fora.escanteios,
            faltas: casa.faltas + fora.faltas,
            cartoes: casa.cartoes + fora.cartoes,
            ataques_perigosos: casa.ataques_perigosos + fora.ataques_perigosos
        }
    };
}

module.exports = { buscarJogosAoVivoESPN, casarJogoESPN, buscarStatsESPN, SLUGS };