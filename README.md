# free-hosting-starter

Компактный API-стартер для MVP на Cloudflare Workers. Он сохраняет понятные
границы модулей и даёт рабочий эталон авторизации, но не переносит в маленький
проект инфраструктуру enterprise-приложения.

Стартовый сценарий рассчитан на Cloudflare Workers Free, D1 Free и стандартный
домен `workers.dev`. Обязательных платных ресурсов в составе нет.

## Что внутри

- TypeScript 7 и Node.js 24 для локальной разработки;
- Hono и `@hono/zod-openapi` для HTTP API и OpenAPI 3.1;
- Cloudflare Workers как runtime;
- D1 и Drizzle ORM с SQL-миграциями;
- Telegram OpenID Connect Authorization Code Flow с PKCE как эталонный модуль;
- независимая Telegram Bot API webhook capability с отключённым по умолчанию режимом;
- cookie-сессия и защищённый CRUD заметок;
- Vitest в Cloudflare Workers runtime;
- Biome, строгая типизация и автоматическая проверка границ модулей;
- один локальный и CI-gate: `pnpm check`.

Здесь намеренно нет Docker, PostgreSQL, Redis, BullMQ, Queues, KV, R2, Durable
Objects, Cron, testcontainers, Swagger UI и автоматического production deploy.
Добавляйте их только тогда, когда потребность подтверждена конкретным проектом.

## HTTP API

| Метод | Маршрут | Доступ | Назначение |
| --- | --- | --- | --- |
| `GET` | `/health` | публичный | Состояние Worker и revision сборки |
| `GET` | `/openapi.json` | публичный | OpenAPI 3.1 контракт |
| `GET` | `/api/auth/telegram/start` | публичный | Начать Telegram OIDC + PKCE |
| `GET` | `/api/auth/telegram/callback` | публичный | Проверить callback и создать сессию |
| `POST` | `/telegram/webhook` | webhook secret | Принять Telegram Bot API update (только при включённой capability) |
| `GET` | `/api/auth/me` | сессия | Текущий пользователь |
| `POST` | `/api/auth/logout` | сессия | Завершить текущую сессию |
| `GET` | `/api/notes` | сессия | Список своих заметок |
| `POST` | `/api/notes` | сессия | Создать заметку |
| `GET` | `/api/notes/{noteId}` | сессия | Получить свою заметку |
| `PATCH` | `/api/notes/{noteId}` | сессия | Изменить свою заметку |
| `DELETE` | `/api/notes/{noteId}` | сессия | Удалить свою заметку |

Пользователь видит только свои заметки. Чужой или отсутствующий `noteId`
возвращает одинаковый `404`, чтобы не раскрывать существование чужих данных.
Заголовок содержит от 1 до 120 символов, тело — не более 10 000 символов.
Параметр списка `limit` принимает значения от 1 до 100, по умолчанию — 20.
Ошибки API имеют формат Problem Details (`application/problem+json`, RFC 9457).
Каждый такой ответ содержит стабильный машинный `code`, `instance` с безопасным
pathname и fragment из `requestId` для конкретного возникновения проблемы, а
также отдельный `requestId` для корреляции запроса. Query-параметры в
`instance` не попадают. Клиентский код должен ветвиться по `code`, а не
разбирать человекочитаемые `title` или `detail`.

Например, отсутствующая и принадлежащая другому пользователю заметка намеренно
дают одинаковую бизнес-проблему:

```json
{
  "type": "https://free-hosting-starter.dev/problems/note-not-found",
  "title": "Note not found",
  "status": 404,
  "detail": "The note was not found.",
  "instance": "/api/notes/019...#opaque-request-id",
  "code": "NOTE_NOT_FOUND",
  "requestId": "opaque-request-id"
}
```

`NOTE_NOT_FOUND` принадлежит модулю Notes. Транспортные ошибки используют
общие коды вроде `VALIDATION_FAILED`, `UNSUPPORTED_MEDIA_TYPE` и
`UNTRUSTED_ORIGIN`. Полный состав ответов является частью `/openapi.json`.

