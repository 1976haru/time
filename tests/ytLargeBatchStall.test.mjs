import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const client = fs.readFileSync(new URL('../tools/yt/app.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../routes/yt.js', import.meta.url), 'utf8');

function takeFunction(source, name) {
  const match = source.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(match, `${name} must be present`);
  return match[0];
}
function calculate(source, name, scope, title, description, total) {
  const expression = [
    'const TRANSLATE_TOKEN_BUDGET = 12000;',
    'const MAX_TRANSLATE_BATCH_LANGUAGES = 12;',
    takeFunction(source, name),
    name === 'estimateBatchSize' ? `${name}(${JSON.stringify(scope)}, ${JSON.stringify(title)}, ${JSON.stringify(description)}, ${total})`
      : `${name}(${JSON.stringify(scope)}, ${JSON.stringify(title)}, ${JSON.stringify(description)})`,
  ].join('\n');
  return vm.runInNewContext(expression);
}
test('82 title languages split into 7 calls no larger than 12', () => {
  const clientSize = calculate(client, 'estimateBatchSize', 'title', 'Tokyo café', '', 82);
  const serverSize = calculate(server, 'estimateMaxBatchSize', 'title', 'Tokyo café', '');
  assert.equal(clientSize, 12);
  assert.equal(serverSize, 12);
  const pieces = Array.from({ length: Math.ceil(82 / clientSize) }, (_, i) => Math.min(clientSize, 82 - i * clientSize));
  assert.equal(pieces.length, 7);
  assert.equal(pieces.reduce((a, b) => a + b, 0), 82);
});
test('long descriptions use smaller synchronized batches', () => {
  const description = '가'.repeat(4000);
  assert.equal(calculate(client, 'estimateBatchSize', 'full', 'Title', description, 82), 5);
  assert.equal(calculate(server, 'estimateMaxBatchSize', 'full', 'Title', description), 5);
});
test('83-language catalogue remains separate from per-request cap', () => {
  assert.ok(server.includes('maxLanguagesPerRequest()'));
  assert.ok(server.includes('getLanguageCatalog'));
  assert.ok(!/languages\\.length\\s*>\\s*50/.test(server));
});
test('client shows heartbeat progress and terminates silent requests', () => {
  assert.ok(client.includes('setInterval(paintWaiting, 1000)'));
  assert.ok(client.includes('signal: controller.signal'));
  assert.ok(client.includes('clearInterval(heartbeat)'));
  assert.ok(client.includes('TRANSLATE_REQUEST_TIMEOUT_MS = 180000'));
  assert.ok(client.includes('pendingLanguages(overallLanguages).length'));
});
