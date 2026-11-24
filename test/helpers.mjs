import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy, resolveUpstream, capsPolicy } from '../src/proxy.mjs';

export const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
export const SNAP = JSON.parse(fx('snapshot.json'));
export const FAKE_KEY = 'test-key-not-real-7f3a9c'; // synthetic; must never reach disk or logs

/** Fake upstream: replies with a fixture, split into odd-sized chunks; remembers what it was sent. */
export function fakeUpstream(reply) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body ? Buffer.from(init.body).toString('utf8') : null, redirect: init.redirect });
    const r = typeof reply === 'function' ? reply(seen.at(-1)) : reply;
    const bytes = Buffer.from(r.body ?? '');
    const stream = new ReadableStream({
      start(c) { for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.subarray(i, i + 37)); c.close(); },
    });
    return new Response(stream, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/json', 'x-upstream': 'fake' } });
  };
  return { fetchImpl, seen };
}

export async function boot({ reply, upstream = 'openrouter', caps, price = null, env = {}, logs = [], snapshot = SNAP, injectUsage } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-'));
  const up = fakeUpstream(reply);
  const { server } = createProxy({ dir, upstream: resolveUpstream(upstream, env), policy: capsPolicy(caps ?? {}), snapshot: () => snapshot, price, env, fetchImpl: up.fetchImpl, log: (s) => logs.push(s), injectUsage });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, base, seen: up.seen, logs, close: () => new Promise((r) => server.close(r)) };
}

export const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
export const lines = (dir, f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