В локальной конфигурации `AUTH_MODE=disabled`. Публичные маршруты остаются
доступны, а Telegram auth и зависящий от него Notes API отвечают `404`. Это
позволяет начать разработку без создания бота; полный auth-сценарий включается
явно.

## Архитектура, которая растёт вместе с проектом

Это feature-first modular monolith с прогрессивным количеством слоёв:

```text
src/
  app/                         # composition root и сборка Worker
  modules/
    identity-access/
      index.ts                 # публичная поверхность модуля
      public-contracts.ts      # контракты для других модулей
      presentation/            # HTTP и cookies
      application/             # use cases и ports
      infrastructure/          # D1, OIDC, crypto
    notes/
      index.ts
      presentation/
      application/
      infrastructure/
  platform/
    config/                    # runtime-конфигурация
    database/                  # общая D1 schema/connection
    http/                      # transport-wide middleware
    logging/                   # структурированные события
  shared/                      # маленькие стабильные примитивы
```

Маленькая фича может начинаться с нескольких файлов внутри своего модуля. Слои
появляются там, где уже есть отдельная ответственность, а не ради симметрии.
При этом действуют стабильные правила:

- другой модуль импортируется только через его `index.ts` или
  `public-contracts.ts`;
- `presentation` вызывает application use cases;
- application-код не знает о Hono, D1 и Telegram SDK/HTTP;
- application-ошибки принадлежат своему модулю, а presentation-слой переводит
  их в безопасные Problem Details с фиксированными публичными текстами;
- infrastructure реализует объявленные application ports;
- каждый `index.ts` скрывает внутренний wiring своего модуля, а `src/app`
  соединяет только публичные module factories, без контейнера DI и декораторов;
- generic repository отсутствует: ports выражают операции конкретной capability.

Центрального registry бизнес-ошибок намеренно нет. Локального исчерпывающего
маппера достаточно, пока модули собираются одним приложением. Registry имеет
смысл добавлять позже как контроль уникальности `code`/`type` и сборщик общего
каталога, если модулей и независимо работающих команд станет много.

`pnpm boundaries:check` защищает эти правила. Такая структура остаётся лёгкой
для MVP, но не требует болезненной перекладки каталогов, когда проект вырастет.

## Локальный запуск

Нужны Node.js 24 и pnpm 11.15.1. Версии зафиксированы в `.nvmrc`, `package.json`
и lockfile.

```bash
pnpm install
pnpm db:migrate:local
pnpm dev
```

После запуска проверьте:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/openapi.json
```

Для локальной проверки Telegram auth скопируйте `.dev.vars.example` в
`.dev.vars`, переключите `AUTH_MODE` в локальной конфигурации на `telegram` и
заполните значения только на своей машине. `.dev.vars` игнорируется Git.

Перед коммитом выполните:

```bash
pnpm check
```

Gate последовательно проверяет сгенерированные Cloudflare types, формат,
архитектурные границы, TypeScript, тесты и dry-run сборки Wrangler.

## D1 и миграции

Schema находится в `src/platform/database/schema.ts`, а сгенерированный SQL — в
`migrations/`. Миграции не запускаются из Worker и не применяются CI автоматически.
Единый schema-файл — осознанное маленькое исключение уровня persistence
composition: он описывает таблицы и внешние ключи, но не содержит продуктовых
правил. Если schema станет конфликтной зоной, её фрагменты можно перенести в
модули, сохранив этот файл только build-time aggregator для Drizzle Kit.

Обычный цикл изменения schema:

```bash
pnpm db:generate
pnpm db:migrate:local
pnpm check
pnpm db:migrate:remote
pnpm deploy
```

Всегда просматривайте сгенерированный SQL перед применением. Для изменений,
которые несовместимы с работающей версией API, используйте отдельные
expand/migrate/contract шаги, а не одну разрушающую миграцию.

В `wrangler.jsonc` исходно записан all-zero `database_id`. Это предохранитель
шаблона: remote migration и production deploy не должны случайно обратиться к
базе автора стартера. Для нового проекта:

```bash
pnpm exec wrangler login
pnpm exec wrangler d1 create free-hosting-starter-db
```

Wrangler вернёт UUID. В конкретном проекте замените им обе all-zero записи
`database_id` (base и `env.production`) до любой remote-операции. UUID базы не
является секретом, но принадлежит
конкретному Cloudflare account. В прикладном репозитории его нормально
закоммитить; при копировании стартера всегда создавайте новую D1 и не
переиспользуйте чужой UUID.

## Telegram OIDC

Production использует современный Telegram OpenID Connect Authorization Code
Flow с PKCE. Legacy login widget в стартер не входит.

1. Создайте отдельного нового бота через официальный `@BotFather`.
2. В BotFather настройте Telegram Login/OIDC для production origin и получите
   Client ID и Client Secret.
3. Зарегистрируйте точный callback:
   `https://<ваш-workers.dev>/api/auth/telegram/callback`.
