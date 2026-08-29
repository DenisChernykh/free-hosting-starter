export type AuthenticatedUser = {
  id: string;
  displayName: string | null;
  username: string | null;
  photoUrl: string | null;
};

export type IdentityContextVariables = {
  authenticatedUser?: AuthenticatedUser;
};

export const SESSION_COOKIE_NAME = "__Host-session";

export function requireAuthenticatedUser(variables: IdentityContextVariables): AuthenticatedUser {
  if (!variables.authenticatedUser) {
    throw new Error("Authentication middleware did not provide a user");
  }
  return variables.authenticatedUser;
}
