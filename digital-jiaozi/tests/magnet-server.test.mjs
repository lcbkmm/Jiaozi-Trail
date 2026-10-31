import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createMagnetHandler, MAGNET_API_PREFIX as prefix } from '../server/magnet/handler.mjs';
import { generateMagnetPanel, validateReference, MagnetError } from '../server/magnet/provider.mjs';
import { loadMagnetConfig } from '../server/magnet/config.mjs';
const config = { ...loadMagnetConfig({ env: {}, loadFile: false }), key: 'test-only-not-a-real-key', cooldownMs: 0 };
const source = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#435eab' } }).png().toBuffer();
const output = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#ded4bf' } }).png().toBuffer();
const result = { imageBase64: output.toString('base64'), mime: 'image/png', width: 120, height: 160, sha256: createHash('sha256').update(output).digest('hex'), model: 'gpt-image-2', provider: 'openai-next', generatedAt: new Date().toISOString() };
function form(id = 'request-0001', overrides = {}) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ requestId: id, category: 'scenery', subjectDescription: '测试桥梁', backgroundColor: '#ded4bf', style: 'enamel', ...overrides })) f.set(k, v);
  f.set('image', new Blob([source], { type: 'image/png' }), 'fixture.png'); return f;
}
async function server(t, cfg = config, generate = async () => result) {
  const handler = createMagnetHandler(cfg, { generate });
  const s = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return 'http://127.0.0.1:' + s.address().port + prefix;
}
test('provider uploads exact reference bytes with only verified fixed parameters; preserves the entire returned PNG', async () => {
  let calls = 0;
  const actual = await generateMagnetPanel({ referenceImage: source, type: 'image/png', category: 'portrait', subjectDescription: '两位旅客', backgroundColor: '#ded4bf', style: 'enamel' }, config, async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai-next.com/v1/images/edits');
    assert.equal(options.headers.Authorization, 'Bearer ' + config.key);
    const f = options.body;
    assert.deepEqual([...f.keys()].sort(), ['image','model','n','size','quality','output_format','prompt'].sort());
    assert.deepEqual(Buffer.from(await f.get('image').arrayBuffer()), source);
    assert.equal(f.get('model'), 'gpt-image-2'); assert.equal(f.get('size'), '1536x2048'); assert.equal(f.get('quality'), 'medium'); assert.equal(f.get('n'), '1'); assert.equal(f.get('output_format'), 'png');
    assert.match(f.get('prompt'), /Q版/); assert.match(f.get('prompt'), /两位旅客/);
    return Response.json({ data: [{ b64_json: output.toString('base64') }] });
  });
  assert.equal(calls, 1); assert.deepEqual(Buffer.from(actual.imageBase64, 'base64'), output); assert.equal(actual.sha256, result.sha256);
});

test('one-click photo-only request reaches the image model once with automatic recognition and color rules; obsolete inputs do not affect replay', async t => {
  let calls = 0;
  const url = await server(t, config, input => generateMagnetPanel(input, config, async (_url, options) => {
    calls++;
    const body = options.body, prompt = body.get('prompt');
    assert.deepEqual(Buffer.from(await body.get('image').arrayBuffer()), source);
    assert.equal(body.get('model'), 'gpt-image-2'); assert.equal(body.get('n'), '1');
    assert.match(prompt, /自行识别主要主体及类别/); assert.match(prompt, /根据照片配色自动选择/);
    assert.match(prompt, /人物为主时采用Q版/); assert.match(prompt, /物体为主/); assert.match(prompt, /景观或建筑为主/);
    assert.doesNotMatch(prompt, /undefined|旧的错误主体|#ff0000/);
    return Response.json({ data: [{ b64_json: output.toString('base64') }] });
  }));
  const body = new FormData(); body.set('requestId', 'request-auto');
  body.set('image', new Blob([source], { type: 'image/png' }), 'photo.png');
  const first = await fetch(url + '/generate', { method: 'POST', body });
  assert.equal(first.status, 200); assert.equal((await first.json()).sha256, result.sha256);
  const replay = await fetch(url + '/generate', { method: 'POST', body: form('request-auto', { category: 'auto', subjectDescription: '旧的错误主体', backgroundColor: '#ff0000' }) });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).replay, true); assert.equal(calls, 1);
});