4. Укажите реальный HTTPS origin без path в `APP_ORIGIN`, а допустимый redirect
   того же origin — в `AUTH_SUCCESS_REDIRECT_URL`.
5. Сохраните значения через скрытый prompt Wrangler:

```bash
pnpm exec wrangler secret put TELEGRAM_OIDC_CLIENT_ID --env production
pnpm exec wrangler secret put TELEGRAM_OIDC_CLIENT_SECRET --env production
pnpm exec wrangler secret put AUTH_FLOW_SECRET --env production
```

`AUTH_FLOW_SECRET` — отдельный криптографически случайный секрет длиной 32 байта,
представленный в base64url. Генерируйте его локально криптографическим
генератором или password manager. Не передавайте bot token, Client Secret или
`AUTH_FLOW_SECRET` в чат, issue, документацию, shell arguments либо Git. Bot
token для OIDC не подходит и приложению не нужен.

OIDC ID token принимается только с фиксированным Telegram issuer, audience и
алгоритмом RS256; `state`, PKCE и `nonce` обязательны. Короткоживущий flow cookie
зашифрован AES-GCM и живёт 10 минут. Новый старт входа в том же браузере заменяет
предыдущий незавершённый flow. Сессия — непрозрачный случайный token; в D1
хранится только его hash.
BotFather должен быть настроен на RS256; другой алгоритм считается ошибкой
production-конфигурации. Ротация `AUTH_FLOW_SECRET` инвалидирует только
незавершённые входы, которым не более десяти минут.

Cloudflare invocation logs отключены: иначе стандартная строка события содержит
полный callback URL вместе с одноразовыми `code` и `state`. Собственные
структурированные логи используют только pathname и никогда не пишут query,
cookies или токены.

Production cookie `__Host-session` имеет `Secure`, `HttpOnly`, `SameSite=Lax`,
`Path=/`, не имеет `Domain` и живёт до 30 дней. Из этого следует важное
ограничение: браузерный frontend должен обращаться к API с того же origin. В
бесплатной схеме отдельный frontend на `*.pages.dev` и API на `*.workers.dev`
не образуют рабочую cookie-сессию. Если UI понадобится, отдавайте его с того же
Worker origin через Static Assets либо ставьте frontend и API за единым origin.

## Telegram Bot API webhook

Bot API — отдельная capability от Telegram OIDC. Она выключена по умолчанию:

```text
TELEGRAM_BOT_MODE=disabled | webhook
```

Режимы независимы и включаются только своими настройками:

| `AUTH_MODE` | `TELEGRAM_BOT_MODE` | Результат |
| --- | --- | --- |
| `disabled` | `disabled` | OIDC/Notes и webhook отвечают безопасным `404` |
| `telegram` | `disabled` | Работают OIDC/Notes; webhook отвечает безопасным `404` |
| `disabled` | `webhook` | Работает Bot API webhook; OIDC/Notes отвечают безопасным `404` |
| `telegram` | `webhook` | OIDC/Notes и Bot API webhook работают независимо |

