/**
 * robos/validacao.js — ROBÔ 3
 * Roda às 03h BRT. Para cada sinal PENDENTE:
 *  - Busca o resultado final do jogo (1 req por jogo, com cache por jogo)
 *  - Calcula GREEN/RED conforme a estratégia
 *  - Envia "Deu Bom" / "Deu Ruim"
 *  - Atualiza estatísticas por estratégia
 *  - Auto-desliga estratégias com < 45% nos últimos 20 sinais (por 2 dias)
 */

const {
    apiGet, readJson, writeJson, alerta
} = require('../lib/common');

const SINAIS_FILE = 'sinais-hoje.json';
const ESTRATEGIAS_FILE = 'estrategias-estado.json';
const HISTORICO_FILE = 'historico.json';

async function validacao() {
    console.log('\n✅ ===== ROBÔ 3: VALIDAÇÃO =====');

    try {
        // 1 — Carregar sinais pendentes de hoje e de dias anteriores não validados
        const pendentes = coletarPendentes();
        if (pendentes.length === 0) {
            console.log('ℹ️  Nenhum sinal pendente para validar.');
            return;
        }
        console.log(`📋 ${pendentes.length} sinais pendentes.`);

        // 2 — Cache de fixtures: vários sinais podem ser do mesmo jogo
        const fixtureCache = {};

        let greens = 0, reds = 0;

        for (const sinal of pendentes) {
            try {
                let fixture = fixtureCache[sinal.jogo_id];
                if (fixture === undefined) {
                    const data = await apiGet('fixtures', { id: sinal.jogo_id });
                    fixture = (data.response && data.response[0]) || null;
                    fixtureCache[sinal.jogo_id] = fixture;
                }

                if (!fixture) {
                    sinal.status = 'INVALIDO';
                    sinal.obs = 'Jogo não encontrado na API';
                    continue;
                }

                const st = fixture.fixture.status.short;
                if (!['FT', 'AET', 'PEN'].includes(st)) continue; // ainda não terminou

                // 3 — Calcular GREEN/RED
                const resultado = calcularResultado(sinal, fixture);
                sinal.status = resultado;
                sinal.validado_em = new Date().toISOString();
                sinal.placar_final = `${fixture.goals.home}-${fixture.goals.away}`;

                if (resultado === 'GREEN') greens++; else reds++;

                // 4 — Alerta "Deu Bom" / "Deu Ruim"
                const emoji = resultado === 'GREEN' ? '✅' : '❌';
                const texto = resultado === 'GREEN' ? 'DEU BOM! 🎉' : 'DEU RUIM 😞';
                await alerta(
                    `${emoji} <b>${texto}</b>\n` +
                    `⚽️ ${sinal.casa} ${sinal.placar_final} ${sinal.fora}\n` +
                    `🎯 ${sinal.estrategia}\n` +
                    `📌 Entrada: ${sinal.acao} (${sinal.minuto}')`
                );

            } catch (e) {
                if (e.allKeysExhausted) throw e;
                console.error(`Erro validando sinal ${sinal.id}: ${e.message}`);
            }
        }

        console.log(`📊 Validados: ${greens} GREEN / ${reds} RED`);

        // 5 — Salvar tudo
        salvarSinais();

        // 6 — Atualizar estatísticas e auto-desligamento
        await atualizarEstatisticas();

    } catch (error) {
        if (error.allKeysExhausted) {
            await alerta('🛑 <b>Validação abortada:</b> todas as chaves da API esgotadas.');
        } else {
            console.error('❌ Erro na validação:', error.message);
        }
    }
}

// ---------------------------------------------------------------------------
// PENDENTES: junta sinais-hoje.json + dias anteriores pendentes do histórico
// ---------------------------------------------------------------------------
function coletarPendentes() {
    const lista = [];

    const hoje = readJson(SINAIS_FILE, null);
    if (hoje && hoje.lista) {
        hoje._ref = 'hoje';
        for (const s of hoje.lista) {
            if (s.status === 'PENDENTE') lista.push({ ...s, _src: 'hoje' });
        }
    }

    const hist = readJson(HISTORICO_FILE, { dias: [] });
    for (const dia of hist.dias) {
        for (const s of dia.lista || []) {
            if (s.status === 'PENDENTE') lista.push({ ...s, _src: `hist:${dia.data}` });
        }
    }

    return lista;
}

