const request = require('supertest');
const gateway = require('../src/index');

describe('API Gateway', () => {
  let server;

  beforeAll(async () => {
    // Start gateway without Redis for testing
    process.env.NODE_ENV = 'test';
    await gateway.initialize();
    gateway.setupMiddleware();
    server = gateway.entryLayer.getApp();
  });

  afterAll(async () => {
    if (gateway.server) {
      gateway.server.close();
    }
    if (gateway.rateLimitLayer) {
      await gateway.rateLimitLayer.close();
    }
  });

  describe('Health Endpoints', () => {
    test('GET /ping should return pong', async () => {
      const response = await request(server)
        .get('/ping')
        .expect(200);
      
      expect(response.body.status).toBe('pong');
      expect(response.body.requestId).toBeDefined();
    });

    test('GET /version should return version info', async () => {
      const response = await request(server)
        .get('/version')
        .expect(200);
      
      expect(response.body.name).toBe('API Gateway');
      expect(response.body.version).toBe('1.0.0');
    });

    test('GET /health/live should return alive status', async () => {
      const response = await request(server)
        .get('/health/live')
        .expect(200);
      
      expect(response.body.status).toBe('alive');
      expect(response.body.uptime).toBeGreaterThan(0);
    });
  });

  describe('Admin Endpoints', () => {
    test('GET /admin/metrics should return metrics', async () => {
      const response = await request(server)
        .get('/admin/metrics')
        .expect(200);
      
      expect(response.body.requests).toBeDefined();
      expect(response.body.responseTime).toBeDefined();
      expect(response.body.system).toBeDefined();
    });

    test('GET /admin/routes should return route configuration', async () => {
      const response = await request(server)
        .get('/admin/routes')
        .expect(200);
      
      expect(response.body.routes).toBeInstanceOf(Array);
      expect(response.body.stats).toBeDefined();
    });
  });

  describe('Request Processing', () => {
    test('Should add request ID to all responses', async () => {
      const response = await request(server)
        .get('/ping')
        .expect(200);
      
      expect(response.headers['x-request-id']).toBeDefined();
    });

    test('Should handle invalid routes', async () => {
      const response = await request(server)
        .get('/invalid/route')
        .expect(404);
      
      expect(response.body.error).toBe('ROUTE_NOT_FOUND');
      expect(response.body.requestId).toBeDefined();
    });

    test('Should validate HTTP methods', async () => {
      const response = await request(server)
        .trace('/ping') // TRACE is not allowed
        .expect(405);
      
      expect(response.body.error).toBe('Method Not Allowed');
    });
  });

  describe('Authentication', () => {
    test('Should create test token in development', async () => {
      if (process.env.NODE_ENV === 'development') {
        const response = await request(server)
          .post('/admin/test-token')
          .send({ userId: 'test-user' })
          .expect(200);
        
        expect(response.body.token).toBeDefined();
        expect(response.body.expiresIn).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    test('Should handle malformed JSON', async () => {
      const response = await request(server)
        .post('/admin/test-token')
        .set('Content-Type', 'application/json')
        .send('invalid json')
        .expect(400);
      
      expect(response.body.error).toBeDefined();
    });

    test('Should enforce request size limits', async () => {
      const largePayload = 'x'.repeat(11 * 1024 * 1024); // 11MB
      
      const response = await request(server)
        .post('/admin/test-token')
        .send({ data: largePayload })
        .expect(413);
    });
  });
});

module.exports = {
  testTimeout: 10000
};