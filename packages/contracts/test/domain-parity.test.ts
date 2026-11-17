import { describe, expect, it } from 'vitest';
import * as core from '@tshepovet/core';
import { LICENCE_CODES, PRDP_CATEGORIES } from '../src/domain';

describe('contracts stay in step with the domain', () => {
  it('lists the same licence codes and PrDP categories', () => {
    expect([...LICENCE_CODES]).toEqual([...core.LICENCE_CODES]);
    expect([...PRDP_CATEGORIES]).toEqual([...core.PRDP_CATEGORIES]);
  });
});
