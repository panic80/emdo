# Astra migration

EMDO's active reasoning and document extraction model is `gpt-6-astra`.
The manager, scheduler, shopping, and Finance agents use it for every planning,
specialist, and synthesis phase. Finance document extraction uses the same model.
Speech transcription, speech generation, and embeddings retain their dedicated
models.

## Request compatibility

All Astra requests use the Responses API, explicit `reasoning.effort: medium`,
Standard processing (`service_tier: default`), `store: false`, and
`prompt_cache_options.ttl: 30m`. The pinned Agents SDK 0.14.3 supports these fields;
the request contract test exercises its actual HTTP serialization with a fake
transport. It verifies function tools and strict structured output, and rejects
unsupported sampling/log-probability parameters in the outgoing request.

EMDO previously supplied `modelSettings: { maxTokens }`, which replaces the SDK's
model defaults. That left reasoning unset on the wire. Luna and Terra's documented
API default is `medium`; direct Finance extraction also left reasoning unset.
This migration explicitly preserves that effective effort, following OpenAI's
migration guide. Existing instructions, phase separation,
strict output schemas, tool permissions, disclosure checks, and visual approval
requirements are retained. Astra availability failure returns a safe error while
local features remain available. There is no fallback to Luna or Terra. Existing
bounded retry and replay protection remains in force.

## Database and approvals

Apply `0023_astra_model_migration` before starting the migrated application. The
migration expands model provenance constraints, updates extraction job claims to
Astra, and accepts the new model resolution in approval result validation. Prior
migration SQL files and settled history are unchanged; legacy results remain
readable.

The agent graph identity includes model policy. Pending approvals from a previous
graph must be requested again and reviewed under the new graph. The migration
does not rewrite encrypted checkpoints or bypass graph, session, grant, or
proposal checks. New Astra interruptions retain the existing authenticated
approval flow.

Drain active API requests and extraction jobs during rollout so an old worker
cannot finish an extraction newly claimed with Astra provenance. Keep the Finance
feature flags and deployment acceptance gates under their existing controls.

## Cost configuration

Keep `EMDO_OPENAI_AGENT_API_KEY` and set a new
`EMDO_OPENAI_AGENT_PRICING_VERSION` identifying Astra's rates and the CAD conversion
used. Replace the four Luna/Terra rate variables with:

```text
EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS
EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS
```

Both values are positive integer CAD cents per million tokens at the uncached
Standard rate. Use current account pricing and the selected exchange-rate
conversion; old Luna/Terra prices are not valid substitutes. Missing, invalid,
or leftover legacy agent configuration fails closed. No API credentials or live
deployment configuration are changed by this source migration.

The spend guard conservatively prices all input at Astra's 1.25x cache-write rate
and rounds up once to whole CAD cents. Above 272,000 input tokens it also accounts
for the 2x input/cache and 1.5x output multipliers. This is an upper-bound ledger
estimate, not an invoice; cache hits can make the actual provider charge smaller.

The staging workflow now supplies five protected input lines: the Finance key,
agent key, pricing version, Astra input rate, and Astra output rate. Update the
two GitHub rate variables before requesting a live-chat staging run. Live provider
acceptance and deployment remain separate from local test results.

## References

- [OpenAI Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-update-api-and-model-parameters)
- [Astra model capabilities and pricing multipliers](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Prompt caching differences](https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences)

- [Previous Luna API default](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Previous Terra API default](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
