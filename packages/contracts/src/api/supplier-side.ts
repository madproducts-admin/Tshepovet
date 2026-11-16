import { z } from 'zod';
import { Day, Timestamp, Uuid } from './common';

/**
 * The supplier's side (docs/PLAN.md M6): onboarding from a buyer's invitation, self-service for
 * a supplier's contacts, and the public Verified Vendor Passport.
 */

// --- Buyer: invitations -------------------------------------------------------------------
export const InviteSupplierSchema = z
  .object({
    email: z.email('Enter the supplier contact’s email address.').max(254),
    contact_name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const SupplierInviteSchema = z.strictObject({
  id: Uuid,
  email: z.string(),
  contact_name: z.string().nullable(),
  created_at: Timestamp,
  expires_at: Timestamp,
  opened_at: Timestamp.nullable(),
  completed_at: Timestamp.nullable(),
  revoked_at: Timestamp.nullable(),
});

// --- Onboarding (anonymous, with the invitation token in X-Onboarding-Token) ------------------
export const OnboardingStateSchema = z.strictObject({
  buyer: z.string(),
  supplier: z.strictObject({ legal_name: z.string(), registration_number: z.string().nullable(), entity_kind: z.string() }),
  contact: z.strictObject({ full_name: z.string(), email: z.string() }).nullable(),
  invited_email: z.string(),
  sandbox: z.boolean(),
  consent_given: z.boolean(),
  company: z.strictObject({
    state: z.enum(['todo', 'found', 'confirmed', 'disputed', 'not_found', 'unavailable']),
    legal_name: z.string().nullable(),
    cipc_status: z.string().nullable(),
    directors: z.array(z.string()),
  }),
  identity: z.strictObject({ state: z.enum(['todo', 'accepted', 'review', 'retake', 'wrong_document']), is_director: z.boolean().nullable() }),
  bbbee: z.strictObject({ state: z.enum(['todo', 'accepted', 'review', 'refused', 'retake', 'wrong_document', 'skipped']), level: z.number().int().nullable(), reasons: z.array(z.string()) }),
  bank: z.strictObject({ state: z.enum(['todo', 'added', 'skipped']), last4: z.string().nullable() }),
  tax: z.strictObject({ state: z.enum(['todo', 'compliant', 'non_compliant', 'problem', 'skipped']), detail: z.string().nullable() }),
  submitted_at: Timestamp.nullable(),
  /** Sandbox only: sample documents to choose instead of uploading real ones. */
  samples: z.array(z.strictObject({ id: z.string(), kind: z.enum(['identity', 'bbbee']), label: z.string(), outcome: z.string() })),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingStartSchema = z
  .object({
    agree: z.literal(true, { message: 'Agree to the notice to continue.' }),
    full_name: z.string().trim().min(1, 'Enter your full name.').max(120),
    role: z.string().trim().max(80).optional(),
  })
  .strict();
export const OnboardingCompanySchema = z.object({ correct: z.boolean() }).strict();
export const OnboardingSampleSchema = z.object({ kind: z.enum(['identity', 'bbbee']), sample: z.string().max(40) }).strict();
export const OnboardingSkipSchema = z.object({ step: z.enum(['bbbee', 'bank', 'tax']) }).strict();
export const OnboardingBankSchema = z
  .object({
    bank_name: z.string().trim().min(2, 'Choose your bank.').max(80),
    account_number: z.string().trim().regex(/^\d{6,16}$/, 'Account numbers are 6 to 16 digits.'),
    account_type: z.enum(['current', 'savings', 'transmission']),
  })
  .strict();
export const OnboardingTaxSchema = z
  .object({
    tax_reference_number: z.string().trim().regex(/^[0-39]\d{9}$/, 'Enter the 10-digit income tax reference number.'),
    tcs_pin: z.string().trim().min(6, 'Enter the PIN from SARS eFiling.').max(30),
  })
  .strict();
export const OnboardingSubmitSchema = z.object({ publish_passport: z.boolean() }).strict();

// --- Supplier self-service (/api/vendor) -------------------------------------------------------
export const PASSPORT_FIELDS = ['legal_name', 'registration_number', 'cipc_status', 'vat_status', 'tcs_status', 'bbbee_level', 'directors_initials', 'verified_at'] as const;

export const VendorPortalSchema = z.strictObject({
  contact: z.strictObject({ full_name: z.string(), email: z.string() }),
  vendor: z.strictObject({
    id: Uuid,
    legal_name: z.string(),
    trading_name: z.string().nullable(),
    registration_number: z.string().nullable(),
    entity_kind: z.string(),
    cipc_status: z.string().nullable(),
    vat_number: z.string().nullable(),
    passport_status: z.enum(['none', 'active', 'suspended', 'revoked']),
    passport_public_id: z.string(),
    passport_public_fields: z.array(z.string()),
    passport_last_verified_at: Timestamp.nullable(),
  }),
  buyers: z.array(z.strictObject({ relationship_id: Uuid, buyer: z.string(), status: z.string(), since: Timestamp, monitored: z.boolean() })),
  consents: z.array(
    z.strictObject({
      id: Uuid,
      buyer: z.string().nullable(),
      granted_at: Timestamp,
      capture_method: z.string(),
      purposes: z.array(z.strictObject({ purpose: z.string(), withdrawn_at: Timestamp.nullable() })),
    }),
  ),
  documents: z.array(z.strictObject({ id: Uuid, document_type: z.string(), name: z.string(), review_status: z.string(), expires_on: Day.nullable(), created_at: Timestamp })),
  requests: z.array(z.strictObject({ id: Uuid, buyer: z.string().nullable(), request_type: z.string(), status: z.string(), received_at: Timestamp, due_at: Timestamp })),
});

export const VendorPassportUpdateSchema = z
  .object({
    status: z.enum(['active', 'revoked']),
    fields: z.array(z.enum(PASSPORT_FIELDS)).min(1, 'Choose at least one fact to show.'),
  })
  .strict();
export const VendorWithdrawSchema = z.object({ purposes: z.array(z.string().max(60)).min(1).optional() }).strict();
export const VendorRequestSchema = z
  .object({
    relationship_id: Uuid,
    request_type: z.enum(['access', 'correction', 'deletion', 'objection']),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

// --- The public passport -----------------------------------------------------------------------
export const PublicPassportSchema = z.strictObject({
  public_id: z.string(),
  legal_name: z.string().nullable(),
  registration_number: z.string().nullable(),
  cipc_status: z.string().nullable(),
  vat_registered: z.boolean().nullable(),
  tcs: z.strictObject({ status: z.string().nullable(), expires_on: Day.nullable(), checked_at: Timestamp.nullable() }).nullable(),
  bbbee: z.strictObject({ level: z.number().int().nullable(), valid_until: Day }).nullable(),
  directors: z.array(z.string()).nullable(),
  verified_at: Timestamp.nullable(),
  /** Printed on a paper copy; POST /api/passport/verify says whether it is genuine and current. */
  verification_code: z.string(),
});
export type PublicPassport = z.infer<typeof PublicPassportSchema>;

export const PassportVerifyRequestSchema = z.object({ code: z.string().trim().min(10).max(80) }).strict();
export const PassportVerifyResultSchema = z.strictObject({
  genuine: z.boolean(),
  current: z.boolean(),
  status: z.enum(['active', 'withdrawn', 'unknown']),
  legal_name: z.string().nullable(),
  printed_verified_at: Timestamp.nullable(),
  public_id: z.string().nullable(),
});
