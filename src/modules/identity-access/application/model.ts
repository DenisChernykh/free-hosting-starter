import type { AuthenticatedUser } from "../public-contracts";

export type ExternalIdentityProfile = {
  issuer: string;
  subject: string;
  displayName: string | null;
  username: string | null;
  photoUrl: string | null;
};

export type LoginFlow = {
  version: 1;
  issuer: "https://oauth.telegram.org";
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
};

export type SessionToCreate = {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
};

export type AuthenticationResult = {
  sessionToken: string;
  user: AuthenticatedUser;
};
