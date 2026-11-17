/**
 * Minimal WhatsApp Cloud API client (Graph API).
 * Media URLs returned by GET /{media-id} are short-lived and require the
 * bearer token to download; we stream them straight into encrypted object
 * storage and never persist the URL.
 */
export class WhatsAppGraphClient {
  constructor(
    private readonly o: { accessToken: string; phoneNumberId: string; version: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.o.version}/${path}`;
  }

  private async post(body: unknown): Promise<{ messageId: string }> {
    const res = await this.fetchImpl(this.url(`${this.o.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`whatsapp send failed: HTTP ${res.status}`);
    const j = (await res.json()) as { messages?: Array<{ id: string }> };
    return { messageId: j.messages?.[0]?.id ?? '' };
  }

  sendText(to: string, text: string) {
    return this.post({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } });
  }

  sendButtons(to: string, text: string, buttons: Array<{ id: string; title: string }>) {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: { type: 'button', body: { text }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
    });
  }

  sendList(to: string, text: string, button: string, rows: Array<{ id: string; title: string; description?: string }>) {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: { type: 'list', body: { text }, action: { button: button.slice(0, 20), sections: [{ title: 'Options', rows: rows.slice(0, 10).map((r) => ({ ...r, title: r.title.slice(0, 24) })) }] } },
    });
  }

  /** Business-initiated messages outside the 24h window must use an approved (utility) template. */
  sendTemplate(to: string, name: string, language: string, params: string[]) {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: language }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
    });
  }

  async downloadMedia(mediaId: string, maxBytes = 16 * 1024 * 1024): Promise<{ bytes: Buffer; mimeType: string }> {
    const meta = await this.fetchImpl(this.url(mediaId), { headers: { authorization: `Bearer ${this.o.accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) throw new Error(`media lookup failed: HTTP ${meta.status}`);
    const m = (await meta.json()) as { url: string; mime_type: string; file_size?: number };
    if (m.file_size && m.file_size > maxBytes) throw new Error('media too large');
    const res = await this.fetchImpl(m.url, { headers: { authorization: `Bearer ${this.o.accessToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('media too large');
    return { bytes, mimeType: m.mime_type };
  }
}

/** What the conversation worker needs from a Graph client: the real one, or the sandbox's. */
export type GraphClient = Pick<WhatsAppGraphClient, 'sendText' | 'sendButtons' | 'sendList' | 'sendTemplate' | 'downloadMedia'>;
