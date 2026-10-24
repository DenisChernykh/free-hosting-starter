# Cloudflare API Starter

Основа модульного API на Cloudflare Workers с авторизацией, хранением данных и проверяемыми контрактами.

## Возможности

- Hono API, D1, Drizzle и миграции.
- Telegram OIDC с PKCE, cookie-сессии и пользовательские заметки.
- OpenAPI, единый формат ошибок и тесты в Workers runtime.

## Инженерные акценты

- Проектирование повторно используемой backend-основы.
- Разграничение доступа к пользовательским данным и защита сессий.
- Проверяемые модульные границы и воспроизводимый набор проверок.

## Стек

TypeScript, Hono, Drizzle, grammY, Vitest.

## Навигация по коду

- [src/modules/](src/modules/) — предметные модули.
- [src/](src/) — исходный код.
- [test/](test/) — автоматизированные проверки.

## Разработка

Инструменты: Node.js 24, pnpm@11.15.1.

```sh
pnpm install
pnpm dev
pnpm check
pnpm test
```

Параметры окружения перечислены в [.dev.vars.example](.dev.vars.example). Локальные значения задаются вне Git.
