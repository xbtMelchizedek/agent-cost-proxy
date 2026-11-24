# Contributing to agent-cost-proxy

Small, finished pull requests with tests are the easiest to merge.

```sh
git clone https://github.com/xbtMelchizedek/agent-cost-proxy && cd agent-cost-proxy
npm install && npm test
```

## Ground rules

- **Keys, prompts and responses never touch disk or logs.** Any new field written to `calls.jsonl` or the ledger needs a test that the synthetic key isn't in it.
- **Local only.** Don't widen the bind address, and don't relax the Origin, Host or loopback checks.
- **Never invent a price.** Every cost names its basis. When nothing applies, the call is `unpriced`, not $0. Estimates are flagged.
- **Exact amounts.** USD is nano-USD BigInt or decimal strings, never floats.
- **Synthetic fixtures are labelled.** New response shapes go in `test/fixtures` with the doc URL they follow. No recorded traffic and no live keys in tests.
- **New price sources belong in justweight.** This repo only reads its snapshot.

## Pull requests

One change per PR, with tests. CI runs `npm test` and a secret scan. Security findings go through [SECURITY.md](SECURITY.md), never into a public issue.
