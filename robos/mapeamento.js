/**
 * robos/mapeamento.js — ROBÔ 1
 * Roda às 08h BRT. Escolhe os 25 melhores jogos do dia e salva em data/jogos-hoje.json
 * Estratégia de economia de requisições:
 *  1. Busca fixtures do dia (1 req)
 *  2. Para cada liga permitida, busca odds em LOTE por liga (1 req por liga)
 *  3. Seleciona os 25 melhores por odd Over 2.5
 * Se o dia não tiver odds (comum na free), faz fallback por ranking de liga.
 */

const fs = require('fs');
const path = require('path');
const { apiGet, readJson, writeJson, alerta, resetKeys } = require('../lib/common');
const { buscarOddsTheOdds } = require('../lib/odds');

const DATA_FILE = path.join(__dirname, '..', 'data', 'jogos-hoje.json');

// IDs de ligas na API-Football
const LEAGUES = {
    71: 'Brasileirão Série A',
    72: 'Brasileirão Série B',
    39: 'Premier League',
    140: 'La Liga',
    135: 'Serie A',
    78: 'Bundesliga',
    61: 'Ligue 1',
    88: 'Eredivisie',
    94: 'Primeira Liga',
    2: 'Champions League',
    3: 'Europa League',
    13: 'Libertadores',
    11: 'Sul-Americana',
    15: 'Copa do Brasil',
    73: 'Brasileirão Série C',
    45: 'FA Cup'
};

// Ligas conhecidas por muitos cartões (Estratégia 2 e 5)
const LIGAS_CARTAO = [71, 72, 13, 11, 15, 140, 135, 73];

async function mapeamento() {
    console.log('\n🗺️  ===== ROBÔ 1: MAPEAMENTO =====');
    const hoje = hojeBRT();
    console.log(`📅 Data (BRT): ${hoje}`);

    // Reset diário do estado das chaves
    resetKeys();

    try {
        // 1 req — fixtures do dia
        const data = await apiGet('fixtures', { date: hoje });
        const fixtures = (data.response || []).filter(f =>
            f.fixture.status.short === 'NS' &&
            LEAGUES[f.league.id]
        );

        console.log(`📋 ${fixtures.length} jogos nas ligas monitoradas ainda não iniciados.`);

        if (fixtures.length === 0) {
            writeJson('jogos-hoje.json', []);
            await alerta('🗺️ Mapeamento: nenhum jogo encontrado nas ligas monitoradas hoje.');
            return [];
        }

        // 2 — odds em lote por liga (1 req por liga que tiver jogo hoje)
        const ligasHoje = [...new Set(fixtures.map(f => f.league.id))];
        const oddsPorFixture = {};
        let reqsOdds = 0;

        for (const ligaId of ligasHoje) {
            try {
                const oddsData = await apiGet('odds', { date: hoje, league: ligaId, season: await seasonOf(ligaId, hoje) });
                reqsOdds++;
                for (const item of oddsData.response || []) {
                    const parsed = parseOdds(item);
                    if (parsed) oddsPorFixture[item.fixture.id] = parsed;
                }
            } catch (e) {
                console.error(`   Odds liga ${ligaId}: ${e.message}`);
            }
        }
        console.log(`💰 Odds api-football: ${Object.keys(oddsPorFixture).length} jogos (${reqsOdds} req).`);

        // 2b — complementa com a the-odds-api (grátis, destrava E1/E6)
        try {
            const oddsTheOdds = await buscarOddsTheOdds(fixtures);
            let novos = 0;
            for (const fx of fixtures) {
                if (!oddsPorFixture[fx.fixture.id] && oddsTheOdds[fx.fixture.id]) {
                    oddsPorFixture[fx.fixture.id] = oddsTheOdds[fx.fixture.id];
                    novos++;
                }
            }
            if (novos) console.log(`💰 +${novos} jogos com odds via the-odds-api.`);
        } catch (e) {
            console.error('   Erro the-odds-api:', e.message);
        }

        // 3 — montar lista de jogos
        const jogosFiltrados = [];
        for (const fx of fixtures) {
            const f = fx.fixture;
            const odds = oddsPorFixture[f.id] || null;

            let favorito = 'empate';
            let qualif = true;

            if (odds) {
                // Critérios principais:
                // - Over 2.5 entre 1.60 e 2.20 (jogo aberto)
                // - Favorito não muito baixo (odd home/away > 1.30) — jogo sem graça
                const menor = Math.min(odds.home, odds.away);
                qualif = odds.over25 >= 1.60 && odds.over25 <= 2.20 && menor > 1.30;

                if (odds.home < odds.away) favorito = 'casa';
                else if (odds.away < odds.home) favorito = 'fora';
            } else {
                // Sem odds pré-jogo na API free: mantém o jogo mas sem filtro de odd
                qualif = true;
            }

            jogosFiltrados.push({
                api_id: f.id,
                date: f.date,
                hora: horaBRT(f.date),
                liga_id: fx.league.id,
                liga: LEAGUES[fx.league.id] || fx.league.name,
                liga_cartoes: LIGAS_CARTAO.includes(fx.league.id),
                pais: fx.league.country,
                casa: fx.teams.home.name,
                casa_id: fx.teams.home.id,
                fora: fx.teams.away.name,
                fora_id: fx.teams.away.id,
                odd_casa_pre: odds ? odds.home : null,
                odd_empate_pre: odds ? odds.draw : null,
                odd_fora_pre: odds ? odds.away : null,
                odd_over25_pre: odds ? odds.over25 : null,
                favorito_pre: favorito,
                tem_odds: !!odds,
                qualificado: qualif
            });
        }

        // 4 — ordenar e pegar 25
        // Prioridade: qualificados com odds → ordena por over2.5 desc (jogos mais abertos)
        // Depois os sem odds (ordenados por liga importante)
        const comOdds = jogosFiltrados.filter(j => j.tem_odds && j.qualificado)
            .sort((a, b) => b.odd_over25_pre - a.odd_over25_pre);
        const semOdds = jogosFiltrados.filter(j => !j.tem_odds);
        const desqualificados = jogosFiltrados.filter(j => j.tem_odds && !j.qualificado);

        let selecionados = [...comOdds, ...semOdds].slice(0, 25);

        // Se ainda sobram vagas (ex: dia fraco), completa com desqualificados
        if (selecionados.length < 25) {
            selecionados = [...selecionados, ...desqualificados].slice(0, 25);
        }

        // Metadados do dia
        const payload = {
            gerado_em: new Date().toISOString(),
            data_ref: hoje,
            total: selecionados.length,
            jogos: selecionados.map(j => ({
                ...j,
                // Runtime do scanner
                status: 'NS',
                placar: '0-0',
                sinais_enviados: []     // [{ estrategia, timestamp }]
            }))
        };

        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));

        console.log(`✅ MAPEAMENTO concluído: ${selecionados.length} jogos selecionados.`);
        const porLiga = {};
        selecionados.forEach(j => { porLiga[j.liga] = (porLiga[j.liga] || 0) + 1; });
        Object.entries(porLiga).forEach(([l, c]) => console.log(`   • ${l}: ${c}`));

        await alerta(
            `🗺️ <b>Mapeamento concluído</b>\n` +
            `📅 ${hoje}\n` +
            `⚽ ${selecionados.length} jogos selecionados\n` +
            `💰 ${Object.keys(oddsPorFixture).length} com odds pré-jogo`
        );

        return selecionados;

    } catch (error) {
        console.error('❌ Erro no MAPEAMENTO:', error.message);
        if (error.allKeysExhausted) {
            await alerta('💳 <b>Mapeamento abortado:</b> todas as chaves da API esgotadas.');
        }
        throw error;
    }
}