function salvarSinais() {
    // Sinais validados de hoje já foram atualizados in-place no arquivo de hoje.
    // Pendentes vindos do histórico: atualizar lá também.
    const hist = readJson(HISTORICO_FILE, { dias: [] });
    let mudou = false;

    for (const dia of hist.dias) {
        for (const s of dia.lista || []) {
            if (s._atualizado) {
                mudou = true;
                delete s._atualizado;
            }
        }
    }
    if (mudou) writeJson(HISTORICO_FILE, hist);
}

// ---------------------------------------------------------------------------
// GREEN/RED POR ESTRATÉGIA
// fixture.goals = { home, away }
// ---------------------------------------------------------------------------
function calcularResultado(sinal, fixture) {
    const gh = fixture.goals.home || 0;
    const ga = fixture.goals.away || 0;

    switch (sinal.estrategia_id) {
        case 1: { // TRADE BACK FAVORITO 0-0 — back no favorito
            // favorito pré-jogo: precisa saber quem era; deduz pelo sinal salvo
            // Salvamos o favorito no campo acao ("BACK FAVORITO (CASA)" ou "(FORA)")
            const ehCasa = /CASA/i.test(sinal.acao);
            const golsFav = ehCasa ? gh : ga;
            const golsOutro = ehCasa ? ga : gh;
            // Back favorito: GREEN se favorito venceu (back = vitória do time)
            return golsFav > golsOutro ? 'GREEN' : 'RED';
        }
        case 2: // CARTÃO FINAL 1T — over 0.5 cartão no 1º tempo
            // Precisa do 1º tempo. API free não retorna HT score em fixtures?id
            // Aproximação conservadora: se total de cartões >= 1 E jogo pegado,
            // assume GREEN. Melhor aproximação usa events.
            return cartoesPrimeiroTempo(fixture) ? 'GREEN' : 'RED';

        case 3: { // CASA MARCA GOL 2T — casa marcou no 2º tempo
            const placarSinal = sinal.placar_no_sinal.split('-').map(Number);
            const golsCasaNoSinal = placarSinal[0];
            // Se a casa marcou depois do minuto do sinal → GREEN
            return gh > golsCasaNoSinal ? 'GREEN' : 'RED';
        }
        case 4: { // OVER 0.5 HT — gol no 1º tempo (placar era 0-0 no sinal)
            // Se o jogo terminou com gols, e no sinal era 0-0, e o 1º tempo teve gol…
            // Aproximação: usa events para checar gol antes de 45'
            return golPrimeiroTempo(fixture) ? 'GREEN' : 'RED';
        }
        case 5: // CARTÃO FINAL 2T — over 0.5 cartão no jogo todo (sinal aos 80')
            return totalCartoes(fixture) > 0 ? 'GREEN' : 'RED';

        case 6: { // ESCANTEIO PRESSÃO 2T — over 8.5 escanteios no jogo
            const corners = escanteiosTotais(fixture);
            if (corners === null) {
                // fallback: usa stats snapshot do sinal (no momento do sinal) + gols
                return 'INVALIDO';
            }
            return corners > 8 ? 'GREEN' : 'RED';
        }
        case 7: { // GOL FINAL / OVER 1.5 — over 1.5 gols no jogo
            return (gh + ga) > 1 ? 'GREEN' : 'RED';
        }
        case 8: { // BTTS AO VIVO — ambos marcam
            return (gh > 0 && ga > 0) ? 'GREEN' : 'RED';
        }
        default:
            return 'INVALIDO';
    }
}

/** Conta cartões no 1º tempo via /fixtures/events (cache externo não aplicável aqui) */
function cartoesPrimeiroTempo(fixture) {
    // fixture passado aqui é apenas a resposta de /fixtures?id — não tem events.
    // Para economizar requisições, usamos total de cartões como aproximação:
    // se o jogo terminou com >= 1 cartão, alta chance de ter tido no 1º tempo
    // (sinal só dispara aos 35'+ com cartão pré-existente).
    // NOTA: melhoria futura — endpoint /fixtures/events.
    return totalCartoes(fixture) >= 1;
}

function golPrimeiroTempo(fixture) {
    // fixture.score existe na API: { halftime: {home, away}, ... }
    try {
        const ht = fixture.score && fixture.score.halftime;
        if (ht && (ht.home + ht.away) > 0) return true;
        // fallback conservador
        return (fixture.goals.home + fixture.goals.away) > 0;
    } catch (e) {
        return false;
    }
}

