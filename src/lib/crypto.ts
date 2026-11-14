import crypto from 'node:crypto';

/**
 * Envelope encryption + blind indexing.
 *
 *   plaintext --AES-256-GCM(DEK, AAD)--> ciphertext
 *   DEK       --wrap(KEK[version])-----> wrappedDek     (KEK lives in KMS / HSM)
 *
 * Stored blob layout (all big-endian):
 *   [0]      format version (0x01)
 *   [1..2]   KEK version (uint16)
 *   [3..4]   wrapped DEK length (uint16)
 *   [..]     wrapped DEK
 *   [12 B]   IV
 *   [16 B]   GCM tag
 *   [..]     ciphertext
 *
 * AAD ("additional authenticated data") binds a ciphertext to its context,
 * e.g. `tcs_pin:<tenant>:<vendor>`. Copying an encrypted PIN into another
 * vendor's row makes decryption fail instead of silently disclosing it.
 *
 * Crypto-shredding: purging the row's `*_enc` column (or retiring a DEK/KEK)
 * renders the data unrecoverable - this is how POPIA s14 deletion is proven
 * for backups we cannot rewrite.
 */
export interface KeyProvider {
  readonly currentVersion: number;
  wrap(dek: Buffer, version: number): Promise<Buffer>;
  unwrap(wrapped: Buffer, version: number): Promise<Buffer>;
}

/**
 * Local KEK provider (dev/test, or prod with keys injected from a secrets
 * manager). The production drop-in is a KMS provider in af-south-1 calling
 * GenerateDataKey / Decrypt, with DEK caching to keep KMS cost per check at
 * fractions of a cent.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys = new Map<number, Buffer>();
  readonly currentVersion: number;

  constructor(spec: string) {
    for (const part of spec.split(',')) {
      const [v, k] = part.split(':');
      const version = Number(v);
      const key = Buffer.from(k ?? '', 'base64');
      if (!Number.isInteger(version) || version < 1 || key.length !== 32) {
        throw new Error('KEK_KEYS must be "version:base64(32 bytes)" entries');
      }
      this.keys.set(version, key);
    }
    this.currentVersion = Math.max(...this.keys.keys());
  }

  private key(version: number): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`unknown KEK version ${version}`);
    return k;
  }

  async wrap(dek: Buffer, version: number): Promise<Buffer> {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key(version), iv);
    const body = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  async unwrap(wrapped: Buffer, version: number): Promise<Buffer> {
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(version), wrapped.subarray(0, 12));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

const FORMAT_V1 = 0x01;

export class Crypto {
  constructor(
    private readonly keys: KeyProvider,
    private readonly blindIndexRoot: Buffer,
  ) {}

  /** KEK version new ciphertexts are wrapped with. */
  get keyVersion(): number {
    return this.keys.currentVersion;
  }

  async encrypt(plaintext: string | Buffer, aad: string): Promise<Buffer> {
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
    const version = this.keys.currentVersion;
    const wrapped = await this.keys.wrap(dek, version);
    dek.fill(0);
    const header = Buffer.alloc(5);
    header.writeUInt8(FORMAT_V1, 0);
    header.writeUInt16BE(version, 1);
    header.writeUInt16BE(wrapped.length, 3);
    return Buffer.concat([header, wrapped, iv, cipher.getAuthTag(), ct]);
  }

  async decrypt(blob: Buffer, aad: string): Promise<Buffer> {
    if (blob.readUInt8(0) !== FORMAT_V1) throw new Error('unsupported ciphertext format');
    const version = blob.readUInt16BE(1);
    const wlen = blob.readUInt16BE(3);
    let off = 5;
    const wrapped = blob.subarray(off, (off += wlen));
    const iv = blob.subarray(off, (off += 12));
    const tag = blob.subarray(off, (off += 16));
    const ct = blob.subarray(off);
    const dek = await this.keys.unwrap(wrapped, version);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', dek, iv);
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } finally {
      dek.fill(0);
    }
  }

  async decryptString(blob: Buffer, aad: string): Promise<string> {
    return (await this.decrypt(blob, aad)).toString('utf8');
  }

  /** Version of the KEK that encrypted a blob (for rotation jobs). */
  static keyVersionOf(blob: Buffer): number {
    return blob.readUInt16BE(1);
  }

  /**
   * Keyed HMAC "blind index" for equality search over encrypted columns.
   * Keys are derived per purpose with HKDF so a leaked index for one field
   * cannot be correlated with another. Pass `scope` (e.g. a tenant id) to get
   * a tenant-specific index that cannot be joined across tenants.
   */
  blindIndex(purpose: BlindIndexPurpose, normalisedValue: string, scope = 'global'): Buffer {
    const key = Buffer.from(
      crypto.hkdfSync('sha256', this.blindIndexRoot, Buffer.alloc(0), `tshepovet:bidx:${purpose}:${scope}`, 32),
    );
    return crypto.createHmac('sha256', key).update(normalisedValue, 'utf8').digest();
  }
}

export type BlindIndexPurpose =
  | 'sa_id'
  | 'msisdn'
  | 'bank_account'
  | 'tax_reference'
  | 'tcs_pin'
  | 'licence_number'
  | 'address'
  | 'cache_key'
  | 'subject';

/** Constant-time comparison for secrets of possibly different lengths. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function sha256(data: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/** Mask an identifier for display: keep the last `keep` characters. */
export function mask(value: string, keep = 4): string {
  if (value.length <= keep) return '*'.repeat(value.length);
  return '*'.repeat(value.length - keep) + value.slice(-keep);
}
