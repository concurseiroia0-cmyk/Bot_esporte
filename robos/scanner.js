/**
 * robos/scanner.js — ROBÔ 2 (núcleo do sistema)
 * Roda a cada 2 minutos (10h–23h BRT). Analisa jogos ao vivo do mapeamento
 * e dispara sinais no Telegram quando alguma das 8 estratégias bate.
 *
 * Economia de requisições (plano free ~10/min):
 *  - 1 req: fixtures?live=all  → pega TODOS os jogos ao vivo de uma vez
 *  - Só chama /fixtures/statistics para jogos que estão na janela de alguma estratégia
 *  - Cooldowns e sinais do dia persistidos em JSON (data/sinais-hoje.json)
 *
 * Regras implementadas:
 *  - Cooldown 20 min por estratégia/jogo
 *  - Gap mínimo de 10 min entre sinais do MESMO jogo (estratégias diferentes)
 *  - Red card antes de 70' cancela estratégias de pressão (posse/finalizações)
 *  - Rotação das 2 chaves da API; se todas esgotarem → scanner para e avisa Telegram
 *  - Estratégias desativadas (auto ou manual) são respeitadas
 */

const path = require('path');
const {
    apiGet, readJson, writeJson, sendTelegram, alerta,
    parseMinuto, extractStats, sleep
} = require('../lib/common');
const { buscarJogosAoVivoESPN, casarJogoESPN, buscarStatsESPN, SLUGS: SLUGS_ESPN } = require('../lib/espn');

const JOGOS_FILE = 'jogos-hoje.json';
const SINAIS_FILE = 'sinais-hoje.json';
const ESTRATEGIAS_FILE = 'estrategias-estado.json';

const COOLDOWN_ESTRATEGIA_MIN = 20;   // mesma estratégia no mesmo jogo
const GAP_JOGO_MIN = 10;              // qualquer sinal no mesmo jogo

// ---------------------------------------------------------------------------
// DEFINIÇÃO DAS 8 ESTRATÉGIAS
// ---------------------------------------------------------------------------
/**
 * ctx = {
 *   minuto, periodo, placarCasa, placarFora,
 *   jogo (dados do mapeamento), stats { casa, fora, total },
 *   oddsLive { home, draw, away } | null,
 *   favorito: 'casa'|'fora', fav (stats do favorito), under (stats do azarão),
 *   perder: stats do time que está perdendo | null
 * }
 * Cada condição retorna true/false. Cada estratégia define:
 *  - nome, inicio, fim, janelas (placares válidos), usaPressao (afetada por red card)
 *  - acao(ctx) → texto do que fazer
 *  - condicao(ctx) → boolean
 */

