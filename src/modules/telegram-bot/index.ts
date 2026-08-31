import type { TelegramBotHandlerConfig, TelegramWebhookHandler } from "./bot";
import { createTelegramWebhookHandler } from "./bot";
import { createTelegramBotHttp } from "./presentation/http";

export {
  TELEGRAM_BOT_FAILURE_CATEGORIES,
  TELEGRAM_BOT_INITIALIZATION_TIMEOUT_MS,
  type TelegramBotFailureCategory,
  type TelegramBotHandlerConfig,
  TelegramWebhookFailure,
  type TelegramWebhookHandler,
  type TelegramWebhookRequestContext,
} from "./bot";
export { TELEGRAM_WEBHOOK_SECURITY_SCHEME } from "./presentation/http";

export type TelegramBotModuleOptions = {
  createWebhookHandler?: (config: TelegramBotHandlerConfig) => TelegramWebhookHandler;
};

export function createTelegramBotModule(options: TelegramBotModuleOptions = {}) {
  return {
    router: createTelegramBotHttp({
      createWebhookHandler: options.createWebhookHandler ?? createTelegramWebhookHandler,
    }),
  };
}
