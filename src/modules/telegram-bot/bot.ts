import { Bot, webhookCallback } from "grammy";
import type { WebhookTelegramBotRuntimeConfig } from "../../platform/config/runtime-config";
import { registerTelegramBotHandlers } from "./handlers";

export type TelegramWebhookHandler = (request: Request) => Response | Promise<Response>;

export type TelegramBotHandlerConfig = Pick<WebhookTelegramBotRuntimeConfig, "telegramBotToken">;

export function createTelegramWebhookHandler(
  config: TelegramBotHandlerConfig,
): TelegramWebhookHandler {
  const bot = new Bot(config.telegramBotToken);
  registerTelegramBotHandlers(bot);
  return webhookCallback(bot, "cloudflare-mod");
}