const ESTRATEGIAS = [
    {
        id: 1,
        nome: 'TRADE BACK FAVORITO 0-0',
        inicio: 25, fim: 40,
        usaPressao: true,
        condicao: (c) => {
            if (c.placarCasa !== 0 || c.placarFora !== 0) return false;
            // odd pré-jogo do favorito < 1.70 e odd ao vivo do favorito >= 2.00
            const oddPre = c.favorito === 'casa' ? c.jogo.odd_casa_pre : c.jogo.odd_fora_pre;
            const oddLive = c.favorito === 'casa' ? (c.oddsLive && c.oddsLive.home) : (c.oddsLive && c.oddsLive.away);
            if (oddPre === null || oddPre === undefined || oddPre >= 1.70) return false;
            // Odd ao vivo: se disponível, exige >= 2.00. Sem odd ao vivo (API free),
            // segue com a odd pré como referência (o favorito dominando 0-0 já indica o trade).
            if (oddLive && oddLive < 2.00) return false;
            if (c.fav.posse <= 60) return false;
            if (c.fav.chutes_gol < 4) return false;
            if (c.fav.ataques_perigosos < 25) return false;
            return true;
        },
        acao: (c) => {
            const lado = c.favorito === 'casa' ? 'CASA' : 'FORA';
            const oddLive = c.favorito === 'casa'
                ? (c.oddsLive && c.oddsLive.home) : (c.oddsLive && c.oddsLive.away);
            const oddPre = c.favorito === 'casa' ? c.jogo.odd_casa_pre : c.jogo.odd_fora_pre;
            const ref = oddLive ? oddLive.toFixed(2) : (oddPre ? '~' + oddPre.toFixed(2) : '??');
            return `BACK FAVORITO (${lado}) - ODD ATUAL: ${ref}`;
        }
    },
    {
        id: 2,
        nome: 'CARTÃO FINAL 1T',
        inicio: 35, fim: 47,          // 45+2 ~ 47
        usaPressao: false,
        condicao: (c) => {
            if (c.stats.total.faltas <= 12) return false;
            if (c.stats.total.cartoes < 1) return false;
            const dif = Math.abs(c.placarCasa - c.placarFora);
            if (dif > 1) return false;
            if (!c.jogo.liga_cartoes) return false;
            // Mín 3 faltas nos últimos 8 minutos: aproximação com ritmo do jogo
            const ritmoFaltas = c.stats.total.faltas / Math.max(c.minuto, 1);
            if (ritmoFaltas * 8 < 3) return false;
            return true;
        },
        acao: () => `OVER 0.5 CARTÃO ATÉ INTERVALO - ODD: ~1.75`
    },
    {
        id: 3,
        nome: 'CASA MARCA GOL 2T',
        inicio: 55, fim: 78,
        usaPressao: true,
        condicao: (c) => {
            // Casa perdendo por 1 OU empatando (0-0 ou 0-1)
            const emp = c.placarCasa === c.placarFora;
            const perdeu1 = c.placarFora - c.placarCasa === 1;
            if (!(emp || perdeu1)) return false;
            // 2º tempo: casa com pressão. Sem splits por tempo na API: usa total + minutos
            if (c.stats.casa.finalizacoes < 5) return false;
            if (c.stats.casa.chutes_gol < 2) return false;
            if (c.stats.casa.ataques_perigosos < 10) return false;
            return true;
        },
        acao: () => `CASA MARCA GOL - ODD: ~1.65`
    },
    {
        id: 4,
        nome: 'OVER 0.5 HT',
        inicio: 30, fim: 40,
        usaPressao: true,
        condicao: (c) => {
            if (c.placarCasa !== 0 || c.placarFora !== 0) return false;
            if (c.stats.total.chutes_gol < 5) return false;
            if (c.stats.total.ataques_perigosos <= 40) return false;
            if (c.stats.total.escanteios <= 3) return false;
            if (c.stats.casa.cartoes_vermelhos > 0 || c.stats.fora.cartoes_vermelhos > 0) return false;
            return true;
        },
        acao: () => `OVER 0.5 GOLS NO 1º TEMPO - ODD: ~1.52`
    },
    {
        id: 5,
        nome: 'CARTÃO FINAL 2T',
        inicio: 80, fim: 88,
        usaPressao: false,
        condicao: (c) => {
            if (c.stats.total.cartoes < 3) return false;
            if (c.stats.total.faltas <= 20) return false;
            const dif = Math.abs(c.placarCasa - c.placarFora);
            if (dif > 1) return false;
            const ritmoFaltas = c.stats.total.faltas / Math.max(c.minuto, 1);
            if (ritmoFaltas * 10 < 3) return false;
            // Nenhum time com 2+ cartões
            if (c.stats.casa.cartoes >= 3 || c.stats.fora.cartoes >= 3) return false;
            return true;
        },
        acao: () => `OVER 0.5 CARTÃO ATÉ O FIM - ODD: ~1.68`
    },
    {
        id: 6,
        nome: 'ESCANTEIO PRESSÃO 2T',
        inicio: 75, fim: 85,
        usaPressao: true,
        condicao: (c) => {
            // favorito pré-jogo (odd < 1.80) perdendo OU empatando
            const oddFav = c.favorito === 'casa' ? c.jogo.odd_casa_pre : c.jogo.odd_fora_pre;
            if (oddFav === null || oddFav === undefined || oddFav >= 1.80) return false;
            const placarFav = c.favorito === 'casa' ? c.placarCasa : c.placarFora;
            const placarOutro = c.favorito === 'casa' ? c.placarFora : c.placarCasa;
            if (!(placarFav <= placarOutro)) return false; // perdendo ou empatando
            if (c.stats.total.escanteios < 6) return false;
            if (c.fav.posse <= 65) return false;
            return true;
        },
        acao: () => `OVER 8.5 ESCANTEIOS NO JOGO - ODD: ~1.85`
    },
    {
        id: 7,
        nome: 'GOL FINAL / OVER 1.5',
        inicio: 70, fim: 85,
        usaPressao: true,
        condicao: (c) => {
            const placar = `${c.placarCasa}-${c.placarFora}`;
            if (!['0-0', '1-0', '0-1', '1-1'].includes(placar)) return false;
            if (c.stats.total.finalizacoes <= 15) return false;
            if (c.stats.total.ataques_perigosos <= 80) return false;
            if (c.perder && c.perder.chutes_gol < 4) return false;
            return true;
        },
        acao: (c) => {
            const ladoPerdedor = c.placarCasa > c.placarFora ? 'FORA' : c.placarFora > c.placarCasa ? 'CASA' : 'AMBOS';
            const nomePerdedor = c.placarCasa > c.placarFora
                ? c.jogo.fora : c.placarFora > c.placarCasa ? c.jogo.casa : 'Jogo equilibrado';
            return `OVER 1.5 GOLS NO JOGO - Quem busca: ${nomePerdedor}`;
        }
    },
    {
        id: 8,
        nome: 'BTTS AO VIVO',
        inicio: 60, fim: 70,
        usaPressao: true,
        condicao: (c) => {
            const placar = `${c.placarCasa}-${c.placarFora}`;
            if (!['1-0', '0-1', '1-1'].includes(placar)) return false;
            if (c.perder && c.perder.chutes_gol < 4) return false;
            if (c.perder && c.perder.escanteios < 5) return false;
            return true;
        },
        acao: (c) => {
            const nomePerdedor = c.placarCasa > c.placarFora ? c.jogo.fora : c.jogo.casa;
            return `PRÓXIMO GOL: ${nomePerdedor.toUpperCase()} OU AMBOS MARCAM - ODD: ~2.10`;
        }
    }
];

