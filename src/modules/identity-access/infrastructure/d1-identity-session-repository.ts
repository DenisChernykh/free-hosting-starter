import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { externalIdentities, sessions, users } from "../../../platform/database/schema";
import type { ExternalIdentityProfile, SessionToCreate } from "../application/model";
import type { IdentitySessionRepository } from "../application/ports";
import type { AuthenticatedUser } from "../public-contracts";

function toUser(row: typeof users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    displayName: row.displayName,
    username: row.username,
    photoUrl: row.photoUrl,
  };
}

export class D1IdentitySessionRepository implements IdentitySessionRepository {
  private readonly database;

  constructor(private readonly binding: D1Database) {
    this.database = drizzle(this.binding);
  }

  async authenticateExternalIdentity(
    profile: ExternalIdentityProfile,
    session: SessionToCreate,
  ): Promise<AuthenticatedUser> {
    await this.cleanupExpiredSessions(session.createdAt);
    const existing = await this.findByExternalIdentity(profile.issuer, profile.subject);
    if (existing) {
      await this.database.batch([
        this.database
          .update(users)
          .set({
            displayName: profile.displayName,
            username: profile.username,
            photoUrl: profile.photoUrl,
            updatedAt: session.createdAt,
          })
          .where(eq(users.id, existing.id)),
        this.database.insert(sessions).values({ ...session, userId: existing.id }),
      ]);
      return {
        id: existing.id,
        displayName: profile.displayName,
        username: profile.username,
        photoUrl: profile.photoUrl,
      };
    }

    const user: AuthenticatedUser = {
      id: crypto.randomUUID(),
      displayName: profile.displayName,
      username: profile.username,
      photoUrl: profile.photoUrl,
    };

    try {
      await this.database.batch([
        this.database.insert(users).values({
          ...user,
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        }),
        this.database.insert(externalIdentities).values({
          issuer: profile.issuer,
          subject: profile.subject,
          userId: user.id,
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        }),
        this.database.insert(sessions).values({ ...session, userId: user.id }),
      ]);
      return user;
    } catch (error) {
      const concurrent = await this.findByExternalIdentity(profile.issuer, profile.subject);
      if (!concurrent) {
        throw error;
      }
      await this.database.insert(sessions).values({ ...session, userId: concurrent.id });
      return concurrent;
    }
  }

  async findUserBySession(tokenHash: string, now: number): Promise<AuthenticatedUser | null> {
    const [row] = await this.database
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
      .limit(1);
    return row ? toUser(row.user) : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.database.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  private async findByExternalIdentity(
    issuer: string,
    subject: string,
  ): Promise<AuthenticatedUser | null> {
    const [row] = await this.database
      .select({ user: users })
      .from(externalIdentities)
      .innerJoin(users, eq(users.id, externalIdentities.userId))
      .where(and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject)))
      .limit(1);
    return row ? toUser(row.user) : null;
  }

  private async cleanupExpiredSessions(now: number): Promise<void> {
    try {
      await this.binding
        .prepare(
          `DELETE FROM sessions
           WHERE token_hash IN (
             SELECT token_hash FROM sessions
             WHERE expires_at <= ?
             ORDER BY expires_at
             LIMIT 25
           )`,
        )
        .bind(now)
        .run();
    } catch (error) {
      console.warn(
        JSON.stringify({
          error: error instanceof Error ? error.name : "UnknownError",
          event: "expired_session_cleanup_failed",
        }),
      );
    }
  }
}
