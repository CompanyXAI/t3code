# T3 usage policies

Config-driven daily token caps and model allowlists enforced by T3, independent
of provider-reported rate limits.

## Settings

`ServerSettings.usagePolicies` is a map of policy id ? `UsagePolicy`. Each policy
has:

- optional `scope` (`driverKind` and/or `instanceId`)
- UTC `day` period
- `groups` with model lists, `maxTokens`, and `stopAtRatio` (default 0.9)
- `allowlist`: `"groups"` or an explicit model id list
- `onExceeded`: `block` or `warn`
- optional `authModes` (Codex: `apiKey` / `chatgpt`)

Preset **OpenAI free daily** (`openai-free-daily`): Codex + `apiKey` only, with
the two Free Daily groups (250k standard / 2.5M mini).

## Status RPC and composer meter

- `server.getUsagePolicyStatus` / `subscribeUsagePolicyStatus` return today's
  used tokens per group vs cap plus `resetsAt` (next UTC midnight).
- The composer shows a live **today X / cap** meter per group; it refreshes when
  usage is recorded.

## Enforcement

| Provider    | Pre-turn allowlist/cap                                                  | Mid-turn / turn-end recording                                                                      | Notes                                    |
| ----------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Codex       | yes                                                                     | mid-turn (`thread/tokenUsage/updated` ? interrupt)                                                 | `last` as each model-response delta      |
| Claude      | yes                                                                     | turn-end `TurnTokenUsage` once                                                                     | no mid-turn interrupt                    |
| Cursor      | allowlist + pre-turn cap (reported context, else chars/4 **estimated**) | turn-end: SDK `turn-ended.usage` / `RunResult.usage` recorded via `ProviderHost.recordUsagePolicy` | Dashboard account usage remains separate |
| Antigravity | allowlist + pre-turn cap (reported context, else chars/4 **estimated**) | no billable per-turn stream; ACP `usage_update` is context window only; history reader is post-hoc | estimate labeled estimated in UI         |

OpenAI Project Limits remain a recommended second net for API keys.

## Storage

Migration `063_ProviderUsageDaily` creates `provider_usage_daily`, upserted by
`(day, instance_id, driver, model, group_id)` with token columns.
