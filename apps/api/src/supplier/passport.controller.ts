import crypto from 'node:crypto';
import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '@tshepovet/core';
import { PassportVerifyRequestSchema, type PublicPassport } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { utcInstants } from '../portal/tenant';

interface PassportRow {
  status: string;
  public_id: string;
  fields: string[];
  legal_name: string;
  registration_number: string | null;
  cipc_status: string | null;
  verified_at: string | null;
  vat_registered: boolean;
  tcs: { status: string | null; expires_on: string | null; checked_at: string | null } | null;
  bbbee: { level: number | null; valid_until: string } | null;
  directors: string[];
}

/**
 * The public Verified Vendor Passport (no sign-in). It shows only the facts the supplier chose,
 * only while the supplier keeps it published; withdrawn, it answers 410 Gone.
 *
 * A paper copy carries a verification code: the passport id, the date it was verified and a
 * signature over both (keyed from the platform's blind-index root). POST /verify tells anyone
 * holding a printout whether it is genuine, and whether the facts on it are still current.
 */
@Controller('api/passport')
export class PassportController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private signature(publicId: string, day: string): string {
    return this.c.crypto.blindIndex('subject', `passport|${publicId}|${day}`, 'passport-signature').toString('hex').slice(0, 12).toUpperCase();
  }

  private code(publicId: string, verifiedAt: string | null): string {
    const day = (verifiedAt ?? '').slice(0, 10).replace(/-/g, '') || '00000000';
    return `${publicId.toUpperCase()}-${day}-${this.signature(publicId, day)}`;
  }

  private async load(publicId: string): Promise<PassportRow | null> {
    if (!/^[0-9a-f]{24}$/i.test(publicId)) return null;
    const r = await this.c.pool.query<{ p: PassportRow | null }>(`SELECT passport_public_view($1) AS p`, [publicId.toLowerCase()]);
    // JSON from the database carries the session's time-zone offset: normalise instants to UTC.
    return utcInstants(r.rows[0]?.p ?? null);
  }

  /** A GET: the code is printed on paper for anyone to read, so it is no secret in a URL. Declared
   *  before :publicId, which would otherwise take "verify" as an id. */
  @Get('verify')
  async verify(@Req() req: Request) {
    const { code } = PassportVerifyRequestSchema.parse(req.query);
    const m = /^([0-9A-F]{24})-(\d{8})-([0-9A-F]{12})$/.exec(code.replace(/\s+/g, '').toUpperCase());
    const none = { genuine: false, current: false, status: 'unknown' as const, legal_name: null, printed_verified_at: null, public_id: null };
    if (!m) return none;
    const [, id, day, sig] = m as unknown as [string, string, string, string];
    const expected = Buffer.from(this.signature(id.toLowerCase(), day));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return none;
    const p = await this.load(id);
    const printed = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
    if (!p || p.status !== 'active') return { genuine: true, current: false, status: 'withdrawn' as const, legal_name: null, printed_verified_at: printed, public_id: id.toLowerCase() };
    const currentDay = (p.verified_at ?? '').slice(0, 10).replace(/-/g, '');
    return { genuine: true, current: currentDay === day, status: 'active' as const, legal_name: p.legal_name, printed_verified_at: printed, public_id: p.public_id };
  }

  @Get(':publicId')
  async view(@Param('publicId') publicId: string): Promise<PublicPassport> {
    const p = await this.load(publicId);
    if (!p) throw new ApiError(404, 'not_found', 'There is no passport at this address. Check the link or the code.');
    if (p.status !== 'active') throw new ApiError(410, 'passport_withdrawn', 'The supplier has withdrawn this passport. Ask them for their current details.');
    const show = (f: string) => p.fields.includes(f);
    return {
      public_id: p.public_id,
      legal_name: show('legal_name') ? p.legal_name : null,
      registration_number: show('registration_number') ? p.registration_number : null,
      cipc_status: show('cipc_status') ? p.cipc_status : null,
      vat_registered: show('vat_status') ? p.vat_registered : null,
      tcs: show('tcs_status') ? p.tcs : null,
      bbbee: show('bbbee_level') ? p.bbbee : null,
      directors: show('directors_initials') ? p.directors : null,
      verified_at: show('verified_at') ? p.verified_at : null,
      verification_code: this.code(p.public_id, p.verified_at),
    };
  }

}
