require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    nodeEnv: process.env.NODE_ENV || 'development'
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-me',
    expiry: process.env.JWT_EXPIRY || '1h'
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined
  },

  rateLimiting: {
    defaultRequests: parseInt(process.env.DEFAULT_RATE_LIMIT_REQUESTS || '100'),
    defaultWindowMs: parseInt(process.env.DEFAULT_RATE_LIMIT_WINDOW_MS || '60000'),
    
    tiers: {
      basic: { requests: 100, windowMs: 60000 },
      premium: { requests: 1000, windowMs: 60000 },
      enterprise: { requests: 10000, windowMs: 60000 }
    }
  },

  circuitBreaker: {
    failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5'),
    recoveryTimeout: parseInt(process.env.CIRCUIT_BREAKER_RECOVERY_TIMEOUT || '30000'),
    monitorTimeout: parseInt(process.env.CIRCUIT_BREAKER_MONITOR_TIMEOUT || '2000')
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/gateway.log'
  },

  routes: [
    {
      path: '/api/users',
      target: 'http://localhost:3001',
      timeout: 5000,
      retries: 3,
      authRequired: true,
      rateLimitTier: 'basic',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    },
    {
      path: '/api/auth',
      target: 'http://localhost:3002',
      timeout: 3000,
      retries: 2,
      authRequired: false,
      rateLimitTier: 'basic',
      methods: ['POST']
    },
    {
      path: '/api/products',
      target: 'http://localhost:3003',
      timeout: 5000,
      retries: 3,
      authRequired: true,
      rateLimitTier: 'premium',
      methods: ['GET', 'POST', 'PUT', 'DELETE']
    },
    {
      path: '/api/orders',
      target: 'http://localhost:3004',
      timeout: 10000,
      retries: 2,
      authRequired: true,
      rateLimitTier: 'enterprise',
      methods: ['GET', 'POST', 'PUT', 'PATCH']
    }
  ]
};

module.exports = config;