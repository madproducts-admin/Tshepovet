import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Crypto } from '../lib/crypto';
import type { ObjectStore } from '../whatsapp/conversationWorker';

/**
 * Documents on the box's disk, encrypted (docs/PLAN.md §6: the stand-in for S3 + KMS in
 * af-south-1). Each object is sealed with the platform key and its storage key as associated
 * data, so a file copied to another key does not decrypt. Writes are atomic (temp, rename).
 */
export class LocalEncryptedStore implements ObjectStore {
  constructor(
    private readonly root: string,
    private readonly crypto: Crypto,
  ) {}

  private file(key: string): string {
    if (!/^[A-Za-z0-9/_.-]{1,400}$/.test(key) || key.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error('invalid storage key');
    }
    return path.join(this.root, ...key.split('/')) + '.enc';
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const sealed = await this.crypto.encrypt(bytes, `object:${key}`);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, sealed);
    await rename(tmp, file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
