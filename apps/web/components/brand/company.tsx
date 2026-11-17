import type { ReactNode } from 'react';
import type { Meta } from '@/lib/server';

/** An abbreviation with its expansion for screen readers (WCAG 3.1.4), as <Term> does for the glossary. */
export function Short({ expansion, children }: { expansion: string; children: string }) {
  return (
    <>
      <abbr title={expansion}>{children}</abbr>
      <span className="sr-only"> ({expansion})</span>
    </>
  );
}

const Bar = () => (
  <span aria-hidden="true" className="px-2">
    |
  </span>
);

/**
 * Who runs TshepoVet, as the Electronic Communications and Transactions Act (s43) asks a website
 * to say, in the owner's words (2026-11-17): "MAD Products (Pty) Ltd t/a TshepoVet | Reg No:
 * [CIPC Number] | VAT No: [SARS VAT Number] | [Physical Address]". A detail not configured yet
 * (SELLER_REGISTRATION_NUMBER, SELLER_ADDRESS) shows its bracketed placeholder; with no VAT
 * number the operator is not a VAT vendor (the owner: "We are not VAT registered yet"), and the
 * line says so.
 */
export function CompanyDisclosure({ seller, className }: { seller: Meta['seller']; className?: string }) {
  return (
    <address className={`not-italic ${className ?? ''}`}>
      <ul className="flex flex-wrap gap-y-1">
        <li>
          {seller.legal_name} <Short expansion="trading as">t/a</Short> {seller.trading_name}
        </li>
        <li>
          <Bar />
          <Short expansion="Company registration number">Reg No</Short>: {seller.registration_number ?? '[CIPC Number]'}
        </li>
        <li>
          <Bar />
          {seller.vat_number ? (
            <>
              <Short expansion="Value-added tax registration number">VAT No</Short>: {seller.vat_number}
            </>
          ) : (
            <>
              Not registered for <Short expansion="Value-added tax">VAT</Short>
            </>
          )}
        </li>
        <li>
          <Bar />
          {seller.address ?? '[Physical Address]'}
        </li>
      </ul>
    </address>
  );
}

/**
 * The rest of ECTA s43 for the terms (the owner, 2026-11-17: "do what you think is best"): legal
 * status and place of registration, the address for legal notices, the directors, contact details
 * and the website. Contact details not configured yet show a bracketed placeholder.
 */
export function CompanyDetails({ seller }: { seller: Meta['seller'] }) {
  const rows: Array<[string, ReactNode]> = [
    ['Registered name', `${seller.legal_name}, a private company registered in South Africa with the Companies and Intellectual Property Commission`],
    ['Registration number', seller.registration_number ?? '[CIPC Number]'],
    ['Registered office, also for legal notices', seller.address ?? '[Physical Address]'],
    [seller.directors.length === 1 ? 'Director' : 'Directors', seller.directors.length ? seller.directors.join(', ') : '[Directors]'],
    ['Value-added tax', seller.vat_number ? `Registered, number ${seller.vat_number}` : 'Not registered, so none is charged'],
    ['Email', seller.email ? <a href={`mailto:${seller.email}`}>{seller.email}</a> : '[Email address]'],
    ['Telephone', seller.phone ? <a href={`tel:${seller.phone.replace(/[^+0-9]/g, '')}`}>{seller.phone}</a> : '[Telephone number]'],
    ['Website', <a key="w" href={seller.website}>{seller.website.replace(/^https?:\/\//, '')}</a>],
  ];
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 text-lg sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-semibold">{k}</dt>
          <dd className="mb-2 sm:mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
