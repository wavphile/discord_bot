# AI provider configuration

The provider infrastructure powers the read-only `/ask` command. The default `AI_PROVIDER=mock` is deterministic and does not make network requests. It labels its output as a test response rather than pretending to answer from the selected evidence.

## Settings

Set these values in the local, ignored `.env` file. Keep the API key out of source control, issue reports, logs, and Discord.

| Setting                           | Default                        | Meaning                                                                                  |
| --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                     | `mock`                         | `mock`, `openai`, or `anthropic`                                                         |
| `OPENAI_API_KEY`                  | empty                          | Required for `openai`; never included in request bodies or error messages                |
| `OPENAI_BASE_URL`                 | `https://api.openai.com/v1`    | HTTPS API base URL; HTTP is allowed only for localhost during non-production development |
| `OPENAI_MODEL`                    | `gpt-6-astra`                  | Model passed to the Responses API                                                        |
| `ANTHROPIC_API_KEY`               | empty                          | Required for `anthropic`; never included in request bodies or error messages             |
| `ANTHROPIC_BASE_URL`              | `https://api.anthropic.com/v1` | HTTPS API base URL; HTTP is allowed only for localhost during non-production development |
| `ANTHROPIC_MODEL`                 | `claude-sonnet-5-5`            | Model passed to the Messages API                                                         |
| `AI_REQUEST_TIMEOUT_MS`           | `20000`                        | Per-request timeout, from 1,000 to 120,000 ms                                            |
| `AI_MAX_INPUT_TOKENS`             | `12000`                        | Input ceiling enforced before generation, from 1 to 200,000                              |
| `AI_MAX_OUTPUT_TOKENS`            | `1024`                         | Maximum output reserved and requested, from 16 to 32,000                                 |
| `AI_DAILY_TOKEN_BUDGET_PER_GUILD` | `100000`                       | Per-server UTC daily token allowance, from 1 to 100,000,000                              |

Run `npm run deploy:commands` after changing provider keys so Discord refreshes the `/messages config provider` choices. That selector always offers mock output and includes hosted providers only when their keys are configured in the deployment environment.

The OpenAI adapter counts the exact developer and user messages with `/v1/responses/input_tokens`, then sends those same messages to `/v1/responses` with `store:false`. It does not use conversation state, tools, or arbitrary endpoints. Provider errors are reduced to safe categories; response bodies and credentials are not logged or returned to Discord.

The Anthropic adapter counts the exact system prompt and user message with `/v1/messages/count_tokens`, then sends those same inputs to `/v1/messages` with the configured maximum output tokens. It does not use tools or conversation state. Anthropic's API version is set in the request header; the endpoint can be overridden for a compatible development gateway. As with OpenAI, errors are reduced to safe categories and response bodies and credentials are never shown to Discord.

For endpoint behavior, see Anthropic's [Messages API](https://platform.claude.com/docs/en/api/messages), [token-counting API](https://platform.claude.com/docs/en/api/messages/count_tokens), and [error reference](https://platform.claude.com/docs/en/api/errors).

Before generation, SQLite reserves the counted input plus the configured maximum output against that server's daily allowance. On success it records the provider's reported actual usage. A timeout, interrupted request, invalid response, or unexpected provider failure keeps the reservation until its expiry is cleaned up by a later request, since generation may have been charged. Known configuration, rejected-request, and rate-limit failures release it. The database stores per-server daily aggregates and temporary reservations, not prompts or generated text. Aggregate usage is pruned after 90 days.

## Provider data handling

`store:false` prevents this adapter from asking the Responses API to retain a response as application state. It is not a zero-retention guarantee for every category of provider data. OpenAI's current data-controls documentation says API content is not used to train models unless the customer opts in, and default abuse-monitoring logs may include prompts and responses for up to 30 days. Eligibility, configured retention controls, endpoint behavior, and legal exceptions can affect handling. Review the current [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and your organization's requirements before sending server data to a hosted provider.

For endpoint behavior, see OpenAI's [text-generation guide](https://developers.openai.com/api/docs/guides/text) and [token-counting guide](https://developers.openai.com/api/docs/guides/token-counting). The bot currently defaults to `AI_PROVIDER=mock`; configure a hosted provider only after reviewing this data flow.

When `AI_PROVIDER=anthropic`, the bounded instructions and input are sent to Anthropic for both token counting and generation. Anthropic states that commercial API inputs and outputs are not used to train models by default and are deleted within 30 days by default, subject to policy, legal, feedback, and approved retention exceptions. Review the current [data retention terms](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) and [model-training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) before enabling the provider; controls and terms can vary by account and use case.

When a server administrator explicitly enables `/messages` retrieval and a requester runs `/ask include_messages:true` or `/summarize`, the bounded message evidence (text, display names, timestamps, and selected-channel metadata) plus the question or summary instructions become provider input for both token counting and generation. Provider selection is local configuration: `mock` makes no network requests; `openai` sends input to the configured Responses API endpoint; `anthropic` sends it to the configured Anthropic Messages API endpoint. `/summarize` returns links only for source IDs validated against the evidence supplied in that request. The bot does not persist retrieved messages, the prompt, or the generated answer in SQLite. Its configured 1–7 day lookback limits which messages one request may retrieve; it is not a durable retention or purge system. Review provider handling and obtain any required server-member notice or consent before enabling a hosted provider for message content.

The separate `/messages config storage-enable` setting persists new message text in the local SQLite database for its configured 1–7 day lifetime. That retained content is not consumed by `/ask` or `/summarize` and is not sent to the configured AI provider by the current implementation. Database files and backups still contain readable message content while rows are retained; restrict access and apply the documented purge and expiry controls.
