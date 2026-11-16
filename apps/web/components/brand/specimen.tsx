import { GuillocheBand } from './seal';

/**
 * The sandbox band, on every page while the environment is the sandbox. Banknotes printed for
 * reference are overprinted "specimen": the same idea, said in plain words.
 */
export function SpecimenBand() {
  return (
    <div role="note" aria-label="Sandbox" className="relative overflow-hidden border-b border-amber/40 bg-specimen text-ink">
      <GuillocheBand className="pointer-events-none absolute inset-y-0 right-0 h-full w-[40%] text-amber/35" />
      <p className="relative mx-auto max-w-none px-4 py-2 text-sm sm:px-6">
        <strong className="font-bold">Specimen.</strong> This is the TshepoVet sandbox: checks use test data, top-ups are pretend money, and nothing here is
        a real verification.
      </p>
    </div>
  );
}

/** The wordmark: the seal and the name. */
export { Seal } from './seal';
