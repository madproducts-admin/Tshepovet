import { z } from 'zod';
import {
  AcceptInviteSchema,
  ChangePasswordSchema,
  EmailOnlySchema,
  InviteSchema,
  LoginSchema,
  MfaChallengeSchema,
  MfaCodeSchema,
  MfaDisableSchema,
  PasswordConfirmSchema,
  ResetPasswordSchema,
  SignupSchema,
  TokenSchema,
} from '../auth';
import type { Permission } from '../rbac';
import { ROLES } from '../rbac';
import { CheckListQuerySchema, CheckPageSchema, CheckPricesSchema, PortalCompanyCheckSchema, PortalDriverCheckSchema, PortalVerificationSchema } from './checks';
import {
  AuditQuerySchema,
  ChainVerificationSchema,
  ConsentListQuerySchema,
  ConsentPageSchema,
  ConsentSchema,
  CreateDsrSchema,
  DsrListQuerySchema,
  DsrPageSchema,
  DsrSchema,
  NoticeSchema,
  ProcessingActivitySchema,
  UpdateDsrSchema,
  WithdrawConsentSchema,
} from './compliance';
import {
  ApiKeySchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  CreateWebhookSchema,
  DeliveryPageSchema,
  DeliveryQuerySchema,
  UpdateWebhookSchema,
  WebhookEndpointSchema,
  WebhookWithSecretSchema,
} from './developers';
import { AddSpendSchema, ModuleChangeSchema, ModuleSchema, PeriodQuerySchema, ScorecardSchema, SpendLineSchema } from './modules';
import { AlertSchema, CalendarQuerySchema, EnrolSchema, MonitoringOverviewSchema, PaymentLockSchema, ScheduleItemSchema, UpdateEnrolmentSchema } from './monitoring';
import { MetaSchema, OverviewSchema, SettingsSchema, UpdateSettingsSchema } from './organisation';
import {
  AddSupplierSchema,
  AuditListSchema,
  CreateSavedViewSchema,
  SavedViewSchema,
  SupplierDetailSchema,
  SupplierListItemSchema,
  SupplierListQuerySchema,
  SupplierPageSchema,
  SupplierStatusChangeSchema,
  UpdateSupplierSchema,
} from './suppliers';
import { HoldSchema, LedgerPageSchema, LedgerQuerySchema, TopupPageSchema, TopupRequestSchema, TopupResultSchema, UpdateWalletSchema, WalletSchema } from './wallet';

/**
 * Every route of the portal API, in one table. It is the source for the OpenAPI document
 * (openapi.ts) and the web app's typed client, and a test checks it against the routes the
 * NestJS controllers actually register, both ways, so neither can drift from the other.
 *
 * access: 'public' needs nothing; 'session' a signed-in portal user (plus `permission`);
 * 'staff' a signed-in staff member. POST/PATCH/PUT/DELETE also need the X-CSRF-Token header.
 */
export interface ApiRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  tag: string;
  summary: string;
  access: 'public' | 'session' | 'staff';
  permission?: Permission;
  /** Reachable while the session must still enrol in two-step verification. */
  mfaSetupAllowed?: boolean;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  status: number;
  produces?: 'application/json' | 'text/csv';
}

