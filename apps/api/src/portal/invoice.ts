import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * The invoice for a wallet top-up, as a PDF (docs/PLAN.md M9). While TshepoVet's operator is
 * not a VAT vendor (no VAT was charged) it is a plain invoice that says so; a top-up that carried
 * VAT gets a full tax invoice under the VAT Act s20(4): the words "Tax Invoice", the seller's
 * name, address and VAT number, the buyer's name (and VAT number when it has one), a serial
 * number, the date, a description, the value, the VAT and the total. Either way it names the
 * company's registration number (Companies Act s32(4)). In the sandbox it is overprinted as a
 * specimen: nothing was paid and it is not a valid invoice.
 *
 * Money is written the South African way (R1 250,00), by hand, as on the web pages.
 */
export interface InvoiceData {
  number: string;
  issuedAt: Date;
  /** A tax invoice (the top-up carried VAT) or a plain invoice. */
  taxInvoice: boolean;
  seller: { name: string; registrationNumber: string | null; address: string; vatNumber: string | null };
  buyer: { name: string; vatNumber: string | null };
  creditCents: number;
  vatCents: number;
  grossCents: number;
  vatRate: number;
  specimen: boolean;
}

const NBSP = ' ';
function rands(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${cents < 0 ? '-' : ''}R${whole},${String(abs % 100).padStart(2, '0')}`;
}
const day = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });

export async function renderInvoice(d: InvoiceData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const kind = d.taxInvoice ? (d.specimen ? 'Specimen tax invoice' : 'Tax Invoice') : d.specimen ? 'Specimen invoice' : 'Invoice';
  const title = `${kind} ${d.number}`;
  pdf.setTitle(title, { showInWindowTitleBar: true });
  pdf.setAuthor(d.seller.name);
  pdf.setSubject(`TshepoVet wallet top-up for ${d.buyer.name}`);
  pdf.setLanguage('en-ZA');
  pdf.setCreator('TshepoVet');
  pdf.setCreationDate(d.issuedAt);

  const page = pdf.addPage([595.28, 841.89]); // A4
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.063, 0.141, 0.173); // #10242c
  const ink2 = rgb(0.227, 0.31, 0.341); // #3a4f57
  const rule = rgb(0.776, 0.824, 0.808);
  const left = 56;
  const right = 595.28 - 56;
  let y = 841.89 - 64;

  const text = (s: string, x: number, size = 11, font = regular, color = ink) => page.drawText(s, { x, y, size, font, color });
  const rightText = (s: string, size = 11, font = regular) => page.drawText(s, { x: right - font.widthOfTextAtSize(s, size), y, size, font, color: ink });
  const line = () => page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.75, color: rule });

  if (d.specimen) {
    page.drawText('SPECIMEN', { x: 120, y: 330, size: 96, font: bold, color: rgb(0.42, 0.247, 0), opacity: 0.12, rotate: degrees(30) });
  }

  text(kind, left, 24, bold);
  y -= 22;
  if (d.specimen) {
    text(`Sandbox: nothing was paid. This is not a valid ${d.taxInvoice ? 'tax invoice' : 'invoice'}.`, left, 11, bold, rgb(0.42, 0.247, 0));
    y -= 16;
  }
  y -= 14;

  // Seller and invoice details, side by side.
  const top = y;
  text(d.seller.name, left, 12, bold);
  y -= 16;
  if (d.seller.registrationNumber) {
    text(`Registration number ${d.seller.registrationNumber}`, left, 10, regular, ink2);
    y -= 13;
  }
  for (const l of d.seller.address.split(/\s*\n\s*|,\s*/).filter(Boolean)) {
    text(l, left, 10, regular, ink2);
    y -= 13;
  }
  text(d.taxInvoice ? `VAT number ${d.seller.vatNumber ?? 'not set'}` : 'Not registered for VAT: no VAT is charged', left, 10, regular, ink2);
  const sellerEnd = y;
  y = top;
  rightText(`Invoice ${d.number}`, 12, bold);
  y -= 16;
  rightText(`Date ${day.format(d.issuedAt)}`, 10);
  y = Math.min(sellerEnd, y) - 30;

  text('To', left, 10, bold, ink2);
  y -= 15;
  text(d.buyer.name, left, 12, bold);
  y -= 15;
  if (d.buyer.vatNumber) {
    text(`VAT number ${d.buyer.vatNumber}`, left, 10, regular, ink2);
    y -= 15;
  }
  y -= 20;

  // The line, then the totals.
  text('Description', left, 10, bold, ink2);
  rightText(d.taxInvoice ? 'Amount (excl. VAT)' : 'Amount', 10, bold);
  y -= 8;
  line();
  y -= 18;
  text('Prepaid TshepoVet credit for supplier checks and modules', left, 11);
  rightText(rands(d.creditCents), 11);
  y -= 14;
  line();
  y -= 22;
  const totals: Array<[string, number, boolean]> = d.taxInvoice
    ? [
        ['Total excluding VAT', d.creditCents, false],
        [`VAT at ${Math.round(d.vatRate * 100)}%`, d.vatCents, false],
        ['Total including VAT', d.grossCents, true],
      ]
    : [['Total', d.grossCents, true]];
  for (const [label, cents, strong] of totals) {
    page.drawText(label, { x: right - 260, y, size: strong ? 12 : 11, font: strong ? bold : regular, color: ink });
    rightText(rands(cents), strong ? 12 : 11, strong ? bold : regular);
    y -= strong ? 20 : 16;
  }
  y -= 24;
  text('Amounts are in South African rand. The credit is used for checks and modules at the prices in force on the day.', left, 9, regular, ink2);
  return pdf.save();
}