// ---------------------------------------------------------------------------
// SCANNER PRINCIPAL
// ---------------------------------------------------------------------------
let scanning = false; // trava contra sobreposição de execuções

async function scanner() {
    if (scanning) {
        console.log('⏭️  Scanner anterior ainda em execução. Pulando ciclo.');
        return;
    }
    scanning = true;

    try {
        const estadoEstrategias = getEstadoEstrategias();

        // 1 — Carregar jogos do mapeamento
        const payload = readJson(JOGOS_FILE, null);
        if (!payload || !payload.jogos || payload.jogos.length === 0) {
            console.log('ℹ️  Sem jogos mapeados (rode o ROBÔ 1 primeiro).');
            return;
        }

        // 2 — 1 única requisição: todos os jogos ao vivo (api-football)
        //     Se a cota acabar, troca para a ESPN (sem cota) e continua.
        let liveMap = {};
        let vivosESPN = [];
        let fonteViva = 'api-football';
        try {
            const live = await apiGet('fixtures', { live: 'all' });
            for (const fx of live.response || []) {
                liveMap[fx.fixture.id] = fx;
            }
        } catch (e) {
            if (e.allKeysExhausted) {
                console.log('⚠️  Cota api-football esgotada — trocando para ESPN (sem cota).');
                fonteViva = 'espn';
                const aviso = readJson('aviso-espn.json', { data: '' });
                const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
                if (aviso.data !== hoje) {
                    writeJson('aviso-espn.json', { data: hoje });
                    await alerta('⚠️ <b>Cota api-football esgotada.</b> O scanner continuou usando a ESPN como fonte reserva (posse, chutes, escanteios, faltas, cartões).');
                }
            } else {
                throw e;
            }
        }

        // 2b — ESPN sempre consultada (sem cota): cobre jogos que a api-football
        //     não listou como ao vivo (cobertura parcial do plano free).
        try {
            vivosESPN = await buscarJogosAoVivoESPN();
            if (fonteViva === 'api-football' && vivosESPN.length) {
                console.log(`   📡 ESPN como cobertura extra: ${vivosESPN.length} jogos ao vivo.`);
            }
        } catch (e) {
            console.error('   📡 ESPN falhou:', e.message);
        }

        // 3 — Iterar jogos mapeados
        let sinaisNovos = 0;
        for (const jogo of payload.jogos) {
            let fx = liveMap[jogo.api_id];
            let fonteJogo = 'api-football';

            if (!fx && fonteViva === 'espn') {
                const m = casarJogoESPN(jogo, vivosESPN);
                if (m) {
                    fx = {
                        fixture: { status: { short: '2H', elapsed: m.minuto } },
                        goals: { home: m.placarCasa, away: m.placarFora },
                        _espnEventoId: m.eventoId,
                        _espnSlug: SLUGS_ESPN[m.ligaId]
                    };
                    fonteJogo = 'espn';
                }
            }

            if (!fx) continue; // não está ao vivo

            const st = fx.fixture.status.short;
            if (!['1H', '2H', 'HT'].includes(st)) {
                // Atualizar status final no arquivo
                if (['FT', 'AET', 'PEN'].includes(st)) jogo.status = 'FT';
                else if (['SUSP', 'INT', 'CANC', 'PST', 'ABD'].includes(st)) jogo.status = st;
                continue;
            }

            const { minuto, periodo } = parseMinuto(fx.fixture.status.elapsed, st);
            jogo.status = st;
            jogo.placar = `${fx.goals.home}-${fx.goals.away}`;

            // 4 — Está em alguma janela válida? (senão, economiza req de stats)
            const candidatas = ESTRATEGIAS.filter(e =>
                minuto >= e.inicio && minuto <= e.fim &&
                !estaDesativada(e.nome, estadoEstrategias)
            );
            if (candidatas.length === 0) continue;

            // 5 — Cooldowns / gap
            const agora = Date.now();
            const disponiveis = candidatas.filter(e => {
                const reg = (jogo.sinais_enviados || []).find(s => s.estrategia === e.nome);
                if (reg && agora - reg.timestamp < COOLDOWN_ESTRATEGIA_MIN * 60 * 1000) return false;
                // Gap de 10 min para QUALQUER sinal no mesmo jogo
                const ultimoQualquer = (jogo.sinais_enviados || [])
                    .reduce((max, s) => Math.max(max, s.timestamp), 0);
                if (ultimoQualquer && agora - ultimoQualquer < GAP_JOGO_MIN * 60 * 1000) return false;
                return true;
            });
            if (disponiveis.length === 0) continue;

            // 6 — Buscar estatísticas (1 req por jogo na janela)
            let stats = null;
            try {
                if (fonteJogo === 'espn') {
                    stats = await buscarStatsESPN(fx._espnEventoId, fx._espnSlug);
                } else {
                    const statsData = await apiGet('fixtures/statistics', { fixture: jogo.api_id });
                    stats = extractStats(statsData.response);
                }
            } catch (e) {
                if (e.allKeysExhausted && fonteJogo !== 'espn') throw e;
                console.error(`   Stats ${jogo.casa}x${jogo.fora}: ${e.message}`);
            }
            if (!stats) continue; // sem stats → pula jogo (qualidade de dados)

            // 7 — Red card antes de 70' cancela estratégias de pressão
            const redCard = (stats.casa.cartoes_vermelhos + stats.fora.cartoes_vermelhos) > 0;
            const finais = disponiveis.filter(e => !(redCard && minuto < 70 && e.usaPressao));
            if (finais.length === 0) continue;

            // 8 — Odds ao vivo: só para a estratégia 1 (requisição extra só se necessário)
            const precisaOdds = finais.some(e => e.id === 1);
            let oddsLive = null;
            if (precisaOdds) {
                try {
                    const oddsData = await apiGet('odds', { fixture: jogo.api_id });
                    const parsed = parseOddsLive(oddsData.response);
                    oddsLive = parsed;
                } catch (e) {
                    if (e.allKeysExhausted && fonteJogo !== 'espn') throw e;
                    oddsLive = null;
                }
            }

            // 9 — Montar contexto e avaliar estratégias
            const placarCasa = fx.goals.home || 0;
            const placarFora = fx.goals.away || 0;
            const favorito = jogo.favorito_pre === 'fora' ? 'fora' : 'casa';
            const ctx = {
                minuto, periodo,
                placarCasa, placarFora,
                jogo, stats, oddsLive,
                favorito,
                fav: favorito === 'casa' ? stats.casa : stats.fora,
                under: favorito === 'casa' ? stats.fora : stats.casa,
                perder: placarCasa === placarFora ? null :
                    (placarCasa > placarFora ? stats.fora : stats.casa)
            };

            for (const est of finais) {
                let bateu = false;
                try {
                    bateu = est.condicao(ctx);
                } catch (e) {
                    console.error(`   Condição ${est.nome}: ${e.message}`);
                }
                if (!bateu) continue;

                // 10 — Disparar sinal
                const mensagem = formatarMensagem(est, jogo, ctx);
                const enviado = await sendTelegram(mensagem);
                if (process.env.TEST_MODE === 'true') {
                    console.log('🧪 [TESTE] Sinal disparado:\n' + mensagem);
                }

                registrarSinal(jogo, est, ctx, mensagem);
                sinaisNovos++;
                console.log(`🚨 SINAL [${est.nome}] ${jogo.casa} x ${jogo.fora} ${minuto}' (${jogo.placar})`);
            }
        }

        // 11 — Persistir estado
        writeJson(JOGOS_FILE, payload);
        console.log(`✅ Scan concluído. Sinais novos: ${sinaisNovos}`);

    } catch (error) {
        if (error.allKeysExhausted) {
            console.error('🛑 Todas as chaves esgotadas. Scanner parado.');
            await alerta(
                '🛑 <b>SCANNER PARADO</b>\n' +
                '💳 Todas as chaves da API-Football esgotaram o crédito do dia.\n' +
                'O scanner tentará novamente no próximo ciclo após a renovação (meia-noite UTC).'
            );
        } else {
            console.error('❌ Erro no scanner:', error.message);
        }
    } finally {
        scanning = false;
    }
}

