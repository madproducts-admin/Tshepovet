import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Crypto } from '../lib/crypto';
import { SANDBOX_SAMPLES, sandboxMediaBytes, type SandboxSample } from '../ocr/sandboxExtractor';
import type { GraphClient } from './graphClient';

/**
 * The sandbox stand-in for the WhatsApp Cloud API (docs/PLAN.md §6): every message the bot
 * would send is recorded in wa_sandbox_messages (the staff console's simulator shows it, M8)
 * and nothing leaves the box. Numbers are kept only as blind indexes.
 *
 * Media: the simulator "sends" one of the sandbox's sample documents as the media id
 * `sample:<sample>` (for example `sample:id_director`); downloading it returns a marker the
 * sandbox document extractor reads. There are no real photos in the sandbox.
 */
export class SandboxGraphClient implements GraphClient {
  constructor(
    private readonly pool: Pool,
    private readonly crypto: Crypto,
  ) {}

  private async record(to: string, kind: 'text' | 'buttons' | 'list' | 'template', body: Record<string, unknown>) {
    await this.pool.query(`INSERT INTO wa_sandbox_messages (msisdn_bidx, direction, kind, body) VALUES ($1, 'out', $2, $3)`, [
      this.crypto.blindIndex('msisdn', to),
      kind,
      JSON.stringify(body),
    ]);
    return { messageId: `wamid.sandbox.${randomUUID()}` };
  }

  sendText(to: string, text: string) {
    return this.record(to, 'text', { text });
  }

  sendButtons(to: string, text: string, buttons: Array<{ id: string; title: string }>) {
    return this.record(to, 'buttons', { text, buttons: buttons.slice(0, 3) });
  }

  sendList(to: string, text: string, button: string, rows: Array<{ id: string; title: string; description?: string }>) {
    return this.record(to, 'list', { text, button, rows: rows.slice(0, 10) });
  }

  sendTemplate(to: string, name: string, language: string, params: string[]) {
    return this.record(to, 'template', { name, language, params });
  }

  async downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const m = /^sample:([a-z_]+)$/.exec(mediaId);
    if (!m || !(m[1]! in SANDBOX_SAMPLES)) throw new Error('sandbox media must be a sample document (sample:<name>)');
    return { bytes: sandboxMediaBytes(m[1] as SandboxSample), mimeType: 'image/jpeg' };
  }
}
