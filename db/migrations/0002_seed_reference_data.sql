-- =============================================================================
-- TshepoVet - reference data seed.
-- Everything here is owned by the compliance/commercial team and must be
-- re-validated against the primary source before go-live. Rows that encode
-- regulatory thresholds carry the source in-line.
-- =============================================================================
BEGIN;

-- CIPC enterprise-number suffixes (YYYY/NNNNNN/TT). Validate against the CIPC
-- master list annually; unknown suffixes are accepted but flagged for review.
INSERT INTO ref_cipc_entity_types (code, name, abbreviation, has_directors, notes) VALUES
  ('06', 'Public Company',                    'Ltd',     true,  NULL),
  ('07', 'Private Company',                   '(Pty) Ltd', true, NULL),
  ('08', 'Non-Profit Company',                'NPC',     true,  'Former Section 21 companies'),
  ('09', 'Company Limited by Guarantee',      NULL,      true,  'Legacy (1973 Act)'),
  ('10', 'External Company',                  NULL,      true,  'Foreign company registered to do business in SA'),
  ('21', 'Personal Liability Company',        'Inc',     true,  'Directors jointly and severally liable for pre-incorporation debts'),
  ('22', 'Unlimited Company',                 NULL,      true,  'Legacy'),
  ('23', 'Close Corporation',                 'CC',      false, 'Members, not directors. No new CCs since 1 May 2011; often written with a CK prefix'),
  ('24', 'Primary Co-operative',              'Co-op',   true,  'Board members'),
  ('25', 'Secondary Co-operative',            'Co-op',   true,  NULL),
  ('26', 'Tertiary Co-operative',             'Co-op',   true,  NULL),
  ('30', 'State-Owned Company',               'SOC Ltd', true,  NULL),
  ('31', 'Statutory Body',                    NULL,      true,  NULL);

-- Procurement recognition (Amended Codes of Good Practice, 2013 - Statement 000).
INSERT INTO ref_bbbee_recognition_levels (level, procurement_recognition_pct) VALUES
  (1, 135), (2, 125), (3, 110), (4, 100), (5, 80), (6, 60), (7, 50), (8, 10), (0, 0);

-- Generic Codes thresholds (Amended Codes, Gazette 36928 of 11 Oct 2013, effective 1 May 2015).
-- Sector codes (Construction, Tourism, ICT, Financial, Agri, Transport, MAC, Property, Forestry,
-- Defence, Chartered Accountancy) have their own thresholds: load them from the gazettes
-- with verified=true only after legal review. Classification falls back to "manual review"
-- when a vendor's sector has no verified row.
INSERT INTO ref_bbbee_thresholds (sector_code, eme_max_turnover_cents, qse_max_turnover_cents, effective_from, gazette_reference, verified) VALUES
  ('generic', 1000000000, 5000000000, '2015-05-01', 'GG 36928 (11 Oct 2013) - Amended Codes of Good Practice, Statement 000', true);

INSERT INTO ref_document_types (code, name, default_validity_months, reminder_offsets_days, lock_grace_days, contains_special_pi, image_retention_days) VALUES
  ('sa_smart_id_card',          'SA Smart ID Card',                                NULL, '{}',          0,  false, 30),
  ('sa_green_id_book',          'SA Green Barcoded ID Book',                       NULL, '{}',          0,  false, 30),
  ('passport',                  'Passport',                                        NULL, '{60,30}',     0,  false, 30),
  ('driver_licence_card',       'SA Driving Licence Card',                         60,   '{60,30,14,0}',0,  false, 30),
  ('temporary_driver_licence',  'Temporary Driving Licence',                       6,    '{30,14,7,0}', 0,  false, 30),
  ('prdp',                      'Professional Driving Permit (PrDP)',              24,   '{60,30,14,0}',0,  false, 30),
  ('bbbee_eme_affidavit',       'B-BBEE Sworn Affidavit - EME',                    12,   '{30,14,7,0}', 30, true,  90),
  ('bbbee_qse_affidavit',       'B-BBEE Sworn Affidavit - QSE (>=51% black owned)',12,   '{30,14,7,0}', 30, true,  90),
  ('bbbee_certificate',         'B-BBEE Verification Certificate (SANAS)',         12,   '{60,30,14,0}',30, true,  90),
  ('cipc_eme_certificate',      'CIPC B-BBEE Certificate (EME)',                   12,   '{30,14,7,0}', 30, true,  90),
  ('tcs_pin_letter',            'SARS Tax Compliance Status (PIN letter)',         NULL, '{30,14,7,0}', 7,  false, 90),
  ('cipc_cor14_3',              'CIPC Registration Certificate (CoR14.3)',         NULL, '{}',          0,  false, 365),
  ('coida_logs',                'COIDA Letter of Good Standing',                   NULL, '{30,14,7,0}', 7,  false, 365),
  ('cidb_grading_certificate',  'CIDB Contractor Grading Certificate',             NULL, '{60,30,14,0}',14, false, 365),
  ('bank_confirmation_letter',  'Bank Account Confirmation Letter',                3,    '{}',          0,  false, 90),
  ('csd_registration_report',   'National Treasury CSD Registration Report',       NULL, '{}',          0,  false, 365),
  ('proof_of_address',          'Proof of Address',                                3,    '{}',          0,  false, 90);

