#!/usr/bin/env node
// agent-cost-proxy: one command, a local proxy for coding agents that records what every call really cost.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxy, resolveUpstream, capsPolicy, UPSTREAMS } from './proxy.mjs';
import { loadSnapshot, SNAPSHOT_URL } from './prices.mjs';
import { report, reportText } from './report.mjs';
import { fromNano } from 'agent-spendcap';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_DIR = join(homedir(), '.agent-cost-proxy');
const HELP = `agent-cost-proxy ${VERSION}: what your coding agent's calls really cost, and what they'd cost at the cheapest venue

  agent-cost-proxy [--upstream openrouter|openai|anthropic|<url>] [--port 8788] [--max-call <usd>] [--max-day <usd>]
                   [--policy <agent-spendcap policy.json>] [--price <in>,<out>] [--dir ~/.agent-cost-proxy]
                   [--snapshot <url|file|off>] [--assume-max-output 32000] [--no-usage-inject] [--trust-reported-cost]
  agent-cost-proxy report [--dir ~/.agent-cost-proxy] [--json]

Then point your agent at it, e.g.
  OPENAI_BASE_URL=http://127.0.0.1:8788/v1        (Codex, Hermes, most OpenAI-compatible agents)
  ANTHROPIC_BASE_URL=http://127.0.0.1:8788         (Claude Code, with --upstream anthropic)

Your key: whatever your agent sends (Authorization or x-api-key) is passed through. If it sends none, the proxy
uses ${Object.values(UPSTREAMS).map((u) => u.keyEnv).join(', ')} (by upstream) or UPSTREAM_API_KEY from its own environment.
Keys, prompts and responses are never written to disk or printed. Listens on 127.0.0.1 only.
Prices: ${SNAPSHOT_URL}`;

const FLAGS = new Set(['upstream', 'port', 'max-call', 'max-day', 'policy', 'price', 'dir', 'snapshot', 'assume-max-output']);
const BOOL = new Set(['no-usage-inject', 'trust-reported-cost', 'json']);

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; continue; }
    if (!FLAGS.has(k)) throw new Error(`unknown option ${a}`);
    if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
    o[k] = argv[++i];
  }
  return o;
}

const DEC = /^\d+(\.\d{1,9})?$/;
export function parsePrice(s) {
  if (s === undefined) return null;
  const [a, b] = String(s).split(',');
  if (!DEC.test(a ?? '') || !DEC.test(b ?? '')) throw new Error('--price must be <in>,<out> in USD per 1M tokens, e.g. 3,15');
  return { inPer1M: a, outPer1M: b };
}

function usdFlag(v, name) {
  if (v === undefined) return undefined;
  if (!DEC.test(v) || Number(v) === 0) throw new Error(`${name} must be a USD amount above 0, e.g. 0.50`);
  return v;
}

/** Start from parsed options. Resolves once listening; returns { server, url, close }. */
export async function start(o, { env = process.env, fetchImpl = globalThis.fetch, log = (s) => console.error(s) } = {}) {
  const upstream = resolveUpstream(o.upstream ?? 'openrouter', env);
  const port = o.port === undefined ? 8788 : Number(o.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
  const amo = o['assume-max-output'] === undefined ? 32000 : Number(o['assume-max-output']);
  if (!Number.isSafeInteger(amo) || amo < 1) throw new Error('--assume-max-output must be a whole number above 0');
  const policy = capsPolicy({ maxCall: usdFlag(o['max-call'], '--max-call'), maxDay: usdFlag(o['max-day'], '--max-day'), policy: o.policy ? JSON.parse(readFileSync(o.policy, 'utf8')) : undefined });
  const price = parsePrice(o.price);
  const src = o.snapshot ?? SNAPSHOT_URL;
  let snap = null;
  const refresh = async () => {
    try { snap = await loadSnapshot(src, { fetchImpl }); } catch (e) { log(`prices: could not load ${src} (${e.message}); costs need --price or upstream-reported cost`); }
  };
  await refresh();
  const timer = src === 'off' ? null : setInterval(refresh, 2 * 3600 * 1000);
  timer?.unref();
  const dir = o.dir ?? DEFAULT_DIR;
  const { server, cap } = createProxy({ dir, upstream, policy, snapshot: () => snap, price, assumeMaxOutput: amo, injectUsage: !o['no-usage-inject'], trustReportedCost: o['trust-reported-cost'] ? true : undefined, env, fetchImpl, log });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const keyNote = upstream.keyEnv && env[upstream.keyEnv] ? `${upstream.keyEnv} is set (used only if your agent sends no key)` : 'your agent\'s own key header is passed through';
  log([
    `agent-cost-proxy ${VERSION} on ${url} → ${upstream.base}`,
    `  OpenAI-style agents: OPENAI_BASE_URL=${url}/v1   Claude Code: ANTHROPIC_BASE_URL=${url}`,
    `  key: ${keyNote}. Caps: ${policy ? `on (${cap.status().windows.map((w) => `${w.window} $${w.maxUsd}`).join(', ')}, per call $${fromNano(policy.perCallMax)})` : 'off (record only)'}.`,
    `  prices: ${snap ? `${snap.offers?.length ?? 0} offers from justweight, ${snap.generatedAt}` : 'none loaded'}. Ledger: ${dir}`,
  ].join('\n'));
  return { server, url, close: () => new Promise((r) => { clearInterval(timer); server.close(r); }) };
}

export async function main(argv, { out = console.log, env = process.env, fetchImpl, log } = {}) {
  try {
    if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) { out(HELP); return 0; }
    if (argv[0] === 'version' || argv.includes('--version')) { out(VERSION); return 0; }
    const o = parseArgs(argv);
    const cmd = o._[0];
    if (cmd === 'report') {
      const r = report(o.dir ?? DEFAULT_DIR);
      out(o.json ? JSON.stringify(r, null, 1) : reportText(r));
      return 0;
    }
    if (cmd !== undefined && cmd !== 'start') throw new Error(`unknown command ${cmd}`);
    const s = await start(o, { env, fetchImpl, ...(log ? { log } : {}) });
    const stop = () => s.close().then(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return null; // keep running
  } catch (e) {
    out(JSON.stringify({ ok: false, error: e.message }));
    return 2;
  }
}

function isEntry() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) main(process.argv.slice(2)).then((c) => { if (c !== null) process.exit(c); });
