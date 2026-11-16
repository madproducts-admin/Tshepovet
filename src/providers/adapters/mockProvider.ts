import type { TcsResult } from '../../domain/sa/tax';
import {
  Capability,
  CompanyRecord,
  InputOf,
  LicenceRecord,
  OutputOf,
  ProviderAdapter,
  ProviderError,
  ProviderResult,
  VatRecord,
  IdRecord,
} from '../types';

/**
 * Deterministic sandbox provider used by `tv_test_` API keys and the test
 * suite. Magic values (like card-network test numbers) trigger scenarios:
 *
 *   Enterprise number sequence  000404 -> not found
 *                               000500 -> provider 5xx (exercises failover)
 *                               000408 -> hangs until timeout
 *                               000777 -> "AR Deregistration Process"
 *                               000888 -> director appointed 10 days ago
 *   VAT 4000000404              -> not registered
 *   TCS PIN starting NC / EX / RV -> non-compliant / expired PIN / revoked PIN
 *   Licence number ending 0404 / 0410 / 0420 / 0430
 *                               -> not found / expired / PrDP expired / suspended
 */
export class MockProvider implements ProviderAdapter {
  constructor(
    readonly code: string = 'mock',
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(c: Capability): boolean {
    return ['company_registration', 'vat_status', 'tax_compliance_status', 'driver_licence', 'id_verification'].includes(c);
  }

  async call<C extends Capability>(capability: C, input: InputOf<C>, signal: AbortSignal): Promise<ProviderResult<OutputOf<C>>> {
    const r = await this.dispatch(capability, input, signal);
    return r as ProviderResult<OutputOf<C>>;
  }

  private dayOffset(days: number): string {
    const d = new Date(this.now().getTime() + days * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  private async dispatch(capability: Capability, input: unknown, signal: AbortSignal): Promise<ProviderResult<unknown>> {
    switch (capability) {
      case 'company_registration':
        return this.company((input as InputOf<'company_registration'>).enterpriseNumber, signal);
      case 'vat_status':
        return this.vat((input as InputOf<'vat_status'>).vatNumber);
      case 'tax_compliance_status':
        return this.tcs((input as InputOf<'tax_compliance_status'>).pin);
      case 'driver_licence':
        return this.licence(input as InputOf<'driver_licence'>);
      case 'id_verification': {
        const q = input as InputOf<'id_verification'>;
        const rec: IdRecord = { idNumber: q.idNumber, surname: q.surname, forenames: 'TEST', deceased: false, dhaStatus: 'valid' };
        return { kind: 'found', data: rec };
      }
    }
  }

  private async company(enterpriseNumber: string, signal: AbortSignal): Promise<ProviderResult<CompanyRecord>> {
    const [, seq, type] = enterpriseNumber.split('/');
    if (seq === '000404') return { kind: 'not_found' };
    if (seq === '000500') throw new ProviderError('error_5xx', 'mock upstream failure', 502);
    if (seq === '000408') {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderError('timeout', 'mock timeout')), { once: true });
      });
    }
    const isCc = type === '23';
    const record: CompanyRecord = {
      enterpriseNumber,
      legalName: enterpriseNumber === '2019/123456/07' ? 'ACME TRADING (PTY) LTD' : `MOCK ENTERPRISE ${seq} ${isCc ? 'CC' : '(PTY) LTD'}`,
      statusRaw: seq === '000777' ? 'AR Deregistration Process' : 'In Business',
      incorporationDate: `${enterpriseNumber.slice(0, 4)}-03-15`,
      entityTypeDescription: isCc ? 'Close Corporation' : 'Private Company',
      registeredAddress: '1 Commissioner Street, Johannesburg, 2001',
      directors: [
        {
          fullName: 'THANDI MOKOENA',
          idNumber: '8001015009087',
          idType: 'sa_id',
          role: isCc ? 'member' : 'director',
          status: 'active',
          appointedOn: seq === '000888' ? this.dayOffset(-10) : '2019-03-15',
          resignedOn: null,
        },
        {
          fullName: 'PIETER VAN DER MERWE',
          idNumber: '7506205009086',
          idType: 'sa_id',
          role: isCc ? 'member' : 'director',
          status: 'resigned',
          appointedOn: '2019-03-15',
          resignedOn: '2022-07-31',
        },
      ],
    };
    return { kind: 'found', data: record, costCents: 0 };
  }

  private vat(vatNumber: string): ProviderResult<VatRecord> {
    if (vatNumber === '4000000404') return { kind: 'not_found' };
    return {
      kind: 'found',
      data: {
        vatNumber,
        registered: true,
        vendorName: vatNumber === '4123456789' ? 'ACME TRADING (PTY) LTD' : `VAT VENDOR ${vatNumber.slice(-4)} (PTY) LTD`,
        tradingName: null,
        effectiveDate: '2019-06-01',
      },
    };
  }

  private tcs(pin: string): ProviderResult<TcsResult> {
    const checkedAt = this.now().toISOString();
    if (pin.startsWith('EX'))
      return { kind: 'found', data: { status: 'unknown', pinStatus: 'expired', pinExpiresOn: this.dayOffset(-3), taxpayerName: null, checkedAt } };
    if (pin.startsWith('RV'))
      return { kind: 'found', data: { status: 'unknown', pinStatus: 'revoked', pinExpiresOn: null, taxpayerName: null, checkedAt } };
    const status = pin.startsWith('NC') ? 'non_compliant' : 'compliant';
    return {
      kind: 'found',
      data: { status, pinStatus: 'active', pinExpiresOn: this.dayOffset(pin.startsWith('SOON') ? 10 : 200), taxpayerName: 'ACME TRADING (PTY) LTD', checkedAt },
    };
  }

  private licence(q: InputOf<'driver_licence'>): ProviderResult<LicenceRecord> {
    const ln = q.licenceNumber ?? '';
    if (ln.endsWith('0404')) return { kind: 'not_found' };
    const base: LicenceRecord = {
      idNumber: q.idNumber,
      surname: q.surname,
      licenceNumber: ln || null,
      codes: ['EC1'],
      issuedOn: this.dayOffset(-700),
      expiresOn: this.dayOffset(1125),
      restrictions: [],
      status: 'valid',
      prdp: { categories: ['G', 'P'], expiresOn: this.dayOffset(400) },
    };
    if (ln.endsWith('0410')) return { kind: 'found', data: { ...base, status: 'expired', expiresOn: this.dayOffset(-40) } };
    if (ln.endsWith('0420')) return { kind: 'found', data: { ...base, prdp: { categories: ['G'], expiresOn: this.dayOffset(-5) } } };
    if (ln.endsWith('0430')) return { kind: 'found', data: { ...base, status: 'suspended' } };
    return { kind: 'found', data: base };
  }
}