-- POPIA s14 retention schedule. Statutory anchors:
--   FIC Act s22/s23: 5 years from end of business relationship (when the buyer is an accountable institution)
--   Tax Administration Act s29: 5 years from submission of the relevant return
--   Companies Act s24: 7 years for company records
-- Buyers may extend via tenants.settings.retention_overrides where they have a legal duty.
INSERT INTO ref_retention_policies (data_category, retention_days, clock_starts, legal_basis_note) VALUES
  ('identity_document_image',   30,   'created',          'Purpose (extraction & verification) achieved; keep hash + extracted fields only'),
  ('compliance_document_image', 90,   'created',          'Dispute/review window; certificate metadata retained separately'),
  ('bureau_raw_payload',        30,   'created',          'Dispute window with bureau; normalised result retained'),
  ('verification_result',       1825, 'relationship_end', 'Buyer due-diligence evidence; FIC Act s22 analogue (5 yrs)'),
  ('tcs_pin',                   1,    'expiry',           'Bearer credential; purge at PIN expiry or end of monitoring'),
  ('director_identifiers',      1825, 'relationship_end', 'COI/fraud evidence; public-register data re-fetchable'),
  ('employee_hr_import',        30,   'last_activity',    'COI screening only; HR system remains source of truth'),
  ('consent_evidence',          1825, 'relationship_end', 'Proof of lawful processing (POPIA s11(2)(a) burden of proof)'),
  ('whatsapp_message_metadata', 30,   'created',          'Operational dedupe only'),
  ('audit_log',                 2555, 'created',          'Companies Act s24 (7 yrs) / evidential integrity'),
  ('financial_ledger',          2555, 'created',          'Tax Administration Act / Companies Act');

INSERT INTO price_book (sku, description, billing_type, unit_price_cents, effective_from) VALUES
  ('COMPANY_CHECK',             'Company legitimacy check (CIPC, directors, VAT, TCS)',      'usage',                300,    '2026-01-01'),
  ('COMPANY_CHECK_LIVE',        'Company check forcing a live bureau refresh (no cache)',   'usage',                600,    '2026-01-01'),
  ('DRIVER_LICENCE_CHECK',      'Driving licence / PrDP check',                              'usage',                250,    '2026-01-01'),
  ('MOD_BBBEE',                 'B-BBEE Spend & Scorecard Calculator',                       'subscription_monthly', 500000, '2026-01-01'),
  ('MOD_COI_RADAR',             'Employee-Vendor Conflict of Interest & Ghost Supplier Radar','subscription_monthly', 350000, '2026-01-01'),
  ('MOD_CONSTRUCTION',          'Industry add-on: COIDA / CIDB',                             'subscription_monthly', 250000, '2026-01-01'),
  ('MOD_LOGISTICS',             'Industry add-on: eNaTIS / PrDP',                            'subscription_monthly', 250000, '2026-01-01'),
  ('MONITORING_PER_VENDOR',     'Continuous expiry monitoring & accounting webhook lock',    'per_vendor_monthly',   1500,   '2026-01-01');

-- Providers & capabilities. unit_cost_cents are PLACEHOLDERS - replace with
-- contracted wholesale rates. Capability coverage must match each bureau's
-- signed product schedule; do not assume a bureau offers TCS or eNaTIS access.
INSERT INTO providers (code, name, operator_agreement_signed_on, notes) VALUES
  ('xds',         'XDS (Xpert Decision Systems)', NULL, 'Commercial bureau'),
  ('cpb',         'Consumer Profile Bureau',      NULL, 'Commercial bureau'),
  ('searchworks', 'SearchWorks',                  NULL, 'Aggregator'),
  ('verifyid',    'VerifyID',                     NULL, 'Identity verification'),
  ('mock',        'Sandbox provider',             NULL, 'Deterministic test data - test keys only');

INSERT INTO provider_capabilities (provider_code, capability, unit_cost_cents, is_live_source, timeout_ms) VALUES
  ('cpb',         'company_registration', 120, false, 3000),
  ('cpb',         'company_directors',    0,   false, 3000),   -- bundled with registration
  ('xds',         'company_registration', 180, true,  4000),
  ('xds',         'company_directors',    0,   true,  4000),
  ('searchworks', 'company_registration', 220, true,  5000),
  ('searchworks', 'company_directors',    0,   true,  5000),
  ('searchworks', 'vat_status',           40,  true,  4000),
  ('xds',         'vat_status',           60,  true,  4000),
  ('verifyid',    'id_verification',      150, true,  4000),
  ('verifyid',    'driver_licence',       140, true,  5000),
  ('verifyid',    'prdp',                 0,   true,  5000),
  ('searchworks', 'tax_compliance_status',0,   true,  60000),  -- async/assisted; see docs/03
  ('mock',        'company_registration', 0,   true,  1000),
  ('mock',        'company_directors',    0,   true,  1000),
  ('mock',        'vat_status',           0,   true,  1000),
  ('mock',        'tax_compliance_status',0,   true,  1000),
  ('mock',        'driver_licence',       0,   true,  1000),
  ('mock',        'prdp',                 0,   true,  1000);

