// Sobe o dashboard, testa e encerra (para testes rápidos)
require('dotenv').config();
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || 3000;
const { server } = require('./dashboard/server');

const PORT = process.env.DASHBOARD_PORT;
server.listen(PORT, () => {
    console.log(`🖥️  Dashboard rodando em http://localhost:${PORT}`);
    console.log('Pressione Ctrl+C para parar');
});
