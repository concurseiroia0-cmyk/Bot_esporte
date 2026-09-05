/**
 * index.js — Inicialização dos 3 robôs + painel Telegram interativo
 *
 * ROBÔ 1 MAPEAMENTO  — 08h BRT (escolhe os 25 jogos do dia)
 * ROBÔ 2 SCANNER     — a cada 2 min, 10h–23h BRT (sinais ao vivo)
 * ROBÔ 3 VALIDAÇÃO   — 03h BRT (GREEN/RED, stats, auto-desligamento)
 *
 * Painel Telegram (se TELEGRAM_TOKEN configurado):
 *   /status   — sinais de hoje + taxa de acerto por estratégia
 *   /reset    — reseta cooldowns do dia
 *   /desativar NOME — desativa manualmente (ex: /desativar BTTS AO VIVO)
 *   /ativar NOME    — reativa manualmente
 *   /jogos    — lista os 25 jogos mapeados
 */

require('dotenv').config();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const { mapeamento } = require('./robos/mapeamento');
const { scanner, ESTRATEGIAS, getEstadoEstrategias } = require('./robos/scanner');
const { validacao } = require('./robos/validacao');
const { readJson, writeJson, alerta } = require('./lib/common');

// ---------------------------------------------------------------------------
// CRON JOBS
// ---------------------------------------------------------------------------
// ROBÔ 1 — Mapeamento 08h BRT
cron.schedule('0 8 * * *', () => safeRun(mapeamento, 'MAPEAMENTO'), { timezone: 'America/Sao_Paulo' });

// ROBÔ 2 — Scanner a cada 2 min entre 10h e 23h BRT
cron.schedule('*/2 10-23 * * *', () => safeRun(scanner, 'SCANNER'), { timezone: 'America/Sao_Paulo' });

// ROBÔ 2 — Varredura extra à meia-noite (jogos que terminam tarde)
cron.schedule('5 0 * * *', () => safeRun(scanner, 'SCANNER-MADRUGADA'), { timezone: 'America/Sao_Paulo' });

// ROBÔ 3 — Validação 03h BRT
cron.schedule('0 3 * * *', () => safeRun(validacao, 'VALIDACAO'), { timezone: 'America/Sao_Paulo' });

// ROBÔ 3 — Pré-validação 23h30 BRT (valida cedo os jogos que já acabaram)
cron.schedule('30 23 * * *', () => safeRun(validacao, 'VALIDACAO-PRE'), { timezone: 'America/Sao_Paulo' });

async function safeRun(fn, nome) {
    try {
        console.log(`\n⏰ [CRON] Disparando ${nome} — ${new Date().toLocaleString('pt-BR')}`);
        await fn();
    } catch (e) {
        console.error(`[${nome}] Falhou:`, e.message);
    }
}

// ---------------------------------------------------------------------------
// PAINEL TELEGRAM (comandos)
// ---------------------------------------------------------------------------
function setupTelegramCommands() {
    if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('ℹ️  Telegram não configurado — painel de comandos desativado.');
        return;
    }

    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
    const CHAT = process.env.TELEGRAM_CHAT_ID;

    bot.on('message', async (msg) => {
        if (String(msg.chat.id) !== String(CHAT)) return;
        const text = (msg.text || '').trim();
        if (!text.startsWith('/')) return;

        try {
            if (text === '/status') {
                await bot.sendMessage(CHAT, cmdStatus(), { parse_mode: 'HTML' });
            } else if (text === '/reset') {
                const payload = readJson('jogos-hoje.json', null);
                if (payload && payload.jogos) {
                    payload.jogos.forEach(j => { j.sinais_enviados = []; });
                    writeJson('jogos-hoje.json', payload);
                }
                await bot.sendMessage(CHAT, '♻️ Cooldowns resetados!', { parse_mode: 'HTML' });
            } else if (text.startsWith('/desativar')) {
                const nome = text.replace('/desativar', '').trim().toUpperCase();
                if (!nome) {
                    await bot.sendMessage(CHAT, 'Uso: /desativar NOME DA ESTRATÉGIA\n\n' + listaEstrategias());
                    return;
                }
                const estado = getEstadoEstrategias();
                const match = ESTRATEGIAS.find(e => e.nome.toUpperCase().includes(nome));
                if (!match) {
                    await bot.sendMessage(CHAT, '❌ Estratégia não encontrada.\n\n' + listaEstrategias());
                    return;
                }
                estado.desativadas = estado.desativadas.filter(d => d.nome !== match.nome);
                estado.desativadas.push({
                    nome: match.nome, motivo: 'MANUAL',
                    ate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                });
                writeJson('estrategias-estado.json', estado);
                await bot.sendMessage(CHAT, `🚫 <b>${match.nome}</b> desativada manualmente.`, { parse_mode: 'HTML' });
            } else if (text.startsWith('/ativar')) {
                const nome = text.replace('/ativar', '').trim().toUpperCase();
                const estado = getEstadoEstrategias();
                const match = estado.desativadas.find(d => d.nome.toUpperCase().includes(nome));
                if (!match) {
                    await bot.sendMessage(CHAT, 'ℹ️ Nenhuma estratégia desativada com esse nome.');
                    return;
                }
                estado.desativadas = estado.desativadas.filter(d => d !== match);
                writeJson('estrategias-estado.json', estado);
                await bot.sendMessage(CHAT, `✅ <b>${match.nome}</b> reativada!`, { parse_mode: 'HTML' });
            } else if (text === '/jogos') {
                await bot.sendMessage(CHAT, cmdJogos(), { parse_mode: 'HTML' });
            } else if (text === '/ajuda' || text === '/start') {
                await bot.sendMessage(CHAT,
                    '🤖 <b>Bot Farejador de Pressão</b>\n\n' +
                    '/status — sinais de hoje + taxa por estratégia\n' +
                    '/jogos — jogos mapeados hoje\n' +
                    '/reset — reseta cooldowns\n' +
                    '/desativar NOME — desativa estratégia\n' +
                    '/ativar NOME — reativa estratégia',
                    { parse_mode: 'HTML' });
            }
        } catch (e) {
            console.error('Erro comando Telegram:', e.message);
        }
    });

    console.log('📱 Painel Telegram ativo (comandos /status /jogos /reset /desativar /ativar)');
}

