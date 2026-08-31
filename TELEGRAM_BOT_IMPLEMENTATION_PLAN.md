# Telegram Bot capability implementation plan

Status: implemented locally

Target: reusable backend capability for `free-hosting-starter`

Last reviewed: 2026-08-31

## 1. Goal

Add an opt-in Telegram Bot API webhook capability to the existing Cloudflare
Workers starter without turning it into a frontend starter or a generic bot
framework.

The capability must let a derived product receive Telegram updates, register
grammY handlers, call application use cases, and send Bot API responses while
preserving the starter's module boundaries, security rules, Free-plan baseline,
and manual deployment model.

## 2. Decisions

- Keep this repository backend-only. React and Telegram Mini App UI remain in a
  separate web application.
- Add Telegram Bot API handling as a module independent from Telegram OIDC.
  OIDC authenticates a browser user; Bot API handles Telegram updates.
- Use webhook delivery in the existing Worker. Do not add long polling or a
  persistent Node.js process.
- Support one bot identity per Worker deployment. Different products use
  separate Workers, secrets, and D1 databases.
- Keep the capability disabled until explicitly configured.
- Do not add Queue, Durable Objects, Cron, KV, R2, Redis, Docker, or automatic
  deployment.
- Treat webhook delivery as at-least-once. Do not claim exactly-once processing.
- Do not add a generic `processed_updates` table. A product capability that
  mutates durable state must own its idempotency key and transaction. Telegram
  `update_id` is supplied to those application commands as the default source
  idempotency key.
- Do not automatically call `setWebhook` from Worker startup, tests, CI, or
  deploy. Changing BotFather/Telegram state remains an explicit operation.

## 3. Stack

| Responsibility | Choice | Reason |
| --- | --- | --- |
| Runtime | Cloudflare Workers | Existing target; webhook is a request-scoped workload |
| HTTP routing | Hono 4.13.5 | Existing Worker router and middleware composition |
| API documentation | `@hono/zod-openapi` 1.6.1 | Existing public HTTP contract |
| Telegram framework | grammY 1.46.0, exact pin | Current stable package verified on 2026-08-31; official Workers webhook adapter |
| Language | TypeScript 7.0.2 | Existing strict project contract |
| Local toolchain | Node.js 24, pnpm 11.15.1 | Existing `.nvmrc`, engines, and lockfile contract |
| Persistence | Existing D1 + Drizzle | Product-owned durable state and transactional idempotency when needed |
| Configuration validation | Zod 4.5.1 | Existing fail-closed runtime configuration |
| Secret comparison | Web Crypto | Available in Workers; existing timing-safe string helper |
| Tests | Vitest 4.1.11 + Cloudflare Vitest plugin | Exercises the actual Workers runtime locally |
| Deployment | Wrangler 4.127.1, manual | Existing deployment and evidence boundary |

Only one new runtime dependency is planned: `grammy@1.46.0`. Do not add
`@grammyjs/runner`, conversations, menu, session, or other plugins to the base
capability.

## 4. Runtime path

```text
Telegram Bot API
  -> POST /telegram/webhook
  -> request ID middleware
  -> bot mode/config validation
  -> content type and X-Telegram-Bot-Api-Secret-Token validation
  -> grammY webhookCallback(..., "cloudflare-mod")
  -> Telegram transport handler
  -> product application use case
  -> optional product-owned D1 transaction
  -> grammY Bot API client
```

The webhook must not use the browser-origin middleware mounted under `/api/*`.
Telegram does not participate in the browser CSRF/origin contract.

## 5. Configuration contract

Add an independent bot configuration axis rather than extending `AUTH_MODE`:

```text
TELEGRAM_BOT_MODE=disabled | webhook
```

When `TELEGRAM_BOT_MODE=webhook`, require:

- `TELEGRAM_BOT_TOKEN`: Wrangler secret; never logged or stored in D1;
- `TELEGRAM_BOT_WEBHOOK_SECRET`: independent Wrangler secret used as Telegram
  `setWebhook.secret_token` and compared with the
  `X-Telegram-Bot-Api-Secret-Token` header.