test('automatic mode still rejects invalid categories, extra parameters, duplicate fields and malformed photos without upstream calls', async t => {
  let calls = 0; const url = await server(t, config, async () => { calls++; return result; });
  for (const overrides of [{ category: 'unknown' }, { category: 'auto', style: 'other' }, { category: 'auto', model: 'other' }, { category: 'auto', subjectDescription: 'x'.repeat(401) }, { category: 'scenery', subjectDescription: '' }]) {
    assert.equal((await fetch(url + '/generate', { method: 'POST', body: form('request-invalid', overrides) })).status, 400);
  }
  const duplicate = form('request-duplicate', { category: 'auto' }); duplicate.append('category', 'portrait');
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: duplicate })).status, 400);
  const broken = form('request-broken', { category: 'auto' }); broken.set('image', new Blob(['broken'], { type: 'image/png' }), 'broken.png');
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: broken })).status, 400);
  assert.equal(calls, 0);
});
test('authorization, rate limiting, timeout, invalid image and URL-only response are explicit; never automatically retried', async () => {
  for (const [status, code] of [[401,'UPSTREAM_AUTH'],[429,'UPSTREAM_RATE'],[500,'UPSTREAM_FAILED']]) {
    let calls = 0;
    await assert.rejects(generateMagnetPanel({ referenceImage: source, type: 'image/png', category: 'object', subjectDescription: '花瓶', backgroundColor: '#ded4bf' }, config, async () => { calls++; return new Response('sensitive upstream body', { status }); }), { code });
    assert.equal(calls, 1);
  }
  for (const data of [{ data: [{ url: 'https://untrusted.invalid/image.png' }] }, { data: [{ b64_json: Buffer.from('not a png').toString('base64') }] }]) {
    await assert.rejects(generateMagnetPanel({ referenceImage: source, type: 'image/png', category: 'object' }, config, async () => Response.json(data)), error => error.uncertain && !error.message.includes('untrusted'));
  }
  await assert.rejects(generateMagnetPanel({ referenceImage: source, type: 'image/png' }, config, async () => { throw new DOMException('timeout', 'TimeoutError'); }), { code: 'UPSTREAM_UNKNOWN', uncertain: true });
  await assert.rejects(validateReference(Buffer.from('broken')), { code: 'IMAGE_DECODE' });
});
test('handler: unavailable config, origin guard, validation, replay and conflict protect the upstream call', async t => {
  const empty = await server(t, { ...config, key: '' });
  assert.equal((await (await fetch(empty + '/status')).json()).configured, false);
  assert.equal((await fetch(empty + '/generate', { method: 'POST', body: form() })).status, 503);
  let calls = 0; const url = await server(t, config, async input => { calls++; assert.deepEqual(input.referenceImage, source); return result; });
  assert.equal((await fetch(url + '/generate', { method: 'POST', headers: { Origin: 'https://evil.invalid' }, body: form() })).status, 403);
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form('invalid-fields', { model: 'other-model' }) })).status, 400);
  const first = await (await fetch(url + '/generate', { method: 'POST', body: form() })).json();
  const replay = await (await fetch(url + '/generate', { method: 'POST', body: form() })).json();
  assert.equal(replay.replay, true); assert.equal(first.sha256, result.sha256); assert.equal(calls, 1);
  const recovered = await (await fetch(url + '/results/request-0001')).json();
  assert.equal(recovered.replay, true); assert.equal(recovered.imageBase64, result.imageBase64); assert.equal(calls, 1);
  assert.equal((await fetch(url + '/results/request-missing')).status, 404);
  assert.equal((await fetch(url + '/results/x')).status, 400);
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form('request-0001', { subjectDescription: '另一张' }) })).status, 409);
  assert.equal(JSON.stringify(first).includes(config.key), false);
});
test('handler: one upstream slot, duplicate pending attempt, unknown result stays cached', async t => {
  let release, calls = 0; const waiting = new Promise(resolve => { release = resolve; });
  const url = await server(t, config, async () => { calls++; await waiting; throw new MagnetError('UPSTREAM_UNKNOWN', '结果未确认', 504, true); });
  const first = fetch(url + '/generate', { method: 'POST', body: form() });
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form() })).status, 409);
  assert.equal((await fetch(url + '/results/request-0001')).status, 409);
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form('request-0002') })).status, 429);
  release(); assert.equal((await first).status, 504);
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form() })).status, 504); assert.equal(calls, 1);
  assert.equal((await fetch(url + '/results/request-0001')).status, 504); assert.equal(calls, 1);
});
test('handler: result cache expires or evicts older entries without making extra upstream requests', async t => {
  let calls = 0;
  const url = await server(t, { ...config, cacheMs: 30 }, async () => { calls++; return result; });
  assert.equal((await fetch(url + '/generate', { method: 'POST', body: form() })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 60));
  const missing = await fetch(url + '/results/request-0001');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.uncertain, true); assert.equal(calls, 1);
  const bounded = await server(t, { ...config, maxCacheBytes: result.imageBase64.length * 1.5 }, async () => { calls++; return result; });
  assert.equal((await fetch(bounded + '/generate', { method: 'POST', body: form('request-cache1') })).status, 200);
  assert.equal((await fetch(bounded + '/generate', { method: 'POST', body: form('request-cache2') })).status, 200);
  assert.equal((await fetch(bounded + '/results/request-cache1')).status, 404);
  assert.equal((await fetch(bounded + '/results/request-cache2')).status, 200); assert.equal(calls, 3);
});
