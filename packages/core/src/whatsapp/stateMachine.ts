import { parseEnterpriseNumber } from '../domain/sa/cipc';
import { normaliseTaxReference, normaliseTcsPin } from '../domain/sa/tax';

/**
 * Vendor onboarding conversation as a PURE state machine:
 *
 *   transition(snapshot, event) -> { state, data, actions[] }
 *
 * No I/O happens here; the worker executes actions (send message, run OCR,
 * record consent, start verification) and feeds results back as events.
 * That makes every path unit-testable and replayable.
 *
 *  INVITED --any--> AWAITING_CONSENT --agree--> AWAITING_ENTITY_TYPE
 *     |                  |--decline/STOP--> OPTED_OUT
 *  company/cc: AWAITING_REG_NUMBER -> (lookup) -> AWAITING_COMPANY_CONFIRM
 *  sole prop:  -----------------------------------------------+
 *                                                             v
 *  AWAITING_ID_DOCUMENT -> (ocr) -> [AWAITING_DRIVER_LICENCE] -> [AWAITING_BBBEE_CHOICE
 *    -> AWAITING_BBBEE_DOCUMENT] -> [AWAITING_TCS_PIN] -> REVIEW -> SUBMITTED -> COMPLETED
 *  any state: STOP -> OPTED_OUT, HELP/AGENT -> HUMAN_HANDOFF, 3 failed tries -> HUMAN_HANDOFF
 */
export type State =
  | 'INVITED'
  | 'AWAITING_CONSENT'
  | 'AWAITING_ENTITY_TYPE'
  | 'AWAITING_REG_NUMBER'
  | 'AWAITING_COMPANY_LOOKUP'
  | 'AWAITING_COMPANY_CONFIRM'
  | 'AWAITING_ID_DOCUMENT'
  | 'AWAITING_DRIVER_LICENCE'
  | 'AWAITING_BBBEE_CHOICE'
  | 'AWAITING_BBBEE_DOCUMENT'
  | 'AWAITING_TCS_PIN'
  | 'AWAITING_TAX_REFERENCE'
  | 'AWAITING_OCR'
  | 'REVIEW'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'HUMAN_HANDOFF'
  | 'OPTED_OUT'
  | 'ABANDONED';

export type DocKind = 'identity' | 'driver_licence' | 'bbbee';

export interface Requirements {
  driverLicence: boolean;
  bbbee: boolean;
  tcs: boolean;
}

export interface ConversationData {
  entityKind?: 'company' | 'close_corporation' | 'sole_proprietor' | 'trust' | 'npo' | 'other';
  registrationNumber?: string;
  companyName?: string;
  identityDocumentId?: string;
  idNumberLast4?: string;
  isListedDirector?: boolean;
  licenceDocumentId?: string;
  bbbeeEvidence?: 'affidavit' | 'certificate' | 'not_applicable';
  bbbeeDocumentId?: string;
  bbbeeDecision?: 'accept' | 'reject' | 'manual_review';
  tcsCaptured?: boolean;
  pendingDocKind?: DocKind;
  resumeState?: State;
  retries: number;
}

export interface Snapshot {
  state: State;
  data: ConversationData;
  requirements: Requirements;
  buyerName: string;
  withinServiceWindow: boolean; // < 24h since the vendor's last message
}

export type Event =
  | { type: 'text'; text: string; messageId: string }
  | { type: 'button'; id: string; messageId: string }
  | { type: 'media'; mediaId: string; mimeType: string; messageId: string; sizeBytes?: number }
  | { type: 'company_lookup_result'; found: boolean; legalName?: string; statusLabel?: string }
  | {
      type: 'ocr_result';
      kind: DocKind;
      documentId: string;
      outcome: 'ok' | 'retake' | 'wrong_document' | 'needs_review';
      detail?: string;
      idNumberLast4?: string;
      isListedDirector?: boolean;
      bbbeeDecision?: 'accept' | 'reject' | 'manual_review';
    }
  | { type: 'tcs_captured' }
  | { type: 'verification_result'; outcome: string; passportUrl?: string }
  | { type: 'reminder_due' };

