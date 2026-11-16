import type { MessageKey } from './stateMachine';

/**
 * Message copy. English is the source; other official languages (isiZulu,
 * isiXhosa, Afrikaans, Sesotho, Setswana, ...) must be produced by
 * professional translators and legally reviewed - the consent text especially,
 * because consent must be "informed" (POPIA s1).
 */
export const EN: Record<MessageKey, string> = {
  consent_request:
    'Hi! {buyer} uses TshepoVet to onboard suppliers. We will ask for your company details, an ID document and, if required, B-BBEE and tax compliance documents, and check them with CIPC, SARS and licensed data bureaus.\n\nPhotos are read by automated software and deleted within 30 days. Reply STOP at any time.\nFull notice: https://tshepovet.co.za/privacy\n\nDo you agree?',
  consent_more_info:
    'Who: {buyer} is responsible for your information; TshepoVet processes it on their behalf.\nWhy: to confirm your business is real, active and compliant before you are paid.\nWhat: company registration, directors, ID, tax status, B-BBEE documents.\nYour rights: access, correction, objection, and complaints to the Information Regulator (inforeg.org.za).',
  opted_out: 'Understood - we have stopped. Your information will not be processed further. Reply START if you change your mind.',
  ask_entity_type: 'What type of business are you?',
  ask_reg_number: 'Please type your CIPC registration number, e.g. 2019/123456/07.',
  reg_number_invalid: "That doesn't look like a CIPC number. It has the form YYYY/NNNNNN/NN, e.g. 2019/123456/07 - you'll find it on your CoR14.3 certificate.",
  company_confirm: 'We found *{name}* ({status}). Is this your business?',
  company_not_found: "We couldn't find that number at CIPC. Please check it and type it again.",
  ask_id_document:
    'Please send a photo of your ID: the FRONT of your Smart ID card, or the photo page of your green ID book.\n\nTip: lay it flat, good light, no glare. For best quality, send it as a *Document* (tap the paperclip -> Document) rather than a photo.',
  ask_driver_licence: 'Please send a photo of the FRONT of your driving licence card.',
  ask_bbbee_choice: 'Which B-BBEE document do you have? (Small businesses under R10m turnover can use a sworn affidavit.)',
  ask_bbbee_document: 'Please send your B-BBEE document (photo or PDF). All pages, including the Commissioner of Oaths stamp.',
  ask_tcs_pin: 'Last step: your SARS Tax Compliance Status PIN (from eFiling -> Tax Compliance Status). For your security, please enter it using this link:',
  tcs_looks_like_tax_number: 'That looks like your tax or VAT reference number, not the TCS PIN. The PIN is on your eFiling Tax Compliance Status page.',
  ask_tax_reference: 'Please type the SARS income tax reference number the PIN belongs to (10 digits).',
  tax_reference_invalid: 'Income tax reference numbers are 10 digits and start with 0, 1, 2, 3 or 9. Please check and type it again.',
  tcs_pin_in_chat_warning: 'Thanks - received. Next time you can use the secure link so the PIN does not stay in your chat history.',
  processing_document: 'Got it - reading your document...',
  retake_photo: "We couldn't read that clearly ({detail}). Please retake it: flat surface, good light, all four corners visible.",
  wrong_document: "That looks like a different document ({detail}). Please send the one requested.",
  not_a_director:
    "Note: you are not listed as a director of {company}. That's OK if you are authorised to act for the business - {buyer}'s team may ask for a letter of authority.",
  unsupported_media: 'Please send a photo (JPG/PNG) or a PDF under 16 MB.',
  review_summary: 'Please confirm:\nBusiness: {company}\nID: {id}\n\nSubmit for verification?',
  submitted: 'Submitted! We are verifying your details now - this usually takes a minute.',
  result: 'Verification complete: {outcome}.\nYour Verified Vendor Passport: {passport}\nShare it with other buyers so they can onboard you instantly.',
  handoff: 'A person from our team will help you shortly.',
  please_wait: 'One moment please...',
};

export function render(key: MessageKey, vars: Record<string, string> = {}): string {
  return EN[key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
