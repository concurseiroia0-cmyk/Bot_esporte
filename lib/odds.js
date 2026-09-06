/**
 * lib/odds.js — Odds pré-jogo via the-odds-api (plano free: 500 req/mês por chave)
 *
 * Usado pelo ROBÔ 1 (mapeamento) para destravar:
 *  - ESTRATÉGIA 1 (TRADE BACK FAVORITO 0-0): exige odd pré do favorito < 1.70
 *  - ESTRATÉGIA 6 (ESCANTEIO PRESSÃO 2T): exige odd pré do favorito < 1.80
 *  - Ranking do mapeamento (Over 2.5 entre 1.60 e 2.20)
 *
 * Economia: 1 requisição por liga por dia (as odds vêm de TODOS os jogos da liga
 * em uma única chamada). 12 ligas monitoradas → ~12 req/dia por chave.
 * Se as duas chaves estiverem com pouca cota, pula sem quebrar o mapeamento.
 */

const axios = require('axios');

const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// Liga api-football (id) → esporte na the-odds-api
const SPORTS_MAP = {
    71: 'soccer_brazil_campeonato',
    72: 'soccer_brazil_serie_b',
    39: 'soccer_epl',
    140: 'soccer_spain_la_liga',
    135: 'soccer_italy_serie_a',
    78: 'soccer_germany_bundesliga',
    61: 'soccer_france_ligue_one',
    88: 'soccer_netherlands_eredivisie',
    94: 'soccer_portugal_primeira_liga',
    2: 'soccer_uefa_champs_league',
    3: 'soccer_uefa_europa_league',
    13: 'soccer_conmebol_copa_libertadores',
    11: 'soccer_conmebol_copa_sudamericana'
};

// Chaves em ordem de rotação (vindas do .env)
function chaves() {
    return [process.env.ODDS_API_KEY, process.env.ODDS_API_KEY_2].filter(Boolean);
}

function normalizar(nome) {
    return String(nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
}

function chaveJogo(g) {
    return `${normalizar(g.home_team)}|${normalizar(g.away_team)}|${(g.commence_time || '').slice(0, 10)}`;
}

function media(precos) {
    if (!precos.length) return null;
    return +(precos.reduce((a, b) => a + b, 0) / precos.length).toFixed(2);
}

/** Converte a resposta de uma liga em { chaveJogo: {home, draw, away, over25, over15} } */
function parseOddsLiga(response) {
    const mapa = {};
    for (const g of response || []) {
        const k = chaveJogo(g);
        const h2h = [], totals = {};
        for (const bm of g.bookmakers || []) {
            for (const m of bm.markets || []) {
                if (m.key === 'h2h') {
                    const o = {};
                    for (const x of m.outcomes) {
                        const nm = x.name;
                        const preco = parseFloat(x.price);
                        if (nm === 'Home') o.home = preco;
                        else if (nm === 'Away') o.away = preco;
                        else if (nm === 'Draw') o.draw = preco;
                        else if (normalizar(nm) === normalizar(g.home_team)) o.home = preco;
                        else if (normalizar(nm) === normalizar(g.away_team)) o.away = preco;
                    }
                    if (o.home && o.draw && o.away) h2h.push(o);
                } else if (m.key === 'totals') {
                    for (const x of m.outcomes) {
                        const linha = parseFloat(x.point);
                        if (!totals[linha]) totals[linha] = [];
                        totals[linha].push(parseFloat(x.price));
                    }
                }
            }
        }
        if (!h2h.length) continue;
        const home = media(h2h.map(o => o.home));
        const draw = media(h2h.map(o => o.draw));
        const away = media(h2h.map(o => o.away));
        const over25 = totals[2.5] ? media(totals[2.5]) : null;
        const over15 = totals[1.5] ? media(totals[1.5]) : null;
        if (home && draw && away) {
            mapa[k] = { home, draw, away, over25, over15 };
        }
    }
    return mapa;
}

/** Busca odds das ligas dos fixtures (1 req por liga/dia). Retorna { apiId: odds } */
async function buscarOddsTheOdds(fixtures) {
    const resultado = {};
    if (!fixtures || !fixtures.length) return resultado;

    const ligas = [...new Set(fixtures.map(f => f.league && f.league.id).filter(id => SPORTS_MAP[id]))];
    if (!ligas.length) return resultado;

    const keys = chaves();
    if (!keys.length) return resultado;

    let idx = 0;
    for (const ligaId of ligas) {
        const sport = SPORTS_MAP[ligaId];
        const key = keys[idx % keys.length];

        try {
            const { data, headers } = await axios.get(`${ODDS_BASE}/sports/${sport}/odds/`, {
                params: {
                    apiKey: key,
                    regions: 'eu,uk',
                    markets: 'h2h,totals',
                    oddsFormat: 'decimal',
                    dateFormat: 'iso'
                },
                timeout: 20000
            });
            const restante = parseInt(headers['x-requests-remaining'] || '0', 10);
            console.log(`   🎲 Odds ${sport}: ${(data || []).length} jogos (cota restante: ${restante})`);

            const mapa = parseOddsLiga(data);
            for (const fx of fixtures) {
                if ((fx.league || {}).id !== ligaId) continue;
                const k = chaveJogo({ home_team: fx.teams.home.name, away_team: fx.teams.away.name, commence_time: fx.fixture.date });
                if (mapa[k]) resultado[fx.fixture.id] = mapa[k];
            }

            // Se a chave está acabando (<= 30 restantes), alterna para a próxima
            if (restante <= 30 && keys.length > 1) idx = (idx + 1) % keys.length;
        } catch (e) {
            const status = e.response ? e.response.status : 'net';
            console.error(`   🎲 Erro odds ${sport} (${status}): ${e.response ? e.response.data.message || e.message : e.message}`);
            // Quota esgotada: alterna a chave e tenta a próxima liga com ela
            if (status === 401 || status === 429) idx = (idx + 1) % keys.length;
        }
    }

    return resultado;
}

module.exports = { buscarOddsTheOdds, SPORTS_MAP };