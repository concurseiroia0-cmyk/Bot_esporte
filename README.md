# ⚽ Bot Farejador de Pressão

Sistema com 3 robôs em Node.js que monitora jogos de futebol ao vivo e envia sinais de aposta no Telegram quando o "jogo esquenta".

## 🤖 Os 3 Robôs

| Robô | Horário | Função |
|------|---------|--------|
| **1. MAPEAMENTO** | 08h BRT | Escolhe os 25 melhores jogos do dia |
| **2. SCANNER** | a cada 2 min (10h–23h) | Analisa ao vivo, dispara sinais no Telegram |
| **3. VALIDAÇÃO** | 03h BRT (+23h30) | Confirma GREEN/RED, atualiza stats, desliga estratégias ruins |

## 🚀 Como rodar

```bash
cd bot-farejador
npm install

# 1. Edite o .env com suas chaves:
#    API_FOOTBALL_KEY, API_FOOTBALL_KEY_2 (rotação automática)
#    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

# Rodar tudo (crons + painel Telegram + dashboard)
npm start

# Ou rodar cada robô manualmente:
npm run map        # ROBÔ 1 agora
npm run scan       # ROBÔ 2 agora (1 ciclo)
npm run validate   # ROBÔ 3 agora

# Dashboard/site
# Coloque DASHBOARD=true no .env e rode npm start
# → http://localhost:3000
```

## 🎯 As 8 Estratégias

1. **TRADE BACK FAVORITO 0-0** (25'–40') — favorito pressionando, odd subiu pra 2.00+
2. **CARTÃO FINAL 1T** (35'–47') — jogo pegando fogo, faltas 12+, cartão já dado
3. **CASA MARCA GOL 2T** (55'–78') — casa empatando/perdendo por 1 com pressão total
4. **OVER 0.5 HT** (30'–40') — 0-0 com jogo aberto (chutes, escanteios, ataques)
5. **CARTÃO FINAL 2T** (80'–88') — jogo tenso, 3+ cartões, 20+ faltas
6. **ESCANTEIO PRESSÃO 2T** (75'–85') — favorito atrás no placar pressionando
7. **GOL FINAL / OVER 1.5** (70'–85') — jogo aberto, quem perde busca o gol
8. **BTTS AO VIVO** (60'–70') — perdedor pressionando com chutes e escanteios

## 🛡️ Regras de segurança implementadas

- **Cooldown 20 min** por estratégia/jogo + **gap 10 min** por jogo
- **Red card antes dos 70'** cancela estratégias de pressão do jogo
- **Favorito casa/fora** detectado automaticamente pelas odds pré-jogo
- **Rotação de 2 chaves** da API: quando uma esgota (HTTP 402/429), usa a outra; se ambas esgotarem, scanner para e avisa no Telegram
- **Rate limit 10 req/min** (plano free) com fila automática
- **Auto-desligamento**: estratégia com < 45% nos últimos 20 sinais → desligada por 2 dias
- **Alertas "Deu Bom"/"Deu Ruim"** quando o sinal bate

## 📱 Comandos do Telegram

```
/status          — sinais de hoje + taxa de acerto
/jogos           — os 25 jogos mapeados
/reset           — reseta cooldowns
/desativar NOME  — desliga estratégia manualmente
/ativar NOME     — religa estratégia
```

## 📂 Estrutura

```
bot-farejador/
├── index.js            # crons + painel Telegram
├── lib/common.js       # API (rotação chaves), Telegram, storage JSON
├── robos/
│   ├── mapeamento.js   # ROBÔ 1
│   ├── scanner.js      # ROBÔ 2 (8 estratégias)
│   └── validacao.js    # ROBÔ 3
├── dashboard/          # site/painel web (sem framework)
│   ├── server.js
│   └── index.html
└── data/               # "banco de dados" em JSON (sem Supabase)
    ├── jogos-hoje.json
    ├── sinais-hoje.json
    ├── historico.json
    ├── estrategias-estado.json
    └── api-keys.json
```

## ⚠️ Notas importantes

- **Sem Supabase** — tudo em arquivos JSON dentro de `data/`
- A API-Football **free não tem "ataques perigosos"** — usamos proxy (chutes na área + escanteios + chutes no gol)
- A API free às vezes **não tem odds pré-jogo** — o mapeamento tem fallback (mantém o jogo sem filtro de odd)
- Estatísticas de 1º/2º tempo não existem separadas na API free — as condições usam totais do jogo como aproximação
- **TEST_MODE=true** no .env: sinais aparecem só no console (não envia Telegram)