const Ok = z.strictObject({ ok: z.literal(true) });
const CsrfView = z.strictObject({ csrf_token: z.string() });
const Unknown = z.record(z.string(), z.unknown());
const TeamView = z.strictObject({
  members: z.array(
    z.strictObject({
      id: z.uuid(),
      email: z.string(),
      full_name: z.string(),
      role: z.enum(ROLES),
      mfa_enrolled: z.boolean(),
      email_verified_at: z.iso.datetime().nullable(),
      last_login_at: z.iso.datetime().nullable(),
      disabled_at: z.iso.datetime().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
  invitations: z.array(z.strictObject({ id: z.uuid(), email: z.string(), role: z.enum(ROLES), expires_at: z.iso.datetime(), created_at: z.iso.datetime() })),
  assignable_roles: z.array(z.enum(ROLES)),
});

const r = (route: ApiRoute) => route;

export const API_ROUTES: ApiRoute[] = [
  // --- Platform -------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/meta', tag: 'Platform', summary: 'Sandbox flag, prices and modules (public)', access: 'public', response: MetaSchema, status: 200 }),
  r({ method: 'GET', path: '/api/openapi.json', tag: 'Platform', summary: 'This document', access: 'public', response: Unknown, status: 200 }),

  // --- Accounts (M2) --------------------------------------------------------------------
  r({ method: 'GET', path: '/api/auth/csrf', tag: 'Accounts', summary: 'Issue the CSRF cookie and token', access: 'public', response: CsrfView, status: 200 }),
  r({ method: 'POST', path: '/api/auth/signup', tag: 'Accounts', summary: 'Create an organisation and its owner', access: 'public', body: SignupSchema, status: 202 }),
  r({ method: 'POST', path: '/api/auth/verify-email', tag: 'Accounts', summary: 'Confirm an email address', access: 'public', body: TokenSchema, status: 200 }),
  r({ method: 'POST', path: '/api/auth/resend-verification', tag: 'Accounts', summary: 'Send the confirmation email again', access: 'public', body: EmailOnlySchema, status: 202 }),
  r({ method: 'POST', path: '/api/auth/login', tag: 'Accounts', summary: 'Sign in (may return an MFA challenge)', access: 'public', body: LoginSchema, status: 200 }),
  r({ method: 'POST', path: '/api/auth/mfa', tag: 'Accounts', summary: 'Answer the MFA challenge', access: 'public', body: MfaChallengeSchema, status: 200 }),
  r({ method: 'POST', path: '/api/auth/logout', tag: 'Accounts', summary: 'Sign out', access: 'public', status: 204 }),
  r({ method: 'GET', path: '/api/auth/session', tag: 'Accounts', summary: 'The signed-in user, organisation and permissions', access: 'session', mfaSetupAllowed: true, status: 200 }),
  r({ method: 'POST', path: '/api/auth/password/forgot', tag: 'Accounts', summary: 'Email a password reset link', access: 'public', body: EmailOnlySchema, status: 202 }),
  r({ method: 'POST', path: '/api/auth/password/reset', tag: 'Accounts', summary: 'Set a new password from a reset link', access: 'public', body: ResetPasswordSchema, status: 200 }),
  r({ method: 'POST', path: '/api/auth/password/change', tag: 'Accounts', summary: 'Change the password', access: 'session', body: ChangePasswordSchema, status: 204 }),
  r({ method: 'POST', path: '/api/auth/mfa/setup', tag: 'Accounts', summary: 'Start two-step verification enrolment', access: 'session', mfaSetupAllowed: true, status: 200 }),
  r({ method: 'POST', path: '/api/auth/mfa/enable', tag: 'Accounts', summary: 'Confirm enrolment with a first code', access: 'session', mfaSetupAllowed: true, body: MfaCodeSchema, status: 200 }),
  r({ method: 'POST', path: '/api/auth/mfa/disable', tag: 'Accounts', summary: 'Turn two-step verification off', access: 'session', body: MfaDisableSchema, status: 204 }),
  r({ method: 'POST', path: '/api/auth/mfa/recovery-codes', tag: 'Accounts', summary: 'Replace the recovery codes', access: 'session', body: PasswordConfirmSchema, status: 200 }),
  r({ method: 'GET', path: '/api/auth/sessions', tag: 'Accounts', summary: 'My signed-in sessions', access: 'session', status: 200 }),
  r({ method: 'DELETE', path: '/api/auth/sessions/{id}', tag: 'Accounts', summary: 'End one of my sessions', access: 'session', status: 204 }),
  r({ method: 'POST', path: '/api/auth/sessions/revoke-others', tag: 'Accounts', summary: 'Sign out everywhere else', access: 'session', status: 200 }),
  r({ method: 'GET', path: '/api/auth/invitations/{token}', tag: 'Accounts', summary: 'Look at an invitation before accepting it', access: 'public', status: 200 }),
  r({ method: 'POST', path: '/api/auth/invitations/accept', tag: 'Accounts', summary: 'Accept an invitation', access: 'public', body: AcceptInviteSchema, status: 201 }),

  // --- Team (M2) ------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/team', tag: 'Team', summary: 'Members and pending invitations', access: 'session', permission: 'team:read', response: TeamView, status: 200 }),
  r({ method: 'POST', path: '/api/team/invitations', tag: 'Team', summary: 'Invite someone', access: 'session', permission: 'team:manage', body: InviteSchema, status: 202 }),
  r({ method: 'DELETE', path: '/api/team/invitations/{id}', tag: 'Team', summary: 'Withdraw an invitation', access: 'session', permission: 'team:manage', status: 204 }),
  r({ method: 'PATCH', path: '/api/team/members/{id}', tag: 'Team', summary: 'Change a member’s role', access: 'session', permission: 'team:manage', body: z.object({ role: z.enum(ROLES) }), status: 200 }),
  r({ method: 'POST', path: '/api/team/members/{id}/disable', tag: 'Team', summary: 'Remove a member', access: 'session', permission: 'team:manage', status: 204 }),

  // --- Overview and settings ------------------------------------------------------------
  r({ method: 'GET', path: '/api/overview', tag: 'Overview', summary: 'The dashboard', access: 'session', permission: 'suppliers:read', response: OverviewSchema, status: 200 }),
  r({ method: 'GET', path: '/api/settings', tag: 'Settings', summary: 'Organisation profile and preferences', access: 'session', response: SettingsSchema, status: 200 }),
  r({ method: 'PATCH', path: '/api/settings', tag: 'Settings', summary: 'Change the profile or preferences', access: 'session', permission: 'settings:manage', body: UpdateSettingsSchema, response: SettingsSchema, status: 200 }),

  // --- Suppliers ------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/suppliers', tag: 'Suppliers', summary: 'List suppliers', access: 'session', permission: 'suppliers:read', query: SupplierListQuerySchema, response: SupplierPageSchema, status: 200 }),
  r({ method: 'GET', path: '/api/suppliers/export.csv', tag: 'Suppliers', summary: 'The filtered list as CSV', access: 'session', permission: 'suppliers:read', query: SupplierListQuerySchema, status: 200, produces: 'text/csv' }),
  r({ method: 'POST', path: '/api/suppliers', tag: 'Suppliers', summary: 'Add a supplier by registration number', access: 'session', permission: 'suppliers:write', body: AddSupplierSchema, response: SupplierListItemSchema, status: 201 }),
  r({ method: 'GET', path: '/api/suppliers/{id}', tag: 'Suppliers', summary: 'One supplier in full', access: 'session', permission: 'suppliers:read', response: SupplierDetailSchema, status: 200 }),
  r({ method: 'PATCH', path: '/api/suppliers/{id}', tag: 'Suppliers', summary: 'Change reference, risk rating or industry', access: 'session', permission: 'suppliers:write', body: UpdateSupplierSchema, response: SupplierListItemSchema, status: 200 }),
  r({ method: 'POST', path: '/api/suppliers/{id}/status', tag: 'Suppliers', summary: 'Approve, reject, suspend or offboard', access: 'session', permission: 'suppliers:write', body: SupplierStatusChangeSchema, response: SupplierListItemSchema, status: 200 }),
  r({ method: 'GET', path: '/api/suppliers/{id}/audit', tag: 'Suppliers', summary: 'The supplier’s audit trail', access: 'session', permission: 'audit:read', response: AuditListSchema, status: 200 }),
  r({ method: 'GET', path: '/api/saved-views', tag: 'Suppliers', summary: 'My saved list views', access: 'session', permission: 'suppliers:read', query: z.object({ scope: z.enum(['suppliers', 'checks']) }), response: z.array(SavedViewSchema), status: 200 }),
  r({ method: 'POST', path: '/api/saved-views', tag: 'Suppliers', summary: 'Save a list view', access: 'session', permission: 'suppliers:read', body: CreateSavedViewSchema, response: SavedViewSchema, status: 201 }),
  r({ method: 'DELETE', path: '/api/saved-views/{id}', tag: 'Suppliers', summary: 'Delete a saved view', access: 'session', permission: 'suppliers:read', status: 204 }),

  // --- Checks ---------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/checks/prices', tag: 'Checks', summary: 'What each check costs, and the balance', access: 'session', permission: 'checks:run', response: CheckPricesSchema, status: 200 }),
  r({ method: 'POST', path: '/api/checks/company', tag: 'Checks', summary: 'Run a company check (200 done, 202 still running)', access: 'session', permission: 'checks:run', body: PortalCompanyCheckSchema, response: PortalVerificationSchema, status: 200 }),
  r({ method: 'POST', path: '/api/checks/driver', tag: 'Checks', summary: 'Run a driver’s licence / PrDP check', access: 'session', permission: 'checks:run', body: PortalDriverCheckSchema, response: PortalVerificationSchema, status: 200 }),
  r({ method: 'GET', path: '/api/checks', tag: 'Checks', summary: 'Checks history', access: 'session', permission: 'suppliers:read', query: CheckListQuerySchema, response: CheckPageSchema, status: 200 }),
  r({ method: 'GET', path: '/api/checks/{id}', tag: 'Checks', summary: 'One check and its results', access: 'session', permission: 'suppliers:read', response: PortalVerificationSchema, status: 200 }),

  // --- Monitoring -----------------------------------------------------------------------
  r({ method: 'GET', path: '/api/monitoring', tag: 'Monitoring', summary: 'Enrolments and counts', access: 'session', permission: 'suppliers:read', response: MonitoringOverviewSchema, status: 200 }),
  r({ method: 'GET', path: '/api/monitoring/calendar', tag: 'Monitoring', summary: 'Expiries between two dates', access: 'session', permission: 'suppliers:read', query: CalendarQuerySchema, response: z.array(ScheduleItemSchema), status: 200 }),
  r({ method: 'GET', path: '/api/monitoring/alerts', tag: 'Monitoring', summary: 'Expired, expiring and payment-locked suppliers', access: 'session', permission: 'suppliers:read', response: z.array(AlertSchema), status: 200 }),
  r({ method: 'POST', path: '/api/monitoring/{supplierId}', tag: 'Monitoring', summary: 'Start monitoring a supplier', access: 'session', permission: 'monitoring:manage', body: EnrolSchema, response: MonitoringOverviewSchema.shape.enrolments.element, status: 201 }),
  r({ method: 'PATCH', path: '/api/monitoring/{supplierId}', tag: 'Monitoring', summary: 'Turn the accounting lock on or off', access: 'session', permission: 'monitoring:manage', body: UpdateEnrolmentSchema, response: MonitoringOverviewSchema.shape.enrolments.element, status: 200 }),
  r({ method: 'DELETE', path: '/api/monitoring/{supplierId}', tag: 'Monitoring', summary: 'Stop monitoring a supplier', access: 'session', permission: 'monitoring:manage', status: 204 }),
  r({ method: 'POST', path: '/api/monitoring/{supplierId}/payment-lock', tag: 'Monitoring', summary: 'Lock, unlock or override payments', access: 'session', permission: 'monitoring:manage', body: PaymentLockSchema, response: SupplierListItemSchema, status: 200 }),

  // --- Wallet ---------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/wallet', tag: 'Wallet', summary: 'Balance, holds and threshold', access: 'session', permission: 'wallet:read', response: WalletSchema, status: 200 }),
  r({ method: 'PATCH', path: '/api/wallet', tag: 'Wallet', summary: 'Set the low-balance warning', access: 'session', permission: 'wallet:topup', body: UpdateWalletSchema, response: WalletSchema, status: 200 }),
  r({ method: 'GET', path: '/api/wallet/holds', tag: 'Wallet', summary: 'Funds reserved for checks in progress', access: 'session', permission: 'wallet:read', response: z.array(HoldSchema), status: 200 }),
  r({ method: 'GET', path: '/api/wallet/ledger', tag: 'Wallet', summary: 'Wallet movements', access: 'session', permission: 'wallet:read', query: LedgerQuerySchema, response: LedgerPageSchema, status: 200 }),
  r({ method: 'GET', path: '/api/wallet/ledger.csv', tag: 'Wallet', summary: 'Wallet movements as CSV', access: 'session', permission: 'wallet:read', query: LedgerQuerySchema, status: 200, produces: 'text/csv' }),
  r({ method: 'GET', path: '/api/wallet/topups', tag: 'Wallet', summary: 'Top-ups and their tax invoices', access: 'session', permission: 'wallet:read', query: z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) }), response: TopupPageSchema, status: 200 }),
  r({ method: 'POST', path: '/api/wallet/topups', tag: 'Wallet', summary: 'Top up (sandbox: credited at once)', access: 'session', permission: 'wallet:topup', body: TopupRequestSchema, response: TopupResultSchema, status: 201 }),

  // --- Modules --------------------------------------------------------------------------
  r({ method: 'GET', path: '/api/modules', tag: 'Modules', summary: 'Modules and their state', access: 'session', response: z.array(ModuleSchema), status: 200 }),
  r({ method: 'POST', path: '/api/modules/{sku}', tag: 'Modules', summary: 'Turn a module on (charges the first month)', access: 'session', permission: 'settings:manage', response: ModuleChangeSchema, status: 200 }),
  r({ method: 'DELETE', path: '/api/modules/{sku}', tag: 'Modules', summary: 'Turn a module off at the end of the period', access: 'session', permission: 'settings:manage', response: ModuleChangeSchema, status: 200 }),
  r({ method: 'GET', path: '/api/modules/bbbee/spend', tag: 'Modules', summary: 'Recorded procurement spend', access: 'session', permission: 'modules:use', query: PeriodQuerySchema, response: z.array(SpendLineSchema), status: 200 }),
  r({ method: 'POST', path: '/api/modules/bbbee/spend', tag: 'Modules', summary: 'Record procurement spend', access: 'session', permission: 'modules:use', body: AddSpendSchema, response: z.array(SpendLineSchema), status: 201 }),
  r({ method: 'DELETE', path: '/api/modules/bbbee/spend/{id}', tag: 'Modules', summary: 'Delete a spend line', access: 'session', permission: 'modules:use', status: 204 }),
  r({ method: 'GET', path: '/api/modules/bbbee/scorecard', tag: 'Modules', summary: 'Preferential procurement for a period', access: 'session', permission: 'modules:use', query: PeriodQuerySchema, response: ScorecardSchema, status: 200 }),

  // --- Developers -----------------------------------------------------------------------
  r({ method: 'GET', path: '/api/developers/keys', tag: 'Developers', summary: 'API keys', access: 'session', permission: 'developers:manage', response: z.array(ApiKeySchema), status: 200 }),
  r({ method: 'POST', path: '/api/developers/keys', tag: 'Developers', summary: 'Create an API key (shown once)', access: 'session', permission: 'developers:manage', body: CreateApiKeySchema, response: CreatedApiKeySchema, status: 201 }),
  r({ method: 'DELETE', path: '/api/developers/keys/{id}', tag: 'Developers', summary: 'Revoke an API key', access: 'session', permission: 'developers:manage', status: 204 }),
  r({ method: 'GET', path: '/api/developers/webhooks', tag: 'Developers', summary: 'Webhook endpoints', access: 'session', permission: 'developers:manage', response: z.array(WebhookEndpointSchema), status: 200 }),
  r({ method: 'POST', path: '/api/developers/webhooks', tag: 'Developers', summary: 'Add an endpoint (secret shown once)', access: 'session', permission: 'developers:manage', body: CreateWebhookSchema, response: WebhookWithSecretSchema, status: 201 }),
  r({ method: 'PATCH', path: '/api/developers/webhooks/{id}', tag: 'Developers', summary: 'Change, pause or resume an endpoint', access: 'session', permission: 'developers:manage', body: UpdateWebhookSchema, response: WebhookEndpointSchema, status: 200 }),
  r({ method: 'POST', path: '/api/developers/webhooks/{id}/rotate-secret', tag: 'Developers', summary: 'New signing secret; the old one signs for 24 more hours', access: 'session', permission: 'developers:manage', response: WebhookWithSecretSchema, status: 200 }),
  r({ method: 'GET', path: '/api/developers/webhooks/{id}/deliveries', tag: 'Developers', summary: 'Delivery log', access: 'session', permission: 'developers:manage', query: DeliveryQuerySchema, response: DeliveryPageSchema, status: 200 }),
  r({ method: 'POST', path: '/api/developers/webhooks/{id}/deliveries/{deliveryId}/replay', tag: 'Developers', summary: 'Send a delivery again', access: 'session', permission: 'developers:manage', response: Ok, status: 202 }),

  // --- Compliance -----------------------------------------------------------------------
  r({ method: 'GET', path: '/api/compliance/consents', tag: 'Compliance', summary: 'Consent records', access: 'session', permission: 'compliance:read', query: ConsentListQuerySchema, response: ConsentPageSchema, status: 200 }),
  r({ method: 'POST', path: '/api/compliance/consents/{id}/withdraw', tag: 'Compliance', summary: 'Record a withdrawal of consent', access: 'session', permission: 'compliance:manage', body: WithdrawConsentSchema, response: ConsentSchema, status: 200 }),
  r({ method: 'GET', path: '/api/compliance/notices', tag: 'Compliance', summary: 'Privacy notices', access: 'session', permission: 'compliance:read', response: z.array(NoticeSchema), status: 200 }),
  r({ method: 'GET', path: '/api/compliance/processing', tag: 'Compliance', summary: 'Record of processing activities', access: 'session', permission: 'compliance:read', response: z.array(ProcessingActivitySchema), status: 200 }),
  r({ method: 'GET', path: '/api/compliance/requests', tag: 'Compliance', summary: 'Data-subject requests', access: 'session', permission: 'compliance:read', query: DsrListQuerySchema, response: DsrPageSchema, status: 200 }),
  r({ method: 'POST', path: '/api/compliance/requests', tag: 'Compliance', summary: 'Log a data-subject request (30-day clock)', access: 'session', permission: 'compliance:manage', body: CreateDsrSchema, response: DsrSchema, status: 201 }),
  r({ method: 'PATCH', path: '/api/compliance/requests/{id}', tag: 'Compliance', summary: 'Update a data-subject request', access: 'session', permission: 'compliance:manage', body: UpdateDsrSchema, response: DsrSchema, status: 200 }),
  r({ method: 'GET', path: '/api/audit', tag: 'Compliance', summary: 'Audit log (newest first)', access: 'session', permission: 'audit:read', query: AuditQuerySchema, response: AuditListSchema, status: 200 }),
  r({ method: 'POST', path: '/api/audit/verify', tag: 'Compliance', summary: 'Check the audit log’s hash chain', access: 'session', permission: 'audit:read', response: ChainVerificationSchema, status: 200 }),

  // --- Staff (M2; the console comes in M8) ----------------------------------------------
  r({ method: 'GET', path: '/api/staff/auth/csrf', tag: 'Staff', summary: 'Issue the staff CSRF cookie and token', access: 'public', response: CsrfView, status: 200 }),
  r({ method: 'POST', path: '/api/staff/auth/login', tag: 'Staff', summary: 'Staff sign-in', access: 'public', body: LoginSchema, status: 200 }),
  r({ method: 'POST', path: '/api/staff/auth/mfa', tag: 'Staff', summary: 'Staff MFA challenge', access: 'public', body: MfaChallengeSchema, status: 200 }),
  r({ method: 'GET', path: '/api/staff/auth/session', tag: 'Staff', summary: 'The signed-in staff member', access: 'staff', mfaSetupAllowed: true, status: 200 }),
  r({ method: 'POST', path: '/api/staff/auth/logout', tag: 'Staff', summary: 'Staff sign-out', access: 'public', status: 204 }),
  r({ method: 'POST', path: '/api/staff/auth/mfa/setup', tag: 'Staff', summary: 'Start staff MFA enrolment', access: 'staff', mfaSetupAllowed: true, status: 200 }),
  r({ method: 'POST', path: '/api/staff/auth/mfa/enable', tag: 'Staff', summary: 'Confirm staff MFA enrolment', access: 'staff', mfaSetupAllowed: true, body: MfaCodeSchema, status: 200 }),
  r({ method: 'POST', path: '/api/staff/auth/mfa/recovery-codes', tag: 'Staff', summary: 'Replace staff recovery codes', access: 'staff', body: PasswordConfirmSchema, status: 200 }),
];
