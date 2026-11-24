# agent-cost-proxy

What did your coding agent's calls really cost, and what would the same tokens have cost at the cheapest venue? Start one local proxy, point Claude Code, Codex, Hermes or any OpenAI-compatible agent at it, and keep working. Every call's real cost goes on an [agent-spendcap](https://github.com/xbtMelchizedek/agent-spendcap) ledger, next to the cheapest price [justweight](https://github.com/xbtMelchizedek/justweight) lists for the same model. Turn on caps and calls over budget never leave your machine.

**Page and report viewer:** https://xbtmelchizedek.github.io/agent-cost-proxy/

## Quickstart

```sh
npx -y github:xbtMelchizedek/agent-cost-proxy
```

Then, in the shell where your agent runs:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8788/v1     # Codex, Hermes, OpenAI-compatible agents (upstream: OpenRouter by default)
```

For Claude Code, start it with `--upstream anthropic` and set `ANTHROPIC_BASE_URL=http://127.0.0.1:8788`.

Each call prints one line:

```
deepseek/deepseek-v4.1-flash · 100000 in / 100 out · $0.00509028 · cheapest listed: $0.00503 at pearl-labs (deepseek-ai/DeepSeek-V4.1-Flash)
```

To see the totals:

```sh
npx -y github:xbtMelchizedek/agent-cost-proxy report
```

Node 22 or later. Nothing to configure: no account, no config file, no key to give it.

## Your key

- Whatever your agent already sends (`Authorization` or `x-api-key`) is passed straight through to the upstream.
- If the agent sends no key, the proxy adds the upstream's usual one from its own environment: `OPENROUTER_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (or `UPSTREAM_API_KEY` for a custom URL).
- Keys, prompts and responses are **never written to disk or printed**. The files hold model, token counts, cost, status and timing. Tests check the files and logs for the key.
- Redirects from the upstream are refused, so a key is never re-sent to another host.

## Local only

The proxy listens on `127.0.0.1` and nowhere else. It refuses:

- requests with a browser `Origin` header, so a web page you visit can't spend through your key;
- a `Host` other than `127.0.0.1` or `localhost`, which blocks DNS rebinding;
- any non-loopback peer.

An upstream must be `https`, or `http` on localhost (Ollama, llama.cpp, vLLM).

## Caps

```sh
npx -y github:xbtMelchizedek/agent-cost-proxy --max-day 5 --max-call 0.50
npx -y github:xbtMelchizedek/agent-cost-proxy --policy policy.json     # any agent-spendcap policy: windows, model allow/deny lists, rate limit
```

Before each call, the proxy holds an upper bound on its cost: every request byte counted as a token, plus `max_tokens` (or `--assume-max-output`, 32000 by default). After the call, it settles the real cost. A call that would go over a cap gets a `403` with `error.type: "spend_cap"`, readable by OpenAI-style and Anthropic clients, and it never reaches the provider. With caps on, a model with no known price is refused, because there is nothing to bound it with. Pass `--price <in>,<out>` (USD per 1M tokens) for it. Because the hold is an upper bound, a per-call cap applies to the bound, not the final cost. Daily caps count the real cost once a call settles.

## How cost is worked out

The proxy uses the first of these that applies:

1. **Reported by the upstream.** OpenRouter returns `usage.cost` in credits (1 credit = $1). Pass `--trust-reported-cost` to use it from other upstreams.
2. **`--price <in>,<out>`**, times the tokens the response reports.
3. **The venue's list price in justweight**, for that exact model at that venue (OpenRouter, Venice, Chutes).
4. **Estimate:** OpenRouter's list price for the same model, flagged `estimate: true`, because the maker's own price may differ. This applies only to the OpenRouter, OpenAI and Anthropic upstreams. A local or custom upstream stays unpriced unless you pass `--price`. Claude API ids like `claude-sonnet-5-5-20261001` are matched to `anthropic/claude-sonnet-5.5`.

When cached input tokens are present, they are priced at the full input rate and flagged as an upper bound.

If none apply, the call is recorded as **unpriced**, never as $0. If a response carries no usage and a hold was placed, the full hold is charged. That's agent-spendcap's rule: an unknown outcome counts as spent.

**Cheapest** is the lowest USD list price in justweight for the same model key and the same token counts, skipping batch tiers. It is **not** a quality, latency, precision or privacy match. The line names the venue and model so you can judge. Prices refresh from justweight's snapshot every 2 hours. Use `--snapshot <file>` to pin one, or `--snapshot off`.

For Chat Completions streams, the proxy adds `stream_options.include_usage: true` when the client didn't set it, so the stream reports its tokens. Disable this with `--no-usage-inject`. Responses and Anthropic streams always carry usage.

## Files

`~/.agent-cost-proxy/` (or `--dir`), mode 600:

| File | Contents |
|---|---|
| `ledger.jsonl` | agent-spendcap's hash-chained ledger: holds, settlements, denials, and `unpriced` entries. `report` refuses a ledger whose chain is broken. |
| `calls.jsonl` | One line per call: time, API, upstream, model, status, tokens, cost and its basis, cheapest venue and its price and source. |

## Options

```
agent-cost-proxy [--upstream openrouter|openai|anthropic|<url>] [--port 8788] [--max-call <usd>] [--max-day <usd>]
                 [--policy <file>] [--price <in>,<out>] [--dir <path>] [--snapshot <url|file|off>]
                 [--assume-max-output 32000] [--no-usage-inject] [--trust-reported-cost]
agent-cost-proxy report [--dir <path>] [--json]
```

`GET /__proxy/status` returns the upstream, caps usage and counters.

## Limits

- Only the Chat Completions, Responses, Completions and Anthropic Messages endpoints are metered. Other paths (`/v1/models` and so on) pass through uncounted.
- It costs what the response reports. If a provider bills for something it doesn't report, such as tool calls or web search, that isn't seen.
- The cheapest venue is a list price, not a promise that your agent would work as well there.
- Tests use synthetic responses that follow the documented shapes (see `test/fixtures/README.md`). No live call has been made through it by this project, because that needs a paid key.

## Part of the agent inference kit

Small tools that each do one job and work together. Use any one on its own.

- [justweight](https://github.com/xbtMelchizedek/justweight): one price table for every inference venue (Flop, Pearl, Venice, Chutes, each OpenRouter provider, local) in one unit, with each price linked to its source.
- [justweight `infer`](https://github.com/xbtMelchizedek/justweight#infer-route-one-call-with-caps-and-a-receipt): an MCP tool that routes one call to the cheapest venue meeting your privacy floor, under hard spend caps, and returns chained receipts.
- [agent-price-feed](https://github.com/xbtMelchizedek/agent-price-feed): alerts by JSON Feed, RSS, CLI and MCP when those prices move, a cheaper route appears, or Flop lists a model.
- [agent-spendcap](https://github.com/xbtMelchizedek/agent-spendcap): a budget policy for agents: holds before each call, settlement from real usage, a hash-chained ledger, and a drop-in fetch for OpenAI-compatible APIs.
- [agent-cost-proxy](https://github.com/xbtMelchizedek/agent-cost-proxy) (this repo): one command, a local proxy for coding agents that records each call's real cost and the cheapest listed price for the same tokens, with optional caps.
- [flop-receipt-root](https://github.com/xbtMelchizedek/flop-receipt-root): proves a Flop compute settlement to an EVM contract without a bridge, and checks one receipt offline.
- [flop-spend](https://github.com/xbtMelchizedek/flop-spend): has an address spent on Flop inference yet? Settled spend per address, re-read on chain, as a CLI, MCP tool and dashboard.

## Develop

```sh
git clone https://github.com/xbtMelchizedek/agent-cost-proxy && cd agent-cost-proxy
npm install && npm test
node scripts/make-sample.mjs   # rebuild the page's synthetic sample
```

17 tests, with no network and no keys. They include a real loopback HTTP run with a slow stream and a client that disconnects mid-stream. Dependencies: agent-spendcap and justweight. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

MIT. The page uses Arc UI foundation tokens (MIT, see `web/arc/LICENSE`).
