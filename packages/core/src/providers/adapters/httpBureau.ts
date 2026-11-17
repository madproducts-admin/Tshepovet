import { Capability, InputOf, OutputOf, ProviderAdapter, ProviderError, ProviderResult } from '../types';

/**
 * Generic JSON-over-HTTPS bureau adapter. Each bureau (XDS, CPB, SearchWorks,
 * VerifyID, ...) is described by a `BureauSpec`: where to send a request for
 * a capability and how to map the response to the canonical model.
 *
 * IMPORTANT: endpoint paths and field names below are integration
 * placeholders. Bureau APIs are contract-gated; replace each `request` /
 * `map` pair from the bureau's signed integration guide and record the
 * product codes in provider_capabilities. Keep the mapping pure so it can be
 * unit-tested against recorded (anonymised) fixtures.
 */
export interface CapabilitySpec<C extends Capability> {
  request(input: InputOf<C>): { method: 'GET' | 'POST'; path: string; body?: unknown };
  /** Return null for "no record". Throw for malformed payloads. */
  map(json: unknown, input: InputOf<C>): OutputOf<C> | null;
  /** Some bureaus bill per enquiry and report it; otherwise contract cost is used. */
  cost?(json: unknown): number | undefined;
}

export interface BureauSpec {
  code: string;
  baseUrl: string;
  authHeaders(): Record<string, string>;
  capabilities: { [C in Capability]?: CapabilitySpec<C> };
}

export class HttpBureauAdapter implements ProviderAdapter {
  readonly code: string;

  constructor(
    private readonly spec: BureauSpec,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.code = spec.code;
  }

  supports(capability: Capability): boolean {
    return Boolean(this.spec.capabilities[capability]);
  }

  async call<C extends Capability>(capability: C, input: InputOf<C>, signal: AbortSignal): Promise<ProviderResult<OutputOf<C>>> {
    const cap = this.spec.capabilities[capability] as CapabilitySpec<C> | undefined;
    if (!cap) throw new ProviderError('error_4xx', `${this.code} does not support ${capability}`);
    const req = cap.request(input);

    let res: Response;
    try {
      res = await this.fetchImpl(new URL(req.path, this.spec.baseUrl), {
        method: req.method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...this.spec.authHeaders() },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderError('timeout', `${this.code} timed out`);
      throw new ProviderError('error_5xx', `${this.code} network error: ${(err as Error).message}`);
    }

    if (res.status === 404) return { kind: 'not_found' };
    if (res.status === 429) throw new ProviderError('rate_limited', `${this.code} rate limited`, 429);
    if (res.status >= 500) throw new ProviderError('error_5xx', `${this.code} returned ${res.status}`, res.status);
    if (res.status >= 400) throw new ProviderError('error_4xx', `${this.code} returned ${res.status}`, res.status);

    const json: unknown = await res.json();
    const data = cap.map(json, input);
    const costCents = cap.cost?.(json);
    return data === null ? { kind: 'not_found', costCents, raw: json } : { kind: 'found', data, costCents, raw: json };
  }
}

// ---------------------------------------------------------------------------
// Bureau specs. Mappings are written defensively against a typical shape and
// MUST be replaced with the contracted schema before enabling a provider.
// ---------------------------------------------------------------------------

type J = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);

function mapCompany(json: unknown, enterpriseNumber: string): OutputOf<'company_registration'> | null {
  const j = json as J;
  const c = (j.company ?? j.Company ?? j.result ?? j) as J;
  const name = str(c.name ?? c.CompanyName ?? c.legalName);
  if (!name) return null;
  return {
    enterpriseNumber,
    legalName: name,
    statusRaw: str(c.status ?? c.CompanyStatus) ?? 'unknown',
    incorporationDate: str(c.registrationDate ?? c.RegistrationDate ?? c.incorporationDate),
    entityTypeDescription: str(c.type ?? c.CompanyType),
    registeredAddress: str(c.registeredAddress ?? c.PhysicalAddress),
    directors: arr(c.directors ?? c.Directors).map((d) => ({
      fullName: [str(d.firstNames ?? d.FirstName), str(d.surname ?? d.Surname)].filter(Boolean).join(' ') || (str(d.fullName) ?? 'UNKNOWN'),
      idNumber: str(d.idNumber ?? d.IDNumber),
      idType: str(d.idNumber ?? d.IDNumber)?.match(/^\d{13}$/) ? 'sa_id' : 'unknown',
      role: /member/i.test(String(d.type ?? d.DirectorType ?? '')) ? 'member' : 'director',
      status: /resign/i.test(String(d.status ?? d.DirectorStatus ?? '')) ? 'resigned' : /active/i.test(String(d.status ?? d.DirectorStatus ?? '')) ? 'active' : 'unknown',
      appointedOn: str(d.appointmentDate ?? d.AppointmentDate),
      resignedOn: str(d.resignationDate ?? d.ResignationDate),
    })),
  };
}