// ---------------------------------------------------------------------------
// AUXILIARES
// ---------------------------------------------------------------------------
function getEstadoEstrategias() {
    return readJson(ESTRATEGIAS_FILE, {
        desativadas: []
        // [{ nome, motivo: 'AUTO'|'MANUAL', ate: ISO date }]
    });
}

function estaDesativada(nome, estado) {
    const reg = (estado.desativadas || []).find(d => d.nome === nome);
    if (!reg) return false;
    if (new Date(reg.ate) < new Date()) {
        // Expirou: reativa
        estado.desativadas = estado.desativadas.filter(d => d !== reg);
        writeJson(ESTRATEGIAS_FILE, estado);
        return false;
    }
    return true;
}

function registrarSinal(jogo, est, ctx, mensagem) {
    const sinais = readJson(SINAIS_FILE, { data: null, lista: [] });

    const hoje = new Date().toISOString().split('T')[0];
    if (sinais.data !== hoje) {
        sinais.data = hoje;
        sinais.lista = [];
    }

    sinais.lista.push({
        id: `${jogo.api_id}-${est.id}-${Date.now()}`,
        data_envio: new Date().toISOString(),
        jogo_id: jogo.api_id,
        estrategia: est.nome,
        estrategia_id: est.id,
        liga: jogo.liga,
        casa: jogo.casa,
        fora: jogo.fora,
        minuto: ctx.minuto,
        placar_no_sinal: `${ctx.placarCasa}-${ctx.placarFora}`,
        acao: est.acao(ctx),
        stats_snapshot: {
            posse: `${ctx.stats.casa.posse}%|${ctx.stats.fora.posse}%`,
            chutes_gol: `${ctx.stats.casa.chutes_gol}|${ctx.stats.fora.chutes_gol}`,
            finalizacoes: `${ctx.stats.casa.finalizacoes}|${ctx.stats.fora.finalizacoes}`,
            escanteios: `${ctx.stats.casa.escanteios}|${ctx.stats.fora.escanteios}`,
            faltas: `${ctx.stats.casa.faltas}|${ctx.stats.fora.faltas}`,
            cartoes: `${ctx.stats.casa.cartoes}|${ctx.stats.fora.cartoes}`
        },
        status: 'PENDENTE'   // GREEN | RED depois
    });

    writeJson(SINAIS_FILE, sinais);

    // registra cooldown no jogo (em memória, persistido pelo caller)
    jogo.sinais_enviados = jogo.sinais_enviados || [];
    jogo.sinais_enviados.push({ estrategia: est.nome, timestamp: Date.now() });
}

