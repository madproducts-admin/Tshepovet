
/**
 * POPIA s14 retention job (run hourly via cron / k8s CronJob as tshepovet_worker).
 *  1. Expire stale wallet holds (crashed requests) so credits are never stranded.
 *  2. Delete document images from object storage, then null storage_key.
 *  3. run_retention_purge(): crypto-shred PINs, bureau payloads, cache, etc.
 *  4. Keep audit partitions ahead of time.
 */
export async function purgeOnce(pool: import('pg').Pool, deleteObject: (key: string) => Promise<void>) {
  const holds = await pool.query(
    `WITH h AS (
       UPDATE wallet_holds SET status = 'expired', settled_at = now()
        WHERE status = 'active' AND expires_at < now() RETURNING wallet_id, amount_cents, reference_id)
     , w AS (UPDATE wallets SET held_cents = held_cents - x.total
               FROM (SELECT wallet_id, sum(amount_cents) AS total FROM h GROUP BY wallet_id) x WHERE wallets.id = x.wallet_id)
     UPDATE verifications SET status = 'failed', outcome = 'unable_to_verify', completed_at = now()
      WHERE id IN (SELECT reference_id FROM h) AND status = 'processing'
     RETURNING id`,
  );

  const docs = await pool.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM vendor_documents WHERE storage_key IS NOT NULL AND image_purge_after <= now() LIMIT 1000`,
  );
  for (const d of docs.rows) {
    await deleteObject(d.storage_key);
    await pool.query(`UPDATE vendor_documents SET storage_key = NULL WHERE id = $1`, [d.id]);
  }

  const counts = await pool.query<{ run_retention_purge: Record<string, number> }>(`SELECT run_retention_purge(5000)`);
  await pool.query(`SELECT ensure_audit_partitions(3)`);
  return { expired_holds: holds.rowCount, images_deleted: docs.rowCount, ...counts.rows[0]!.run_retention_purge };
}