export function bureauSpecsFromEnv(env: NodeJS.ProcessEnv): BureauSpec[] {
  const specs: BureauSpec[] = [];
  const bearer = (key?: string) => () => ({ authorization: `Bearer ${key ?? ''}` });

  if (env.CPB_BASE_URL) {
    specs.push({
      code: 'cpb',
      baseUrl: env.CPB_BASE_URL,
      authHeaders: bearer(env.CPB_API_KEY),
      capabilities: {
        company_registration: {
          request: (q) => ({ method: 'POST', path: '/v1/company/enquiry', body: { registrationNumber: q.enterpriseNumber, includeDirectors: true } }),
          map: (json, q) => mapCompany(json, q.enterpriseNumber),
        },
      },
    });
  }
  if (env.XDS_BASE_URL) {
    specs.push({
      code: 'xds',
      baseUrl: env.XDS_BASE_URL,
      authHeaders: bearer(env.XDS_API_KEY),
      capabilities: {
        company_registration: {
          request: (q) => ({ method: 'POST', path: '/commercial/business-enquiry', body: { RegistrationNo: q.enterpriseNumber } }),
          map: (json, q) => mapCompany(json, q.enterpriseNumber),
        },
        vat_status: {
          request: (q) => ({ method: 'GET', path: `/commercial/vat/${encodeURIComponent(q.vatNumber)}` }),
          map: (json, q) => {
            const j = json as J;
            if (j.registered === undefined && j.VatRegistered === undefined) return null;
            return {
              vatNumber: q.vatNumber,
              registered: Boolean(j.registered ?? j.VatRegistered),
              vendorName: str(j.vendorName ?? j.VendorName),
              tradingName: str(j.tradingName ?? j.TradingName),
              effectiveDate: str(j.effectiveDate ?? j.EffectiveDate),
            };
          },
        },
      },
    });
  }
  if (env.SEARCHWORKS_BASE_URL) {
    specs.push({
      code: 'searchworks',
      baseUrl: env.SEARCHWORKS_BASE_URL,
      authHeaders: bearer(env.SEARCHWORKS_API_KEY),
      capabilities: {
        company_registration: {
          request: (q) => ({ method: 'POST', path: '/api/cipc/company', body: { registrationNumber: q.enterpriseNumber } }),
          map: (json, q) => mapCompany(json, q.enterpriseNumber),
        },
        vat_status: {
          request: (q) => ({ method: 'POST', path: '/api/sars/vat', body: { vatNumber: q.vatNumber } }),
          map: (json, q) => {
            const j = json as J;
            const name = str(j.vendorName);
            return name ? { vatNumber: q.vatNumber, registered: j.status === 'ACTIVE', vendorName: name, tradingName: str(j.tradingName), effectiveDate: str(j.effectiveDate) } : null;
          },
        },
      },
    });
  }
  if (env.VERIFYID_BASE_URL) {
    specs.push({
      code: 'verifyid',
      baseUrl: env.VERIFYID_BASE_URL,
      authHeaders: bearer(env.VERIFYID_API_KEY),
      capabilities: {
        driver_licence: {
          request: (q) => ({ method: 'POST', path: '/api/v1/licence/verify', body: { idNumber: q.idNumber, licenceNumber: q.licenceNumber } }),
          map: (json, q) => {
            const j = json as J;
            const l = (j.licence ?? j) as J;
            if (!l || (l.found === false)) return null;
            const status = String(l.status ?? 'valid').toLowerCase();
            const prdp = l.prdp as J | undefined;
            return {
              idNumber: q.idNumber,
              surname: str(l.surname),
              licenceNumber: str(l.licenceNumber) ?? q.licenceNumber,
              codes: Array.isArray(l.codes) ? (l.codes as unknown[]).map(String) : [],
              issuedOn: str(l.issueDate),
              expiresOn: str(l.expiryDate),
              restrictions: Array.isArray(l.restrictions) ? (l.restrictions as unknown[]).map(String) : [],
              status: (['valid', 'expired', 'suspended', 'cancelled'].includes(status) ? status : 'valid') as 'valid',
              prdp: prdp ? { categories: Array.isArray(prdp.categories) ? (prdp.categories as unknown[]).map(String) : [], expiresOn: str(prdp.expiryDate) } : null,
            };
          },
        },
        id_verification: {
          request: (q) => ({ method: 'POST', path: '/api/v1/dha/verify', body: { idNumber: q.idNumber } }),
          map: (json, q) => {
            const j = json as J;
            if (j.found === false) return null;
            return { idNumber: q.idNumber, surname: str(j.surname), forenames: str(j.forenames), deceased: Boolean(j.deceased), dhaStatus: j.blocked ? 'blocked' : 'valid' };
          },
        },
      },
    });
  }
  // TCS: no bureau capability is wired by default. SARS exposes TCS
  // verification through eFiling to authorised eFilers; see
  // docs/03-popia-sars-compliance.md for the assisted/async channel design.
  return specs;
}
