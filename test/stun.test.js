'use strict';

const assert = require('node:assert');
const dgram = require('node:dgram');

const { StunServer } = require('../server/src/stun');

const PORT = 25781;

function bindingRequest() {
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4);
  Buffer.from('1234567890abcdef12345678', 'hex').copy(request, 8);
  return request;
}

async function main() {
  const server = new StunServer({ port: PORT, host: '127.0.0.1' });
  await server.start();
  const client = dgram.createSocket('udp4');
  try {
    const request = bindingRequest();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STUN 响应超时')), 3000);
      client.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      client.send(request, PORT, '127.0.0.1');
    });

    assert.equal(response.readUInt16BE(0), 0x0101);
    assert.equal(response.readUInt32BE(4), 0x2112a442);
    assert.deepEqual(response.subarray(8, 20), request.subarray(8, 20), '事务 ID 必须原样返回');

    const attributes = response.subarray(20);
    let offset = 0;
    const types = [];
    while (offset + 4 <= attributes.length) {
      const type = attributes.readUInt16BE(offset);
      const length = attributes.readUInt16BE(offset + 2);
      types.push(type);
      offset += 4 + length;
    }
    assert.ok(types.includes(0x0020), '必须返回 XOR-MAPPED-ADDRESS');
    console.log('✓ STUN Binding / XOR-MAPPED-ADDRESS');
    console.log('\nSTUN 测试通过 ✅');
  } finally {
    client.close();
    await server.stop();
  }
}

main().catch((error) => {
  console.error('\nSTUN 测试失败 ❌');
  console.error(error);
  process.exitCode = 1;
});
