# Fixtures

**Responses are synthetic.** They were written by hand to match documented shapes. They are not recorded traffic, and no live calls or keys are used in tests.

- `chat_completion.json`, `chat_stream.sse`, `responses_stream.sse`: copied from agent-spendcap's fixtures. They follow OpenRouter's usage accounting docs (https://openrouter.ai/docs/use-cases/usage-accounting, read Nov 24, 2026).
- `chat_completion_deepseek.json`: same shape. Its `cost` is what OpenRouter's list price in `snapshot.json` gives for those tokens.
- `anthropic_message.json`, `anthropic_stream.sse`: follow Anthropic's Messages API and streaming docs (https://docs.anthropic.com/en/api/messages-streaming). `message_start` carries input and cache token counts, and `message_delta` carries the cumulative `output_tokens`.

**`snapshot.json` is real**: justweight's published snapshot from 2026-11-24 21:15 UTC (4:15 PM ET), trimmed to the offers for the four models the tests use, plus the Flop devnet rows (FLOP-priced, so never compared in USD). Nothing in it is edited.
