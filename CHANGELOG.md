# Changelog

## 0.1.2 (2026-11-25)

- Record FLOP gateway fields on each call: `usage.cost_flop` and a sanitized `x_flop_receipt` (miner, cost, channel, settlement ids). These are never treated as USD, and prompt-like or nested fields are dropped. Found while pointing the proxy at `https://api.flop.network/v1`.
- Replace a missing or banned `User-Agent` (`Python-urllib`, `python-requests`, `go-http-client`) with `agent-cost-proxy/0.1.2` before the upstream. `api.flop.network` answers Cloudflare 1010 to Python-urllib's default UA. curl and other agents' UAs are forwarded unchanged.


## 0.1.1 (2026-11-24)

- Fix: a local or custom upstream (for example Ollama on 127.0.0.1) is no longer priced from OpenRouter's list price as an estimate. Those calls are `unpriced` unless you pass `--price`. Found by running the published quickstart against a local upstream: it showed $0.00066 (est.) for a Qwen call on your own hardware.

## 0.1.0 (2026-11-24)

First release.

- `npx -y github:xbtMelchizedek/agent-cost-proxy`: a local proxy on 127.0.0.1:8788 for OpenAI-compatible agents (Chat Completions, Responses, Completions) and Claude Code (Anthropic Messages), JSON or streamed. Upstreams: OpenRouter (default), OpenAI, Anthropic, or any https URL (http on localhost).
- The agent's own key header passes through. If it sends none, the upstream's usual environment variable is used. Keys, prompts and responses are never stored or printed. Redirects are refused.
- Local only: loopback peers, a loopback Host, and no browser Origin.
- Each call's real cost goes on an agent-spendcap ledger. In order: the upstream's reported cost, `--price`, the venue's justweight list price, or OpenRouter's list price flagged as an estimate. Unpriced calls are recorded as unpriced, never $0.
- Alongside it: the cheapest USD list price justweight has for the same model and tokens.
- Caps: `--max-day`, `--max-call` or a full agent-spendcap `--policy`. Calls over a cap get a 403 and never reach the provider.
- `report`: totals and per-model cost against the cheapest listed venue. It checks the ledger's hash chain.
- A page with a local `calls.jsonl` viewer (nothing uploaded) and a synthetic sample.
- 17 tests on synthetic responses with no network and no keys, including a real loopback stream with a client disconnect.
