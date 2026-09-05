/**
 * lib/common.js — Utilitários compartilhados pelos 3 robôs
 * - Rotação das 2 chaves da API-Football (quando uma esgota, usa a outra)
 * - Controle de requisições por minuto (plano free: ~10 req/min)
 * - Persistência em arquivos JSON (sem banco de dados)
 * - Envio Telegram centralizado
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Garante .env carregado em qualquer ponto de entrada (npm run map, cron, etc.)
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');
const API_BASE = 'https://v3.football.api-sports.io';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// ESTADO DAS CHAVES DA API (persistido em data/api-keys.json)
// ---------------------------------------------------------------------------
const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

function loadKeysState() {
    // Valores SEMPRE vem do .env (nunca persistidos em arquivo — segurança)
    const values = {
        primary: process.env.API_FOOTBALL_KEY,
        secondary: process.env.API_FOOTBALL_KEY_2
    };
    try {
        const saved = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        return {
            keys: saved.keys.map(k => ({ ...k, value: values[k.name] })),
            activeIndex: saved.activeIndex || 0
        };
    } catch (e) {
        return {
            keys: [
                { name: 'primary', value: values.primary, exhausted: false, exhaustedAt: null },
                { name: 'secondary', value: values.secondary, exhausted: false, exhaustedAt: null }
            ],
            activeIndex: 0
        };
    }
}

function saveKeysState(state) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(state, null, 2));
}

/**
 * Retorna a chave ativa. Se a ativa estiver esgotada, passa para a próxima.
 * Retorna null se TODAS estiverem esgotadas.
 */
function getApiKey() {
    const state = loadKeysState();

    for (let i = 0; i < state.keys.length; i++) {
        const idx = (state.activeIndex + i) % state.keys.length;
        const key = state.keys[idx];
        if (!key.exhausted && key.value) {
            state.activeIndex = idx;
            saveKeysState(state);
            return key.value;
        }
    }
    return null; // todas esgotadas
}

/**
 * Marca a chave ativa como esgotada e tenta alternar para a próxima.
 * Retorna true se ainda existe outra chave disponível.
 */
function markKeyExhausted() {
    const state = loadKeysState();
    const active = state.keys[state.activeIndex];
    if (active) {
        active.exhausted = true;
        active.exhaustedAt = new Date().toISOString();
    }
    console.log(`💳 Chave "${active ? active.name : '?'}" esgotada. Tentando alternar...`);
    saveKeysState(state);
    return getApiKey() !== null;
}

function resetKeys() {
    const state = loadKeysState();
    state.keys.forEach(k => { k.exhausted = false; k.exhaustedAt = null; });
    state.activeIndex = 0;
    saveKeysState(state);
    console.log('🔄 Chaves da API resetadas (novo dia).');
}

// ---------------------------------------------------------------------------
// RATE LIMIT — buffer de timestamps das requisições (máx 10 por minuto)
// ---------------------------------------------------------------------------
const RATE_FILE = path.join(DATA_DIR, 'rate-limit.json');
const MAX_REQ_PER_MIN = parseInt(process.env.MAX_REQ_PER_MIN || '10', 10);

function loadRate() {
    try {
        const arr = JSON.parse(fs.readFileSync(RATE_FILE, 'utf-8'));
        const oneMinAgo = Date.now() - 60 * 1000;
        return arr.filter(t => t > oneMinAgo);
    } catch (e) {
        return [];
    }
}

function saveRate(arr) {
    fs.writeFileSync(RATE_FILE, JSON.stringify(arr));
}

/**
 * Espera o tempo necessário respeitando o limite de requisições/minuto.
 */
