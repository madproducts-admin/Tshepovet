import type { TcsResult } from '../domain/sa/tax';

/**
 * Canonical capabilities. Bureaus bundle differently (most return directors
 * with the company enquiry; PrDP comes with the licence record), so bundled
 * data is modelled inside the parent capability's output.
 */
export type Capability =
  | 'company_registration'
  | 'vat_status'
  | 'tax_compliance_status'
  | 'driver_licence'
  | 'id_verification';

export interface CompanyQuery {
  enterpriseNumber: string;
}

export interface DirectorRecord {
  fullName: string;
  idNumber: string | null;
  idType: 'sa_id' | 'passport' | 'unknown';
  role: 'director' | 'alternate_director' | 'member' | 'board_member' | 'trustee' | 'company_secretary' | 'public_officer';
  status: 'active' | 'resigned' | 'removed' | 'deceased' | 'unknown';
  appointedOn: string | null;
  resignedOn: string | null;
}

export interface CompanyRecord {
  enterpriseNumber: string;
  legalName: string;
  statusRaw: string;
  incorporationDate: string | null;
  entityTypeDescription: string | null;
  registeredAddress: string | null;
  directors: DirectorRecord[];
}

export interface VatQuery {
  vatNumber: string;
}

export interface VatRecord {
  vatNumber: string;
  registered: boolean;
  vendorName: string | null;
  tradingName: string | null;
  effectiveDate: string | null;
}

export interface TcsQuery {
  taxReference: string;
  pin: string;
}

export interface LicenceQuery {
  idNumber: string;
  licenceNumber: string | null;
  surname: string | null;
}

export interface LicenceRecord {
  idNumber: string;
  surname: string | null;
  licenceNumber: string | null;
  codes: string[];
  issuedOn: string | null;
  expiresOn: string | null;
  restrictions: string[];
  status: 'valid' | 'expired' | 'suspended' | 'cancelled';
  prdp: { categories: string[]; expiresOn: string | null } | null;
}

export interface IdQuery {
  idNumber: string;
  surname: string | null;
}

export interface IdRecord {
  idNumber: string;
  surname: string | null;
  forenames: string | null;
  deceased: boolean;
  dhaStatus: 'valid' | 'blocked' | 'not_found';
}

export interface CapabilityIO {
  company_registration: { input: CompanyQuery; output: CompanyRecord };
  vat_status: { input: VatQuery; output: VatRecord };
  tax_compliance_status: { input: TcsQuery; output: TcsResult };
  driver_licence: { input: LicenceQuery; output: LicenceRecord };
  id_verification: { input: IdQuery; output: IdRecord };
}

export type InputOf<C extends Capability> = CapabilityIO[C]['input'];
export type OutputOf<C extends Capability> = CapabilityIO[C]['output'];

export type ProviderResult<T> =
  | { kind: 'found'; data: T; costCents?: number; raw?: unknown }
  | { kind: 'not_found'; costCents?: number; raw?: unknown };

export type ProviderFailureKind = 'timeout' | 'error_5xx' | 'error_4xx' | 'rate_limited';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderFailureKind,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** 4xx (other than 429) means our request is wrong - trying another bureau with it is still fine. */
  get countsAgainstHealth(): boolean {
    return this.kind !== 'error_4xx';
  }
}

export interface ProviderAdapter {
  readonly code: string;
  supports(capability: Capability): boolean;
  call<C extends Capability>(capability: C, input: InputOf<C>, signal: AbortSignal): Promise<ProviderResult<OutputOf<C>>>;
}
