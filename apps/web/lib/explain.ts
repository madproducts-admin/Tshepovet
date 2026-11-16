/**
 * What each risk flag and warning means, and what to do about it, in plain words. A code with
 * no entry is shown with its own words (and should get an entry).
 */
export const FLAGS: Record<string, { title: string; action: string }> = {
  internal_error: { title: 'TshepoVet could not finish this check', action: 'You were not charged. Run it again in a few minutes.' },
  not_found_in_cached_registry_copy: { title: 'Not found in our copy of the register', action: 'Run a live check to ask CIPC directly.' },
  cipc_status_deregistered: { title: 'The company is deregistered', action: 'Do not pay it. A deregistered company cannot trade or contract.' },
  cipc_status_deregistration_process: { title: 'CIPC is deregistering the company', action: 'Usually for missed annual returns. Ask the supplier to file them before you pay.' },
  cipc_status_in_liquidation: { title: 'The company is in liquidation', action: 'Talk to your finance team before paying: a liquidator may control its money.' },
  cipc_status_voluntary_liquidation: { title: 'The company is being wound up voluntarily', action: 'Talk to your finance team before paying: a liquidator may control its money.' },
  cipc_status_business_rescue: { title: 'The company is in business rescue', action: 'You can still contract, but payments may be directed by the practitioner.' },
  cipc_status_reinstatement_process: { title: 'The company is being reinstated', action: 'It was deregistered and is applying to come back. Wait until it is in business again.' },
  cipc_status_ar_restoration: { title: 'The company is being restored after missed annual returns', action: 'Ask the supplier when restoration will be complete.' },
  cipc_status_dissolved: { title: 'The company is dissolved', action: 'Do not pay it: it no longer exists.' },
  company_younger_than_6_months: { title: 'Registered less than six months ago', action: 'New companies are a common route for fraud. Confirm who is behind it.' },
  close_corporation_after_2011: { title: 'A close corporation number issued after 2011', action: 'No new CCs could be registered after May 2011. Check the number with the supplier.' },
  unknown_entity_type_code: { title: 'The registration number has an unusual type code', action: 'Check the number against the supplier’s CIPC certificate.' },
  no_active_directors: { title: 'No active directors', action: 'A company needs a director to sign a contract. Ask who is authorised to act.' },
  director_appointed_within_30_days: { title: 'A director was appointed in the last 30 days', action: 'Recent changes in control come before many invoice frauds. Confirm the change with someone you know at the supplier.' },
  director_id_number_invalid: { title: 'A director’s ID number is not valid', action: 'Ask the supplier to correct it with CIPC.' },
  vat_number_not_registered: { title: 'The VAT number is not registered', action: 'Do not pay VAT to this supplier until it shows you a valid VAT registration.' },
  vat_number_registered_to_different_name: { title: 'The VAT number belongs to a different name', action: 'Ask the supplier why. It may be a group company, or someone else’s number.' },
  tcs_pin_not_recognised: { title: 'SARS does not recognise the PIN', action: 'Ask the supplier for a new tax compliance status PIN from eFiling.' },
  tcs_pin_expired: { title: 'The tax compliance PIN has expired', action: 'Ask the supplier for a new PIN.' },
  tcs_pin_revoked: { title: 'The supplier withdrew the PIN', action: 'Ask for a new PIN, and why the old one was withdrawn.' },
  sars_non_compliant: { title: 'Not tax compliant with SARS', action: 'Public-sector buyers may not award to it; others should ask the supplier to resolve it.' },
  tcs_taxpayer_name_mismatch: { title: 'The PIN belongs to a different taxpayer name', action: 'Make sure the supplier gave you its own PIN, not another company’s.' },
  licence_not_found: { title: 'No licence found for this ID number', action: 'Check the ID and licence numbers with the driver.' },
  licence_id_number_mismatch: { title: 'The licence belongs to a different ID number', action: 'Do not let the driver operate until this is explained.' },
  licence_code_insufficient: { title: 'The licence code does not cover the vehicle', action: 'Assign the driver to a vehicle the licence covers.' },
  licence_expired: { title: 'The licence has expired', action: 'The driver may not drive until it is renewed.' },
  licence_suspended: { title: 'The licence is suspended', action: 'The driver may not drive.' },
  licence_in_gazetted_grace_period: { title: 'Expired, but inside a gazetted grace period', action: 'Legal for now. Ask the driver to renew before the grace period ends.' },
  prdp_missing: { title: 'No professional driving permit', action: 'The driver needs a PrDP to drive goods or passengers for reward.' },
  prdp_category_insufficient: { title: 'The PrDP does not cover this work', action: 'Check the categories: G for goods, P for passengers, D for dangerous goods.' },
  prdp_expired: { title: 'The professional driving permit has expired', action: 'The driver may not drive for reward until it is renewed.' },
  prdp_d_holder_under_25: { title: 'A dangerous-goods PrDP held by someone under 25', action: 'The D category needs the holder to be 25 or older. Check the permit.' },
};

export const WARNINGS: Record<string, string> = {
  served_from_stale_cache: 'The bureaus could not be reached, so this is the last result we had. Run a live check later.',
  no_active_directors: 'The register lists no active directors.',
  director_id_number_invalid: 'One director’s ID number fails its check digit.',
  vat_vendor_name_mismatch: 'The VAT registration is in a different name from the company.',
  tcs_status_unknown: 'SARS did not say whether the taxpayer is compliant.',
  tcs_taxpayer_name_mismatch: 'The PIN’s taxpayer name differs from the company name.',
  licence_expiry_unknown: 'The traffic register did not give an expiry date.',
};

export const explainFlag = (code: string) => FLAGS[code] ?? { title: code.replace(/_/g, ' '), action: '' };
export const explainWarning = (code: string) => WARNINGS[code] ?? code.replace(/_/g, ' ');
