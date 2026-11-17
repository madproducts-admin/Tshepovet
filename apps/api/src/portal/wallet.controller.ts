import { randomUUID } from 'node:crypto';
import { Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError, settleSandboxTopup, vatRateFor } from '@tshepovet/core';
import { LedgerQuerySchema, TopupRequestSchema, UpdateWalletSchema } from '@tshepovet/contracts';
import { CONTAINER, type Container } from '../container';
import { PortalGuard, RequirePermission } from './guards';
import { renderInvoice } from './invoice';
import { auditBy, inTenant, me, notFound, pageOf, sendCsv, uuidParam, Where } from './tenant';

const TOPUP_COLUMNS = `id, credit_cents, vat_cents, gross_cents, status, payment_provider, tax_invoice_number, created_at`;

/** Movements of the customer's wallet account: positive adds credit, negative spends it. */
function ledger(q: z.infer<typeof LedgerQuerySchema>) {
  const w = new Where();
  if (q.kind) w.add(`t.kind = ?`, q.kind);
  if (q.from) w.add(`t.created_at >= ?::date`, q.from);
  if (q.to) w.add(`t.created_at < ?::date + 1`, q.to);
  const from = `FROM ledger_transactions t
                JOIN ledger_entries e ON e.transaction_id = t.id
                JOIN wallets wl ON wl.ledger_account_id = e.account_id`;
  return { w, from };
}

/**
 * The prepaid wallet over the double-entry ledger (packages/core billing/wallet.ts). Money is
 * VAT-exclusive credit; once TshepoVet is a VAT vendor a top-up's tax invoice carries the VAT on
 * top (until then there is none: vatRateFor).
 */
