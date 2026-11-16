import type { Pool } from 'pg';

/**
 * Typed access to the sign-in functions in db/migrations/0003_accounts.sql. Every method is
 * one SECURITY DEFINER call; nothing here reads the account tables directly.
 */
export type TokenPurpose = 'verify_email' | 'reset_password' | 'invite' | 'staff_reset';
export type UserRole = 'owner' | 'admin' | 'compliance_officer' | 'procurement' | 'ap_clerk' | 'viewer';
export type StaffRole = 'support' | 'reviewer' | 'admin';

export interface UserLogin {
  user_id: string;
  tenant_id: string;
  tenant_status: string;
  legal_name: string;
  email: string;
  full_name: string;
  role: UserRole;
  password_hash: string | null;
  email_verified_at: Date | null;
  mfa_enrolled: boolean;
  mfa_secret_enc: Buffer | null;
  locked_until: Date | null;
}

export interface UserRecord extends Omit<UserLogin, 'locked_until'> {
  password_changed_at: Date | null;
  disabled_at: Date | null;
}

export interface StaffLogin {
  staff_id: string;
  email: string;
  full_name: string;
  role: StaffRole;
  password_hash: string | null;
  mfa_enrolled: boolean;
  mfa_secret_enc: Buffer | null;
  locked_until: Date | null;
}

export interface StaffRecord extends Omit<StaffLogin, 'locked_until'> {
  password_changed_at: Date | null;
  disabled_at: Date | null;
}

export interface ConsumedToken {
  token_id: string;
  tenant_id: string | null;
  user_id: string | null;
  staff_id: string | null;
  email: string;
  role: UserRole | null;
}

export class EmailInUseError extends Error {
  constructor() {
    super('email_in_use');
  }
}

type Subject = { userId: string; staffId?: undefined } | { staffId: string; userId?: undefined };

export class AccountStore {
  constructor(private readonly pool: Pool) {}

  private async one<T>(sql: string, params: unknown[]): Promise<T | null> {
    const r = await this.pool.query(sql, params);
    return (r.rows[0] as T | undefined) ?? null;
  }

  findUser(email: string) {
    return this.one<UserLogin>(`SELECT * FROM auth_find_user($1)`, [email]);
  }

  userById(userId: string) {
    return this.one<UserRecord>(`SELECT * FROM auth_user_by_id($1)`, [userId]);
  }

  recordLogin(userId: string, success: boolean, maxFailures: number, lockMinutes: number) {
    return this.one<{ failed_logins: number; locked_until: Date | null }>(`SELECT * FROM auth_record_login($1, $2, $3, make_interval(mins => $4))`, [
      userId,
      success,
      maxFailures,
      lockMinutes,
    ]);
  }

  /** null when the email already signs in somewhere (answer the caller exactly as on success). */
  async signup(org: string, fullName: string, email: string, passwordHash: string) {
    return this.one<{ tenant_id: string; user_id: string }>(`SELECT * FROM auth_signup($1, $2, $3, $4)`, [org, fullName, email, passwordHash]);
  }

  async issueToken(
    purpose: TokenPurpose,
    hash: Buffer,
    o: { tenantId?: string | null; userId?: string | null; staffId?: string | null; email: string; role?: UserRole | null; ttlSeconds: number; createdBy?: string | null },
  ): Promise<string> {
    const r = await this.pool.query<{ auth_issue_token: string }>(
      `SELECT auth_issue_token($1, $2, $3, $4, $5, $6, $7, make_interval(secs => $8), $9)`,
      [purpose, hash, o.tenantId ?? null, o.userId ?? null, o.staffId ?? null, o.email, o.role ?? null, o.ttlSeconds, o.createdBy ?? null],
    );
    return r.rows[0]!.auth_issue_token;
  }

  consumeToken(purpose: TokenPurpose, hash: Buffer) {
    return this.one<ConsumedToken>(`SELECT * FROM auth_consume_token($1, $2)`, [purpose, hash]);
  }

  peekInvite(hash: Buffer) {
    return this.one<{ legal_name: string; email: string; role: UserRole; expires_at: Date }>(`SELECT * FROM auth_peek_invite($1)`, [hash]);
  }

  async acceptInvite(hash: Buffer, fullName: string, passwordHash: string) {
    try {
      return await this.one<{ tenant_id: string; user_id: string; role: UserRole }>(`SELECT * FROM auth_accept_invite($1, $2, $3)`, [hash, fullName, passwordHash]);
    } catch (err) {
      if ((err as { message?: string }).message?.includes('email_in_use')) throw new EmailInUseError();
      throw err;
    }
  }

  async setPassword(userId: string, passwordHash: string) {
    await this.pool.query(`SELECT auth_set_password($1, $2)`, [userId, passwordHash]);
  }

  async markEmailVerified(userId: string) {
    await this.pool.query(`SELECT auth_mark_email_verified($1)`, [userId]);
  }

  async setMfa(userId: string, secretEnc: Buffer | null, enrolled: boolean) {
    await this.pool.query(`SELECT auth_set_mfa($1, $2, $3)`, [userId, secretEnc, enrolled]);
  }

  async replaceRecoveryCodes(s: Subject, hashes: Buffer[]) {
    await this.pool.query(`SELECT auth_replace_recovery_codes($1, $2, $3::bytea[])`, [s.userId ?? null, s.staffId ?? null, hashes]);
  }

  async useRecoveryCode(s: Subject, hash: Buffer): Promise<boolean> {
    const r = await this.pool.query<{ auth_use_recovery_code: boolean }>(`SELECT auth_use_recovery_code($1, $2, $3)`, [s.userId ?? null, s.staffId ?? null, hash]);
    return r.rows[0]!.auth_use_recovery_code;
  }

  async recoveryCodesLeft(s: Subject): Promise<number> {
    const r = await this.pool.query<{ auth_recovery_codes_left: number }>(`SELECT auth_recovery_codes_left($1, $2)`, [s.userId ?? null, s.staffId ?? null]);
    return r.rows[0]!.auth_recovery_codes_left;
  }

  staffFind(email: string) {
    return this.one<StaffLogin>(`SELECT * FROM staff_find($1)`, [email]);
  }

  staffById(staffId: string) {
    return this.one<StaffRecord>(`SELECT * FROM staff_by_id($1)`, [staffId]);
  }

  staffRecordLogin(staffId: string, success: boolean, maxFailures: number, lockMinutes: number) {
    return this.one<{ failed_logins: number; locked_until: Date | null }>(`SELECT * FROM staff_record_login($1, $2, $3, make_interval(mins => $4))`, [
      staffId,
      success,
      maxFailures,
      lockMinutes,
    ]);
  }

  async staffSetMfa(staffId: string, secretEnc: Buffer | null, enrolled: boolean) {
    await this.pool.query(`SELECT staff_set_mfa($1, $2, $3)`, [staffId, secretEnc, enrolled]);
  }

  async staffSetPassword(staffId: string, passwordHash: string) {
    await this.pool.query(`SELECT staff_set_password($1, $2)`, [staffId, passwordHash]);
  }
}
