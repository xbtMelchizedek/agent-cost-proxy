// Writes web/sample-calls.jsonl for the page's "synthetic sample" button: the proxy run against the synthetic
// fixtures in test/fixtures (no network, no keys). Run: node scripts/make-sample.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { boot, post, fx } from '../test/helpers.mjs';

const runs = [
  ['openrouter', '/v1/chat/completions', { model: 'deepseek/deepseek-v4.1-flash', messages: [] }, { body: fx('chat_completion_deepseek.json') }, 3],
  ['openrouter', '/v1/chat/completions', { model: 'qwen/qwen3.8-27b', messages: [] }, { body: fx('chat_completion.json') }, 4],
  ['anthropic', '/v1/messages', { model: 'claude-sonnet-5-5-20261001', max_tokens: 1024, stream: true, messages: [] }, { body: fx('anthropic_stream.sse'), type: 'text/event-stream' }, 2],
  ['openai', '/v1/responses', { model: 'gpt-unknown-9', input: 'hi', stream: true }, { body: fx('responses_stream.sse'), type: 'text/event-stream' }, 1],
];
const out = [];
for (const [upstream, path, body, reply, n] of runs) {
  const p = await boot({ upstream, reply });
  for (let i = 0; i < n; i++) await (await post(p.base, path, body)).text();
  await new Promise((r) => setTimeout(r, 50));
  await p.close();
  out.push(...readFileSync(`${p.dir}/calls.jsonl`, 'utf8').split('\n').filter(Boolean));
}
writeFileSync(new URL('../web/sample-calls.jsonl', import.meta.url), out.join('\n') + '\n');
console.log(`${out.length} synthetic calls`);
