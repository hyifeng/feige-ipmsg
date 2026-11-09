'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createHubServer } = require('./hub');

function readTls() {
  const certPath = process.env.HUB_TLS_CERT;
  const keyPath = process.env.HUB_TLS_KEY;
  if (!certPath || !keyPath) return null;
  return {
    cert: fs.readFileSync(path.resolve(certPath)),
    key: fs.readFileSync(path.resolve(keyPath)),
  };
}

async function main() {
  const hub = createHubServer({
    port: Number(process.env.HUB_PORT) || 8787,
    host: process.env.HUB_HOST || '0.0.0.0',
    stunPort: Number(process.env.STUN_PORT) || 3478,
    stunHost: process.env.STUN_HOST || '0.0.0.0',
    tls: readTls(),
  });

  const shutdown = async () => {
    await hub.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await hub.start();
}

main().catch((error) => {
  console.error('[feige-hub] 启动失败', error);
  process.exit(1);
});