export type Action =
  | { type: 'send_text'; key: MessageKey; vars?: Record<string, string> }
  | { type: 'send_buttons'; key: MessageKey; buttons: Array<{ id: string; title: string }>; vars?: Record<string, string> }
  | { type: 'send_list'; key: MessageKey; button: string; rows: Array<{ id: string; title: string; description?: string }> }
  | { type: 'send_template'; template: 'onboarding_reminder' | 'onboarding_result'; vars: Record<string, string> }
  | { type: 'send_secure_link'; purpose: 'tcs_pin' }
  | { type: 'record_consent'; messageId: string; purposes: string[] }
  | { type: 'withdraw_consent' }
  | { type: 'lookup_company'; registrationNumber: string }
  | { type: 'run_ocr'; kind: DocKind; mediaId: string; mimeType: string; bbbeeEvidence?: 'affidavit' | 'certificate' }
  | { type: 'store_tcs_pin'; pin: string }
  | { type: 'store_tax_reference'; taxReference: string }
  | { type: 'submit_verification' }
  | { type: 'handoff'; reason: string };

export type MessageKey =
  | 'consent_request'
  | 'consent_more_info'
  | 'opted_out'
  | 'ask_entity_type'
  | 'ask_reg_number'
  | 'reg_number_invalid'
  | 'company_confirm'
  | 'company_not_found'
  | 'ask_id_document'
  | 'ask_driver_licence'
  | 'ask_bbbee_choice'
  | 'ask_bbbee_document'
  | 'ask_tcs_pin'
  | 'tcs_looks_like_tax_number'
  | 'tcs_pin_in_chat_warning'
  | 'ask_tax_reference'
  | 'tax_reference_invalid'
  | 'processing_document'
  | 'retake_photo'
  | 'wrong_document'
  | 'not_a_director'
  | 'unsupported_media'
  | 'review_summary'
  | 'submitted'
  | 'result'
  | 'handoff'
  | 'please_wait';

export interface TransitionResult {
  state: State;
  data: ConversationData;
  actions: Action[];
}

const MAX_RETRIES = 3;
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

function nextAfterIdentity(req: Requirements): State {
  if (req.driverLicence) return 'AWAITING_DRIVER_LICENCE';
  if (req.bbbee) return 'AWAITING_BBBEE_CHOICE';
  if (req.tcs) return 'AWAITING_TCS_PIN';
  return 'REVIEW';
}

function nextAfterLicence(req: Requirements): State {
  if (req.bbbee) return 'AWAITING_BBBEE_CHOICE';
  if (req.tcs) return 'AWAITING_TCS_PIN';
  return 'REVIEW';
}

function nextAfterBbbee(req: Requirements): State {
  return req.tcs ? 'AWAITING_TCS_PIN' : 'REVIEW';
}

/** The prompt that (re-)enters a state. */
export function promptFor(state: State, s: Snapshot): Action[] {
  switch (state) {
    case 'AWAITING_CONSENT':
      return [
        {
          type: 'send_buttons',
          key: 'consent_request',
          vars: { buyer: s.buyerName },
          buttons: [
            { id: 'consent_yes', title: 'I agree' },
            { id: 'consent_info', title: 'More info' },
            { id: 'consent_no', title: 'No thanks' },
          ],
        },
      ];
    case 'AWAITING_ENTITY_TYPE':
      return [
        {
          type: 'send_list',
          key: 'ask_entity_type',
          button: 'Choose type',
          rows: [
            { id: 'entity_company', title: 'Company (Pty) Ltd', description: 'Registered with CIPC' },
            { id: 'entity_cc', title: 'Close Corporation (CC)' },
            { id: 'entity_sole', title: 'Sole proprietor', description: 'Trading in your own name' },
            { id: 'entity_trust', title: 'Trust' },
            { id: 'entity_npo', title: 'NPO / NPC' },
            { id: 'entity_other', title: 'Other' },
          ],
        },
      ];
    case 'AWAITING_REG_NUMBER':
      return [{ type: 'send_text', key: 'ask_reg_number' }];
    case 'AWAITING_ID_DOCUMENT':
      return [{ type: 'send_text', key: 'ask_id_document' }];
    case 'AWAITING_DRIVER_LICENCE':
      return [{ type: 'send_text', key: 'ask_driver_licence' }];
    case 'AWAITING_BBBEE_CHOICE':
      return [
        {
          type: 'send_buttons',
          key: 'ask_bbbee_choice',
          buttons: [
            { id: 'bbbee_affidavit', title: 'Sworn affidavit' },
            { id: 'bbbee_certificate', title: 'SANAS certificate' },
            { id: 'bbbee_none', title: "Don't have one" },
          ],
        },
      ];
    case 'AWAITING_BBBEE_DOCUMENT':
      return [{ type: 'send_text', key: 'ask_bbbee_document' }];
    case 'AWAITING_TAX_REFERENCE':
      return [{ type: 'send_text', key: 'ask_tax_reference' }];
    case 'AWAITING_TCS_PIN':
      // Prefer a secure web form / WhatsApp Flow over typing a bearer
      // credential into chat history.
      return [{ type: 'send_text', key: 'ask_tcs_pin' }, { type: 'send_secure_link', purpose: 'tcs_pin' }];
    case 'REVIEW':
      return [
        {
          type: 'send_buttons',
          key: 'review_summary',
          vars: { company: s.data.companyName ?? '-', id: s.data.idNumberLast4 ? `******${s.data.idNumberLast4}` : '-' },
          buttons: [
            { id: 'review_submit', title: 'Submit' },
            { id: 'review_restart', title: 'Start over' },
          ],
        },
      ];
    default:
      return [];
  }
}

