/**
 * South African reference values the contracts need. They live here, not in @tshepovet/core,
 * so the contracts stay free of server code and the web app can import them in the browser.
 * test/domain-parity.test.ts keeps them equal to the domain's own lists.
 */
export const LICENCE_CODES = ['A1', 'A', 'B', 'EB', 'C1', 'C', 'EC1', 'EC'] as const;
export type LicenceCode = (typeof LICENCE_CODES)[number];

export const PRDP_CATEGORIES = ['G', 'P', 'D'] as const;
export type PrdpCategory = (typeof PRDP_CATEGORIES)[number];
