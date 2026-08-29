import { z } from "zod";
import { decodeBase64Url, encodeBase64Url } from "../../../platform/crypto/base64url";
import { ApplicationError } from "../../../shared/application/application-error";
import type { LoginFlow } from "../application/model";
import type { LoginFlowCodec } from "../application/ports";

const FLOW_VERSION = "v1";
const ADDITIONAL_DATA = new TextEncoder().encode("free-hosting-starter:telegram-flow:v1");

const loginFlowSchema = z.object({
  version: z.literal(1),
  issuer: z.literal("https://oauth.telegram.org"),
  clientId: z.string().min(1).max(64),
  redirectUri: z.url(),
  state: z.string().min(32).max(128),
  nonce: z.string().min(32).max(128),
  codeVerifier: z.string().min(43).max(128),
  issuedAt: z.number().int().nonnegative(),
});

export class AesGcmLoginFlowCodec implements LoginFlowCodec {
  private readonly key: Promise<CryptoKey>;

  constructor(secret: string) {
    const rawKey = decodeBase64Url(secret);
    if (rawKey.byteLength !== 32) {
      throw new Error("AUTH_FLOW_SECRET must be exactly 32 base64url-encoded bytes");
    }
    this.key = crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async seal(flow: LoginFlow): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(flow));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
      await this.key,
      plaintext,
    );
    return `${FLOW_VERSION}.${encodeBase64Url(iv)}.${encodeBase64Url(ciphertext)}`;
  }

  async open(value: string): Promise<LoginFlow> {
    try {
      const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
      if (version !== FLOW_VERSION || !encodedIv || !encodedCiphertext || extra) {
        throw new Error("Malformed flow cookie");
      }
      const iv = decodeBase64Url(encodedIv);
      if (iv.byteLength !== 12) {
        throw new Error("Malformed flow IV");
      }
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
        await this.key,
        decodeBase64Url(encodedCiphertext),
      );
      return loginFlowSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch (error) {
      throw new ApplicationError("INVALID_REQUEST", "The Telegram login flow is invalid.", {
        cause: error,
      });
    }
  }
}
