# Repository instructions

## Product boundary

This is an API-only, free-tier-first Cloudflare Workers starter for MVPs. Keep
zero mandatory Cloudflare cost as a hard constraint. Do not add a paid plan,
custom domain, Queue, KV, R2, Durable Object, Cron, external database, Redis,
Docker, or automatic deployment without an explicit project decision.

The baseline runtime is Hono + D1/Drizzle. Telegram OIDC and owner-scoped Notes
are reference capabilities, not permission to grow a generic auth framework.

## Architecture

- Keep a feature-first modular monolith under `src/modules`.
- Cross-module imports may target only a module root `index.ts` or its
  `public-contracts.ts`.
- Presentation depends on application use cases. Application code must not
  import Hono, Drizzle, D1, Wrangler, or Telegram transport details.
- Infrastructure implements capability-specific application ports.
- Keep each module's internal wiring behind its root `index.ts`; `src/app` may
  compose only public module factories. Do not add a DI container or decorators.
- Do not introduce generic repositories or base services.
- A small feature may remain flat inside its module. Add a layer only when it
  represents a real responsibility, while preserving the dependency direction.
- `src/platform` owns runtime mechanisms; `src/shared` contains only small,
  stable, domain-neutral primitives.
- The central Drizzle schema is a persistence-composition exception: keep it
  mechanical and free of business policy. Split it into module fragments plus a
  build-time aggregator if it becomes a collaboration bottleneck.

Run `pnpm boundaries:check` after moving files or changing imports.

## Public contracts

Preserve the routes and OpenAPI behavior documented in `README.md`. API errors
use RFC 9457 Problem Details. Notes are owner-scoped; a missing note and another
owner's note must remain indistinguishable (`404`). Unsafe authenticated requests
must enforce the configured origin.

Production auth uses Telegram OIDC Authorization Code + PKCE with fixed issuer,
audience, RS256, state, and nonce validation. Do not weaken these checks to make
a local or hosted smoke pass. Session identifiers remain opaque and only their
hashes are stored in D1.

Keep Cloudflare invocation logs disabled: they include the full OAuth callback
URL. Custom logs and Problem Details may contain the pathname only, never query
parameters, cookies, codes, state, verifiers, or tokens.

The `__Host-session` cookie is Secure, HttpOnly, SameSite=Lax, Path=/, and has no
Domain. Do not claim support for a separate `pages.dev` frontend: under the
default workers.dev deployment, browser auth requires a same-origin frontend.

## Toolchain and checks

- Respect `.nvmrc`, `engines`, `packageManager`, and the checked-in lockfile.
- Use plain `pnpm`; do not substitute npm or silently change Node/pnpm versions.
- Before changing dependencies, confirm `node --version` and `pnpm --version`.
- Install locally with `pnpm install`. Use `--frozen-lockfile` for the clean CI
  reproducibility gate.
- Before handoff, run `pnpm check`. Narrow checks are useful while iterating but
  do not replace the full gate.
- Keep GitHub Actions check-only. Deployment and D1 migration are manual.

## D1 migrations

Change `src/platform/database/schema.ts`, run `pnpm db:generate`, inspect the SQL,
apply it locally, and test it. Never edit an already-applied migration to change
production history. Remote migration needs explicit authorization and is not a
side effect of tests, CI, Worker startup, or deploy.

The all-zero `database_id` in the template is intentional. Resolve the exact
Cloudflare account and newly created D1 database before replacing it or running
any remote operation. A D1 UUID is not a credential, but it is instance-specific;
never reuse the starter author's database binding in a derived project.

## Secrets and external state

- Never request, print, log, commit, or paste Telegram secrets, bot tokens,
  `AUTH_FLOW_SECRET`, `.dev.vars`, or Cloudflare credentials into chat.
- Set production secrets only through Wrangler's hidden `secret put` prompt.
- A Telegram bot token is not an OIDC Client Secret and is not used by this app.
- Resource creation, remote migration, deployment, GitHub repository changes,
  and push require explicit authorization and exact target verification.
- Paid Cloudflare resources or plan upgrades always require a separate explicit
  decision.

## Evidence boundaries

Report observed evidence precisely:

- local `pnpm check` is not GitHub CI;
- dry-run is not deployment;
- remote D1 migration is not Worker availability;
- `/health` returning `200` is not Telegram login or Notes CRUD;
- fake OIDC tests are not a real Telegram smoke;
- push is not proof that the remote workflow passed.

A real auth claim requires a dedicated test bot configured in BotFather and a
browser smoke covering login, callback, session, Notes CRUD, logout, and rejected
reuse of the logged-out session.
