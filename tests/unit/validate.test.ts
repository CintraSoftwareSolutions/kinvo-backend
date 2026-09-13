import express, { type Express } from 'express';
import supertest from 'supertest';
import { z } from 'zod';

import { errorHandler } from '@middleware/error-handler';
import { validate } from '@middleware/validate';
import { sendSuccess } from '@utils/response';
import { expectErrorEnvelope } from '../helpers/request';

const bodySchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  age: z.number().int().min(18, 'You must be 18 or older to use Kinvo.'),
});

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const paramsSchema = z.object({
  id: z.string().uuid('Not a valid id.'),
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  app.post('/body', validate({ body: bodySchema }), (req, res) => {
    sendSuccess(res, { received: req.body });
  });

  app.get('/query', validate({ query: querySchema }), (req, res) => {
    sendSuccess(res, { received: req.query });
  });

  app.get('/item/:id', validate({ params: paramsSchema }), (req, res) => {
    sendSuccess(res, { id: req.params.id });
  });

  app.use(errorHandler);
  return app;
}

const client = supertest(buildApp());

describe('validate middleware (spec 0.5)', () => {
  it('passes a valid body through to the handler', async () => {
    const response = await client.post('/body').send({ email: 'sarah@example.com', age: 27 });

    expect(response.status).toBe(200);
    expect(response.body.data.received).toEqual({ email: 'sarah@example.com', age: 27 });
  });

  it('rejects an invalid body with VALIDATION_FAILED and field-keyed details', async () => {
    const response = await client.post('/body').send({ email: 'nope', age: 16 });

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual({
      email: ['Enter a valid email address.'],
      age: ['You must be 18 or older to use Kinvo.'],
    });
  });

  it('collects every failing field, not just the first', async () => {
    const response = await client.post('/body').send({});

    expect(Object.keys(response.body.error.details).sort()).toEqual(['age', 'email']);
  });

  it('coerces and defaults query parameters', async () => {
    const response = await client.get('/query?limit=50');

    expect(response.body.data.received).toEqual({ limit: 50 });
  });

  it('applies the default limit when the query omits it (spec 4.5)', async () => {
    const response = await client.get('/query');

    expect(response.body.data.received.limit).toBe(20);
  });

  it('rejects a query parameter over the maximum limit', async () => {
    const response = await client.get('/query?limit=500');

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toHaveProperty('limit');
  });

  it('validates route params', async () => {
    const valid = await client.get('/item/2f1b1d0e-8c3a-4a5e-9f1e-2b3c4d5e6f70');
    expect(valid.status).toBe(200);

    const invalid = await client.get('/item/12345');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual({ id: ['Not a valid id.'] });
  });

  it('reports nested field paths with dotted keys', async () => {
    const nested = z.object({ preferences: z.object({ radius_metres: z.number().max(80_000) }) });
    const app = express();
    app.use(express.json());
    app.post('/nested', validate({ body: nested }), (_req, res) => sendSuccess(res, {}));
    app.use(errorHandler);

    const response = await supertest(app)
      .post('/nested')
      .send({ preferences: { radius_metres: 1e9 } });

    expect(Object.keys(response.body.error.details)).toEqual(['preferences.radius_metres']);
  });
});
