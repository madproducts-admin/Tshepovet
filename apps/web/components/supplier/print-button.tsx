'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function PrintButton() {
  return (
    <Button intent="secondary" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print or save as PDF
    </Button>
  );
}