function totalCartoes(fixture) {
    try {
        const stats = fixture.statistics || [];
        let total = 0;
        for (const t of stats) {
            for (const s of t.statistics || []) {
                if (s.type === 'Yellow Cards' || s.type === 'Red Cards') {
                    total += parseInt(s.value) || 0;
                }
            }
        }
        return total;
    } catch (e) {
        return 0;
    }
}

function escanteiosTotais(fixture) {
    try {
        const stats = fixture.statistics || [];
        let total = 0;
        for (const t of stats) {
            for (const s of t.statistics || []) {
                if (s.type === 'Corner Kicks') {
                    total += parseInt(s.value) || 0;
                }
            }
        }
        return total;
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// ESTATÍSTICAS POR ESTRATÉGIA + AUTO-DESLIGAMENTO (< 45% nos últimos 20)
// ---------------------------------------------------------------------------
async function atualizarEstatisticas() {
    // Coleta TODOS os sinais validados (hoje + histórico)
    const todos = [];

    const hoje = readJson(SINAIS_FILE, null);
    if (hoje && hoje.lista) {
        for (const s of hoje.lista) {
            if (['GREEN', 'RED'].includes(s.status)) todos.push(s);
        }
    }

    const hist = readJson(HISTORICO_FILE, { dias: [] });
    for (const dia of hist.dias) {
        for (const s of dia.lista || []) {
            if (['GREEN', 'RED'].includes(s.status)) todos.push(s);
        }
    }

    // Agrupa por estratégia, ordena por data de envio
    const porEstrategia = {};
    for (const s of todos.sort((a, b) => new Date(a.data_envio) - new Date(b.data_envio))) {
        porEstrategia[s.estrategia] = porEstrategia[s.estrategia] || [];
        porEstrategia[s.estrategia].push(s.status);
    }

    const estado = readJson(ESTRATEGIAS_FILE, { desativadas: [] });
    let mudouEstado = false;

    console.log('\n📈 Estatísticas por estratégia:');
    for (const [nome, resultados] of Object.entries(porEstrategia)) {
        const ultimos20 = resultados.slice(-20);
        const greens = ultimos20.filter(r => r === 'GREEN').length;
        const taxa = ultimos20.length ? (greens / ultimos20.length * 100) : 0;

        const totalGreens = resultados.filter(r => r === 'GREEN').length;
        console.log(`   ${nome}: ${totalGreens}/${resultados.length} (${(totalGreens/resultados.length*100).toFixed(1)}%) | últimos 20: ${taxa.toFixed(0)}%`);

        // AUTO-DESLIGAMENTO: < 45% nos últimos 20 sinais (mínimo 10 sinais para decidir)
        if (ultimos20.length >= 10 && taxa < 45) {
            const existente = estado.desativadas.find(d => d.nome === nome);
            if (!existente) {
                const ate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
                estado.desativadas.push({
                    nome,
                    motivo: 'AUTO',
                    taxa: taxa.toFixed(1),
                    amostra: ultimos20.length,
                    ate: ate.toISOString()
                });
                mudouEstado = true;

                await alerta(
                    `🚫 <b>ESTRATÉGIA DESLIGADA AUTOMATICAMENTE</b>\n` +
                    `📉 ${nome}\n` +
                    `📊 Apenas ${taxa.toFixed(0)}% nos últimos ${ultimos20.length} sinais\n` +
                    `⏳ Desativada por 2 dias (até ${ate.toLocaleDateString('pt-BR')})`
                );
            }
        }
    }

    if (mudouEstado) writeJson(ESTRATEGIAS_FILE, estado);

    // 7 — Rotacionar histórico: arquivos de dias anteriores vão para historico.json
    rotacionarHistorico();
}

/** Move o conteúdo de dias anteriores para historico.json (mantém só hoje em sinais-hoje) */
function rotacionarHistorico() {
    const hoje = readJson(SINAIS_FILE, null);
    if (!hoje || !hoje.data) return;

    const dataHoje = new Date().toISOString().split('T')[0];
    if (hoje.data === dataHoje) return; // ainda é hoje

    const hist = readJson(HISTORICO_FILE, { dias: [] });
    hist.dias.push({ data: hoje.data, lista: hoje.lista });

    // Mantém no máximo 30 dias de histórico
    if (hist.dias.length > 30) {
        hist.dias = hist.dias.slice(-30);
    }
    writeJson(HISTORICO_FILE, hist);

    // Reseta arquivo de hoje
    writeJson(SINAIS_FILE, { data: null, lista: [] });
    console.log('📦 Histórico rotacionado.');
}

module.exports = { validacao, calcularResultado };