/** Temporada correta para ligas europeias (ago-mai) vs americanas (jan-dez) */
async function seasonOf(ligaId, dataISO) {
    const dt = new Date(dataISO + 'T12:00:00Z');
    const mes = dt.getUTCMonth() + 1; // 1-12
    const ano = dt.getUTCFullYear();
    // Ligas europeias/copa EU: temporada = ano se mes >= 7, senão ano-1
    const europeias = [39, 140, 135, 78, 61, 88, 94, 2, 3, 45];
    if (europeias.includes(ligaId)) {
        return mes >= 7 ? ano : ano - 1;
    }
    return ano;
}

/** Extrai odds Match Winner + Over 2.5 do payload do endpoint /odds */
function parseOdds(oddsItem) {
    try {
        const bookmaker = oddsItem.bookmakers && oddsItem.bookmakers[0];
        if (!bookmaker) return null;

        const mw = bookmaker.bets.find(b => b.id === 1 || b.name === 'Match Winner');
        const tg = bookmaker.bets.find(b => b.id === 5 || b.name === 'Goals Over/Under' || b.name === 'Total Goals');
        if (!mw || !tg) return null;

        const home = mw.values.find(v => v.value === 'Home');
        const draw = mw.values.find(v => v.value === 'Draw');
        const away = mw.values.find(v => v.value === 'Away');
        const over25 = tg.values.find(v => v.value === 'Over 2.5');
        if (!home || !draw || !away || !over25) return null;

        return {
            home: parseFloat(home.odd),
            draw: parseFloat(draw.odd),
            away: parseFloat(away.odd),
            over25: parseFloat(over25.odd)
        };
    } catch (e) {
        return null;
    }
}

/** Data de hoje no fuso BRT (America/Sao_Paulo) em YYYY-MM-DD */
function hojeBRT() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return fmt.format(new Date());
}

/** Extrai HH:MM no fuso BRT a partir do ISO date do fixture */
function horaBRT(isoDate) {
    try {
        return new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit', minute: '2-digit'
        }).format(new Date(isoDate));
    } catch (e) {
        return null;
    }
}

module.exports = { mapeamento, hojeBRT };
