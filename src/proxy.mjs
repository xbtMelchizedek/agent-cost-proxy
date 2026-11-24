// The proxy: 127.0.0.1 only, forwards each call to the upstream with the caller's own key, reads the real usage
// from the response as it streams through, and records the cost on an agent-spendcap ledger next to what the same
// tokens would have cost at the cheapest venue justweight lists. Prompts, responses and keys are never stored.
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SpendCap, parsePolicy, fromNano, toNano } from 'agent-spendcap';
import { fileLedger } from 'agent-spendcap/file';
import { costOf, reportedNano } from 'agent-spendcap/openai';
import { fromJson, sseUsage } from './usage.mjs';
import { venuePrice, cheapest } from './prices.mjs';

export const UPSTREAMS = {
  openrouter: { base: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', auth: 'bearer', reportsCost: true },
  openai: { base: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', auth: 'bearer', reportsCost: false },
  anthropic: { base: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', auth: 'x-api-key', reportsCost: false },
};

const METERED = /\/(chat\/completions|responses|messages|completions)$/;
const HOP = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding', 'origin', 'referer', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'cookie']);
const HOP_OUT = new Set(['connection', 'keep-alive', 'content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 32 * 1024 * 1024;
const MAX_JSON_SCAN = 8 * 1024 * 1024;
const RECORD_ONLY = { version: 1, perCallMax: '1000000', windows: [{ name: 'day', seconds: 86400, max: '1000000000' }] };

export function resolveUpstream(u = 'openrouter', env = process.env) {
  if (UPSTREAMS[u]) return { name: u, ...UPSTREAMS[u] };
  let url;
  try { url = new URL(u); } catch { throw new Error(`--upstream: ${u} is not openrouter, openai, anthropic or a URL`); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('--upstream must be https (or http on localhost)');
  if (url.username || url.password || url.search) throw new Error('--upstream must not carry credentials or a query string');
  return { name: local ? 'local' : `custom:${url.hostname}`, base: url.href.replace(/\/$/, ''), keyEnv: env.UPSTREAM_API_KEY !== undefined ? 'UPSTREAM_API_KEY' : null, auth: 'bearer', reportsCost: false };
}

/** Caps policy from flags, or an agent-spendcap policy object; null means record only. */
export function capsPolicy({ maxCall, maxDay, policy } = {}) {
  if (policy) return parsePolicy(policy);
  if (maxCall === undefined && maxDay === undefined) return null;
  const perCallMax = maxCall ?? maxDay;
  return parsePolicy({ version: 1, perCallMax, windows: [{ name: 'day', seconds: 86400, max: maxDay ?? '1000000000' }] });
}

const idSafe = (s) => String(s).replace(/[^A-Za-z0-9._\/:@-]/g, '-').slice(0, 120) || 'unknown';

function errorBody(type, message) {
  // Readable by OpenAI-style clients (error.message) and Anthropic clients (type: "error", error.type).
  return JSON.stringify({ type: 'error', error: { type, code: type, message: `agent-cost-proxy: ${message}` } });
}

/**
 * @param {object} o
 * @param {string} o.dir         ledger.jsonl and calls.jsonl go here (mode 600)
 * @param {object} [o.upstream]  from resolveUpstream
 * @param {object|null} [o.policy] parsed policy (caps) or null for record only
 * @param {() => object|null} [o.snapshot]  current justweight snapshot
 * @param {{inPer1M,outPer1M}|null} [o.price]  user's own price for the upstream
 * @param {number} [o.assumeMaxOutput=32000]  output bound for holds when the request sets none
 * @param {boolean} [o.injectUsage=true]  ask Chat Completions streams to include usage
 * @param {boolean} [o.trustReportedCost]  use usage.cost as USD (default: only for OpenRouter)
 */
export function createProxy(o) {
  const { dir, upstream = resolveUpstream('openrouter'), policy = null, snapshot = () => null, price = null, assumeMaxOutput = 32000, injectUsage = true, env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = () => Date.now() } = o;
  const trustCost = o.trustReportedCost ?? upstream.reportsCost;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ledger = fileLedger(join(dir, 'ledger.jsonl'));
  const cap = new SpendCap({ policy: policy ?? parsePolicy(RECORD_ONLY), ledger, now });
  const callsPath = join(dir, 'calls.jsonl');
  const record = (c) => { appendFileSync(callsPath, JSON.stringify(c) + '\n', { mode: 0o600 }); chmodSync(callsPath, 0o600); return c; };
  const stats = { calls: 0, denied: 0, errors: 0 };

  async function handle(req, res) {
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    // Local only: loopback peers, a loopback Host (no DNS rebinding) and no browser Origin (no drive-by spending
    // from a web page while your key is in this process's environment).
    if (!LOOPBACK.has(req.socket.remoteAddress)) return send(403, errorBody('forbidden', 'only local clients'));
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(403, errorBody('forbidden', 'Host must be 127.0.0.1 or localhost'));
    if (req.headers.origin) return send(403, errorBody('forbidden', 'browser requests are refused'));
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/__proxy/status' && req.method === 'GET') return send(200, JSON.stringify({ upstream: upstream.name, base: upstream.base, caps: policy ? cap.status() : 'record-only', ...stats }));
    if (!path.startsWith('/v1/')) return send(404, errorBody('not_found', `point your client at http://127.0.0.1:<port>/v1 (got ${path})`));

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(413, errorBody('too_large', 'request body over 32 MB'));
      chunks.push(c);
    }
    let raw = Buffer.concat(chunks);
    let body = null;
    if (req.method === 'POST' && METERED.test(path)) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    const metered = body && typeof body.model === 'string';
    const api = metered ? (path.endsWith('/messages') ? 'anthropic-messages' : path.endsWith('/responses') ? 'responses' : 'chat') : null;
    if (metered && api === 'chat' && body.stream === true && injectUsage && body.stream_options === undefined) {
      body = { ...body, stream_options: { include_usage: true } };
      raw = Buffer.from(JSON.stringify(body));
    }

    const t0 = now();
    const model = metered ? body.model : null;
    const p = metered ? venuePrice(snapshot(), upstream.name, model, price) : null;
    let hold = null;
    if (metered) {
      if (p) {
        const maxOut = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].find((x) => Number.isSafeInteger(x) && x > 0) ?? assumeMaxOutput;
        const nano = costOf(p, raw.length, maxOut); // every request byte as a token: an upper bound
        const a = cap.authorize({ venue: idSafe(upstream.name), model: idSafe(model), usd: fromNano(nano > 0n ? nano : 1n), privacy: upstream.name === 'local' ? 'local' : 'any' });
        if (!a.ok) {
          stats.denied++;
          record({ ts: new Date(t0).toISOString(), api, upstream: upstream.name, model, status: 403, outcome: 'denied', reasons: a.reasons });
          log(`DENIED ${model}: ${a.reasons.join('; ')}`);
          return send(403, errorBody('spend_cap', a.reasons.join('; ')));
        }
        hold = a;
      } else if (policy) {
        stats.denied++;
        const why = `no price known for ${model} at ${upstream.name}, so a cap can't be enforced; pass --price <in>,<out> (USD per 1M tokens)`;
        record({ ts: new Date(t0).toISOString(), api, upstream: upstream.name, model, status: 403, outcome: 'denied', reasons: [why] });
        return send(403, errorBody('spend_cap', why));
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers['accept-encoding'] = 'identity';
    const hasKey = headers.authorization || headers['x-api-key'];
    if (!hasKey && upstream.keyEnv && env[upstream.keyEnv]) {
      if (upstream.auth === 'x-api-key') headers['x-api-key'] = env[upstream.keyEnv];
      else headers.authorization = `Bearer ${env[upstream.keyEnv]}`;
    }
    const url = upstream.base + path.slice(3) + (new URL(req.url, 'http://x').search);

    let up;
    try {
      up = await fetchImpl(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, redirect: 'error' });
    } catch (e) {
      stats.errors++;
      // The request may have reached the provider: an open hold keeps counting (agent-spendcap's rule).
      if (metered) record({ ts: new Date(t0).toISOString(), api, upstream: upstream.name, model, status: 502, outcome: hold ? 'hold-open' : 'error', holdId: hold?.id ?? null, error: e.name });
      return send(502, errorBody('upstream_unreachable', `${upstream.name}: ${e.name}`));
    }
    const outHeaders = {};
    up.headers.forEach((v, k) => { if (!HOP_OUT.has(k)) outHeaders[k] = v; });
    res.writeHead(up.status, outHeaders);

    const sse = (up.headers.get('content-type') ?? '').includes('text/event-stream');
    const reader = sse ? sseUsage() : null;
    const dec = new TextDecoder();
    let text = '';
    let broken = false;
    if (up.body) {
      try {
        for await (const c of up.body) {
          // If the client went away, keep reading: the provider bills the call either way, and usage comes last.
          if (!res.destroyed && !res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
          if (!metered) continue;
          if (reader) reader.push(dec.decode(c, { stream: true }));
          else if (text.length < MAX_JSON_SCAN) text += dec.decode(c, { stream: true });
        }
      } catch { broken = true; }
    }
    res.end();
    if (!metered) return;

    stats.calls++;
    const usage = up.ok ? (reader ? reader.result() : (() => { try { return fromJson(JSON.parse(text)); } catch { return null; } })()) : null;
    const entry = { ts: new Date(t0).toISOString(), ms: now() - t0, api, upstream: upstream.name, model, status: up.status, stream: sse, tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedTokens } : null };

    if (!up.ok) {
      if (hold) cap.release(hold.id);
      return void record({ ...entry, outcome: 'http-error', cost: null, cheapest: null });
    }
    // Real cost, best source first.
    let charged = null;
    if (usage && trustCost && usage.reportedCostUsd !== null) charged = { nano: reportedNano(usage.reportedCostUsd), basis: `reported:${upstream.name}`, estimate: false };
    else if (usage && p && usage.inputTokens !== null && usage.outputTokens !== null) charged = { nano: costOf(p, usage.inputTokens, usage.outputTokens), basis: p.basis + (usage.cachedTokens ? ' (cached input at the full input rate: an upper bound)' : ''), estimate: p.estimate || usage.cachedTokens > 0, source: p.source };
    const cheap = usage ? cheapest(snapshot(), model, usage.inputTokens, usage.outputTokens) : null;
    let outcome;
    if (hold) {
      const nano = charged?.nano ?? toNano(hold.reservedUsd);
      cap.settle(hold.id, fromNano(nano), { receipt: typeof usage?.id === 'string' && usage.id.length >= 8 ? usage.id.slice(0, 200) : null });
      if (!charged) charged = { nano, basis: broken ? 'stream-broke-charged-full-hold' : 'no-usage-charged-full-hold', estimate: true };
      outcome = 'settled';
    } else if (charged && charged.nano > 0n) {
      const a = cap.authorize({ venue: idSafe(upstream.name), model: idSafe(model), usd: fromNano(charged.nano) });
      if (a.ok) { cap.settle(a.id, fromNano(charged.nano), { receipt: typeof usage?.id === 'string' && usage.id.length >= 8 ? usage.id.slice(0, 200) : null }); outcome = 'settled'; }
      else outcome = 'over-record-limit';
    } else {
      ledger.append({ t: 'unpriced', ts: now(), venue: idSafe(upstream.name), model: idSafe(model), tokens: entry.tokens, note: usage ? 'no price known for this model and venue' : 'response carried no usage' });
      outcome = 'unpriced';
    }
    const c = record({ ...entry, outcome, cost: charged ? { usd: fromNano(charged.nano), basis: charged.basis, estimate: charged.estimate, source: charged.source ?? null } : null, cheapest: cheap ? { ...cheap, usd: fromNano(BigInt(cheap.nano)) } : null });
    log(line(c));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      stats.errors++;
      log(`error: ${e.message}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(errorBody('proxy_error', e.message)); } else res.end();
    });
  });
  server.on('close', () => ledger.close());
  return { server, cap, stats, ledger };
}

export function line(c) {
  const t = c.tokens ? `${c.tokens.input ?? '?'} in / ${c.tokens.output ?? '?'} out` : 'no usage';
  const cost = c.cost ? `$${c.cost.usd}${c.cost.estimate ? ' (est.)' : ''}` : 'cost unknown';
  const ch = c.cheapest ? ` · cheapest listed: $${c.cheapest.usd} at ${c.cheapest.provider} (${c.cheapest.model})` : '';
  return `${c.model} · ${t} · ${cost}${ch}`;
}