Validate the webhook secret against Telegram's provider contract: 1-256
characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`. Treat the bot token as an
opaque non-empty secret instead of freezing Telegram's current token shape into
the starter.

Do not reuse the OIDC Client Secret, OIDC Client ID, bot token, or
`AUTH_FLOW_SECRET` for another purpose.

Version one may lazily run grammY bot initialization once per Worker isolate and
cache the resulting bot information in module scope. A precomputed bot-info
binding is not part of the initial contract; it can be added later only if cold
start measurements justify the operational complexity.

Local defaults keep both `AUTH_MODE=disabled` and
`TELEGRAM_BOT_MODE=disabled`. OIDC and Bot API can be enabled independently or
together in a derived project.

## 6. HTTP contract

Route: `POST /telegram/webhook`

Expected behavior:

| Condition | Response |
| --- | --- |
| Bot capability disabled | `404` using the existing safe not-found contract |
| Missing or incorrect webhook secret | `401` with no secret-dependent detail |
| Unsupported content type | `415` Problem Details |
| Invalid JSON/update envelope | `400` Problem Details |
| Update handled successfully | `200` |
| Handler or Bot API failure | `500`, allowing Telegram to retry |

Document the route in OpenAPI, but do not copy the complete Telegram `Update`
schema into this repository. The request body is documented as a provider-owned
JSON object with a link to the Telegram Bot API contract. Register a header
security scheme for the webhook secret.

The route must never log the request body, token, secret header, cookies, or URL
query. Structured failure logs may contain only event name, pathname, request
ID, Telegram `update_id` when safely parsed, and a stable error category.

## 7. Module shape

Start small; do not manufacture application and infrastructure layers without a
real responsibility:

```text
src/modules/telegram-bot/
  index.ts
  presentation/
    bot.ts
    handlers.ts
    http.ts
    problems.ts
