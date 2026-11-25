import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromJson, sseUsage, normalize, sanitizeReceipt } from '../src/usage.mjs';
import { modelKey, venuePrice, cheapest } from '../src/prices.mjs';
import { fx, SNAP } from './helpers.mjs';

const sse = (text, step = 23) => { const r = sseUsage(); for (let i = 0; i < text.length; i += step) r.push(text.slice(i, i + step)); return r.result(); };

test('usage: chat JSON, chat stream, Responses stream, Anthropic JSON and stream', () => {
  assert.deepEqual(fromJson(JSON.parse(fx('chat_completion.json'))), { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, reportedCostUsd: 0.0004213, id: 'gen-synthetic-0001', costFlop: null, flopReceipt: null });
  assert.deepEqual(sse(fx('chat_stream.sse')), { inputTokens: 800, outputTokens: 200, cachedTokens: 0, reportedCostUsd: 0.00031, id: 'gen-synthetic-0002', costFlop: null, flopReceipt: null });
  assert.deepEqual(sse(fx('responses_stream.sse'), 7), { inputTokens: 19, outputTokens: 277, cachedTokens: 0, reportedCostUsd: 0.005616, id: 'resp-synthetic-0003', costFlop: null, flopReceipt: null });
  // Anthropic input_tokens excludes cache writes and reads; the total billed input is all three.
  assert.deepEqual(fromJson(JSON.parse(fx('anthropic_message.json'))), { inputTokens: 51020, outputTokens: 400, cachedTokens: 51000, reportedCostUsd: null, id: 'msg_synthetic_0004', costFlop: null, flopReceipt: null });
  assert.deepEqual(sse(fx('anthropic_stream.sse'), 11), { inputTokens: 51020, outputTokens: 400, cachedTokens: 51000, reportedCostUsd: null, id: 'msg_synthetic_0005', costFlop: null, flopReceipt: null });
  assert.equal(sse('data: {"choices":[]}\n\ndata: [DONE]\n\n'), null);
  assert.equal(normalize({ prompt_tokens: -1, completion_tokens: 'x' }), null);
  assert.deepEqual(normalize({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }), { inputTokens: 100, outputTokens: 5, cachedTokens: 80, reportedCostUsd: null });
});

test('modelKey: Anthropic API ids meet OpenRouter and Venice ids; others use justweight canonicalModel', () => {
  assert.equal(modelKey('claude-sonnet-5-5-20261001').key, 'claude-sonnet-5.5');
  assert.equal(modelKey('anthropic/claude-sonnet-5.5').key, 'claude-sonnet-5.5');
  assert.equal(modelKey('venice/claude-sonnet-5-5').key, 'claude-sonnet-5.5');
  assert.equal(modelKey('Qwen/Qwen3.8-27B-TEE').key, 'qwen3.8-27b');
  assert.equal(modelKey('qwen3-8b').key, 'qwen3-8b'); // the digit rule is Claude-only
});

test('venuePrice: --price, then exact listing at the venue, then OpenRouter list flagged estimate, else null', () => {
  assert.deepEqual(venuePrice(SNAP, 'openrouter', 'x/y', { inPer1M: '1', outPer1M: '2' }), { inPer1M: '1', outPer1M: '2', basis: 'price-flag', source: null, estimate: false });
  const or = venuePrice(SNAP, 'openrouter', 'deepseek/deepseek-v4.1-flash');
  assert.equal(or.basis, 'list-price:openrouter');
  assert.equal(or.estimate, false);
  assert.deepEqual([or.inPer1M, or.outPer1M], ['0.0507', '0.2028']);
  const an = venuePrice(SNAP, 'anthropic', 'claude-sonnet-5-5-20261001');
  assert.equal(an.basis, 'openrouter-list-for:anthropic/claude-sonnet-5.5');
  assert.equal(an.estimate, true);
  assert.equal(venuePrice(SNAP, 'openai', 'gpt-unknown-9'), null);
  // A local or custom upstream is never priced from OpenRouter's list: running Qwen on your own GPU isn't $0.06/M.
  assert.equal(venuePrice(SNAP, 'local', 'qwen/qwen3.8-27b'), null);
  assert.equal(venuePrice(SNAP, 'custom:api.example.com', 'qwen/qwen3.8-27b'), null);
  assert.equal(venuePrice(null, 'openrouter', 'deepseek/deepseek-v4.1-flash'), null);
});

test('cheapest: lowest USD list price for the same model key and tokens; batch and non-USD rows skipped', () => {
  // 100k in / 100 out: Pearl (0.05/0.30) beats OpenRouter (0.0507/0.2028); the 0.05/0.15 :batch row is skipped.
  const c = cheapest(SNAP, 'deepseek/deepseek-v4.1-flash', 100000, 100);
  assert.equal(c.provider, 'pearl-labs');
  assert.equal(c.nano, '5030000'); // $0.00503
  // 1200 in / 300 out on Qwen3.8-27B: Chutes at 0.039/1.25 = $0.0004218, tie broken by provider name.
  const q = cheapest(SNAP, 'qwen/qwen3.8-27b', 1200, 300);
  assert.equal(q.provider, 'chutes-bittensor');
  assert.equal(q.nano, '421800');
  assert.equal(cheapest(SNAP, 'nothing/listed', 1, 1), null);
  assert.equal(cheapest(SNAP, 'qwen/qwen3.8-27b', null, 1), null);
  const junk = { offers: [{ provider: 'a', model: 'm', unit: 'USD', inPer1M: '-1', outPer1M: '1' }, { provider: 'b', model: 'm', unit: 'USD', inPer1M: '1e-7', outPer1M: '1' }] };
  assert.equal(cheapest(junk, 'm', 10, 10), null);
});

test('FLOP: cost_flop and a sanitized x_flop_receipt are recorded, never as USD; nested junk is dropped', () => {
  const j = JSON.parse(fx('flop_completion.json'));
  const u = fromJson(j);
  assert.equal(u.inputTokens, 12);
  assert.equal(u.outputTokens, 4);
  assert.equal(u.reportedCostUsd, null); // usage.cost_flop is not usage.cost
  assert.equal(u.costFlop, 0.000016);
  assert.deepEqual(u.flopReceipt, { miner: '5FakeMinerAddressForTestsOnlyDontUse', cost_flop: 0.000016, channel_id: '0xabc', terminal_event: '0xdef:1', request_id: 'req-synthetic-flop-1' });
  assert.equal('prompt' in (u.flopReceipt), false);
  const streamed = sse(fx('flop_stream.sse'));
  assert.equal(streamed.costFlop, 0.000016);
  assert.equal(streamed.flopReceipt.miner, '5FakeMinerAddressForTestsOnlyDontUse');
  assert.equal(sanitizeReceipt({ miner: '5A', prompt: 'secret', nested: { x: 1 } }).miner, '5A');
  assert.equal('prompt' in sanitizeReceipt({ miner: '5A', prompt: 'secret' }), false);
  assert.equal(sanitizeReceipt({ nested: { miner: '5A' } }), null);
});

