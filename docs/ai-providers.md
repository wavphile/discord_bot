# AI provider configuration

This milestone adds provider and usage-accounting infrastructure. It does not yet expose an AI command in Discord, so setting up a hosted provider does not add a command to try. The default `AI_PROVIDER=mock` is deterministic and does not make network requests.

## Settings

Set these values in the local, ignored `.env` file. Keep the API key out of source control, issue reports, logs, and Discord.

| Setting                           | Default                     | Meaning                                                                                  |
| --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                     | `mock`                      | `mock` or `openai`                                                                       |
| `OPENAI_API_KEY`                  | empty                       | Required for `openai`; never included in request bodies or error messages                |
| `OPENAI_BASE_URL`                 | `https://api.openai.com/v1` | HTTPS API base URL; HTTP is allowed only for localhost during non-production development |
| `OPENAI_MODEL`                    | `gpt-6-astra`               | Model passed to the Responses API                                                        |
| `AI_REQUEST_TIMEOUT_MS`           | `20000`                     | Per-request timeout, from 1,000 to 120,000 ms                                            |
| `AI_MAX_INPUT_TOKENS`             | `12000`                     | Input ceiling enforced before generation, from 1 to 200,000                              |
| `AI_MAX_OUTPUT_TOKENS`            | `1024`                      | Maximum output reserved and requested, from 16 to 32,000                                 |
| `AI_DAILY_TOKEN_BUDGET_PER_GUILD` | `100000`                    | Per-server UTC daily token allowance, from 1 to 100,000,000                              |

The OpenAI adapter counts the exact developer and user messages with `/v1/responses/input_tokens`, then sends those same messages to `/v1/responses` with `store:false`. It does not use conversation state, tools, or arbitrary endpoints. Provider errors are reduced to safe categories; response bodies and credentials are not logged or returned to Discord.

Before generation, SQLite reserves the counted input plus the configured maximum output against that server's daily allowance. On success it records the provider's reported actual usage. A timeout, interrupted request, invalid response, or unexpected provider failure keeps the reservation until its expiry is cleaned up by a later request, since generation may have been charged. Known configuration, rejected-request, and rate-limit failures release it. The database stores per-server daily aggregates and temporary reservations, not prompts or generated text. Aggregate usage is pruned after 90 days.

## Provider data handling

`store:false` prevents this adapter from asking the Responses API to retain a response as application state. It is not a zero-retention guarantee for every category of provider data. OpenAI's current data-controls documentation says API content is not used to train models unless the customer opts in, and default abuse-monitoring logs may include prompts and responses for up to 30 days. Eligibility, configured retention controls, endpoint behavior, and legal exceptions can affect handling. Review the current [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and your organization's requirements before sending server data to a hosted provider.

For endpoint behavior, see OpenAI's [text-generation guide](https://developers.openai.com/api/docs/guides/text) and [token-counting guide](https://developers.openai.com/api/docs/guides/token-counting). Keep `AI_PROVIDER=mock` until a later feature is ready to call the provider and its data flow has been reviewed.
