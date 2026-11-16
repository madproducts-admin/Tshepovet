import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CompanyRequestSchema, DriverRequestSchema } from '../src/v1';

/** Keeps openapi/openapi.yaml honest against the route validators. */
const spec = parse(readFileSync(path.join(__dirname, '..', '..', '..', 'openapi', 'openapi.yaml'), 'utf8'));

function resolve(ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], spec);
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

describe('OpenAPI contract', () => {
  it('is OpenAPI 3.1 and every $ref resolves', () => {
    expect(spec.openapi).toBe('3.1.0');
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(20);
    for (const r of refs) expect(resolve(r), r).toBeDefined();
  });

  it('has no text truncated by an unquoted comma in a { } mapping', () => {
    // `{ description: A, B }` parses as description "A" plus a stray key "B" with a null value.
    const stray: string[] = [];
    (function walk(node: unknown, path: string) {
      if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (/\s/.test(k) && v === null) stray.push(`${path} -> "${k}"`);
          walk(v, `${path}.${k}`);
        }
      }
    })(spec, '');
    expect(stray).toEqual([]);
  });

  it('company request examples pass the route validator', () => {
    const examples = spec.paths['/verify/company'].post.requestBody.content['application/json'].examples;
    for (const [name, ex] of Object.entries<{ value: unknown }>(examples)) {
      const r = CompanyRequestSchema.safeParse(ex.value);
      expect(r.success, `${name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });

  it('driver request example passes the route validator', () => {
    const ex = spec.paths['/verify/driver-license'].post.requestBody.content['application/json'].example;
    const r = DriverRequestSchema.safeParse(ex);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('documents every request field the validators accept, and no others', () => {
    const company = spec.components.schemas.CompanyVerificationRequest.properties;
    expect(Object.keys(company).sort()).toEqual(Object.keys(CompanyRequestSchema.shape).sort());
    const driver = spec.components.schemas.DriverVerificationRequest ?? spec.components.schemas.DriverLicenceVerificationRequest;
    expect(Object.keys(driver.properties).sort()).toEqual(Object.keys(DriverRequestSchema.shape).sort());
  });

  it('response examples carry every required Verification field', () => {
    const required: string[] = spec.components.schemas.Verification.required;
    for (const name of ['CompanyVerified', 'DriverVerified']) {
      const v = spec.components.examples[name].value;
      for (const f of required) expect(v, `${name}.${f}`).toHaveProperty(f);
      for (const f of spec.components.schemas.Verification.properties.billing.required) expect(v.billing, `${name}.billing.${f}`).toHaveProperty(f);
    }
  });
});
