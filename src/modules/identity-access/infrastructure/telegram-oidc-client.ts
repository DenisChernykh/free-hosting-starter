import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { encodeUtf8Base64 } from "../../../platform/crypto/base64url";
import { timingSafeEqualStrings } from "../../../platform/crypto/secure-values";
import { ApplicationError } from "../../../shared/application/application-error";
import type { ExternalIdentityProfile } from "../application/model";
import type { TelegramOidcClient } from "../application/ports";

const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const AUTHORIZATION_ENDPOINT = `${TELEGRAM_ISSUER}/auth`;
const TOKEN_ENDPOINT = `${TELEGRAM_ISSUER}/token`;
const TELEGRAM_JWKS = createRemoteJWKSet(new URL(`${TELEGRAM_ISSUER}/.well-known/jwks.json`), {
  timeoutDuration: 5_000,
});
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
});

const profileClaimsSchema = z.object({
  sub: z.string().min(1).max(128),
  nonce: z.string().min(1).max(256),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive().max(4_102_444_800),
  name: z.string().trim().min(1).max(256).optional(),
  preferred_username: z.string().trim().min(1).max(64).optional(),
  picture: z.url().optional(),
});

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
    throw new Error("Telegram token response is too large");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Telegram token response is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export class TelegramOidcHttpClient implements TelegramOidcClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  buildAuthorizationUrl(input: {
    codeChallenge: string;
    nonce: string;
    redirectUri: string;
    state: string;
  }): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      nonce: input.nonce,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid profile",
      state: input.state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    now: number;
    redirectUri: string;
  }): Promise<ExternalIdentityProfile> {
    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Basic ${encodeUtf8Base64(`${this.clientId}:${this.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          code: input.code,
          code_verifier: input.codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        throw new Error(`Telegram token endpoint returned ${response.status}`);
      }

      const encodedResponse = await readBoundedResponse(response);
      const tokenResponse = tokenResponseSchema.parse(JSON.parse(encodedResponse));
      const { payload } = await jwtVerify(tokenResponse.id_token, TELEGRAM_JWKS, {
        algorithms: ["RS256"],
        audience: this.clientId,
        issuer: TELEGRAM_ISSUER,
      });
      const claims = profileClaimsSchema.parse(payload);
      if (payload.aud !== this.clientId) {
        throw new Error("Telegram ID token audience must be a scalar client ID");
      }
      const issuedAtMs = claims.iat * 1000;
      if (issuedAtMs > input.now + 60_000 || input.now - issuedAtMs > 10 * 60 * 1000) {
        throw new Error("Telegram ID token was issued outside the accepted window");
      }
      if (!(await timingSafeEqualStrings(claims.nonce, input.nonce))) {
        throw new Error("Telegram ID token nonce mismatch");
      }

      return {
        issuer: TELEGRAM_ISSUER,
        subject: claims.sub,
        displayName: claims.name ?? null,
        username: claims.preferred_username ?? null,
        photoUrl: claims.picture ?? null,
      };
    } catch (error) {
      throw new ApplicationError(
        "DEPENDENCY_UNAVAILABLE",
        "Telegram authentication could not be completed.",
        { cause: error },
      );
    }
  }
}