Это независимость runtime-конфигурации. Checked-in production preset самого
стартера по умолчанию включает `AUTH_MODE=telegram` и требует OIDC secrets через
Wrangler; для bot-only derived deployment явно поменяйте production vars и
соответствующий список required secrets перед deploy. Не добавляйте ненужные
secrets только ради capability, которая выключена.

В режиме `webhook` Worker читает `TELEGRAM_BOT_TOKEN` и
`TELEGRAM_BOT_WEBHOOK_SECRET` из Wrangler secrets. Второй секрет передаётся в
`setWebhook.secret_token` и проверяется в заголовке
`X-Telegram-Bot-Api-Secret-Token`. Не переиспользуйте для этого OIDC Client
Secret или `AUTH_FLOW_SECRET`.

Маршрут — только `POST /telegram/webhook`. Его безопасные ответы не раскрывают
токен, webhook secret, тело update, cookies или query-параметры:

| Условие | Ответ |
| --- | --- |
| Capability выключена или использован другой HTTP-метод | `404 NOT_FOUND` |
| Secret отсутствует или неверен | `401 UNAUTHENTICATED` |
| Content-Type не является JSON | `415 UNSUPPORTED_MEDIA_TYPE` |
| JSON не является объектом update | `400 VALIDATION_FAILED` |
| Update обработан, в том числе неизвестного для reference handler типа | `200` |
| Ошибка инициализации или обработчика | `500 INTERNAL_ERROR`; Telegram может повторить доставку |

Ошибочные HTTP-ответы имеют общий формат Problem Details. В логах ошибок webhook
остаются только категория события, pathname, request ID и безопасно разобранный
`update_id`; данные провайдера не логируются. Общий request log добавляет лишь
метод, статус и длительность запроса.

Reference handler регистрирует только `/start` и отвечает текстом `Bot is
ready.`. Он не создаёт пользователей, сессии, меню или бизнес-таблицы. Точка
расширения derived product находится на уровне исходника
`src/modules/telegram-bot/handlers.ts`: добавляйте туда transport handlers и
вызывайте product module только через его root/public contracts. `bot.ts` при
этом сохраняет общий lifecycle — инициализацию, cache и safe error boundary.
Опция `createTelegramBotModule({ createWebhookHandler })` — test/composition seam
(например, для fake handler в Vitest), а не product extension: её переопределение
заменяет core lifecycle. Переданный handler получает проверенный request и
контекст с `requestId`, pathname и (если он корректен) `updateId`.

### At-least-once delivery and idempotency

Telegram может повторно доставить update при timeout или ответе с ошибкой, поэтому
webhook имеет семантику at-least-once: повторы и конкурентная доставка ожидаемы.
Capability передаёт `update_id` в контекст вызванного handler-а. Если команда
продукта меняет durable state, продукт сам выводит стабильный ключ, например
`telegram:<bot-id>:update:<update-id>`, и сохраняет его в той же транзакции D1,
что и бизнес-мутацию. Уже зафиксированная команда должна вернуть успех без
повторной мутации. Общей таблицы `processed_updates` в стартере нет.

Это не обещает exactly-once для внешнего `sendMessage`: сбой после принятия
сообщения Telegram, но до локального завершения, может привести к дублю. Для
надёжной исходящей доставки потребуются отдельно спроектированные outbox и
механизм восстановления; Queue, Cron и Durable Objects в baseline не входят.

Для локальной проверки HTTP-границы без настоящего токена запустите Worker и
отправьте сохранённый fake update:

```bash
pnpm dev
./scripts/curl-telegram-update.sh
```

С локальной конфигурацией по умолчанию ожидается безопасный `404`; если
capability включена, запрос без webhook-заголовка завершается `401` до
инициализации Bot API. Этот сценарий не обращается к Telegram и не является
проверкой реального ответа бота. Fake Bot API и `/start` проверяются в Vitest:

