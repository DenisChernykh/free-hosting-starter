import { z } from "zod";
import { decodeBase64Url } from "../crypto/base64url";

const baseConfigSchema = z.object({
  APP_ORIGIN: z.url(),
  AUTH_MODE: z.enum(["development", "disabled", "telegram"]),
  AUTH_SUCCESS_REDIRECT_URL: z.url(),
  BUILD_REVISION: z.string().trim().min(1).max(128),
  TELEGRAM_BOT_MODE: z.enum(["disabled", "webhook"]),
});

const telegramAuthSecretsSchema = z.object({
  AUTH_FLOW_SECRET: z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          return decodeBase64Url(value).byteLength === 32;
        } catch {
          return false;
        }
      },
      { message: "AUTH_FLOW_SECRET must be exactly 32 base64url-encoded bytes" },
    ),
  TELEGRAM_OIDC_CLIENT_ID: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  TELEGRAM_OIDC_CLIENT_SECRET: z.string().trim().min(1).max(512),
});

const telegramBotSecretsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_BOT_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
});

type BaseRuntimeConfig = {
  appOrigin: string;
  authSuccessRedirectUrl: string;
  buildRevision: string;
};

export type DisabledRuntimeConfig = BaseRuntimeConfig & {
  authMode: "disabled";
};

export type DevelopmentRuntimeConfig = BaseRuntimeConfig & {
  authMode: "development";
};

export type TelegramAuthRuntimeConfig = {
  authFlowSecret: string;
  authMode: "telegram";
  telegramClientId: string;
  telegramClientSecret: string;
};

export type TelegramRuntimeConfig = BaseRuntimeConfig & TelegramAuthRuntimeConfig;

export type DisabledTelegramBotRuntimeConfig = {
  telegramBotMode: "disabled";
};

export type WebhookTelegramBotRuntimeConfig = {
  telegramBotMode: "webhook";
  telegramBotToken: string;
  telegramBotWebhookSecret: string;
};

export type TelegramBotRuntimeConfig =
  | DisabledTelegramBotRuntimeConfig
  | WebhookTelegramBotRuntimeConfig;

export type AuthRuntimeConfig =
  | Pick<DisabledRuntimeConfig, "authMode">
  | Pick<DevelopmentRuntimeConfig, "authMode">
  | TelegramAuthRuntimeConfig;

export type RuntimeConfig = BaseRuntimeConfig & AuthRuntimeConfig & TelegramBotRuntimeConfig;

type RuntimeModeBindings = {
  TELEGRAM_BOT_MODE: "disabled" | "webhook";
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_WEBHOOK_SECRET?: string;
};

// Wrangler's required secret list is unconditional; keep bot secrets optional
// here and let the selected bot mode decide whether they must be present.
export type RuntimeConfigBindings = Omit<CloudflareBindings, "AUTH_MODE" | "TELEGRAM_BOT_MODE"> &
  RuntimeModeBindings & {
    AUTH_MODE: "development" | "disabled" | "telegram";
  };

export function readRuntimeConfig(bindings: RuntimeConfigBindings): RuntimeConfig {
  const base = baseConfigSchema.parse(bindings);
  const appOriginUrl = new URL(base.APP_ORIGIN);
  const normalizedAppOrigin = appOriginUrl.origin;

  if (base.APP_ORIGIN !== normalizedAppOrigin) {
    throw new Error("APP_ORIGIN must contain only an origin without a path");
  }

  if (appOriginUrl.protocol !== "https:" && appOriginUrl.hostname !== "localhost") {
    throw new Error("APP_ORIGIN must use HTTPS outside localhost");
  }
  if (
    base.AUTH_MODE === "development" &&
    (appOriginUrl.protocol !== "http:" || appOriginUrl.hostname !== "localhost")
  ) {
    throw new Error("AUTH_MODE=development is only permitted for http://localhost");
  }

  const successUrl = new URL(base.AUTH_SUCCESS_REDIRECT_URL);
  if (successUrl.origin !== normalizedAppOrigin) {
    throw new Error("AUTH_SUCCESS_REDIRECT_URL must use APP_ORIGIN");
  }

  const common = {
    appOrigin: normalizedAppOrigin,
    authSuccessRedirectUrl: successUrl.toString(),
    buildRevision: base.BUILD_REVISION,
  };

  const auth: AuthRuntimeConfig =
    base.AUTH_MODE === "disabled"
      ? { authMode: "disabled" }
      : base.AUTH_MODE === "development"
        ? (() => {
            if (base.BUILD_REVISION !== "local") {
              throw new Error("AUTH_MODE=development is only permitted with BUILD_REVISION=local");
            }
            return { authMode: "development" as const };
          })()
        : (() => {
            const telegram = telegramAuthSecretsSchema.parse(bindings);
            return {
              authFlowSecret: telegram.AUTH_FLOW_SECRET,
              authMode: "telegram" as const,
              telegramClientId: telegram.TELEGRAM_OIDC_CLIENT_ID,
              telegramClientSecret: telegram.TELEGRAM_OIDC_CLIENT_SECRET,
            };
          })();

  const telegramBot: TelegramBotRuntimeConfig =
    base.TELEGRAM_BOT_MODE === "disabled"
      ? { telegramBotMode: "disabled" }
      : (() => {
          const telegram = telegramBotSecretsSchema.parse(bindings);
          return {
            telegramBotMode: "webhook" as const,
            telegramBotToken: telegram.TELEGRAM_BOT_TOKEN,
            telegramBotWebhookSecret: telegram.TELEGRAM_BOT_WEBHOOK_SECRET,
          };
        })();

  return { ...common, ...auth, ...telegramBot };
}
