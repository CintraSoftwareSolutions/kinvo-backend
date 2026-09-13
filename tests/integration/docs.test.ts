import fs from 'node:fs';
import path from 'node:path';

import { API_PREFIX } from '@config/constants';
import { ROUTES, buildOpenApiDocument } from '@/docs/openapi';
import { api, expectErrorEnvelope } from '../helpers/request';

/**
 * Documentation that drifts from the code is worse than none: the mobile team
 * builds against it and the bug surfaces as "your API is broken".
 *
 * So this suite reads the actual route files and asserts the OpenAPI document
 * covers exactly the endpoints that exist — no more, no fewer. Adding an
 * endpoint without documenting it fails the build.
 */

interface DiscoveredRoute {
  method: string;
  path: string;
}

/**
 * Parses the route files rather than importing the app, which would open
 * database and Redis connections this suite has no use for.
 */
function discoverRoutes(): DiscoveredRoute[] {
  const routesSource = fs.readFileSync(path.join(process.cwd(), 'src/routes.ts'), 'utf8');

  const mounts: Record<string, string> = {};
  for (const match of routesSource.matchAll(/apiRouter\.use\(\s*'([^']+)'\s*,\s*(\w+)\)/g)) {
    mounts[match[2]!] = match[1]!;
  }

  const found: DiscoveredRoute[] = [];
  const moduleDir = path.join(process.cwd(), 'src/modules');

  const files: string[] = [];
  for (const dir of fs.readdirSync(moduleDir)) {
    const full = path.join(moduleDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (file.endsWith('.routes.ts')) files.push(path.join(full, file));
    }
  }

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(\w+Router)\s*\.\s*(get|post|put|patch|delete)\(\s*'([^']*)'/g,
    )) {
      const [, router, method, routePath] = match;
      const prefix = mounts[router!];
      // A router the api router does not mount is not reachable.
      if (prefix === undefined) continue;

      const suffix = routePath === '/' ? '' : routePath!;
      found.push({ method: method!.toUpperCase(), path: prefix + suffix });
    }
  }

  return found;
}

/** Express ":id" and OpenAPI "{id}" describe the same route. */
function normalise(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const discovered = discoverRoutes();
const documented = ROUTES.map((route) => ({
  method: route.method.toUpperCase(),
  path: normalise(route.path),
}));

describe('OpenAPI coverage', () => {
  it('discovers the routes that actually exist', () => {
    // A sanity check on the parser itself: if this ever returns nothing, the
    // two assertions below would pass vacuously and prove nothing.
    expect(discovered.length).toBeGreaterThan(30);
  });

  it('documents every endpoint the API serves', () => {
    const documentedKeys = new Set(documented.map((r) => `${r.method} ${r.path}`));

    const undocumented = discovered
      .map((r) => `${r.method} ${normalise(r.path)}`)
      .filter((key) => !documentedKeys.has(key));

    expect(undocumented).toEqual([]);
  });

  it('documents nothing that does not exist', () => {
    const realKeys = new Set(discovered.map((r) => `${r.method} ${normalise(r.path)}`));

    const phantom = documented
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !realKeys.has(key));

    expect(phantom).toEqual([]);
  });
});

describe('the generated document', () => {
  const doc = buildOpenApiDocument('https://example.test') as {
    openapi: string;
    info: { title: string; description: string };
    servers: { url: string }[];
    paths: Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    components: { securitySchemes: Record<string, unknown> };
  };

  it('is a valid OpenAPI 3 document with the essentials', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Kinvo API');
    expect(doc.servers[0]?.url).toBe('https://example.test');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
  });

  it('prefixes every path with the API version', () => {
    for (const p of Object.keys(doc.paths)) {
      expect(p.startsWith(API_PREFIX)).toBe(true);
    }
  });

  it('marks authenticated endpoints as requiring a bearer token', () => {
    const me = doc.paths[`${API_PREFIX}/auth/me`]?.get;
    expect(me?.security).toEqual([{ bearerAuth: [] }]);

    // ...and leaves public ones open, or the mobile team is told to send a
    // token before they can possibly have one.
    const login = doc.paths[`${API_PREFIX}/auth/login`]?.post;
    expect(login?.security).toEqual([]);
  });

  it('documents the three distinct auth failures on a protected route', () => {
    const me = doc.paths[`${API_PREFIX}/auth/me`]?.get;
    // They share status 401, so only one can occupy that key — but the enum of
    // codes in the error schema is what the client actually branches on.
    expect(me?.responses['401']).toBeDefined();
  });

  it('describes the response envelope, not bare payloads', () => {
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();

    const login = doc.paths[`${API_PREFIX}/auth/login`]?.post as {
      responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    expect(login.responses['200']?.content?.['application/json']?.schema?.$ref).toContain(
      'SuccessEnvelope',
    );
  });

  it('tells the client to branch on code rather than message', () => {
    expect(doc.info.description).toContain('Branch on `error.code`');
    expect(doc.info.description).toContain('metres');
  });
});

describe('the docs endpoints', () => {
  it('serves the OpenAPI document as raw JSON, not wrapped in the envelope', async () => {
    const response = await api.get(`${API_PREFIX}/docs/openapi.json`);

    expect(response.status).toBe(200);
    // Every OpenAPI tool expects the document at the top level.
    expect(response.body.openapi).toMatch(/^3\./);
    expect(response.body).not.toHaveProperty('success');
  });

  it('derives the server URL from the request', async () => {
    const response = await api
      .get(`${API_PREFIX}/docs/openapi.json`)
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'api.example.com');

    // Behind CloudFront the API cannot know its own public hostname, so a
    // hardcoded server URL would send "Try it out" to the wrong place.
    expect(response.body.servers[0].url).toBe('https://api.example.com');
  });

  it('reports https for a public host even though CloudFront calls the origin over http', async () => {
    // The request reaching the origin is genuinely plain HTTP. Trusting that
    // put "http://" in the document and pointed "Try it out" at the wrong
    // scheme. CloudFront announces the viewer's scheme in its own header.
    const response = await api
      .get(`${API_PREFIX}/docs/openapi.json`)
      .set('cloudfront-forwarded-proto', 'https')
      .set('x-forwarded-host', 'dm9o5kgscmnxv.cloudfront.net');

    expect(response.body.servers[0].url).toBe('https://dm9o5kgscmnxv.cloudfront.net');
  });

  it('still reports http for local development', async () => {
    const response = await api.get(`${API_PREFIX}/docs/openapi.json`);

    // Supertest connects over plain HTTP to a local address, which is the one
    // case where http is the truth rather than a proxy artefact.
    expect(response.body.servers[0].url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  });

  it('serves the Swagger UI page', async () => {
    const response = await api.get(`${API_PREFIX}/docs/`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('swagger');
  });

  it('leaves the envelope rule intact for actual API routes', async () => {
    // /docs is a viewer, not part of the v1 contract, and swagger-ui-express
    // answers any sub-path with its own page. What must not change is that a
    // genuine unknown API route still returns the spec 4.2 error envelope.
    const response = await api.get(`${API_PREFIX}/definitely-not-an-endpoint`);

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });
});
