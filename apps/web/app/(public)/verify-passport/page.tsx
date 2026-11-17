import type { Metadata } from 'next';
import { VerifyPassport } from '@/components/supplier/verify-passport';

export const metadata: Metadata = {
  title: 'Check a supplier passport',
  description: 'Check the verification code on a printed TshepoVet Verified Vendor Passport.',
};

export default function Page() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold">Check a supplier passport</h1>
      <p className="mt-3 mb-8 text-lg text-ink-2">
        A supplier may hand you a printed Verified Vendor Passport. Enter its code to see whether TshepoVet issued it, and whether the facts on it are still current.
      </p>
      <VerifyPassport />
    </div>
  );
}