function enter(state: State, s: Snapshot, data: ConversationData, pre: Action[] = []): TransitionResult {
  return { state, data, actions: [...pre, ...promptFor(state, { ...s, data })] };
}

function retry(s: Snapshot, key: MessageKey, vars?: Record<string, string>): TransitionResult {
  const retries = s.data.retries + 1;
  if (retries >= MAX_RETRIES) {
    return { state: 'HUMAN_HANDOFF', data: { ...s.data, retries }, actions: [{ type: 'handoff', reason: `max_retries_${s.state}` }, { type: 'send_text', key: 'handoff' }] };
  }
  return { state: s.state, data: { ...s.data, retries }, actions: [{ type: 'send_text', key, vars }] };
}

function expectMedia(s: Snapshot, e: Event, kind: DocKind, bbbeeEvidence?: 'affidavit' | 'certificate'): TransitionResult | null {
  if (e.type !== 'media') return null;
  if (!ACCEPTED_MIME.includes(e.mimeType)) return retry(s, 'unsupported_media');
  if (e.sizeBytes !== undefined && e.sizeBytes > MAX_MEDIA_BYTES) return retry(s, 'unsupported_media');
  return {
    state: 'AWAITING_OCR',
    data: { ...s.data, pendingDocKind: kind, resumeState: s.state },
    actions: [{ type: 'send_text', key: 'processing_document' }, { type: 'run_ocr', kind, mediaId: e.mediaId, mimeType: e.mimeType, bbbeeEvidence }],
  };
}

