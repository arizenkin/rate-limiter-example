export interface VerifiedKey {
  /** Short, non-secret identifier of the key that matched; safe to log. */
  readonly keyId: string;
}

/** Checks an admin API key presented by a caller (HLD §6.2). */
export interface ApiKeyVerifier {
  verify(presented: string | undefined): VerifiedKey | undefined;
}
