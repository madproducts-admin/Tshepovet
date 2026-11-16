/**
 * The words of South African compliance, explained (WCAG 3.1.3 unusual words and 3.1.4
 * abbreviations). <Term> expands them in place for screen readers; /glossary lists them all.
 */
export const GLOSSARY = {
  AVS: { expansion: 'Account verification service', explanation: 'A bank’s check that an account number belongs to the named business and is open.' },
  'B-BBEE': {
    expansion: 'Broad-Based Black Economic Empowerment',
    explanation: 'South Africa’s framework for economic inclusion. A supplier’s level (1 to 8) decides how much of your spend with it counts towards your own scorecard.',
  },
  CIDB: { expansion: 'Construction Industry Development Board', explanation: 'Grades construction contractors by the size and type of work they may take on.' },
  CIPC: { expansion: 'Companies and Intellectual Property Commission', explanation: 'The register of South African companies and close corporations, and their directors.' },
  COIDA: {
    expansion: 'Compensation for Occupational Injuries and Diseases Act',
    explanation: 'Employers register with the Compensation Fund; a letter of good standing shows they are paid up.',
  },
  CSD: { expansion: 'Central Supplier Database', explanation: 'National Treasury’s register of suppliers to government. Public-sector buyers need a supplier’s CSD number.' },
  DSR: { expansion: 'Data-subject request', explanation: 'A person asking to see, correct or delete their personal information, or objecting to its use. POPIA gives you 30 days to answer.' },
  EME: { expansion: 'Exempted micro enterprise', explanation: 'A business with annual turnover up to R10 million. It proves its B-BBEE level with an affidavit.' },
  KYB: { expansion: 'Know your business', explanation: 'Checking that a company is real, registered, run by the people it says, and in good standing.' },
  PAIA: { expansion: 'Promotion of Access to Information Act', explanation: 'The law under which anyone may ask an organisation for records it holds.' },
  POPIA: { expansion: 'Protection of Personal Information Act', explanation: 'South Africa’s data protection law. It decides what may be collected, why, for how long, and who may see it.' },
  PrDP: { expansion: 'Professional driving permit', explanation: 'Needed, as well as a licence, to drive goods (G), passengers (P) or dangerous goods (D) for reward.' },
  QSE: { expansion: 'Qualifying small enterprise', explanation: 'A business with annual turnover between R10 million and R50 million.' },
  SARS: { expansion: 'South African Revenue Service', explanation: 'The tax authority. It issues tax compliance status PINs.' },
  TCS: {
    expansion: 'Tax compliance status',
    explanation: 'Whether a taxpayer is up to date with SARS. The supplier shares a PIN that lets you check it, live, until the PIN expires.',
  },
  VAT: { expansion: 'Value-added tax', explanation: '15% in South Africa. A VAT-registered supplier’s number starts with 4 and has 10 digits.' },
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
