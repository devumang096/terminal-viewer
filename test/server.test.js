const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { server, screenTail, ownerApp, foregroundProcess, isTrustedRequest } = require('../server');

const trusted = { method: 'GET', headers: { host: 'localhost:4488' } };

test('screenTail keeps the last non-empty lines and trims trailing spaces', () => {
  assert.strictEqual(screenTail('one  \n\ntwo\nthree   \n\n', 2), 'two\nthree');
});

test('foregroundProcess returns the newest child or null', () => {
  assert.strictEqual(foregroundProcess({ pid: 1 }, {}), null);
  assert.deepStrictEqual(foregroundProcess({ pid: 1 }, { 1: [{ pid: 2 }, { pid: 3 }] }), { pid: 3 });
});

test('ownerApp walks parents to find the terminal app', () => {
  const byPid = {
    10: { pid: 10, ppid: 5, command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
    5: { pid: 5, ppid: 1, command: '/sbin/launchd' },
  };
  assert.strictEqual(ownerApp({ pid: 20, ppid: 10, command: '-zsh' }, byPid), 'iTerm2');
});

test('isTrustedRequest rejects foreign hosts, foreign origins and non-JSON posts', () => {
  assert.ok(isTrustedRequest(trusted));
  assert.ok(!isTrustedRequest({ method: 'GET', headers: { host: 'evil.example.com' } }));
  const post = (headers) => ({ method: 'POST', headers: { host: 'localhost:4488', ...headers } });
  assert.ok(isTrustedRequest(post({ 'content-type': 'application/json' })));
  assert.ok(!isTrustedRequest(post({ 'content-type': 'text/plain' })));
  assert.ok(!isTrustedRequest(post({ 'content-type': 'application/json', origin: 'https://evil.example.com' })));
});

test('server answers 403 to a foreign Host and 404 to unknown paths', async (context) => {
  server.listen(0, '127.0.0.1');
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const status = (host, path) => new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.strictEqual(await status('evil.example.com', '/api/terminals'), 403);
  assert.strictEqual(await status('localhost:4488', '/nope'), 404);
});
