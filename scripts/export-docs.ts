import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { stringify } from 'yaml';

import { buildOpenApiDocument } from '@/docs/openapi';
import { buildRealtimeDocument } from '@/docs/realtime-docs';

/**
 * Writes the API contract to files (spec §7, Batch 15: "generated openapi.yaml
 * covering every endpoint").
 *
 * The running API already serves both documents at `/docs/openapi.json` and
 * `/docs/realtime.json`, and those stay the authority. This exists because a
 * served document is only reachable if the service is up and the reader has the
 * URL — and the people who need the contract most are a mobile team starting
 * work, a code generator in someone's build, and a reviewer reading a diff.
 *
 * COMMITTED ON PURPOSE. A generated file in the repository is a contract change
 * that shows up in a pull request: renaming an error code or dropping an
 * endpoint becomes a visible diff rather than something a client discovers at
 * runtime. `npm run docs:export` regenerates; CI could fail on a dirty tree if
 * that ever needs enforcing.
 *
 * YAML for OpenAPI because the spec asks for it and every generator reads it.
 * JSON for the socket document, which has no such convention and is consumed
 * programmatically.
 */

const SERVER_URL = process.env.DOCS_SERVER_URL ?? 'https://dm9o5kgscmnxv.cloudfront.net';

const outputDir = path.resolve(process.cwd(), 'docs');
mkdirSync(outputDir, { recursive: true });

const openapi = buildOpenApiDocument(SERVER_URL);
const realtime = buildRealtimeDocument(SERVER_URL);

const openapiPath = path.join(outputDir, 'openapi.yaml');
const realtimePath = path.join(outputDir, 'realtime.json');

writeFileSync(openapiPath, stringify(openapi), 'utf8');
writeFileSync(realtimePath, `${JSON.stringify(realtime, null, 2)}\n`, 'utf8');

const paths = openapi.paths as Record<string, Record<string, unknown>>;
const endpoints = Object.values(paths).reduce((total, ops) => total + Object.keys(ops).length, 0);

const events = realtime.events as Record<string, unknown[]> | undefined;

// eslint-disable-next-line no-console -- a CLI script's output IS its result.
console.log(
  [
    `openapi.yaml  ${endpoints} endpoints across ${Object.keys(paths).length} paths`,
    `realtime.json ${events ? Object.values(events).flat().length : 0} socket events`,
    `written to    ${outputDir}`,
  ].join('\n'),
);
