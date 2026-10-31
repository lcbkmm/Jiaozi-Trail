import { createServer } from 'node:http';
import { loadMagnetConfig } from './config.mjs';
import { createMagnetHandler } from './handler.mjs';
const config = loadMagnetConfig();
const handler = createMagnetHandler(config);
const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end('Not found'); } });
server.requestTimeout = config.timeoutMs + 30000;
server.timeout = config.timeoutMs + 30000;
server.listen(Number(process.env.DJ_MAGNET_PORT) || 5191, process.env.DJ_MAGNET_HOST || '127.0.0.1', () => console.log('Digital Jiaozi magnet bridge ready; configured=' + Boolean(config.key)));