function formatarMensagem(est, jogo, ctx) {
    const s = ctx.stats;
    const total = s.total;
    const intensidade = total.ataques_perigosos > 60 || total.chutes_gol > 8
        ? 'MUITO ALTA 🔥🔥' : 'PRESSÃO ALTA 🔥';

    return [
        `🚨 SINAL DETECTADO - ${est.nome}`,
        `⚽️ ${jogo.casa} ${ctx.placarCasa} x ${ctx.placarFora} ${jogo.fora} - ${ctx.minuto}'`,
        `🏆 ${jogo.liga}`,
        `🔥 Status: ${intensidade}`,
        ``,
        `📊 DADOS AO VIVO:`,
        `• Posse: ${s.casa.posse}% | ${s.fora.posse}%`,
        `• Chutes no Gol: ${s.casa.chutes_gol} | ${s.fora.chutes_gol}`,
        `• Finalizações: ${s.casa.finalizacoes} | ${s.fora.finalizacoes}`,
        `• Ataques Perigosos: ${s.casa.ataques_perigosos} | ${s.fora.ataques_perigosos}`,
        `• Escanteios: ${s.casa.escanteios} | ${s.fora.escanteios}`,
        `• Faltas: ${total.faltas}`,
        `• Cartões: ${total.cartoes} (🟨 ${s.casa.cartoes_amarelos+s.fora.cartoes_amarelos} / 🟥 ${s.casa.cartoes_vermelhos+s.fora.cartoes_vermelhos})`,
        ``,
        `📈 O QUE FAZER: ${est.acao(ctx)}`,
        `⏰ Válido até ${est.fim}'`
    ].join('\n');
}

function parseOddsLive(oddsResponse) {
    try {
        const item = oddsResponse && oddsResponse[0];
        if (!item) return null;
        const bookmaker = item.bookmakers && item.bookmakers[0];
        if (!bookmaker) return null;
        const mw = bookmaker.bets.find(b => b.id === 1 || b.name === 'Match Winner');
        if (!mw) return null;
        const home = mw.values.find(v => v.value === 'Home');
        const draw = mw.values.find(v => v.value === 'Draw');
        const away = mw.values.find(v => v.value === 'Away');
        if (!home || !draw || !away) return null;
        return {
            home: parseFloat(home.odd),
            draw: parseFloat(draw.odd),
            away: parseFloat(away.odd)
        };
    } catch (e) {
        return null;
    }
}

module.exports = { scanner, ESTRATEGIAS, getEstadoEstrategias, formatarMensagem, registrarSinal };
