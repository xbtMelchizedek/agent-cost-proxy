// Summarize calls.jsonl: what the calls cost, and what the same tokens would have cost at the cheapest listed venue.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileLedger } from 'agent-spendcap/file';

const nano = (usd) => {
  const [i, f = ''] = String(usd).split('.');
  return BigInt(i) * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9));
};
const usd = (n) => {
  const s = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${n / 1_000_000_000n}${s ? `.${s}` : ''}`;
};

export function readCalls(dir) {
  const p = join(dir, 'calls.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${p}:${i + 1}: not JSON`); }
  });
}

/** Totals overall and per model. "compared" sums only calls with both a cost and a cheapest price. */
export function summarize(calls) {
  const by = new Map();
  const tot = { calls: 0, denied: 0, unpriced: 0, errors: 0, costUsd: 0n, estimated: 0, compared: 0, comparedCost: 0n, cheapestCost: 0n };
  for (const c of calls) {
    const m = by.get(c.model) ?? { model: c.model, calls: 0, costUsd: 0n, compared: 0, comparedCost: 0n, cheapestCost: 0n, cheapest: new Map(), input: 0, output: 0 };
    if (c.outcome === 'denied') { tot.denied++; continue; }
    if (c.outcome === 'http-error' || c.outcome === 'error' || c.outcome === 'hold-open') { tot.errors++; continue; }
    tot.calls++; m.calls++;
    m.input += c.tokens?.input ?? 0; m.output += c.tokens?.output ?? 0;
    if (!c.cost) { tot.unpriced++; by.set(c.model, m); continue; }
    const n = nano(c.cost.usd);
    tot.costUsd += n; m.costUsd += n;
    if (c.cost.estimate) tot.estimated++;
    if (c.cheapest) {
      const ch = nano(c.cheapest.usd);
      tot.compared++; tot.comparedCost += n; tot.cheapestCost += ch;
      m.compared++; m.comparedCost += n; m.cheapestCost += ch;
      const k = `${c.cheapest.provider} ${c.cheapest.model}`;
      m.cheapest.set(k, (m.cheapest.get(k) ?? 0) + 1);
    }
    by.set(c.model, m);
  }
  const fmt = (x) => ({ ...x, costUsd: usd(x.costUsd), comparedCost: usd(x.comparedCost), cheapestCost: usd(x.cheapestCost), ...(x.cheapest ? { cheapest: [...x.cheapest.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ venue: k, calls: n })) } : {}) });
  return { totals: fmt(tot), models: [...by.values()].sort((a, b) => (b.costUsd > a.costUsd ? 1 : b.costUsd < a.costUsd ? -1 : 0)).map(fmt) };
}

export function report(dir) {
  const calls = readCalls(dir);
  let ledger = { ok: null, entries: 0 };
  if (existsSync(join(dir, 'ledger.jsonl'))) {
    const l = fileLedger(join(dir, 'ledger.jsonl'), { readOnly: true }); // throws if the hash chain is broken
    ledger = { ok: true, entries: l.entries().length };
  }
  return { dir, ledger, ...summarize(calls) };
}

export function reportText(r) {
  const t = r.totals;
  const lines = [`${t.calls} call(s) recorded in ${r.dir}. Ledger: ${r.ledger.ok ? `hash chain intact, ${r.ledger.entries} entries` : 'none yet'}.`];
  lines.push(`Cost: $${t.costUsd}${t.estimated ? ` (${t.estimated} estimated, see each call's basis)` : ''}. Unpriced: ${t.unpriced}. Denied by caps: ${t.denied}. Errors: ${t.errors}.`);
  if (t.compared) lines.push(`For the ${t.compared} call(s) with both prices: $${t.comparedCost} paid vs $${t.cheapestCost} at the cheapest listed venue for the same model and tokens.`);
  for (const m of r.models) lines.push(`  ${m.model}: ${m.calls} call(s), $${m.costUsd}${m.compared ? `; cheapest listed $${m.cheapestCost} (${m.cheapest.slice(0, 2).map((c) => c.venue).join(', ')})` : ''}`);
  lines.push('Cheapest = lowest USD list price in justweight for the same model key; it is not a quality, latency or privacy match.');
  return lines.join('\n');
}
