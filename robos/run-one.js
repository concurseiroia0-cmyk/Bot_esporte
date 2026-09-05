/**
 * robos/run-one.js — Entrypoint único para o GitHub Actions
 * Uso: node robos/run-one.js <mapeamento|scanner|validacao>
 */

const nome = (process.argv[2] || 'scanner').toLowerCase();

(async () => {
    try {
        if (nome === 'mapeamento') {
            const { mapeamento } = require('./mapeamento');
            await mapeamento();
        } else if (nome === 'validacao') {
            const { validacao } = require('./validacao');
            await validacao();
        } else if (nome === 'scanner') {
            const { scanner } = require('./scanner');
            await scanner();
        } else {
            console.error('Robô desconhecido:', nome);
            process.exit(1);
        }
        process.exit(0);
    } catch (e) {
        console.error('FALHA:', e.message);
        // Não falha o workflow por erro da API (senão o Actions marca vermelho
        // e manda e-mail a cada ciclo). O log fica registrado.
        process.exit(0);
    }
})();
