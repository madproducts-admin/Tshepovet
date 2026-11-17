import { describe, expect, it } from 'vitest';
import { VAT_RATE, vatRateFor, vatRegistered } from '../src/billing/topups';
import { loadConfig } from '../src/config';

/** The smallest valid environment: two 32-byte keys and a database. */
const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  KEK_KEYS: `1:${Buffer.alloc(32, 1).toString('base64')}`,
  BLIND_INDEX_ROOT_KEY: Buffer.alloc(32, 2).toString('base64'),
  API_KEY_PEPPER: Buffer.alloc(32, 3).toString('base64'),
};

describe('who runs TshepoVet (ECTA s43 and tax invoices)', () => {
  it('names MAD Products (Pty) Ltd trading as TshepoVet until told otherwise, and leaves the rest unset', () => {
    const c = loadConfig(BASE);
    expect([c.SELLER_LEGAL_NAME, c.SELLER_TRADING_NAME]).toEqual(['MAD Products (Pty) Ltd', 'TshepoVet']);
    expect([c.SELLER_REGISTRATION_NUMBER, c.SELLER_VAT_NUMBER, c.SELLER_ADDRESS]).toEqual([undefined, undefined, undefined]);
  });

  it('takes a CIPC registration number and a VAT number in their real shapes only', () => {
    const c = loadConfig({ ...BASE, SELLER_REGISTRATION_NUMBER: '2015/123456/07', SELLER_VAT_NUMBER: '4123456789' });
    expect([c.SELLER_REGISTRATION_NUMBER, c.SELLER_VAT_NUMBER]).toEqual(['2015/123456/07', '4123456789']);
    expect(() => loadConfig({ ...BASE, SELLER_REGISTRATION_NUMBER: '[CIPC Number]' })).toThrow(/CIPC registration number/);
    expect(() => loadConfig({ ...BASE, SELLER_VAT_NUMBER: '123' })).toThrow(/VAT number/);
    expect(() => loadConfig({ ...BASE, SELLER_LEGAL_NAME: '' })).toThrow(/SELLER_LEGAL_NAME/);
    expect(() => loadConfig({ ...BASE, SELLER_EMAIL: 'not an address' })).toThrow(/SELLER_EMAIL/);
    expect(() => loadConfig({ ...BASE, SELLER_PHONE: 'call us' })).toThrow(/telephone number/);
    expect(() => loadConfig({ ...BASE, SELLER_INFORMATION_REGULATOR_NUMBER: '66743' })).toThrow(/Information Regulator/);
    expect(loadConfig({ ...BASE, SELLER_PHONE: '+27 11 123 4567', SELLER_INFORMATION_REGULATOR_NUMBER: '2026-066743' }).SELLER_PHONE).toBe('+27 11 123 4567');
  });
});

describe('VAT follows registration (VAT Act s7: only a vendor may charge it)', () => {
  it('charges none until a VAT number is set, then 15%', () => {
    expect([vatRegistered(loadConfig(BASE)), vatRateFor(loadConfig(BASE))]).toEqual([false, 0]);
    const vendor = loadConfig({ ...BASE, SELLER_VAT_NUMBER: '4123456789' });
    expect([vatRegistered(vendor), vatRateFor(vendor)]).toEqual([true, VAT_RATE]);
    expect(VAT_RATE).toBe(0.15);
  });
});
