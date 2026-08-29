import { z } from "zod";
import { decodeBase64Url } from "../crypto/base64url";

const baseConfigSchema = z.object({
  APP_ORIGIN: z.url(),
  AUTH_MODE: z.enum(["disabled", "telegram"]),
  AUTH_SUCCESS_REDIRECT_URL: z.url(),
  BUILD_REVISION: z.string().trim().min(1).max(128),
});

const telegramSecretsSchema = z.object({
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

type BaseRuntimeConfig = {
  appOrigin: string;
  authSuccessRedirectUrl: string;
  buildRevision: string;
};

export type DisabledRuntimeConfig = BaseRuntimeConfig & {
  authMode: "disabled";
};

export type TelegramRuntimeConfig = BaseRuntimeConfig & {
  authFlowSecret: string;
  authMode: "telegram";
  telegramClientId: string;
  telegramClientSecret: string;
};

export type RuntimeConfig = DisabledRuntimeConfig | TelegramRuntimeConfig;

export function readRuntimeConfig(bindings: CloudflareBindings): RuntimeConfig {
  const base = baseConfigSchema.parse(bindings);
  const appOriginUrl = new URL(base.APP_ORIGIN);
  const normalizedAppOrigin = appOriginUrl.origin;

  if (base.APP_ORIGIN !== normalizedAppOrigin) {
    throw new Error("APP_ORIGIN must contain only an origin without a path");
  }

  if (appOriginUrl.protocol !== "https:" && appOriginUrl.hostname !== "localhost") {
    throw new Error("APP_ORIGIN must use HTTPS outside localhost");
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

  if (base.AUTH_MODE === "disabled") {
    return { ...common, authMode: "disabled" };
  }

  const telegram = telegramSecretsSchema.parse(bindings);
  return {
    ...common,
    authFlowSecret: telegram.AUTH_FLOW_SECRET,
    authMode: "telegram",
    telegramClientId: telegram.TELEGRAM_OIDC_CLIENT_ID,
    telegramClientSecret: telegram.TELEGRAM_OIDC_CLIENT_SECRET,
  };
}
