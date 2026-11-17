import type { Meta } from '@/lib/server';

/** An abbreviation with its expansion for screen readers (WCAG 3.1.4), as <Term> does for the glossary. */
function Short({ expansion, children }: { expansion: string; children: string }) {
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
 * (SELLER_REGISTRATION_NUMBER, SELLER_VAT_NUMBER, SELLER_ADDRESS) shows its bracketed placeholder.
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
          <Short expansion="Value-added tax registration number">VAT No</Short>: {seller.vat_number ?? '[SARS VAT Number]'}
        </li>
        <li>
          <Bar />
          {seller.address ?? '[Physical Address]'}
        </li>
      </ul>
    </address>
  );
}
