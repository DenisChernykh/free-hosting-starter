import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { WebhookTelegramBotRuntimeConfig } from "../../../platform/config/runtime-config";
import { readRuntimeConfig } from "../../../platform/config/runtime-config";
import { timingSafeEqualStrings } from "../../../platform/crypto/secure-values";
import type { WorkerHttpEnv } from "../../../platform/http/environment";
import { problemDetailsSchema } from "../../../platform/http/problem-details-schema";
import type { TelegramBotHandlerConfig, TelegramWebhookHandler } from "../bot";
import {
  telegramWebhookInvalidBody,
  telegramWebhookNotFound,
  telegramWebhookUnauthorized,
  telegramWebhookUnsupportedMediaType,
} from "./problems";

type TelegramBotHttpEnv = WorkerHttpEnv;

export const TELEGRAM_WEBHOOK_SECURITY_SCHEME = "telegramWebhookSecret";

export type TelegramBotHttpDependencies = {
  createWebhookHandler(config: TelegramBotHandlerConfig): TelegramWebhookHandler;
};

const telegramUpdateSchema = z.record(z.string(), z.unknown()).openapi("TelegramUpdate", {
  description:
    "Provider-owned Telegram Bot API Update object; see https://core.telegram.org/bots/api#update.",
});

const webhookRoute = createRoute({
  method: "post",
  path: "/telegram/webhook",
  tags: ["Telegram Bot"],
  security: [{ [TELEGRAM_WEBHOOK_SECURITY_SCHEME]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: telegramUpdateSchema,
        },
      },
    },
  },
  responses: {
    200: { description: "Telegram update accepted" },
    400: {
      description: "Malformed or invalid Telegram update",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    401: {
      description: "Missing or invalid Telegram webhook secret",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    404: {
      description: "Telegram Bot capability is disabled",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    415: {
      description: "JSON Content-Type is required",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
    500: {
      description: "Unexpected server failure",
      content: { "application/problem+json": { schema: problemDetailsSchema } },
    },
  },
});

const isJsonContentType = (value: string): boolean =>
  /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json(?:\s*;|$)/iu.test(value);

function webhookConfig(env: CloudflareBindings): WebhookTelegramBotRuntimeConfig | null {
  const config = readRuntimeConfig(env);
  return config.telegramBotMode === "webhook" ? config : null;
}

const requireEnabled: MiddlewareHandler<TelegramBotHttpEnv> = async (c, next) => {
  if (!webhookConfig(c.env)) {
    c.res = telegramWebhookNotFound(c);
    return;
  }
  await next();
};

const requireSecret: MiddlewareHandler<TelegramBotHttpEnv> = async (c, next) => {
  const config = webhookConfig(c.env);
  if (!config) {
    c.res = telegramWebhookNotFound(c);
    return;
  }
  const providedSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!(await timingSafeEqualStrings(providedSecret, config.telegramBotWebhookSecret))) {
    c.res = telegramWebhookUnauthorized(c);
    return;
  }
  await next();
};

const requireJson: MiddlewareHandler<TelegramBotHttpEnv> = async (c, next) => {
  if (!isJsonContentType(c.req.header("Content-Type") ?? "")) {
    c.res = telegramWebhookUnsupportedMediaType(c);
    return;
  }
  await next();
};

function rebuildRequest(c: Context<TelegramBotHttpEnv>, update: Record<string, unknown>): Request {
  const headers = new Headers(c.req.header());
  headers.delete("content-length");
  return new Request(c.req.url, {
    method: c.req.method,
    headers,
    body: JSON.stringify(update),
  });
}

export function createTelegramBotHttp(
  dependencies: TelegramBotHttpDependencies,
): OpenAPIHono<TelegramBotHttpEnv> {
  const router = new OpenAPIHono<TelegramBotHttpEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return telegramWebhookInvalidBody(c);
    },
  });

  router.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 400) {
      return telegramWebhookInvalidBody(c);
    }
    throw error;
  });

  let cached: { handler: TelegramWebhookHandler; token: string } | undefined;

  router.openapi(
    {
      ...webhookRoute,
      middleware: [requireEnabled, requireSecret, requireJson],
    },
    async (c) => {
      const config = webhookConfig(c.env);
      if (!config) return telegramWebhookNotFound(c);

      if (!cached || cached.token !== config.telegramBotToken) {
        cached = {
          handler: dependencies.createWebhookHandler({
            telegramBotToken: config.telegramBotToken,
          }),
          token: config.telegramBotToken,
        };
      }

      return cached.handler(rebuildRequest(c, c.req.valid("json")));
    },
  );

  return router;
}
