import { Bot, webhookCallback } from "grammy";
import type { WebhookTelegramBotRuntimeConfig } from "../../platform/config/runtime-config";
import { registerTelegramBotHandlers } from "./handlers";

export type TelegramWebhookRequestContext = {
  readonly path: string;
  readonly requestId: string;
  readonly updateId?: number;
};

export const TELEGRAM_BOT_FAILURE_CATEGORIES = {
  handler: "handler_failure",
  initialization: "initialization_failure",
} as const;

// grammY retries some Bot API failures indefinitely. Keep initialization
// bounded below webhookCallback's ten-second request deadline.
export const TELEGRAM_BOT_INITIALIZATION_TIMEOUT_MS = 5_000;

export type TelegramBotFailureCategory =
  (typeof TELEGRAM_BOT_FAILURE_CATEGORIES)[keyof typeof TELEGRAM_BOT_FAILURE_CATEGORIES];

export type TelegramWebhookHandler = (
  request: Request,
  context?: TelegramWebhookRequestContext,
) => Response | Promise<Response>;

export type TelegramBotHandlerConfig = Pick<WebhookTelegramBotRuntimeConfig, "telegramBotToken">;

type TelegramBotInfo = Awaited<ReturnType<Bot["api"]["getMe"]>>;

type CachedBotInfo = {
  token: string;
  value: TelegramBotInfo;
};

type InFlightBotInitialization = {
  promise: Promise<TelegramBotInfo>;
  token: string;
};

let cachedBotInfo: CachedBotInfo | undefined;
let inFlightBotInitialization: InFlightBotInitialization | undefined;

/**
 * The Worker keeps this module in an isolate for multiple webhook requests.
 * Cache only the non-sensitive result of getMe, never the token in a log or
 * response. A failed initialization is removed from the in-flight cache so a
 * later request can retry and still produce a retryable response.
 */
async function initializeBot(bot: Bot, token: string): Promise<void> {
  if (cachedBotInfo?.token === token) {
    bot.botInfo = cachedBotInfo.value;
    return;
  }

  let initialization =
    inFlightBotInitialization?.token === token ? inFlightBotInitialization.promise : undefined;

  if (!initialization) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Telegram bot initialization timed out."));
      }, TELEGRAM_BOT_INITIALIZATION_TIMEOUT_MS);
    });
    let promise: Promise<TelegramBotInfo>;
    // grammY's Node declaration uses its bundled abort-controller type while
    // Workers provide a structurally compatible native signal at runtime.
    // @ts-expect-error -- upstream grammY declaration does not accept the Workers signal type.
    const botInitialization = bot.init(controller.signal);
    promise = Promise.race([botInitialization, deadline])
      .then(() => {
        const value = bot.botInfo;
        cachedBotInfo = { token, value };
        return value;
      })
      .finally(() => {
        if (inFlightBotInitialization?.promise === promise) {
          inFlightBotInitialization = undefined;
        }
        if (timeout !== undefined) clearTimeout(timeout);
      });
    inFlightBotInitialization = { promise, token };
    initialization = promise;
  }

  bot.botInfo = await initialization;
}

function logTelegramWebhookFailure(
  category: TelegramBotFailureCategory,
  context: TelegramWebhookRequestContext | undefined,
): void {
  const fields: {
    category: TelegramBotFailureCategory;
    event: "telegram_webhook_failure";
    path: string;
    requestId: string;
    update_id?: number;
  } = {
    category,
    event: "telegram_webhook_failure",
    path: context?.path ?? "/telegram/webhook",
    requestId: context?.requestId ?? "unknown",
  };
  if (context?.updateId !== undefined) fields.update_id = context.updateId;

  // Do not include the provider error: grammY errors contain payloads,
  // descriptions, and may contain the bot token or update content.
  console.error(JSON.stringify(fields));
}

export class TelegramWebhookFailure extends Error {
  readonly category: TelegramBotFailureCategory;

  constructor(category: TelegramBotFailureCategory) {
    super("Telegram webhook processing failed.");
    this.name = "TelegramWebhookFailure";
    this.category = category;
  }
}

export function createTelegramWebhookHandler(
  config: TelegramBotHandlerConfig,
): TelegramWebhookHandler {
  const bot = new Bot(config.telegramBotToken);
  registerTelegramBotHandlers(bot);
  const callback = webhookCallback(bot, "cloudflare-mod");

  return async (request, context) => {
    try {
      await initializeBot(bot, config.telegramBotToken);
    } catch {
      logTelegramWebhookFailure(TELEGRAM_BOT_FAILURE_CATEGORIES.initialization, context);
      throw new TelegramWebhookFailure(TELEGRAM_BOT_FAILURE_CATEGORIES.initialization);
    }

    try {
      return await callback(request);
    } catch {
      logTelegramWebhookFailure(TELEGRAM_BOT_FAILURE_CATEGORIES.handler, context);
      throw new TelegramWebhookFailure(TELEGRAM_BOT_FAILURE_CATEGORIES.handler);
    }
  };
}
