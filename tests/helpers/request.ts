import supertest from 'supertest';

import { app } from '@/app';

/**
 * Supertest client bound to the real app, driven in-process. No port is bound,
 * so tests can run in any order without racing over a socket.
 */
export const api = supertest(app);

interface AnyEnvelope {
  success: boolean;
  data?: unknown;
  meta?: unknown;
  error?: { code: string; message: string; details: unknown };
}

/** Spec 4.2 success shape: success, data, meta — meta present even when null. */
export function expectSuccessEnvelope(body: unknown): void {
  const envelope = body as AnyEnvelope;
  expect(envelope.success).toBe(true);
  expect(Object.keys(envelope).sort()).toEqual(['data', 'meta', 'success']);
  expect(envelope.data === null || envelope.data === undefined).toBe(false);
}

/** Spec 4.2 error shape: code, message, details — `details` always present. */
export function expectErrorEnvelope(body: unknown, code: string): void {
  const envelope = body as AnyEnvelope;
  expect(envelope.success).toBe(false);
  expect(Object.keys(envelope).sort()).toEqual(['error', 'success']);
  expect(envelope.error).toBeDefined();
  expect(Object.keys(envelope.error ?? {}).sort()).toEqual(['code', 'details', 'message']);
  expect(envelope.error?.code).toBe(code);
  expect(typeof envelope.error?.message).toBe('string');
  expect(envelope.error?.message.length).toBeGreaterThan(0);
}