@Controller('api/wallet')
@UseGuards(PortalGuard)
export class WalletController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  private async view(client: PoolClient, tenantId: string) {
    const r = await client.query<{
      balance_cents: number;
      held_cents: number;
      credit_limit_cents: number;
      low_balance_threshold_cents: number;
      status: 'active' | 'frozen';
    }>(`SELECT balance_cents, held_cents, credit_limit_cents, low_balance_threshold_cents, status FROM wallets WHERE tenant_id = $1`, [tenantId]);
    const w = r.rows[0];
    if (!w) throw new ApiError(404, 'not_found', 'This organisation has no wallet yet.');
    const available = w.balance_cents - w.held_cents + w.credit_limit_cents;
    return { currency: 'ZAR' as const, ...w, available_cents: available, low_balance: available < w.low_balance_threshold_cents, sandbox: this.c.config.SANDBOX === 'true' };
  }

  @Get()
  @RequirePermission('wallet:read')
  async get(@Req() req: Request) {
    return inTenant(this.c, req, (client) => this.view(client, me(req).tenantId));
  }

  @Patch()
  @RequirePermission('wallet:topup')
  async update(@Req() req: Request) {
    const b = UpdateWalletSchema.parse(req.body);
    return inTenant(this.c, req, async (client) => {
      await client.query(`UPDATE wallets SET low_balance_threshold_cents = $2, low_balance_notified_at = NULL, updated_at = now() WHERE tenant_id = $1`, [
        me(req).tenantId,
        b.low_balance_threshold_cents,
      ]);
      await auditBy(client, req, { action: 'wallet.threshold_changed', entityType: 'wallet', entityId: me(req).tenantId, details: b });
      return this.view(client, me(req).tenantId);
    });
  }

  @Get('holds')
  @RequirePermission('wallet:read')
  async holds(@Req() req: Request) {
    return inTenant(this.c, req, async (client) => {
      const r = await client.query(
        `SELECT id, sku, amount_cents, reference_type, reference_id, created_at, expires_at FROM wallet_holds WHERE status = 'active' ORDER BY created_at DESC`,
      );
      return r.rows;
    });
  }

  @Get('ledger')
  @RequirePermission('wallet:read')
  async ledger(@Req() req: Request) {
    const q = LedgerQuerySchema.parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const { w, from } = ledger(q);
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n ${from} ${w.sql}`, w.params);
      const rows = await client.query(
        `SELECT t.id, t.kind, t.memo, t.reference_type, t.reference_id, (-e.amount_cents) AS amount_cents, t.created_at
           ${from} ${w.sql} ORDER BY t.created_at ${q.order === 'asc' ? 'ASC' : 'DESC'}, t.id LIMIT ${w.bind(limit)} OFFSET ${w.bind(offset)}`,
        w.params,
      );
      return { items: rows.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  /**
   * A top-up's invoice as a PDF: a tax invoice when the top-up carried VAT (TshepoVet was a VAT
   * vendor), otherwise a plain invoice. In the sandbox it is a marked specimen (nothing was paid);
   * outside it, it needs TshepoVet's registered details in the configuration (and its VAT number
   * for a tax invoice), and is never issued with made-up ones.
   */
  @Get('topups/:id/invoice.pdf')
  @RequirePermission('wallet:read')
  async invoice(@Req() req: Request, @Param('id') raw: string, @Res() res: Response) {
    const id = uuidParam(raw, 'That top-up');
    const cfg = this.c.config;
    const specimen = cfg.SANDBOX === 'true';
    if (!specimen && !(cfg.SELLER_ADDRESS && cfg.SELLER_REGISTRATION_NUMBER)) {
      throw new ApiError(409, 'invoice_unavailable', 'Invoices cannot be downloaded yet. Ask TshepoVet for a copy.');
    }
    const row = await inTenant(this.c, req, async (client) =>
      (
        await client.query<{ tax_invoice_number: string | null; credit_cents: number; vat_cents: number; gross_cents: number; status: string; created_at: Date; legal_name: string; vat_number: string | null }>(
          `SELECT w.tax_invoice_number, w.credit_cents, w.vat_cents, w.gross_cents, w.status, w.created_at, t.legal_name, t.vat_number
             FROM wallet_topups w JOIN tenants t ON t.id = w.tenant_id WHERE w.id = $1`,
          [id],
        )
      ).rows[0],
    );
    if (!row) throw notFound('That top-up');
    if (row.status !== 'succeeded' || !row.tax_invoice_number) throw new ApiError(409, 'no_invoice', 'This top-up was not paid, so it has no invoice.');
    if (!specimen && row.vat_cents > 0 && !cfg.SELLER_VAT_NUMBER) {
      throw new ApiError(409, 'invoice_unavailable', 'This tax invoice cannot be downloaded yet. Ask TshepoVet for a copy.');
    }
    // A tax invoice only for a top-up that carried VAT, i.e. made while TshepoVet was a VAT vendor.
    const pdf = await renderInvoice({
      number: row.tax_invoice_number,
      issuedAt: row.created_at,
      taxInvoice: row.vat_cents > 0,
      seller: {
        name: cfg.SELLER_LEGAL_NAME,
        registrationNumber: cfg.SELLER_REGISTRATION_NUMBER ?? (specimen ? 'not set (sandbox)' : null),
        address: cfg.SELLER_ADDRESS ?? 'Sandbox: no seller address',
        vatNumber: cfg.SELLER_VAT_NUMBER ?? null,
      },
      buyer: { name: row.legal_name, vatNumber: row.vat_number },
      creditCents: row.credit_cents,
      vatCents: row.vat_cents,
      grossCents: row.gross_cents,
      vatRate: row.credit_cents ? row.vat_cents / row.credit_cents : 0,
      specimen,
    });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="tshepovet-${row.tax_invoice_number}.pdf"`);
    res.send(Buffer.from(pdf));
  }

  @Get('ledger.csv')
  @RequirePermission('wallet:read')
  async ledgerCsv(@Req() req: Request, @Res() res: Response) {
    const q = LedgerQuerySchema.parse(req.query);
    const rows = await inTenant(this.c, req, async (client) => {
      const { w, from } = ledger(q);
      return (
        await client.query(
          `SELECT t.created_at, t.kind, t.memo, t.reference_type, t.reference_id, (-e.amount_cents) AS amount_cents ${from} ${w.sql} ORDER BY t.created_at DESC, t.id LIMIT 50000`,
          w.params,
        )
      ).rows;
    });
    sendCsv(
      res,
      'wallet-ledger.csv',
      ['Date', 'Kind', 'Memo', 'Reference type', 'Reference', 'Amount (ZAR, excl. VAT)'],
      rows.map((r) => [r.created_at, r.kind, r.memo, r.reference_type, r.reference_id, (r.amount_cents / 100).toFixed(2)]),
    );
  }

  @Get('topups')
  @RequirePermission('wallet:read')
  async topups(@Req() req: Request) {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) }).parse(req.query);
    return inTenant(this.c, req, async (client) => {
      const { limit, offset } = pageOf(q);
      const total = await client.query<{ n: number }>(`SELECT count(*) AS n FROM wallet_topups`);
      const rows = await client.query(`SELECT ${TOPUP_COLUMNS} FROM wallet_topups ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
      return { items: rows.rows, total: total.rows[0]!.n, page: q.page, page_size: q.page_size };
    });
  }

  @Post('topups')
  @HttpCode(201)
  @RequirePermission('wallet:topup')
  async topup(@Req() req: Request) {
    const b = TopupRequestSchema.parse(req.body);
    if (this.c.config.SANDBOX !== 'true') {
      throw new ApiError(409, 'payments_unavailable', 'Online top-ups are not open yet. Ask TshepoVet for an invoice to pay by EFT.');
    }
    const u = me(req);
    return inTenant(this.c, req, async (client) => {
      const t = await settleSandboxTopup(client, { tenantId: u.tenantId, creditCents: b.credit_cents, requestedBy: u.userId, reference: `sandbox-${randomUUID()}`, vatRate: vatRateFor(this.c.config) });
      await auditBy(client, req, { action: 'wallet.topped_up', entityType: 'wallet_topup', entityId: t.id, details: { credit_cents: t.credit_cents, provider: 'sandbox', invoice: t.tax_invoice_number } });
      const { balance_cents, ...topup } = t;
      return { topup, balance_cents };
    });
  }
}
