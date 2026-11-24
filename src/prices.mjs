// Prices from justweight's snapshot: the list price at the venue the call went to, and the cheapest venue that
// lists the same model. All arithmetic is exact (justweight's 1e-24 fixed point, agent-spendcap's nano-USD).
import { readFileSync } from 'node:fs';
import { canonicalModel, costOf as jwCostOf } from 'justweight';
import { SNAPSHOT_URL } from 'justweight';

export { SNAPSHOT_URL };
const FIXED_PER_NANO = 10n ** 15n; // justweight fixed point is 1e-24; nano-USD is 1e-9

/**
 * Comparison key. justweight's canonicalModel, plus two rules for Anthropic's own ids so that
 * "claude-sonnet-5-5-20261001" (Anthropic API) and "anthropic/claude-sonnet-5.5" (OpenRouter) meet:
 * a trailing -YYYYMMDD date is dropped, and digit-hyphen-digit becomes digit.digit.
 */
export function modelKey(id) {
  const c = canonicalModel(id);
  let k = c.key;
  if (k.startsWith('claude-')) k = k.replace(/-\d{8}$/, '').replace(/(\d)-(\d)/g, '$1.$2');
  return { key: k, variant: c.variant };
}

export async function loadSnapshot(src, { fetchImpl = globalThis.fetch } = {}) {
  if (src === 'off') return null;
  if (/^https:\/\//.test(src)) {
    const r = await fetchImpl(src, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`snapshot ${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

const DEC = /^\d+(\.\d{1,9})?$/;
const usable = (o) => o.unit === 'USD' && DEC.test(String(o.inPer1M)) && DEC.test(String(o.outPer1M)) && !modelKey(o.model).variant.some((v) => /(^|-)batch$/.test(v));

/** Which justweight offers stand for each upstream. Exact model id at that venue only. */
const VENUE_PROVIDER = { openrouter: 'openrouter', venice: 'venice', chutes: 'chutes-bittensor' };

/**
 * Price for this call at the venue it went to, in order:
 *  1. --price given by the user
 *  2. justweight lists this exact model at this venue
 *  3. OpenRouter's list price for the same model key, flagged estimate (the maker's own price may differ)
 * Returns { inPer1M, outPer1M, basis, source, estimate } or null.
 */
export function venuePrice(snapshot, upstream, model, userPrice = null) {
  if (userPrice) return { ...userPrice, basis: 'price-flag', source: null, estimate: false };
  const offers = (snapshot?.offers ?? []).filter(usable);
  const provider = VENUE_PROVIDER[upstream];
  const m = String(model).toLowerCase();
  if (provider) {
    const o = offers.find((x) => x.provider === provider && String(x.model).toLowerCase() === m);
    if (o) return { inPer1M: o.inPer1M, outPer1M: o.outPer1M, basis: `list-price:${provider}`, source: o.source, estimate: false };
  }
  const k = modelKey(model).key;
  const o = offers.find((x) => x.provider === 'openrouter' && modelKey(x.model).key === k && modelKey(x.model).variant.length === 0);
  if (o) return { inPer1M: o.inPer1M, outPer1M: o.outPer1M, basis: `openrouter-list-for:${o.model}`, source: o.source, estimate: true };
  return null;
}

/** Cheapest USD list price for the same model key and token counts. Batch variants are skipped. */
export function cheapest(snapshot, model, inputTokens, outputTokens) {
  if (!snapshot || inputTokens === null || outputTokens === null) return null;
  const k = modelKey(model).key;
  let best = null;
  for (const o of snapshot.offers ?? []) {
    if (!usable(o) || modelKey(o.model).key !== k) continue;
    const c = jwCostOf(o, { inputTokens, outputTokens });
    if (c === null) continue;
    if (!best || c < best.c || (c === best.c && o.provider < best.o.provider)) best = { c, o };
  }
  if (!best) return null;
  const { o, c } = best;
  return {
    provider: o.provider, model: o.model, variant: modelKey(o.model).variant,
    nano: ((c + FIXED_PER_NANO - 1n) / FIXED_PER_NANO).toString(),
    inPer1M: o.inPer1M, outPer1M: o.outPer1M,
    noRetention: o.privacy?.noRetention ?? null, source: o.source,
  };
}
