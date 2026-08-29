import type { TelegramRuntimeConfig } from "../../platform/config/runtime-config";
import type { TelegramOidcClient } from "./application/ports";
import { AesGcmLoginFlowCodec } from "./infrastructure/aes-gcm-login-flow-codec";
import { D1IdentitySessionRepository } from "./infrastructure/d1-identity-session-repository";
import { TelegramOidcHttpClient } from "./infrastructure/telegram-oidc-client";
import { createIdentityHttp } from "./presentation/http";

export type IdentityAccessModuleOptions = {
  createTelegramOidcClient?: (config: TelegramRuntimeConfig) => TelegramOidcClient;
};

export function createIdentityAccessModule(options: IdentityAccessModuleOptions = {}) {
  return createIdentityHttp({
    createFlowCodec: (secret) => new AesGcmLoginFlowCodec(secret),
    createOidcClient:
      options.createTelegramOidcClient ??
      ((config) =>
        new TelegramOidcHttpClient(config.telegramClientId, config.telegramClientSecret)),
    createRepository: (database) => new D1IdentitySessionRepository(database),
  });
}

export type { TelegramOidcClient } from "./application/ports";