```

- `index.ts` is the only composition surface used by `src/app`.
- `bot.ts` creates and initializes grammY and owns the safe error boundary.
- `handlers.ts` contains only the reference transport behavior and is the
  extension point for derived products.
- `http.ts` owns the Hono/OpenAPI webhook adapter and header validation.
- `problems.ts` owns stable public errors for malformed provider requests.
- Business rules and D1 mutations belong to their product modules. Telegram
  handlers call those modules only through root exports or public contracts.
- A future outbound-notification capability must introduce an application port
  and grammY infrastructure adapter rather than letting business code depend on
  grammY.

The reference handler supports only `/start` with a small deterministic reply.
It must not introduce sessions, menus, wizards, user tables, or product policy.

## 8. Idempotency and delivery guarantees

Telegram may retry a webhook when it does not receive a successful response.
Concurrent or repeated delivery must be expected.

The base capability provides these rules:

1. Preserve and expose `update_id` to the called application use case.
2. Derive a stable source key such as `telegram:<bot-id>:update:<update-id>` when
   a durable application command needs idempotency.
3. Store that key in the same D1 transaction as the business mutation.
4. Return success for an already-committed application command.
5. Await all handler promises so failures reach grammY/Hono and result in a
   retryable response.

Handlers must stay within the webhook response deadline. `waitUntil()` may be
used only as a best-effort latency optimization in a derived product; it is not
a durable completion or retry mechanism.

This does not make an external `sendMessage` exactly-once. A crash after
Telegram accepts a message but before local completion can still produce a
duplicate. Durable outbound delivery would require a separately designed
outbox and recovery trigger and is outside this baseline.

## 9. Implementation cards

Implement one card at a time. Each card ends with focused tests and a clean
`pnpm check`; do not combine remote setup with local implementation.

### TB-01 — Independent runtime configuration

Scope:

- Refactor runtime configuration into independent auth and bot capabilities.
- Add `TELEGRAM_BOT_MODE` with disabled-by-default behavior.
- Validate bot secrets only in webhook mode.
- Update `.dev.vars.example`, Wrangler vars/types, and configuration tests.

Acceptance:

- Existing OIDC and Notes behavior is unchanged.
- Disabled bot mode requires no bot secrets.
- Webhook mode fails closed when either bot secret is absent or invalid.
- No dependency is added in this card.

### TB-02 — grammY module and webhook contract

Preflight:

- Confirm `node --version` and `pnpm --version` against repository contracts.
- Add and exactly pin `grammy@1.46.0` with plain `pnpm` in a host-capable
  dependency operation.

Scope:

- Create the `telegram-bot` module and mount it from the app composition root.
- Add `POST /telegram/webhook` and its minimal OpenAPI contract.
- Validate the secret header with the existing timing-safe helper.
- Integrate grammY through the Cloudflare webhook adapter.
- Add the deterministic `/start` reference handler.

Acceptance:

- Disabled mode returns the normal safe `404`.
- Correct requests reach the injected/fake bot handler.
- Missing/wrong secret, wrong method, wrong content type, and malformed body are
  covered by tests.
- Tests make no real Telegram requests.

### TB-03 — Runtime failure and observability contract

Scope:

- Add a safe grammY error boundary and structured log categories.
- Ensure every handler promise is awaited.
- Carry request ID and parsed `update_id` through the transport context without
  exposing secrets or the update body.
- Document at-least-once delivery and the application idempotency-key rule.

Acceptance:

- Handler failure produces a retryable `500` without leaking provider data.
- Successful and unsupported updates return promptly.
- Log-capture tests prove that token, webhook secret, message text, cookies, and
  query parameters are absent.
- No generic D1 receipts table, Queue, Cron, or Durable Object is introduced.

### TB-04 — Local and operator workflow

Scope:

- Add a fake-update fixture and documented local request workflow.
- Add a small operator command for `getWebhookInfo` and `setWebhook` only if it
  can read secrets without command-line arguments or output echo.
- Keep `drop_pending_updates=false` by default; dropping updates requires an
  explicit flag and warning.
- Document secret creation, `wrangler secret put`, exact webhook URL,
  `allowed_updates`, the incompatibility of webhook delivery with `getUpdates`,
  inspection, rollback, and evidence boundaries.

Acceptance:

- Local verification needs no real token.
- Operator tooling never prints or accepts secrets as CLI arguments.
- Tests, CI, startup, and deploy never mutate Telegram webhook state.
- `getWebhookInfo` is the inspection step after an explicitly authorized
  `setWebhook` operation.

### TB-05 — Full local gate and handoff

Scope:

- Update README capability and route documentation.
- Run generated type checks, boundary checks, TypeScript, tests, and Wrangler
  dry run through `pnpm check`.
- Review the final diff for accidental OIDC coupling, secret leakage, or new
  paid/runtime resources.

Acceptance:

- `pnpm check` passes locally.
- No React/frontend code is added.
- No Cloudflare resource, deployment, D1 remote migration, secret, BotFather
  setting, or Telegram webhook is changed.
- Local checks are reported as local evidence only.

### TB-06 — Optional real smoke, separately authorized

This is an operational gate, not a side effect of implementation.

Preconditions:

- exact Cloudflare account, Worker, D1 database, bot username, and deployment
  revision are verified;
- a dedicated test bot and secrets are configured outside chat and Git;
- remote migration, deploy, and webhook mutation are separately authorized.

Smoke path:

1. Run the local `pnpm check` gate.
2. Deploy the verified revision manually.
3. Set the exact HTTPS webhook with a fresh independent secret.
4. Verify `getWebhookInfo`, including URL and pending/error fields.
5. Send `/start` from a test Telegram account.
6. Observe the expected reply and safe Worker diagnostics.
7. Re-send a controlled fake duplicate only in a test environment and record
   the actual at-least-once behavior.

Passing `/health` or a fake update does not prove the real Telegram path. A real
claim requires observed Telegram -> hosted webhook -> handler -> Bot API reply.

## 10. Deferred capabilities

The following require separate product decisions:

- Telegram Mini App `initData` validation;
- React/Mini App UI;
- grammY sessions, conversations, menus, or i18n;
- proactive notifications outside an incoming update;
- transactional outbox, Queue, Cron recovery, or Durable Objects;
- file download/upload pipelines and R2;
- multi-bot routing in one Worker;
- webhook auto-registration during deployment;
- long polling or a Node process profile.

## 11. Documentation sources

- [grammY on Cloudflare Workers](https://github.com/grammyjs/website/blob/main/site/docs/hosting/cloudflare-workers-nodejs.md)
- [grammY webhook deployment](https://github.com/grammyjs/website/blob/main/site/docs/guide/deployment-types.md)
- [Telegram Bot API: setWebhook and getWebhookInfo](https://core.telegram.org/bots/api#setwebhook)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
