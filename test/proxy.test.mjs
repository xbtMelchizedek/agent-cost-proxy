import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileLedger } from 'agent-spendcap/file';
import { resolveUpstream } from '../src/proxy.mjs';
import { report } from '../src/report.mjs';
import { boot, post, lines, fx, FAKE_KEY } from './helpers.mjs';

const noKeyAnywhere = (dir, logs) => {
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(FAKE_KEY), `${f} contains the key`);
  assert.ok(!logs.join('\n').includes(FAKE_KEY), 'log contains the key');
};

test('OpenRouter chat: key from env forwarded, body passed through unchanged, reported cost on the ledger, cheapest venue noted', async () => {
  const body = fx('chat_completion_deepseek.json');
  const p = await boot({ reply: { body }, env: { OPENROUTER_API_KEY: FAKE_KEY } });
  try {
    const r = await post(p.base, '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), body);
    assert.equal(r.headers.get('x-upstream'), 'fake');
    assert.equal(p.seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(p.seen[0].headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(p.seen[0].headers['accept-encoding'], 'identity');
    assert.equal(p.seen[0].redirect, 'error');
    await new Promise((r) => setTimeout(r, 20));
    const [c] = lines(p.dir, 'calls.jsonl');
    assert.equal(c.outcome, 'settled');
    assert.deepEqual(c.tokens, { input: 100000, output: 100, cached: 0 });
    assert.deepEqual(c.cost, { usd: '0.00509028', basis: 'reported:openrouter', estimate: false, source: null });
    assert.equal(c.cheapest.provider, 'pearl-labs');
    assert.equal(c.cheapest.usd, '0.00503');
    const led = lines(p.dir, 'ledger.jsonl');
    assert.deepEqual(led.map((e) => e.t), ['reserve', 'settle']);
    assert.equal(led[1].nano, '5090280');
    assert.equal(led[1].receipt, 'gen-synthetic-0006');
    assert.match(p.logs.at(-1), /deepseek-v4\.1-flash · 100000 in \/ 100 out · \$0\.00509028 · cheapest listed: \$0\.00503 at pearl-labs/);
    noKeyAnywhere(p.dir, p.logs);
  } finally { await p.close(); }
});

test('client key wins over env; chat streams get include_usage and pass through byte for byte', async () => {
  const body = fx('chat_stream.sse');
  const p = await boot({ reply: { body, type: 'text/event-stream' }, env: { OPENROUTER_API_KEY: 'env-key-should-not-be-used' } });
  try {
    const r = await post(p.base, '/v1/chat/completions', { model: 'qwen/qwen3.8-27b', stream: true, messages: [] }, { authorization: `Bearer ${FAKE_KEY}` });
    assert.equal(await r.text(), body);
    assert.equal(p.seen[0].headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.deepEqual(JSON.parse(p.seen[0].body).stream_options, { include_usage: true });
    await new Promise((r) => setTimeout(r, 20));
    const [c] = lines(p.dir, 'calls.jsonl');
    assert.equal(c.stream, true);
    assert.equal(c.cost.usd, '0.00031');
    noKeyAnywhere(p.dir, p.logs);
  } finally { await p.close(); }
  const q = await boot({ reply: { body, type: 'text/event-stream' }, injectUsage: false });
  try {
    await (await post(q.base, '/v1/chat/completions', { model: 'qwen/qwen3.8-27b', stream: true, messages: [] })).text();
    assert.equal(JSON.parse(q.seen[0].body).stream_options, undefined);
  } finally { await q.close(); }
});

test('Claude Code style: Anthropic stream, x-api-key passed through, cost estimated from OpenRouter list with cache tokens flagged', async () => {
  const p = await boot({ upstream: 'anthropic', reply: { body: fx('anthropic_stream.sse'), type: 'text/event-stream' } });
  try {
    const r = await post(p.base, '/v1/messages', { model: 'claude-sonnet-5-5-20261001', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': FAKE_KEY, 'anthropic-version': '2023-06-01' });
    await r.text();
    assert.equal(p.seen[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(p.seen[0].headers['x-api-key'], FAKE_KEY);
    assert.equal(p.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(JSON.parse(p.seen[0].body).stream_options, undefined);
    await new Promise((r) => setTimeout(r, 20));
    const [c] = lines(p.dir, 'calls.jsonl');
    // 51,020 input tokens (20 + 1,000 cache write + 50,000 cache read) at $2/M + 400 output at $10/M.
    assert.equal(c.cost.usd, '0.10604');
    assert.equal(c.cost.estimate, true);
    assert.match(c.cost.basis, /^openrouter-list-for:anthropic\/claude-sonnet-5\.5 \(cached input at the full input rate/);
    assert.equal(c.cheapest.provider, 'openrouter');
    noKeyAnywhere(p.dir, p.logs);
  } finally { await p.close(); }
});

test('caps: a call over the daily cap is refused with 403 and never reaches the upstream', async () => {
  const p = await boot({ reply: { body: fx('chat_completion_deepseek.json') }, caps: { maxDay: '0.015' } });
  try {
    const req = { model: 'deepseek/deepseek-v4.1-flash', max_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(50_000) }] };
    // Hold = request bytes as tokens at $0.0507/M + 1000 out at $0.2028/M ≈ $0.0027; each settles at the reported $0.00509028.
    // After 2 calls $0.0102 + hold fits under $0.015; after 3 ($0.0153) the 4th can't.
    assert.equal((await post(p.base, '/v1/chat/completions', req)).status, 200);
    assert.equal((await post(p.base, '/v1/chat/completions', req)).status, 200);
    assert.equal((await post(p.base, '/v1/chat/completions', req)).status, 200);
    const denied = await post(p.base, '/v1/chat/completions', req);
    assert.equal(denied.status, 403);
    const j = await denied.json();
    assert.equal(j.error.type, 'spend_cap');
    assert.match(j.error.message, /day cap/);
    assert.equal(p.seen.length, 3);
    const led = lines(p.dir, 'ledger.jsonl');
    assert.equal(led.at(-1).t, 'deny');
    assert.equal(lines(p.dir, 'calls.jsonl').at(-1).outcome, 'denied');
  } finally { await p.close(); }
});

test('caps: a model with no known price is refused (a cap needs a bound) unless --price is given', async () => {
  const p = await boot({ upstream: 'openai', reply: { body: fx('chat_completion.json') }, caps: { maxCall: '1' } });
  try {
    const r = await post(p.base, '/v1/chat/completions', { model: 'gpt-unknown-9', messages: [] });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error.message, /no price known.*--price/);
    assert.equal(p.seen.length, 0);
  } finally { await p.close(); }
  const q = await boot({ upstream: 'openai', reply: { body: fx('chat_completion.json') }, caps: { maxCall: '1' }, price: { inPer1M: '1', outPer1M: '4' } });
  try {
    assert.equal((await post(q.base, '/v1/chat/completions', { model: 'gpt-unknown-9', max_tokens: 500, messages: [] })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    // OpenAI does not report cost, so tokens × --price: 1200 × $1/M + 300 × $4/M.
    assert.deepEqual(lines(q.dir, 'calls.jsonl')[0].cost, { usd: '0.0024', basis: 'price-flag', estimate: false, source: null });
  } finally { await q.close(); }
});

test('record only: an unpriced model is forwarded and logged as unpriced on the ledger, never as $0', async () => {
  const p = await boot({ upstream: 'openai', reply: { body: fx('responses_stream.sse'), type: 'text/event-stream' } });
  try {
    await (await post(p.base, '/v1/responses', { model: 'gpt-unknown-9', input: 'hi', stream: true })).text();
    await new Promise((r) => setTimeout(r, 20));
    const [c] = lines(p.dir, 'calls.jsonl');
    assert.equal(c.outcome, 'unpriced');
    assert.equal(c.cost, null); // OpenAI upstream: usage.cost isn't trusted unless --trust-reported-cost
    const led = lines(p.dir, 'ledger.jsonl');
    assert.equal(led[0].t, 'unpriced');
    assert.deepEqual(led[0].tokens, { input: 19, output: 277, cached: 0 });
  } finally { await p.close(); }
});

test('upstream errors release the hold; non-metered paths pass through uncounted', async () => {
  const p = await boot({ reply: (s) => (s.url.endsWith('/models') ? { body: '{"data":[]}' } : { status: 500, body: '{"error":{"message":"boom"}}' }) });
  try {
    const r = await post(p.base, '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [] });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error.message, 'boom');
    assert.equal(await (await fetch(`${p.base}/v1/models`)).text(), '{"data":[]}');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(lines(p.dir, 'ledger.jsonl').map((e) => e.t), ['reserve', 'release']);
    assert.deepEqual(lines(p.dir, 'calls.jsonl').map((c) => c.outcome), ['http-error']);
  } finally { await p.close(); }
});

const raw = (base, headers) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const r = request({ host: u.hostname, port: u.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', reject);
  r.end('{"model":"m","messages":[]}');
});

test('local only: browser Origin, foreign Host and non-/v1 paths are refused; upstream must be https', async () => {
  const p = await boot({ reply: { body: '{}' }, env: { OPENROUTER_API_KEY: FAKE_KEY } });
  try {
    assert.equal(await raw(p.base, { origin: 'https://evil.example' }), 403);
    assert.equal(await raw(p.base, { host: 'evil.example' }), 403);
    assert.equal((await fetch(`${p.base}/chat/completions`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal(p.seen.length, 0);
    const st = await (await fetch(`${p.base}/__proxy/status`)).json();
    assert.equal(st.caps, 'record-only');
    assert.ok(!JSON.stringify(st).includes(FAKE_KEY));
  } finally { await p.close(); }
  assert.throws(() => resolveUpstream('http://api.example.com/v1'), /https/);
  assert.throws(() => resolveUpstream('https://user:pw@api.example.com/v1'), /credentials/);
  assert.throws(() => resolveUpstream('nope'), /not openrouter/);
  assert.equal(resolveUpstream('http://127.0.0.1:11434/v1').name, 'local');
});

test('report: totals, cheapest comparison, and a tampered ledger is refused', async () => {
  const p = await boot({ reply: { body: fx('chat_completion_deepseek.json') } });
  try {
    for (let i = 0; i < 2; i++) await (await post(p.base, '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [] })).text();
  } finally { await p.close(); }
  const r = report(p.dir);
  assert.equal(r.ledger.ok, true);
  assert.equal(r.totals.calls, 2);
  assert.equal(r.totals.costUsd, '0.01018056');
  assert.equal(r.totals.cheapestCost, '0.01006');
  assert.deepEqual(r.models[0].cheapest, [{ venue: 'pearl-labs deepseek-ai/DeepSeek-V4.1-Flash', calls: 2 }]);
  const path = join(p.dir, 'ledger.jsonl');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"nano":"5090280"', '"nano":"1"'), { mode: 0o600 });
  assert.throws(() => report(p.dir), /altered/);
  assert.throws(() => fileLedger(path, { readOnly: true }), /altered/);
});

test('real HTTP end to end: local upstream over loopback, streamed in slow chunks, client disconnects mid-stream', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createProxy, resolveUpstream } = await import('../src/proxy.mjs');
  const { SNAP } = await import('./helpers.mjs');
  const sse = fx('chat_stream.sse');
  let got = null;
  const upstream = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    got = { auth: req.headers.authorization, body: JSON.parse(b) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < sse.length; i += 50) { res.write(sse.slice(i, i + 50)); await new Promise((r) => setTimeout(r, 5)); }
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'acp-e2e-'));
  const { server } = createProxy({ dir, upstream: resolveUpstream(`http://127.0.0.1:${upstream.address().port}/v1`, { UPSTREAM_API_KEY: FAKE_KEY }), env: { UPSTREAM_API_KEY: FAKE_KEY }, snapshot: () => SNAP, price: { inPer1M: '1', outPer1M: '2' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await post(base, '/v1/chat/completions', { model: 'qwen/qwen3.8-27b', stream: true, messages: [] });
    assert.equal(await r.text(), sse);
    assert.equal(got.auth, `Bearer ${FAKE_KEY}`);
    // Disconnect after the first bytes: the proxy keeps reading so the call is still costed.
    const r2 = await post(base, '/v1/chat/completions', { model: 'qwen/qwen3.8-27b', stream: true, messages: [] }, {});
    const rd = r2.body.getReader(); await rd.read(); await rd.cancel();
    await new Promise((r) => setTimeout(r, 300));
    const calls = lines(dir, 'calls.jsonl');
    assert.equal(calls.length, 2);
    for (const c of calls) assert.equal(c.cost.usd, '0.0012'); // 800 × $1/M + 200 × $2/M, local upstream: usage.cost not trusted
    assert.ok(!readFileSync(join(dir, 'calls.jsonl'), 'utf8').includes(FAKE_KEY));
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

test('FLOP JSON: cost_flop and x_flop_receipt are logged, not used as USD; spendcap receipt uses the request id', async () => {
  const body = fx('flop_completion.json');
  const p = await boot({ upstream: 'https://api.flop.network/v1', reply: { body }, caps: { maxCall: "1", maxDay: "1" }, price: { inPer1M: '1', outPer1M: '1' }, env: { UPSTREAM_API_KEY: FAKE_KEY } });
  try {
    const r = await post(p.base, '/v1/chat/completions', { model: 'qwen/qwen2.5-0.5b-instruct', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), body);
    await new Promise((r) => setTimeout(r, 20));
    const [c] = lines(p.dir, 'calls.jsonl');
    assert.equal(c.costFlop, 0.000016);
    assert.equal(c.flopReceipt.miner, '5FakeMinerAddressForTestsOnlyDontUse');
    assert.equal(c.flopReceipt.channel_id, '0xabc');
    assert.ok(!JSON.stringify(c).includes('this must never be logged'));
    assert.equal(c.cost.basis, 'price-flag'); // FLOP is not treated as usage.cost USD
    const led = lines(p.dir, 'ledger.jsonl');
    assert.equal(led[1].t, 'settle');
    assert.equal(led[1].receipt, 'chatcmpl-synthetic-flop');
    noKeyAnywhere(p.dir, p.logs);
  } finally { await p.close(); }
});

test('banned User-Agent (Python-urllib) is replaced before the upstream; curl is forwarded', async () => {
  const body = fx('chat_completion.json');
  const p = await boot({ reply: { body }, env: { OPENROUTER_API_KEY: FAKE_KEY } });
  try {
    await (await post(p.base, '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [] }, { 'user-agent': 'Python-urllib/3.13' })).text();
    assert.equal(p.seen[0].headers['user-agent'], 'agent-cost-proxy/0.1.2');
    await (await post(p.base, '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [] }, { 'user-agent': 'curl/8.5.0' })).text();
    assert.equal(p.seen[1].headers['user-agent'], 'curl/8.5.0');
    noKeyAnywhere(p.dir, p.logs);
  } finally { await p.close(); }
});