function listaEstrategias() {
    return ESTRATEGIAS.map(e => `• ${e.nome}`).join('\n');
}

function cmdStatus() {
    const sinais = readJson('sinais-hoje.json', { lista: [] });
    const lista = sinais.lista || [];
    const greens = lista.filter(s => s.status === 'GREEN').length;
    const reds = lista.filter(s => s.status === 'RED').length;
    const pendentes = lista.filter(s => s.status === 'PENDENTE').length;

    let out = `📊 <b>STATUS DE HOJE</b>\n`;
    out += `🎯 Sinais: ${lista.length} | ✅ ${greens} GREEN | ❌ ${reds} | ⏳ ${pendentes} pendentes\n`;
    if (greens + reds > 0) {
        out += `📈 Aproveitamento: ${(greens / (greens + reds) * 100).toFixed(0)}%\n`;
    }

    // Estratégias desativadas
    const estado = getEstadoEstrategias();
    if (estado.desativadas.length > 0) {
        out += `\n🚫 <b>Desativadas:</b>\n`;
        for (const d of estado.desativadas) {
            out += `• ${d.nome} (${d.motivo}, até ${new Date(d.ate).toLocaleDateString('pt-BR')})\n`;
        }
    }

    // Últimos sinais
    if (lista.length > 0) {
        out += `\n<u>Últimos sinais:</u>\n`;
        for (const s of lista.slice(-5).reverse()) {
            const icon = s.status === 'GREEN' ? '✅' : s.status === 'RED' ? '❌' : '⏳';
            out += `${icon} ${s.minuto}' ${s.casa} x ${s.fora} — ${s.estrategia}\n`;
        }
    }
    return out;
}

function cmdJogos() {
    const payload = readJson('jogos-hoje.json', null);
    if (!payload || !payload.jogos || payload.jogos.length === 0) {
        return 'ℹ️ Nenhum jogo mapeado. Aguarde o ROBÔ 1 (08h) ou rode: npm run map';
    }
    let out = `⚽️ <b>JOGOS DE HOJE (${payload.jogos.length})</b>\n\n`;
    for (const j of payload.jogos) {
        const hora = j.hora || '';
        out += `${j.casa} x ${j.fora} [${j.liga}] ${j.status !== 'NS' ? j.placar : hora}\n`;
    }
    return out;
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
(async () => {
    console.log('🤖 Bot Farejador de Pressão iniciado!');
    console.log('   ROBÔ 1 (Mapeamento): 08h BRT');
    console.log('   ROBÔ 2 (Scanner):    a cada 2 min, 10h–23h BRT');
    console.log('   ROBÔ 3 (Validação):  03h BRT (+ pré às 23h30)');
    console.log(`   Modo teste: ${process.env.TEST_MODE === 'true' ? '🧪 SIM' : '❌ não'}`);

    if (!process.env.API_FOOTBALL_KEY) {
        console.error('❌ API_FOOTBALL_KEY não configurada no .env!');
        process.exit(1);
    }

    // Dashboard (opcional): starta se existir a flag
    if (process.env.DASHBOARD === 'true') {
        try {
            require('./dashboard/server');
            console.log('🖥️  Dashboard em http://localhost:3000');
        } catch (e) {
            console.error('Dashboard falhou:', e.message);
        }
    }

    setupTelegramCommands();

    // Se for manhã e ainda não mapeou hoje, mapeia agora (útil ao reiniciar o bot)
    try {
        const payload = readJson('jogos-hoje.json', null);
        const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        if (!payload || payload.data_ref !== hoje) {
            console.log('🗺️  Sem mapeamento de hoje — rodando ROBÔ 1 agora...');
            await mapeamento();
        }
    } catch (e) {
        console.error('Mapeamento inicial falhou:', e.message);
    }
})();
