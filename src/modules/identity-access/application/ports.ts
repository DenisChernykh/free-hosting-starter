import type { AuthenticatedUser } from "../public-contracts";
import type { ExternalIdentityProfile, LoginFlow, SessionToCreate } from "./model";

export interface IdentitySessionRepository {
  authenticateExternalIdentity(
    profile: ExternalIdentityProfile,
    session: SessionToCreate,
  ): Promise<AuthenticatedUser>;
  findUserBySession(tokenHash: string, now: number): Promise<AuthenticatedUser | null>;
  revokeSession(tokenHash: string): Promise<void>;
}

export interface LoginFlowCodec {
  open(value: string): Promise<LoginFlow>;
  seal(flow: LoginFlow): Promise<string>;
}

export interface TelegramOidcClient {
  buildAuthorizationUrl(input: {
    codeChallenge: string;
    nonce: string;
    redirectUri: string;
    state: string;
  }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    now: number;
    redirectUri: string;
  }): Promise<ExternalIdentityProfile>;
}