-- POPIA s18 notices. Consent records reference the exact text (by id and hash).
-- Legal must approve wording; versions are immutable - publish a new version to change.
INSERT INTO privacy_notices (code, version, language, channel, body, body_sha256, effective_from)
SELECT code, 1, lang, channel, body, sha256(convert_to(body, 'UTF8')), '2026-01-01'
FROM (VALUES
  ('company_verification', 'en', 'api',
   'The buyer named in this request (the responsible party) will use TshepoVet (its operator) to verify the supplier''s registration, directors, VAT status and, where you supplied a SARS Tax Compliance PIN, its tax compliance status, in order to decide whether to contract with and pay the supplier. Information is obtained from the CIPC register, SARS and licensed data bureaus in South Africa. Supplying the PIN is voluntary; without it tax compliance cannot be confirmed. Results are kept for the duration of the business relationship plus five years. You may request access to or correction of your information, object to processing, or lodge a complaint with the Information Regulator (inforeg.org.za).'),
  ('driver_verification', 'en', 'api',
   'Your employer and the buyer named in this request will use TshepoVet to confirm that your driving licence and professional driving permit are valid for the vehicles you will operate. TshepoVet checks the national traffic register through a licensed data provider in South Africa. This is required to drive on the buyer''s contracts; you may refuse, in which case you cannot be assigned to those contracts. Results are kept while you are assigned plus five years. You may request access, correction or object, and complain to the Information Regulator (inforeg.org.za).'),
  ('vendor_onboarding', 'en', 'whatsapp',
   'Hi! {buyer} uses TshepoVet to onboard suppliers. We will ask for your company details, ID document, and (if required) B-BBEE and tax compliance documents, and verify them with CIPC, SARS and licensed data bureaus. Photos are read by automated software and deleted within 30 days; extracted details are kept while you supply {buyer} plus five years. Reply STOP at any time. Full notice: https://tshepovet.co.za/privacy. Do you agree?')
) AS n(code, lang, channel, body);

-- Platform ledger accounts.
INSERT INTO ledger_accounts (tenant_id, code, kind) VALUES
  (NULL, 'cash_clearing',        'asset'),
  (NULL, 'revenue_usage',        'revenue'),
  (NULL, 'revenue_subscription', 'revenue'),
  (NULL, 'promo_credit_expense', 'expense');

INSERT INTO processing_activities (code, description, purpose, lawful_basis, data_categories, special_pi, operators, cross_border, cross_border_basis, retention_category, prior_authorisation) VALUES
  ('company_kyb', 'Company legitimacy verification for buyer onboarding', 'kyb_company_verification', 'legitimate_interest_responsible_party',
     '{company_registration,director_names,director_id_numbers,vat_status}', false, '{xds,cpb,searchworks}', false, NULL, 'verification_result', 'Not required - assess annually'),
  ('tcs_verification', 'SARS TCS status check using vendor-supplied PIN', 'tax_compliance_verification', 'consent',
     '{tax_reference,tcs_pin,tcs_status}', false, '{searchworks}', false, NULL, 'tcs_pin', 'Not required'),
  ('driver_checks', 'Driving licence and PrDP validity for logistics vendors', 'driver_licence_verification', 'consent',
     '{id_number,licence_codes,prdp_categories,validity_dates}', false, '{verifyid}', false, NULL, 'verification_result', 'Not required'),
  ('bbbee_processing', 'B-BBEE level determination from affidavits/certificates', 'bbbee_verification', 'legal_obligation',
     '{black_ownership_pct,black_female_ownership_pct,turnover}', true, '{}', false, NULL, 'verification_result', 's29(b) exemption relied on; no s57 trigger'),
  ('document_ocr', 'LLM/OCR extraction of fields from uploaded documents', 'document_ocr_processing', 'consent',
     '{id_document_image,licence_image,affidavit_image}', true, '{anthropic,aws}', true, 's72(1)(b) binding agreement + s72(1)(a) consent fallback', 'identity_document_image', 'Assess s57(1)(d) if biometric data leaves SA'),
  ('coi_radar', 'Matching employee identifiers against vendor directors/bank accounts', 'conflict_of_interest_screening', 'legitimate_interest_responsible_party',
     '{employee_id_numbers,bank_accounts,director_id_numbers}', false, '{}', false, NULL, 'employee_hr_import', 'Obtain legal opinion on s57(1)(a); tenant-keyed blind indexes used');

COMMIT;
