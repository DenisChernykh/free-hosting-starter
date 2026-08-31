import {
  randomBase64Url,
  sha256Base64Url,
  timingSafeEqualStrings,
} from "../../../platform/crypto/secure-values";
import { ApplicationError } from "../../../shared/application/application-error";
import type { AuthenticatedUser } from "../public-contracts";
import type { AuthenticationResult, LoginFlow } from "./model";
import type { IdentitySessionRepository, LoginFlowCodec, TelegramOidcClient } from "./ports";

const LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_IDENTITY = {
  displayName: "Local Developer",
  issuer: "urn:free-hosting-starter:development",
  photoUrl: null,
  subject: "local-developer",
  username: "local-developer",
} as const;

export class StartTelegramLogin {
  constructor(
    private readonly oidcClient: TelegramOidcClient,
    private readonly flowCodec: LoginFlowCodec,
  ) {}

  async execute(input: { clientId: string; now: number; redirectUri: string }): Promise<{
    authorizationUrl: string;
    flowCookie: string;
  }> {
    const codeVerifier = randomBase64Url(32);
    const flow: LoginFlow = {
      version: 1,
      issuer: "https://oauth.telegram.org",
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      state: randomBase64Url(32),
      nonce: randomBase64Url(32),
      codeVerifier,
      issuedAt: input.now,
    };

    const [codeChallenge, flowCookie] = await Promise.all([
      sha256Base64Url(codeVerifier),
      this.flowCodec.seal(flow),
    ]);

    return {
      authorizationUrl: this.oidcClient.buildAuthorizationUrl({
        codeChallenge,
        nonce: flow.nonce,
        redirectUri: input.redirectUri,
        state: flow.state,
      }),
      flowCookie,
    };
  }
}

export class ValidateTelegramLoginFlow {
  constructor(private readonly flowCodec: LoginFlowCodec) {}

  async execute(input: {
    clientId: string;
    flowCookie: string;
    now: number;
    redirectUri: string;
    state: string;
  }): Promise<LoginFlow> {
    const flow = await this.flowCodec.open(input.flowCookie);
    const age = input.now - flow.issuedAt;
    if (age < 0 || age > LOGIN_FLOW_TTL_MS) {
      throw new ApplicationError("INVALID_REQUEST", "The Telegram login flow has expired.");
    }
    if (!(await timingSafeEqualStrings(flow.state, input.state))) {
      throw new ApplicationError("INVALID_REQUEST", "The Telegram login state is invalid.");
    }
    if (
      flow.issuer !== "https://oauth.telegram.org" ||
      flow.clientId !== input.clientId ||
      flow.redirectUri !== input.redirectUri
    ) {
      throw new ApplicationError("INVALID_REQUEST", "The Telegram login flow is invalid.");
    }
    return flow;
  }
}

export class CompleteTelegramLogin {
  constructor(
    private readonly oidcClient: TelegramOidcClient,
    private readonly repository: IdentitySessionRepository,
  ) {}

  async execute(input: {
    code: string;
    flow: LoginFlow;
    now: number;
    redirectUri: string;
  }): Promise<AuthenticationResult> {
    const profile = await this.oidcClient.exchangeCode({
      code: input.code,
      codeVerifier: input.flow.codeVerifier,
      nonce: input.flow.nonce,
      now: input.now,
      redirectUri: input.redirectUri,
    });
    const sessionToken = randomBase64Url(32);
    const user = await this.repository.authenticateExternalIdentity(profile, {
      tokenHash: await sha256Base64Url(sessionToken),
      createdAt: input.now,
      expiresAt: input.now + SESSION_TTL_MS,
    });

    return { sessionToken, user };
  }
}

export class StartDevelopmentSession {
  constructor(private readonly repository: IdentitySessionRepository) {}

  async execute(now: number): Promise<AuthenticationResult> {
    const sessionToken = randomBase64Url(32);
    const user = await this.repository.authenticateExternalIdentity(DEVELOPMENT_IDENTITY, {
      tokenHash: await sha256Base64Url(sessionToken),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return { sessionToken, user };
  }
}

export class AuthenticateSession {
  constructor(private readonly repository: IdentitySessionRepository) {}

  async execute(input: { now: number; sessionToken: string }): Promise<AuthenticatedUser> {
    const user = await this.repository.findUserBySession(
      await sha256Base64Url(input.sessionToken),
      input.now,
    );
    if (!user) {
      throw new ApplicationError("UNAUTHENTICATED", "A valid session is required.");
    }
    return user;
  }
}

export class Logout {
  constructor(private readonly repository: IdentitySessionRepository) {}

  async execute(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken) {
      return;
    }
    await this.repository.revokeSession(await sha256Base64Url(sessionToken));
  }
}
