import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, main, parsePrice } from '../src/cli.mjs';
import { fakeUpstream, fx, FAKE_KEY } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const snapFile = fileURLToPath(new URL('./fixtures/snapshot.json', import.meta.url));

test('start: one call, prints how to point agents at it, never the key; files are mode 600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-cli-'));
  const logs = [];
  const up = fakeUpstream({ body: fx('chat_completion_deepseek.json') });
  const s = await start({ port: '0', dir, snapshot: snapFile, 'max-day': '5' }, { env: { OPENROUTER_API_KEY: FAKE_KEY }, fetchImpl: up.fetchImpl, log: (x) => logs.push(x) });
  try {
    assert.match(logs[0], /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:\d+\/v1/);
    assert.match(logs[0], /ANTHROPIC_BASE_URL=/);
    assert.match(logs[0], /OPENROUTER_API_KEY is set/);
    assert.match(logs[0], /Caps: on \(day \$5, per call \$5\)/);
    assert.ok(!logs.join('\n').includes(FAKE_KEY));
    const r = await fetch(`${s.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }) });
    assert.equal(r.status, 200);
    await r.text();
  } finally { await s.close(); }
  for (const f of ['ledger.jsonl', 'calls.jsonl']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  let out = '';
  assert.equal(await main(['report', '--dir', dir], { out: (x) => { out = x; } }), 0);
  assert.match(out, /^1 call\(s\) recorded/);
  assert.match(out, /\$0\.00509028 paid vs \$0\.00503 at the cheapest listed venue/);
});

test('flags are checked', async () => {
  assert.deepEqual(parsePrice('3,15'), { inPer1M: '3', outPer1M: '15' });
  assert.throws(() => parsePrice('3'), /--price/);
  let out = '';
  const o = { out: (x) => { out = x; } };
  assert.equal(await main(['--bogus', '1'], o), 2);
  assert.match(out, /unknown option/);
  assert.equal(await main(['--max-day', '0', '--snapshot', 'off', '--port', '0'], o), 2);
  assert.match(out, /above 0/);
  assert.equal(await main(['--upstream', 'http://api.example.com', '--snapshot', 'off'], o), 2);
  assert.match(out, /https/);
});

test('package: bin through a symlink (npx), exports, files and changelog line up', async () => {
  assert.equal(pkg.bin['agent-cost-proxy'], 'src/cli.mjs');
  for (const f of pkg.files) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  assert.match(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), new RegExp(`## ${pkg.version.replaceAll('.', '\\.')} `));
  const m = await import('agent-cost-proxy');
  for (const k of ['createProxy', 'start', 'report', 'cheapest', 'venuePrice', 'sseUsage']) assert.ok(m[k], k);
  const link = join(mkdtempSync(join(tmpdir(), 'acpbin-')), 'agent-cost-proxy');
  symlinkSync(cli, link);
  assert.match(execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' }), /^agent-cost-proxy \d+\.\d+\.\d+/);
  assert.equal(spawnSync(process.execPath, [link, 'nope'], { encoding: 'utf8' }).status, 2);
});
