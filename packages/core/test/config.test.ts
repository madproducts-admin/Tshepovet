import { describe, expect, it } from 'vitest';
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
  });
});