```bash
pnpm exec vitest run test/telegram-bot.spec.ts test/telegram-bot-operator.spec.mjs
```

### Ручная регистрация и inspection

Изменение состояния webhook выполняется только отдельной operator-командой.
Секреты нельзя передавать аргументами (`--token`, `--secret` и т. п.) или
выводить; команда принимает их только из переменных окружения либо из stdin.
`info` и `clear` требуют только token, а `set` — две непустые строки (token,
затем webhook secret):

```bash
pnpm telegram:operator -- info
pnpm telegram:operator -- set https://<ваш-workers.dev>/telegram/webhook
pnpm telegram:operator -- clear
```

`set` требует точный HTTPS URL `https://<ваш-workers.dev>/telegram/webhook`
без query-параметров. Он передаёт Telegram только обновления `message` и
ставит `drop_pending_updates=false`. Для намеренного удаления накопленных
обновлений нужен явный флаг; команда выведет предупреждение:

```bash
pnpm telegram:operator -- set https://<ваш-workers.dev>/telegram/webhook --drop-pending-updates
```

Перед ручной операцией создайте независимые production secrets через скрытый
prompt Wrangler и включите `TELEGRAM_BOT_MODE=webhook` в production vars:

```bash
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --env production
pnpm exec wrangler secret put TELEGRAM_BOT_WEBHOOK_SECRET --env production
```

Токен бота берётся у `@BotFather`. Независимый webhook secret сгенерируйте в
password manager или криптографическом генераторе; он должен содержать от 1 до
256 символов только из `A-Z`, `a-z`, `0-9`, `_` и `-`. Секреты, сохранённые
через `wrangler secret put`, становятся доступными Worker, но не появляются
автоматически в environment локального operator-процесса.

Для локального operator-сеанса введите значения без отображения и удалите их
из environment после операции. В команды и shell history не попадают сами
секреты:

```bash
unset TELEGRAM_BOT_TOKEN TELEGRAM_BOT_WEBHOOK_SECRET
printf '%s' 'Telegram bot token (hidden): ' >&2
read -r -s TELEGRAM_BOT_TOKEN
printf '\n' >&2
printf '%s' 'Telegram webhook secret (hidden): ' >&2
read -r -s TELEGRAM_BOT_WEBHOOK_SECRET
printf '\n' >&2
export TELEGRAM_BOT_TOKEN TELEGRAM_BOT_WEBHOOK_SECRET

pnpm telegram:operator -- info
pnpm telegram:operator -- set https://<ваш-workers.dev>/telegram/webhook
pnpm telegram:operator -- clear

unset TELEGRAM_BOT_TOKEN TELEGRAM_BOT_WEBHOOK_SECRET
```

Также допустим non-echoing stdin pipeline из доверенного password manager или
другого secret source: для `info`/`clear` он передаёт одну строку token, для
`set` — две строки в порядке token, webhook secret. Не используйте `echo` или
`printf` для передачи самого секрета: источник должен писать значения напрямую
в stdin operator-команды, а не показывать их в выводе.

После явно разрешённого `set` выполните inspection — `info` вызывает только
`getWebhookInfo` и позволяет проверить URL, `pending_update_count`, список
обновлений и последнюю ошибку доставки. Для rollback вызовите `clear`, затем
снова `info`; `clear` использует `setWebhook` с пустым URL и по умолчанию также
не удаляет pending updates. Пока webhook установлен, Telegram не позволяет
использовать `getUpdates`; сначала удалите webhook, если требуется перейти на
polling. Установка, очистка и inspection не выполняются при старте Worker,
тестах, в CI или во время deploy.

## Ручной production deploy

CI ничего не публикует. Перед первым deploy:

1. Убедитесь, что Cloudflare account остаётся на Free plan.
2. Создайте D1 и замените template placeholder, как описано выше.
3. Узнайте свой реальный `workers.dev` hostname и обновите `APP_ORIGIN` и
   `AUTH_SUCCESS_REDIRECT_URL` в production env.
