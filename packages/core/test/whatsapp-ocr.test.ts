import { describe, expect, it } from 'vitest';
import { postValidate } from '../src/ocr/postValidate';
import { sniffMime } from '../src/ocr/extractor';
import type { Extraction } from '../src/ocr/schemas';
import { Event, Snapshot, State, transition } from '../src/whatsapp/stateMachine';
import { toEvent } from '../src/whatsapp/conversationWorker';

const snap = (state: State, extra: Partial<Snapshot> = {}): Snapshot => ({
  state,
  data: { retries: 0 },
  requirements: { driverLicence: false, bbbee: true, tcs: true },
  buyerName: 'Demo Buyer',
  withinServiceWindow: true,
  ...extra,
});

function run(start: Snapshot, events: Event[]) {
  let s = start;
  const actions = [];
  for (const e of events) {
    const r = transition(s, e);
    actions.push(...r.actions);
    s = { ...s, state: r.state, data: r.data };
  }
  return { s, actions };
}

describe('WhatsApp onboarding state machine', () => {
  it('walks the happy path from invite to submission', () => {
    const { s, actions } = run(snap('INVITED'), [
      { type: 'text', text: 'hi', messageId: 'm1' },
      { type: 'button', id: 'consent_yes', messageId: 'm2' },
      { type: 'button', id: 'entity_company', messageId: 'm3' },
      { type: 'text', text: '2019/123456/07', messageId: 'm4' },
      { type: 'company_lookup_result', found: true, legalName: 'ACME TRADING (PTY) LTD', statusLabel: 'In Business' },
      { type: 'button', id: 'company_yes', messageId: 'm5' },
      { type: 'media', mediaId: 'media-1', mimeType: 'image/jpeg', messageId: 'm6' },
      { type: 'ocr_result', kind: 'identity', documentId: 'd1', outcome: 'ok', idNumberLast4: '9087', isListedDirector: true },
      { type: 'button', id: 'bbbee_affidavit', messageId: 'm7' },
      { type: 'media', mediaId: 'media-2', mimeType: 'application/pdf', messageId: 'm8' },
      { type: 'ocr_result', kind: 'bbbee', documentId: 'd2', outcome: 'ok', bbbeeDecision: 'accept' },
      { type: 'tcs_captured' },
      { type: 'button', id: 'review_submit', messageId: 'm9' },
    ]);
    expect(s.state).toBe('SUBMITTED');
    expect(s.data.registrationNumber).toBe('2019/123456/07');
    expect(actions.find((a) => a.type === 'record_consent')).toMatchObject({ messageId: 'm2' });
    expect(actions.some((a) => a.type === 'send_secure_link')).toBe(true);
    expect(actions.some((a) => a.type === 'submit_verification')).toBe(true);
  });

  it('free text is never treated as consent', () => {
    const r = transition(snap('AWAITING_CONSENT'), { type: 'text', text: 'yes ok', messageId: 'm' });
    expect(r.state).toBe('AWAITING_CONSENT');
    expect(r.actions.some((a) => a.type === 'record_consent')).toBe(false);
  });

  it('STOP works from any state and withdraws consent', () => {
    const r = transition(snap('AWAITING_ID_DOCUMENT'), { type: 'text', text: 'stop', messageId: 'm' });
    expect(r.state).toBe('OPTED_OUT');
    expect(r.actions[0]).toEqual({ type: 'withdraw_consent' });
  });

  it('hands off to a human after repeated invalid input', () => {
    let s = snap('AWAITING_REG_NUMBER');
    for (let i = 0; i < 3; i++) {
      const r = transition(s, { type: 'text', text: 'not a number', messageId: `m${i}` });
      s = { ...s, state: r.state, data: r.data };
    }
    expect(s.state).toBe('HUMAN_HANDOFF');
  });

  it('sole proprietors skip the CIPC number', () => {
    const r = transition(snap('AWAITING_ENTITY_TYPE'), { type: 'button', id: 'entity_sole', messageId: 'm' });
    expect(r.state).toBe('AWAITING_ID_DOCUMENT');
  });

  it('asks for the tax reference after a PIN typed in chat, and catches pasted tax numbers', () => {
    const r1 = transition(snap('AWAITING_TCS_PIN'), { type: 'text', text: '9123456789', messageId: 'm' });
    expect(r1.actions[0]).toMatchObject({ type: 'send_text', key: 'tcs_looks_like_tax_number' });
    const r2 = transition(snap('AWAITING_TCS_PIN'), { type: 'text', text: 'AB12CD34EF', messageId: 'm' });
    expect(r2.state).toBe('AWAITING_TAX_REFERENCE');
    expect(r2.actions[0]).toEqual({ type: 'store_tcs_pin', pin: 'AB12CD34EF' });
  });

  it('uses an approved template outside the 24h service window', () => {
    const r = transition(snap('AWAITING_ID_DOCUMENT', { withinServiceWindow: false }), { type: 'reminder_due' });
    expect(r.actions).toEqual([{ type: 'send_template', template: 'onboarding_reminder', vars: { buyer: 'Demo Buyer' } }]);
  });

  it('rejects unsupported media types', () => {
    const r = transition(snap('AWAITING_ID_DOCUMENT'), { type: 'media', mediaId: 'x', mimeType: 'video/mp4', messageId: 'm' });
    expect(r.actions[0]).toMatchObject({ key: 'unsupported_media' });
  });

  it('maps WhatsApp list replies to button events', () => {
    expect(toEvent({ from: '27820000000', id: 'w1', timestamp: '0', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'entity_cc', title: 'CC' } } })).toEqual({
      type: 'button',
      id: 'entity_cc',
      messageId: 'w1',
    });
  });
});

const baseExtraction = (o: Partial<Extraction>): Extraction => ({
  document_type: 'sa_smart_id_card',
  legible: true,
  quality_issues: [],
  identity: null,
  driver_licence: null,
  bbbee: null,
  low_confidence_fields: [],
  embedded_instructions_detected: false,
  ...o,
});

const idSection = { id_number: '8001015009087', surname: 'MOKOENA', forenames: 'THANDI', date_of_birth: '1980-01-01', sex: 'M' as const, nationality: 'RSA', country_of_birth: 'RSA', card_issue_date: '2018-05-01' };

describe('OCR post-validation', () => {
  it('accepts a consistent ID card', () => {
    const v = postValidate(baseExtraction({ identity: idSection }), 'identity');
    expect(v.outcome).toBe('ok');
    expect(v.identity?.idNumber).toBe('8001015009087');
  });

  it('asks for a retake when a low-confidence ID number fails Luhn', () => {
    const v = postValidate(baseExtraction({ identity: { ...idSection, id_number: '8001015009088' }, low_confidence_fields: ['identity.id_number'] }), 'identity');
    expect(v.outcome).toBe('retake');
  });

  it('routes DOB/ID mismatch and embedded instructions to review', () => {
    expect(postValidate(baseExtraction({ identity: { ...idSection, date_of_birth: '1981-01-01' } }), 'identity').outcome).toBe('needs_review');
    expect(postValidate(baseExtraction({ identity: idSection, embedded_instructions_detected: true }), 'identity').outcome).toBe('needs_review');
  });

  it('detects the wrong document and capture problems', () => {
    expect(postValidate(baseExtraction({ document_type: 'driver_licence_card' }), 'identity').outcome).toBe('wrong_document');
    expect(postValidate(baseExtraction({ identity: idSection, quality_issues: ['glare'] }), 'identity').outcome).toBe('retake');
  });

  it('sniffs file types from magic bytes', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('<html>'))).toBeNull();
  });
});
