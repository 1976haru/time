import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run with: node --test tests/ytOAuth.multiClient.test.mjs
// Isolated temp copy: never touches the real local .yt_oauth.json.
async function fixture(initialFile) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sunosub-oauth-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../lib/ytOAuth.js', import.meta.url), path.join(root, 'lib', 'ytOAuth.js'));
  fs.writeFileSync(path.join(root, 'lib', 'ytErrorLog.js'), 'export const logYtApiError = () => {};\n');
  fs.writeFileSync(path.join(root, '.yt_oauth.json'), JSON.stringify(initialFile, null, 2));
  const oauth = await import(pathToFileURL(path.join(root, 'lib', 'ytOAuth.js')).href);
  return { oauth, root, read: () => JSON.parse(fs.readFileSync(path.join(root, '.yt_oauth.json'), 'utf8')) };
}

const aClient = 'client-a.apps.googleusercontent.com';
const bClient = 'client-b.apps.googleusercontent.com';

test('02/03/05 B add with a different client preserves A', async () => {
  const f = await fixture({
    clientId: aClient, clientSecret: 'a-secret',
    activeAccountId: 'account-A',
    accounts: [{ id: 'account-A', label: 'A', refreshToken: 'a-refresh',
      channelId: 'UC_A', channelTitle: 'OldPopLounge', connectedAt: '2026-10-28T00:00:00Z' }],
  });
  const originalFetch = globalThis.fetch;
  try {
    f.oauth.saveClientCredentials(bClient, 'b-secret');
    let saved = f.read();
    assert.equal(saved.accounts[0].refreshToken, 'a-refresh');
    assert.equal(saved.accounts[0].clientId, aClient);
    assert.equal(saved.accounts[0].clientSecret, 'a-secret');
    assert.equal(saved.clientId, bClient);

    const start = new URL(f.oauth.buildAuthUrl(5300, { label: 'B' }));
    assert.equal(start.searchParams.get('client_id'), bClient);
    assert.match(start.searchParams.get('prompt'), /select_account/);
    const pending = f.oauth.consumeState(start.searchParams.get('state'));

    globalThis.fetch = async (url, options) => {
      if (String(url).includes('youtube/v3/channels')) {
        return new Response(JSON.stringify({ items: [{ id: 'UC_B', snippet: { title: 'B channel' } }] }), { status: 200 });
      }
      assert.equal(String(url), 'https://oauth2.googleapis.com/token');
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('client_id'), bClient);
        return new Response(JSON.stringify({ access_token: 'b-access', refresh_token: 'b-refresh', expires_in: 3600 }), { status: 200 });
      }
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('client_id'), aClient);
      assert.equal(form.get('refresh_token'), 'a-refresh');
      return new Response(JSON.stringify({ access_token: 'a-access', expires_in: 3600 }), { status: 200 });
    };
    const newAccount = await f.oauth.exchangeCodeForTokens('b-auth-code', 5300, pending);
    saved = f.read();
    assert.equal(saved.accounts.length, 2);
    assert.equal(saved.accounts[0].refreshToken, 'a-refresh');
    assert.equal(saved.accounts[1].clientId, bClient);
    assert.equal(saved.accounts[1].refreshToken, 'b-refresh');
    assert.equal(await f.oauth.getAccessToken('account-A'), 'a-access');
    assert.equal(await f.oauth.getAccessToken(newAccount.accountId), 'b-access');

    f.oauth.saveClientCredentials(aClient, 'a-secret');
    const bReconnect = new URL(f.oauth.buildAuthUrl(5300, { reconnectId: newAccount.accountId }));
    assert.equal(bReconnect.searchParams.get('client_id'), bClient, 'B reconnect must not use the new default');
    assert.equal(f.read().accounts[1].refreshToken, 'b-refresh');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('13 wrong Google/channel reconnect is rejected without mutation', async () => {
  const f = await fixture({
    clientId: bClient, clientSecret: 'b-secret',
    activeAccountId: 'account-A',
    accounts: [{ id: 'account-A', label: 'A', refreshToken: '', channelId: 'UC_A' }],
  });
  const originalFetch = globalThis.fetch;
  try {
    f.oauth.saveClientCredentials(aClient, 'a-secret');
    const start = new URL(f.oauth.buildAuthUrl(5300, { reconnectId: 'account-A' }));
    assert.equal(start.searchParams.get('client_id'), aClient);
    const pending = f.oauth.consumeState(start.searchParams.get('state'));
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        assert.equal(new URLSearchParams(options.body).get('client_id'), aClient);
        return new Response(JSON.stringify({ access_token: 'other-access', refresh_token: 'other-refresh', expires_in: 3600 }), { status: 200 });
      }
      assert.match(String(url), /youtube\/v3\/channels/);
      return new Response(JSON.stringify({ items: [{ id: 'UC_NOT_A' }] }), { status: 200 });
    };
    await assert.rejects(f.oauth.exchangeCodeForTokens('wrong-code', 5300, pending), /다른 유튜브 채널/);
    assert.equal(f.read().accounts[0].refreshToken, '', 'wrong-channel reconnect must preserve the old account row');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

async function connect(f, { clientId = aClient, secret = 'a-secret', label = 'A', channelId = 'UC_A', title = 'A channel', reconnectId = '' } = {}) {
  f.oauth.saveClientCredentials(clientId, secret);
  const client = f.oauth.listOAuthClients().find((row) => row.preview.includes(clientId.split('.')[0].slice(0, 8)));
  const start = new URL(f.oauth.buildAuthUrl(5300, { label, reconnectId, clientKey: reconnectId ? '' : client?.id }));
  const pending = f.oauth.consumeState(start.searchParams.get('state'));
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('oauth2.googleapis.com')
    ? new Response(JSON.stringify({ access_token: `access-${channelId}`, refresh_token: `refresh-${channelId}`, expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ items: [{ id: channelId, snippet: { title } }] }), { status: 200 });
  try { return await f.oauth.exchangeCodeForTokens('code', 5300, pending); }
  finally { globalThis.fetch = previous; }
}

test('01 A first connection stores client, token and verified channel', async () => {
  const f = await fixture({});
  try {
    const result = await connect(f, {});
    const saved = f.read();
    assert.equal(saved.accounts.length, 1);
    assert.equal(saved.accounts[0].channelId, 'UC_A');
    assert.equal(saved.accounts[0].refreshToken, 'refresh-UC_A');
    assert.equal(result.channelTitle, 'A channel');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('04 adding C preserves A and B', async () => {
  const f = await fixture({});
  try {
    await connect(f, {});
    await connect(f, { clientId: bClient, secret: 'b-secret', label: 'B', channelId: 'UC_B' });
    await connect(f, { clientId: 'client-c.apps.googleusercontent.com', secret: 'c-secret', label: 'C', channelId: 'UC_C' });
    assert.deepEqual(f.read().accounts.map((a) => a.refreshToken), ['refresh-UC_A', 'refresh-UC_B', 'refresh-UC_C']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('06 one OAuth client authorizes multiple independent accounts', async () => {
  const f = await fixture({});
  try {
    await connect(f, {});
    await connect(f, { label: 'B', channelId: 'UC_B' });
    const saved = f.read();
    assert.equal(saved.accounts[0].clientId, saved.accounts[1].clientId);
    assert.notEqual(saved.accounts[0].refreshToken, saved.accounts[1].refreshToken);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('07 reconnecting A preserves B', async () => {
  const f = await fixture({});
  try {
    const a = await connect(f, {});
    await connect(f, { clientId: bClient, secret: 'b-secret', label: 'B', channelId: 'UC_B' });
    await connect(f, { label: 'A2', channelId: 'UC_A', reconnectId: a.accountId });
    assert.equal(f.read().accounts.find((x) => x.channelId === 'UC_B').refreshToken, 'refresh-UC_B');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('08 deleting B preserves A', async () => {
  const f = await fixture({});
  try {
    const a = await connect(f, {});
    const b = await connect(f, { label: 'B', channelId: 'UC_B' });
    f.oauth.disconnect(b.accountId);
    assert.deepEqual(f.read().accounts.map((x) => x.id), [a.accountId]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('09 restart-compatible disk state preserves account selection', async () => {
  const f = await fixture({});
  try {
    const a = await connect(f, {});
    f.oauth.renameAccount(a.accountId, 'renamed A');
    assert.equal(f.oauth.readOAuthFile().accounts[0].label, 'renamed A');
    assert.equal(f.oauth.readOAuthFile().activeAccountId, a.accountId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('10 A video API uses only A token', async () => {
  const f = await fixture({ clientId: aClient, clientSecret: 'a-secret', activeAccountId: 'A', accounts: [
    { id: 'A', label: 'A', clientId: aClient, clientSecret: 'a-secret', refreshToken: 'refresh-A', channelId: 'UC_A' },
    { id: 'B', label: 'B', clientId: bClient, clientSecret: 'b-secret', refreshToken: 'refresh-B', channelId: 'UC_B' },
  ] });
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => String(url).includes('oauth2.googleapis.com')
      ? new Response(JSON.stringify({ access_token: `token-${new URLSearchParams(options.body).get('refresh_token')}`, expires_in: 3600 }), { status: 200 })
      : (assert.equal(options.headers.Authorization, 'Bearer token-refresh-A'), new Response('{"items":[]}', { status: 200 }));
    await f.oauth.youtubeApi('videos', { query: { part: 'snippet', id: 'videoA' }, accountId: 'A' });
  } finally { globalThis.fetch = old; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('11 B video API uses only B token', async () => {
  const f = await fixture({ clientId: aClient, clientSecret: 'a-secret', accounts: [
    { id: 'A', label: 'A', clientId: aClient, clientSecret: 'a-secret', refreshToken: 'refresh-A', channelId: 'UC_A' },
    { id: 'B', label: 'B', clientId: bClient, clientSecret: 'b-secret', refreshToken: 'refresh-B', channelId: 'UC_B' },
  ], activeAccountId: 'A' });
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => String(url).includes('oauth2.googleapis.com')
      ? new Response(JSON.stringify({ access_token: `token-${new URLSearchParams(options.body).get('refresh_token')}`, expires_in: 3600 }), { status: 200 })
      : (assert.equal(options.headers.Authorization, 'Bearer token-refresh-B'), new Response('{"items":[]}', { status: 200 }));
    await f.oauth.youtubeApi('videos', { query: { part: 'snippet', id: 'videoB' }, accountId: 'B' });
  } finally { globalThis.fetch = old; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('12 upload ownership guard blocks another channel and unknown identity', async () => {
  const f = await fixture({});
  try {
    assert.equal(f.oauth.assertAccountOwnsChannel({ label: 'A', channelId: 'UC_A' }, 'UC_A'), true);
    assert.throws(() => f.oauth.assertAccountOwnsChannel({ label: 'A', channelId: 'UC_A' }, 'UC_B'), (e) => e.status === 403);
    assert.throws(() => f.oauth.assertAccountOwnsChannel({ label: 'A' }, 'UC_A'), (e) => e.status === 409);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('14 invalid_grant affects only requested account', async () => {
  const f = await fixture({ clientId: aClient, clientSecret: 'a-secret', activeAccountId: 'A', accounts: [
    { id: 'A', label: 'A', clientId: aClient, clientSecret: 'a-secret', refreshToken: 'bad-A' },
    { id: 'B', label: 'B', clientId: bClient, clientSecret: 'b-secret', refreshToken: 'good-B' },
  ] });
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
    await assert.rejects(f.oauth.getAccessToken('A'), (e) => e.status === 401);
    assert.equal(f.read().accounts[1].refreshToken, 'good-B');
  } finally { globalThis.fetch = old; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('15 legacy file migration preserves refresh token and creates backup', async () => {
  const f = await fixture({ clientId: aClient, clientSecret: 'a-secret', refreshToken: 'legacy-token', channelId: 'UC_OLD', channelTitle: 'Old' });
  try {
    const migrated = f.oauth.readOAuthFile();
    assert.equal(migrated.accounts[0].refreshToken, 'legacy-token');
    assert.equal(migrated.accounts[0].clientId, aClient);
    assert.ok(fs.existsSync(path.join(f.root, '.yt_oauth.json.bak')));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('16 injected save failure preserves original file', async () => {
  const initial = { clientId: aClient, clientSecret: 'a-secret', accounts: [], activeAccountId: '' };
  const f = await fixture(initial);
  const before = fs.readFileSync(path.join(f.root, '.yt_oauth.json'), 'utf8');
  try {
    process.env.YT_OAUTH_TEST_FAIL_BEFORE_REPLACE = '1';
    assert.throws(() => f.oauth.saveClientCredentials(bClient, 'b-secret'), /injected/);
    assert.equal(fs.readFileSync(path.join(f.root, '.yt_oauth.json'), 'utf8'), before);
  } finally {
    delete process.env.YT_OAUTH_TEST_FAIL_BEFORE_REPLACE;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('duplicate channel registration is rejected without replacing the first token', async () => {
  const f = await fixture({});
  try {
    await connect(f, {});
    await assert.rejects(connect(f, { label: 'duplicate', channelId: 'UC_A' }), (e) => e.status === 409);
    assert.equal(f.read().accounts.length, 1);
    assert.equal(f.read().accounts[0].refreshToken, 'refresh-UC_A');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('OAuth state is one-time and pins client against callback race', async () => {
  const f = await fixture({});
  try {
    f.oauth.saveClientCredentials(aClient, 'a-secret');
    const start = new URL(f.oauth.buildAuthUrl(5300));
    f.oauth.saveClientCredentials(bClient, 'b-secret');
    const pending = f.oauth.consumeState(start.searchParams.get('state'));
    assert.equal(pending.clientId, aClient);
    assert.equal(f.oauth.consumeState(start.searchParams.get('state')), null);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