4. Настройте BotFather callback для OIDC и положите требуемые OIDC secrets
   скрытыми командами; Bot API secrets добавляйте только при явном включении
   `TELEGRAM_BOT_MODE=webhook`.
5. Выполните локальный `pnpm check`.
6. Примените миграции и опубликуйте Worker вручную:

```bash
pnpm db:migrate:remote
pnpm deploy
```

`pnpm deploy` не меняет состояние Telegram. После публикации, если Bot API
capability явно включена, отдельной командой `telegram:operator set` задайте
точный HTTPS webhook и затем выполните `telegram:operator info`. Это две
разные операции с разными доказательствами.

Production resource names по умолчанию: Worker `free-hosting-starter`, D1
`free-hosting-starter-db`. Custom domain для базового сценария не требуется.
Не запускайте `wrangler tail` во время OIDC smoke: real-time trace содержит
полный request URL и может показать одноразовые callback `code` и `state`.

## Контракт нулевой обязательной стоимости

Стартер использует только Workers Free и D1 Free и не создаёт платные ресурсы.
Это не обещание безлимитной работы: проект остаётся бесплатным, пока account на
Free plan, а фактическое потребление укладывается в актуальные
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) и
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

При исчерпании free quota запросы могут отклоняться, ограничиваться или ждать
сброса соответствующего лимита; стартер не включает автоматический переход на
платный ресурс. Перед каждым production-проектом проверьте текущие лимиты и
поведение в официальной документации Cloudflare. Подключение Paid plan,
платного add-on или нового Cloudflare resource требует отдельного решения.
Распределённого rate limiter в v1 нет: isolate-local счётчик создавал бы ложное
ощущение защиты. Для публичного высокорискового API это отдельная availability и
abuse-задача, которую следует решить до привлечения реального трафика.

## Что именно доказывают проверки

- `pnpm check` доказывает только локальные static checks, тесты в локальном
  Workers/D1 runtime и успешную dry-run сборку.
- Зелёный локальный gate не доказывает, что GitHub Actions запускался или прошёл.
- Push в GitHub не доказывает зелёный CI: статус workflow нужно увидеть отдельно.
- `pnpm db:migrate:remote` доказывает применение миграций к выбранной remote D1,
  но не доступность Worker.
- Успешный deploy и `200` от `/health` доказывают доступность опубликованного
  Worker, но не Telegram login и не CRUD.
- `scripts/curl-telegram-update.sh` доказывает только безопасную HTTP-границу
  без настоящего токена; fake Bot API в тестах не заменяет Telegram.
- `telegram:operator info` — отдельная remote inspection; `set` и `clear` —
  явные remote mutations и не запускаются автоматически.
- Fake OIDC в тестах не заменяет реальный OIDC/Notes smoke.
- `/health`, fake update, fake Bot API и `telegram:operator info` сами по себе не
  доказывают реальный Bot API smoke.

### OIDC/Notes smoke

OIDC/Notes smoke выполняется в обычном браузере с выделенным тестовым ботом:
старт входа → согласие Telegram → callback → `/api/auth/me` →
create/list/get/update/delete своей заметки → logout → отказ старой сессии.
Только такой сценарий подтверждает совместную работу BotFather-настроек OIDC,
cookies, Worker и D1. Он не доказывает реальную доставку Bot API webhook.

### Bot API smoke (TB-06, отдельное разрешение)

Реальный Bot API smoke требует отдельного разрешения TB-06, выделенного test bot,
настроенных secrets и явно выбранной hosted deployment revision. Наблюдаемый
сквозной путь: пользователь отправляет `/start` в Telegram → Telegram доставляет
`POST /telegram/webhook` на опубликованный Worker → handler обрабатывает update →
Worker вызывает Bot API → пользователь получает ответ бота. `setWebhook`, deploy,
inspection и запись evidence выполняются отдельными операциями; они не являются
частью `pnpm check` и не запускаются автоматически.

## Лицензия

Проект помечен как `UNLICENSED`; публичная лицензия намеренно не добавлена.
