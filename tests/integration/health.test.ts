import { API_PREFIX } from '@config/constants';
import { api, expectSuccessEnvelope } from '../helpers/request';

describe('GET /health', () => {
  it('returns 200 with the success envelope and no auth', async () => {
    const response = await api.get(`${API_PREFIX}/health`);

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
    expect(response.body.meta).toBeNull();
  });

  it('reports status, version, environment and uptime', async () => {
    const response = await api.get(`${API_PREFIX}/health`);

    expect(response.body.data).toEqual({
      status: 'ok',
      api_version: 'v1',
      environment: 'test',
      uptime_seconds: expect.any(Number),
      checked_at: expect.any(String),
    });
    expect(response.body.data.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('returns checked_at as UTC ISO-8601 with a Z suffix (spec 4.6)', async () => {
    const response = await api.get(`${API_PREFIX}/health`);
    const { checked_at: checkedAt } = response.body.data;

    expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(checkedAt).toISOString()).toBe(checkedAt);
  });

  it('is also reachable unversioned for load-balancer probes', async () => {
    const response = await api.get('/health');

    expect(response.status).toBe(200);
    expectSuccessEnvelope(response.body);
  });

  it('echoes a correlation id on every response', async () => {
    const response = await api.get(`${API_PREFIX}/health`);

    const correlationId = response.headers['x-request-id'];
    expect(correlationId).toEqual(expect.any(String));
    expect(String(correlationId).length).toBeGreaterThan(0);
  });

  it('honours an inbound X-Request-Id', async () => {
    const response = await api.get(`${API_PREFIX}/health`).set('X-Request-Id', 'trace-abc-123');

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('rejects a hostile X-Request-Id and generates its own', async () => {
    const response = await api
      .get(`${API_PREFIX}/health`)
      .set('X-Request-Id', 'bad value <script>');

    expect(response.headers['x-request-id']).not.toBe('bad value <script>');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not advertise the framework', async () => {
    const response = await api.get(`${API_PREFIX}/health`);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