export function transition(s: Snapshot, e: Event): TransitionResult {
  const data: ConversationData = { ...s.data };

  // Global commands. "STOP" must always work (POPIA s11(3) objection; CPA s11 / ECTA s45 opt-out).
  if (e.type === 'text') {
    const t = e.text.trim().toUpperCase();
    if (['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'YEKA', 'HOU OP'].includes(t)) {
      return { state: 'OPTED_OUT', data, actions: [{ type: 'withdraw_consent' }, { type: 'send_text', key: 'opted_out' }] };
    }
    if (['HELP', 'AGENT', 'USIZO', 'HELP ME'].includes(t)) {
      return { state: 'HUMAN_HANDOFF', data, actions: [{ type: 'handoff', reason: 'user_requested' }, { type: 'send_text', key: 'handoff' }] };
    }
  }

  if (e.type === 'reminder_due') {
    if (['COMPLETED', 'OPTED_OUT', 'ABANDONED', 'HUMAN_HANDOFF', 'SUBMITTED'].includes(s.state)) return { state: s.state, data, actions: [] };
    // Outside the 24h window only pre-approved (utility) templates may be sent.
    return {
      state: s.state,
      data,
      actions: s.withinServiceWindow ? promptFor(s.state, s) : [{ type: 'send_template', template: 'onboarding_reminder', vars: { buyer: s.buyerName } }],
    };
  }

  switch (s.state) {
    case 'INVITED':
      return enter('AWAITING_CONSENT', s, { ...data, retries: 0 });

    case 'AWAITING_CONSENT':
      if (e.type === 'button' && e.id === 'consent_yes') {
        return enter('AWAITING_ENTITY_TYPE', s, { ...data, retries: 0 }, [
          {
            type: 'record_consent',
            messageId: e.messageId,
            purposes: [
              'kyb_company_verification',
              'director_identity_verification',
              'document_ocr_processing',
              'whatsapp_service_messages',
              ...(s.requirements.tcs ? ['tax_compliance_verification'] : []),
              ...(s.requirements.bbbee ? ['bbbee_verification'] : []),
              ...(s.requirements.driverLicence ? ['driver_licence_verification'] : []),
            ],
          },
        ]);
      }
      if (e.type === 'button' && e.id === 'consent_info') return { state: s.state, data, actions: [{ type: 'send_text', key: 'consent_more_info' }, ...promptFor('AWAITING_CONSENT', s)] };
      if (e.type === 'button' && e.id === 'consent_no') return { state: 'OPTED_OUT', data, actions: [{ type: 'send_text', key: 'opted_out' }] };
      // Free text is NOT consent: POPIA requires a voluntary, specific, informed expression of will.
      return { state: s.state, data, actions: promptFor('AWAITING_CONSENT', s) };

    case 'AWAITING_ENTITY_TYPE': {
      if (e.type !== 'button') return { state: s.state, data, actions: promptFor(s.state, s) };
      const map: Record<string, ConversationData['entityKind']> = {
        entity_company: 'company',
        entity_cc: 'close_corporation',
        entity_sole: 'sole_proprietor',
        entity_trust: 'trust',
        entity_npo: 'npo',
        entity_other: 'other',
      };
      const kind = map[e.id];
      if (!kind) return { state: s.state, data, actions: promptFor(s.state, s) };
      if (kind === 'trust' || kind === 'other') {
        return { state: 'HUMAN_HANDOFF', data: { ...data, entityKind: kind }, actions: [{ type: 'handoff', reason: `entity_kind_${kind}` }, { type: 'send_text', key: 'handoff' }] };
      }
      // Sole proprietors have no CIPC record; the owner's ID is the anchor.
      if (kind === 'sole_proprietor') return enter('AWAITING_ID_DOCUMENT', s, { ...data, entityKind: kind, retries: 0 });
      return enter('AWAITING_REG_NUMBER', s, { ...data, entityKind: kind, retries: 0 });
    }

    case 'AWAITING_REG_NUMBER': {
      if (e.type !== 'text') return retry(s, 'reg_number_invalid');
      try {
        const parsed = parseEnterpriseNumber(e.text);
        return {
          state: 'AWAITING_COMPANY_LOOKUP',
          data: { ...data, registrationNumber: parsed.normalised, retries: 0 },
          actions: [{ type: 'send_text', key: 'please_wait' }, { type: 'lookup_company', registrationNumber: parsed.normalised }],
        };
      } catch {
        return retry(s, 'reg_number_invalid');
      }
    }

    case 'AWAITING_COMPANY_LOOKUP':
      if (e.type !== 'company_lookup_result') return { state: s.state, data, actions: [{ type: 'send_text', key: 'please_wait' }] };
      if (!e.found) return { state: 'AWAITING_REG_NUMBER', data: { ...data, retries: data.retries + 1 }, actions: [{ type: 'send_text', key: 'company_not_found' }] };
      return {
        state: 'AWAITING_COMPANY_CONFIRM',
        data: { ...data, companyName: e.legalName },
        actions: [
          {
            type: 'send_buttons',
            key: 'company_confirm',
            vars: { name: e.legalName ?? '', status: e.statusLabel ?? '' },
            buttons: [
              { id: 'company_yes', title: 'Yes, that is us' },
              { id: 'company_no', title: 'No' },
            ],
          },
        ],
      };

    case 'AWAITING_COMPANY_CONFIRM':
      if (e.type === 'button' && e.id === 'company_yes') return enter('AWAITING_ID_DOCUMENT', s, { ...data, retries: 0 });
      if (e.type === 'button' && e.id === 'company_no') return enter('AWAITING_REG_NUMBER', s, { ...data, companyName: undefined, registrationNumber: undefined });
      return { state: s.state, data, actions: [] };

    case 'AWAITING_ID_DOCUMENT':
      return expectMedia(s, e, 'identity') ?? retry(s, 'ask_id_document');

    case 'AWAITING_DRIVER_LICENCE':
      return expectMedia(s, e, 'driver_licence') ?? retry(s, 'ask_driver_licence');

    case 'AWAITING_BBBEE_CHOICE':
      if (e.type === 'button' && (e.id === 'bbbee_affidavit' || e.id === 'bbbee_certificate')) {
        return enter('AWAITING_BBBEE_DOCUMENT', s, { ...data, bbbeeEvidence: e.id === 'bbbee_affidavit' ? 'affidavit' : 'certificate' });
      }
      if (e.type === 'button' && e.id === 'bbbee_none') return enter(nextAfterBbbee(s.requirements), s, { ...data, bbbeeEvidence: 'not_applicable' });
      return { state: s.state, data, actions: promptFor(s.state, s) };

    case 'AWAITING_BBBEE_DOCUMENT':
      return expectMedia(s, e, 'bbbee', data.bbbeeEvidence === 'certificate' ? 'certificate' : 'affidavit') ?? retry(s, 'ask_bbbee_document');

    case 'AWAITING_OCR': {
      if (e.type !== 'ocr_result') return { state: s.state, data, actions: [{ type: 'send_text', key: 'please_wait' }] };
      const resume = data.resumeState ?? 'AWAITING_ID_DOCUMENT';
      const back = { ...s, state: resume };
      if (e.outcome === 'retake') return { ...retry(back, 'retake_photo', { detail: e.detail ?? '' }), state: resume };
      if (e.outcome === 'wrong_document') return { ...retry(back, 'wrong_document', { detail: e.detail ?? '' }), state: resume };

      const cleaned: ConversationData = { ...data, pendingDocKind: undefined, resumeState: undefined, retries: 0 };
      if (e.kind === 'identity') {
        cleaned.identityDocumentId = e.documentId;
        cleaned.idNumberLast4 = e.idNumberLast4;
        cleaned.isListedDirector = e.isListedDirector;
        const pre: Action[] =
          e.isListedDirector === false && data.entityKind !== 'sole_proprietor' ? [{ type: 'send_text', key: 'not_a_director', vars: { company: data.companyName ?? '', buyer: s.buyerName } }] : [];
        return enter(nextAfterIdentity(s.requirements), s, cleaned, pre);
      }
      if (e.kind === 'driver_licence') {
        cleaned.licenceDocumentId = e.documentId;
        return enter(nextAfterLicence(s.requirements), s, cleaned);
      }
      cleaned.bbbeeDocumentId = e.documentId;
      cleaned.bbbeeDecision = e.bbbeeDecision;
      return enter(nextAfterBbbee(s.requirements), s, cleaned);
    }

    case 'AWAITING_TCS_PIN':
      if (e.type === 'tcs_captured') return enter('REVIEW', s, { ...data, tcsCaptured: true, retries: 0 });
      if (e.type === 'text') {
        // The vendor typed the PIN in chat. Accept it (it is their own chat
        // history), store it encrypted, and remind them how to avoid it.
        try {
          const { pin, looksLikeTaxNumber } = normaliseTcsPin(e.text);
          if (looksLikeTaxNumber) return retry(s, 'tcs_looks_like_tax_number');
          return enter('AWAITING_TAX_REFERENCE', s, { ...data, retries: 0 }, [
            { type: 'store_tcs_pin', pin },
            { type: 'send_text', key: 'tcs_pin_in_chat_warning' },
          ]);
        } catch {
          return retry(s, 'ask_tcs_pin');
        }
      }
      return { state: s.state, data, actions: promptFor(s.state, s) };

    case 'AWAITING_TAX_REFERENCE': {
      if (e.type !== 'text') return retry(s, 'ask_tax_reference');
      const ref = normaliseTaxReference(e.text);
      if (!ref) return retry(s, 'tax_reference_invalid');
      return enter('REVIEW', s, { ...data, tcsCaptured: true, retries: 0 }, [{ type: 'store_tax_reference', taxReference: ref }]);
    }

    case 'REVIEW':
      if (e.type === 'button' && e.id === 'review_submit') return { state: 'SUBMITTED', data, actions: [{ type: 'submit_verification' }, { type: 'send_text', key: 'submitted' }] };
      if (e.type === 'button' && e.id === 'review_restart') return enter('AWAITING_ENTITY_TYPE', s, { retries: 0 });
      return { state: s.state, data, actions: promptFor(s.state, s) };

    case 'SUBMITTED':
      if (e.type === 'verification_result') {
        const vars = { outcome: e.outcome, passport: e.passportUrl ?? '' };
        return {
          state: 'COMPLETED',
          data,
          actions: [s.withinServiceWindow ? { type: 'send_text', key: 'result', vars } : { type: 'send_template', template: 'onboarding_result', vars }],
        };
      }
      return { state: s.state, data, actions: [{ type: 'send_text', key: 'please_wait' }] };

    case 'HUMAN_HANDOFF':
    case 'COMPLETED':
    case 'OPTED_OUT':
    case 'ABANDONED':
      return { state: s.state, data, actions: [] };
  }
}