async function waitForSlot() {
    let stamps = loadRate();
    while (stamps.length >= MAX_REQ_PER_MIN) {
        const waitMs = stamps[0] + 60 * 1000 - Date.now() + 250;
        if (waitMs > 0) await sleep(waitMs);
        stamps = loadRate();
    }
    stamps.push(Date.now());
    saveRate(stamps);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// CHAMADA CENTRALIZADA À API-FOOTBALL (com rotação de chave + rate limit)
// ---------------------------------------------------------------------------
/**
 * Faz GET na API-Football. Em 429/402 (limite/crédito) troca de chave
 * automaticamente e tenta de novo. Retorna { data } ou lança.
 * Se TODAS as chaves esgotarem, lança erro com flag allKeysExhausted.
 */
async function apiGet(endpoint, params = {}, retry = true) {
    const apiKey = getApiKey();

    if (!apiKey) {
        const err = new Error('Todas as chaves da API-Football estão esgotadas.');
        err.allKeysExhausted = true;
        throw err;
    }

    await waitForSlot();

    try {
        const { data } = await axios.get(`${API_BASE}/${endpoint}`, {
            headers: { 'x-apisports-key': apiKey },
            params,
            timeout: 20000
        });
        return data;
    } catch (error) {
        const status = error.response && error.response.status;
        if (status === 429 || status === 402 || status === 403) {
            const hasAnother = markKeyExhausted();
            if (hasAnother && retry) {
                console.log(`🔄 Alternando para outra chave (HTTP ${status})...`);
                return apiGet(endpoint, params, false);
            }
            if (!hasAnother) {
                error.allKeysExhausted = true;
            }
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// PERSISTÊNCIA JSON genérica (substitui o Supabase)
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------
let tgBot = null;
function getBot() {
    if (!process.env.TELEGRAM_TOKEN) return null;
    if (!tgBot) {
        const TelegramBot = require('node-telegram-bot-api');
        tgBot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
    }
    return tgBot;
}

async function sendTelegram(text) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const bot = getBot();

    if (!bot || !chatId) {
        console.log(`🔔 [Telegram não configurado] ${text.split('\n')[0]}`);
        return false;
    }

    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        return true;
    } catch (error) {
        console.error('Erro Telegram:', error.message);
        return false;
    }
}

async function alerta(msg) {
    if (process.env.TEST_MODE === 'true') {
        console.log(`🔔 [ALERTA MODO TESTE] ${msg}`);
        return;
    }
    await sendTelegram(`🤖 <b>ALERTA DO SISTEMA</b>\n${msg}`);
}

// ---------------------------------------------------------------------------
// HELPERS DE JOGO
// ---------------------------------------------------------------------------
/**
 * Parse do minuto ao vivo a partir do status/elapsed da API.
 * Retorna { minuto, periodo } onde periodo = '1T' | '2T' | 'HT' | 'FT' | ...
 */
function parseMinuto(elapsed, statusShort) {
    if (elapsed === null || elapsed === undefined) {
        return { minuto: 0, periodo: statusShort || '?' };
    }
    if (statusShort === '1H') return { minuto: elapsed, periodo: '1T' };
    if (statusShort === '2H') return { minuto: elapsed, periodo: '2T' };
    if (statusShort === 'HT') return { minuto: 45, periodo: 'HT' };
    if (statusShort === 'ET' || statusShort === 'BT' || statusShort === 'P') {
        return { minuto: 90 + (elapsed || 0), periodo: 'PR' };
    }
    return { minuto: elapsed, periodo: statusShort || '?' };
}

/**
 * Extrai estatísticas normalizadas do endpoint /fixtures/statistics.
 * A API-Football não tem "ataques perigosos"; usamos ataques = shots
 * perigosos aproximado por "Attacks" quando existir (algumas fontes),
 * senão usamos chute dentro/fora como proxy.
 */
function extractStats(statisticsResponse) {
    // response = [ { team: {id,name}, statistics: [ {type, value} ] }, ... ]
    if (!statisticsResponse || statisticsResponse.length < 2) return null;

    const map = (teamStats) => {
        const out = {};
        for (const s of teamStats.statistics) {
            out[s.type] = s.value;
        }
        return {
            chutes_total: toNum(out['Total Shots'] ?? out['Shots on Goal']) || 0,
            chutes_gol: toNum(out['Shots on Goal']) || 0,
            chutes_fora: toNum(out['Shots off Goal']) || 0,
            posse: toNum(out['Ball Possession']) || 0,
            escanteios: toNum(out['Corner Kicks']) || 0,
            faltas: toNum(out['Fouls']) || 0,
            cartoes_amarelos: toNum(out['Yellow Cards']) || 0,
            cartoes_vermelhos: toNum(out['Red Cards']) || 0,
            cartoes: (toNum(out['Yellow Cards']) || 0) + (toNum(out['Red Cards']) || 0),
            finalizacoes: toNum(out['Total Shots']) || 0,
            ataques_perigosos:
                toNum(out['Dangerous Attacks']) ??
                ((toNum(out['Shots inside box']) || 0) + (toNum(out['Corner Kicks']) || 0) + (toNum(out['Shots on Goal']) || 0)),
            ataques: toNum(out['Attacks']) || 0,
            defesas: toNum(out['Goalkeeper Saves']) || 0
        };
    };

    const casa = map(statisticsResponse[0]);
    const fora = map(statisticsResponse[1]);

    // Corrigir posse se vier 100-0
    if (casa.posse + fora.posse === 100) {
        // ok
    } else if (casa.posse > 0 && fora.posse === 0) {
        fora.posse = 100 - casa.posse;
    } else if (fora.posse > 0 && casa.posse === 0) {
        casa.posse = 100 - fora.posse;
    }

    return { casa, fora, total: {
        chutes_gol: casa.chutes_gol + fora.chutes_gol,
        finalizacoes: casa.finalizacoes + fora.finalizacoes,
        escanteios: casa.escanteios + fora.escanteios,
        faltas: casa.faltas + fora.faltas,
        cartoes: casa.cartoes + fora.cartoes,
        ataques_perigosos: casa.ataques_perigosos + fora.ataques_perigosos
    }};
}

function toNum(v) {
    if (v === null || v === undefined) return null;
    const n = parseInt(String(v).replace('%', '').trim(), 10);
    return isNaN(n) ? null : n;
}

module.exports = {
    DATA_DIR,
    getApiKey,
    markKeyExhausted,
    resetKeys,
    apiGet,
    waitForSlot,
    sleep,
    readJson,
    writeJson,
    sendTelegram,
    alerta,
    parseMinuto,
    extractStats,
    toNum
};
