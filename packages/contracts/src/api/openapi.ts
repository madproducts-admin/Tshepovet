import { z } from 'zod';
import { API_ROUTES, type ApiRoute } from './routes';

type Json = Record<string, unknown>;

function schemaOf(s: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(s, { io, target: 'draft-2020-12', unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function operationId(r: ApiRoute): string {
  const words = r.path
    .replace(/^\/api\//, '')
    .split(/[/.-]/)
    .filter(Boolean)
    .map((w) => (w.startsWith('{') ? `By${w.slice(1, 2).toUpperCase()}${w.slice(2, -1)}` : w[0]!.toUpperCase() + w.slice(1)));
  return r.method.toLowerCase() + words.join('');
}

/**
 * The OpenAPI 3.1 document of the portal API, built from API_ROUTES and the zod contracts.
 * Served at GET /api/openapi.json. (The public /v1 API keeps its hand-written openapi.yaml.)
 */
export function portalOpenApi(version = '0.3.0'): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of API_ROUTES) {
    const parameters: Json[] = [];
    for (const m of r.path.matchAll(/\{(\w+)\}/g)) {
      parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    }
    if (r.query) {
      const q = schemaOf(r.query, 'input') as { properties?: Record<string, Json>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        parameters.push({ name, in: 'query', required: q.required?.includes(name) ?? false, schema });
      }
    }
    const security: Json[] = [];
    if (r.access !== 'public') security.push(UNSAFE.has(r.method) ? { [r.access]: [], csrf: [] } : { [r.access]: [] });
    else if (UNSAFE.has(r.method)) security.push({ csrf: [] });

    const success: Json = { description: r.summary };
    if (r.produces === 'text/csv') success.content = { 'text/csv': { schema: { type: 'string' } } };
    else if (r.response) success.content = { 'application/json': { schema: schemaOf(r.response, 'output') } };

    const op: Json = {
      operationId: operationId(r),
      tags: [r.tag],
      summary: r.summary,
      security,
      parameters,
      responses: {
        [String(r.status)]: success,
        '4XX': { $ref: '#/components/responses/Problem' },
      },
    };
    if (r.permission) op['x-permission'] = r.permission;
    if (r.mfaSetupAllowed) op['x-mfa-setup-allowed'] = true;
    if (r.staffRoles) op['x-staff-roles'] = r.staffRoles;
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(r.body, 'input') } } };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'TshepoVet portal API',
      version,
      description:
        'The API behind the TshepoVet web app: cookie sessions with a CSRF header, every request scoped to the signed-in organisation by row-level security, and role permissions (x-permission). Integrations should use the public /v1 API with API keys instead; this one may change with the web app.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: '__Host-tv_session', description: 'Set by sign-in. tv_session over plain http in development.' },
        staff: { type: 'apiKey', in: 'cookie', name: '__Host-tv_staff_session' },
        vendor: { type: 'apiKey', in: 'cookie', name: '__Host-tv_vendor_session', description: 'A supplier contact, signed in with an emailed link.' },
        onboarding: { type: 'apiKey', in: 'header', name: 'X-Onboarding-Token', description: 'The token from the supplier invitation link.' },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Equal to the csrf cookie and, once signed in, to the session’s token.' },
      },
      responses: {
        Problem: {
          description: 'An error (RFC 9457 problem details)',
          content: {
            'application/problem+json': {
              schema: {
                type: 'object',
                required: ['type', 'title', 'status', 'code'],
                properties: {
                  type: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'integer' },
                  code: { type: 'string' },
                  detail: { type: 'string' },
                  request_id: { type: 'string' },
                  details: { type: 'object' },
                },
              },
            },
          },
        },
      },
    },
  };
}
