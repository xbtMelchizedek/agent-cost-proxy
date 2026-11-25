// Token usage from the three response shapes coding agents use: OpenAI Chat Completions, OpenAI Responses and
// Anthropic Messages, as JSON or as a server-sent event stream. Returns one shape:
// { inputTokens, outputTokens, cachedTokens, reportedCostUsd, id, costFlop, flopReceipt }
// with null for anything the response didn't say. costFlop and flopReceipt are FLOP-network fields;
// they are never treated as USD.

const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

// Public receipt fields only. Prompts, keys and arbitrary nested blobs stay out of the call log.
const RECEIPT_KEYS = ['miner', 'cost', 'cost_flop', 'channel_id', 'terminal_event', 'tx_hash', 'block_number', 'request_id', 'state', 'settled_spend', 'settled_spend_raw', 'model'];
const prim = (v) => (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined);

export function sanitizeReceipt(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const k of RECEIPT_KEYS) {
    if (k in r) {
      const v = prim(r[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

function flopFields(j) {
  const usage = j?.usage ?? j?.response?.usage;
  const cost = usage && typeof usage.cost_flop === 'number' && Number.isFinite(usage.cost_flop) && usage.cost_flop >= 0 ? usage.cost_flop : null;
  const receipt = sanitizeReceipt(j?.x_flop_receipt ?? j?.metadata?.flop_receipt ?? j?.metadata?.x_flop_receipt ?? j?.response?.x_flop_receipt);
  return { costFlop: cost, flopReceipt: receipt };
}

const emptyUsage = () => ({ inputTokens: null, outputTokens: null, cachedTokens: 0, reportedCostUsd: null });

/** Normalize one usage object (any of the three shapes). */
export function normalize(u) {
  if (!u || typeof u !== 'object') return null;
  // Anthropic: input_tokens excludes cache writes and reads; they are separate fields.
  if ('cache_creation_input_tokens' in u || 'cache_read_input_tokens' in u) {
    const base = int(u.input_tokens), cw = int(u.cache_creation_input_tokens) ?? 0, cr = int(u.cache_read_input_tokens) ?? 0;
    return { inputTokens: base === null ? null : base + cw + cr, outputTokens: int(u.output_tokens), cachedTokens: cw + cr, reportedCostUsd: null };
  }
  const inT = int(u.prompt_tokens) ?? int(u.input_tokens);
  const outT = int(u.completion_tokens) ?? int(u.output_tokens);
  const cached = int(u.prompt_tokens_details?.cached_tokens) ?? int(u.input_tokens_details?.cached_tokens) ?? 0;
  const cost = typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null;
  if (inT === null && outT === null && cost === null) return null;
  return { inputTokens: inT, outputTokens: outT, cachedTokens: cached, reportedCostUsd: cost };
}

/** Usage from a complete JSON response body. */
export function fromJson(j) {
  const u = normalize(j?.usage ?? j?.response?.usage);
  const flop = flopFields(j);
  const id = j?.id ?? j?.response?.id ?? null;
  if (!u && flop.costFlop === null && !flop.flopReceipt) return null;
  return { ...(u ?? emptyUsage()), id, ...flop };
}

/** Incremental SSE reader. push(text) as chunks arrive, then result(). */
export function sseUsage() {
  let buf = '';
  let id = null;
  let usage = null; // last complete usage seen (chat final chunk, responses response.completed)
  let anth = null;  // Anthropic: message_start gives input, message_delta gives cumulative output
  let flop = { costFlop: null, flopReceipt: null };
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') return;
    let j;
    try { j = JSON.parse(d); } catch { return; }
    if (j.type === 'message_start' && j.message) {
      id = j.message.id ?? id;
      anth = normalize({ cache_creation_input_tokens: 0, ...j.message.usage });
      return;
    }
    if (j.type === 'message_delta' && j.usage && anth) {
      if (int(j.usage.output_tokens) !== null) anth.outputTokens = j.usage.output_tokens;
      return;
    }
    id = j.id ?? j.response?.id ?? id;
    const u = normalize(j.usage ?? j.response?.usage);
    if (u) usage = u;
    const f = flopFields(j);
    if (f.costFlop !== null || f.flopReceipt) flop = f;
  };
  return {
    push(text) {
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(take);
    },
    result() {
      take(buf);
      buf = '';
      const u = anth ?? usage;
      if (!u && flop.costFlop === null && !flop.flopReceipt) return null;
      return { ...(u ?? emptyUsage()), id, ...flop };
    },
  };
}
