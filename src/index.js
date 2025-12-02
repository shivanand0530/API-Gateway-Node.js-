const config = require('./config');
const ErrorHandler = require('./utils/errorHandler');
const EntryLayer = require('./layers/entry');
const AuthLayer = require('./layers/auth');
const RateLimitLayer = require('./layers/rateLimit');
const RoutingLayer = require('./layers/routing');
const ForwardingLayer = require('./layers/forwarding');
const HealthCheck = require('./layers/health');
const logger = require('./layers/logging');
const metrics = require('./layers/metrics');

class ApiGateway {
  constructor() {
    this.entryLayer = null;
    this.authLayer = null;
    this.rateLimitLayer = null;
    this.routingLayer = null;
    this.forwardingLayer = null;
    this.healthCheck = null;
    this.server = null;
    this.isShuttingDown = false;
  }

  async initialize() {
    try {
      logger.logSystem('info', 'Initializing API Gateway', {
        version: '1.0.0',
        environment: config.server.nodeEnv,
        port: config.server.port
      });

      this.entryLayer = new EntryLayer();
      this.authLayer = new AuthLayer();
      this.rateLimitLayer = new RateLimitLayer();
      this.routingLayer = new RoutingLayer();
      this.forwardingLayer = new ForwardingLayer();
      
      // Initialize Redis for rate limiting (graceful failure)
      try {
        await this.rateLimitLayer.initialize();
        logger.logSystem('info', 'Rate limiting layer initialized with Redis');
      } catch (error) {
        logger.logSystem('warn', 'Redis not available, rate limiting will fail-open', { error: error.message });
      }

      this.healthCheck = new HealthCheck();
      this.healthCheck.registerDependency('redis', () => this.rateLimitLayer.healthCheck());
      this.healthCheck.registerDependency('metrics', () => ({ status: 'healthy', message: 'Metrics collecting' }));
      this.healthCheck.registerDependency('forwardingLayer', () => this.forwardingLayer.getHealthStatus());

      logger.logSystem('info', 'All layers initialized successfully');
    } catch (error) {
      logger.logSystem('error', 'Failed to initialize gateway', { error: error.message });
      throw error;
    }
  }

  setupMiddleware() {
    const app = this.entryLayer.getApp();
    app.use(logger.middleware()); 
    app.use(metrics.middleware());

    this.healthCheck.setupRoutes(app);
    this.setupAdminRoutes(app);

    app.use(this.routingLayer.middleware());
    app.use(this.createConditionalAuthMiddleware());
    app.use(this.createConditionalRateLimitMiddleware());
    app.use(this.forwardingLayer.middleware());
    app.use(ErrorHandler.middleware());

    logger.logSystem('info', 'Middleware pipeline configured');
  }

  createConditionalAuthMiddleware() {
    return (req, res, next) => {
      const route = req.context.route;
      
      if (!route) {
        return next();
      }

      if (route.authRequired) {
        return this.authLayer.requireAuth()(req, res, next);
      } else {
        return this.authLayer.optionalAuth()(req, res, next);
      }
    };
  }

  createConditionalRateLimitMiddleware() {
    return (req, res, next) => {
      const route = req.context.route;
      
      if (!route) {
        return next();
      }

      const tier = route.rateLimitTier || 'basic';
      return this.rateLimitLayer.middleware(tier)(req, res, next);
    };
  }

  setupAdminRoutes(app) {
    app.get('/admin/metrics', (req, res) => {
      const detailed = req.query.detailed === 'true';
      const data = detailed ? metrics.getMetrics() : metrics.getSummary();
      res.json(data);
    });

    app.get('/admin/circuit-breakers', (req, res) => {
      res.json(this.forwardingLayer.getCircuitBreakerStates());
    });

    app.post('/admin/circuit-breakers/:service/reset', (req, res) => {
      const serviceName = req.params.service;
      const success = this.forwardingLayer.resetCircuitBreaker(serviceName);
      
      if (success) {
        res.json({ message: `Circuit breaker reset for ${serviceName}` });
      } else {
        res.status(404).json({ error: `Service ${serviceName} not found` });
      }
    });

    app.get('/admin/rate-limits/:identifier', ErrorHandler.asyncHandler(async (req, res) => {
      const identifier = req.params.identifier;
      const tier = req.query.tier || 'basic';
      
      try {
        const status = await this.rateLimitLayer.getRateLimitStatus(identifier, tier);
        res.json(status);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }));

    app.post('/admin/rate-limits/:identifier/reset', ErrorHandler.asyncHandler(async (req, res) => {
      const identifier = req.params.identifier;
      const tier = req.query.tier || 'basic';
      
      try {
        const result = await this.rateLimitLayer.resetRateLimit(identifier, tier);
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }));

    app.get('/admin/routes', (req, res) => {
      const routes = this.routingLayer.getRoutes();
      const stats = this.routingLayer.getStats();
      res.json({ routes, stats });
    });

    if (config.server.nodeEnv === 'development') {
      app.post('/admin/test-token', (req, res) => {
        const { userId, username, roles, tier } = req.body;
        
        const token = this.authLayer.createTestToken(userId || 'test-user', {
          username: username || 'testuser',
          roles: roles || ['user'],
          tier: tier || 'basic'
        });
        
        res.json({ token, expiresIn: config.jwt.expiry });
      });
    }

    logger.logSystem('info', 'Admin routes configured');
  }

  async start() {
    try {
      await this.initialize();
      this.setupMiddleware();
      this.healthCheck.markReady();

      this.server = this.entryLayer.listen(config.server.port, () => {
        logger.logSystem('info', 'API Gateway started', {
          port: config.server.port,
          environment: config.server.nodeEnv,
          routes: config.routes.length,
          pid: process.pid
        });

        console.log(` API Gateway running on port ${config.server.port}`);
        console.log(`Health check: http://localhost:${config.server.port}/health`);
        console.log(` Metrics: http://localhost:${config.server.port}/admin/metrics`);
        console.log(` Admin: http://localhost:${config.server.port}/admin/`);
      });

      this.setupGracefulShutdown();

    } catch (error) {
      logger.logSystem('error', 'Failed to start API Gateway', { error: error.message });
      this.healthCheck.markNotReady(error.message);
      throw error;
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) {
        return;
      }

      this.isShuttingDown = true;
      logger.logSystem('info', `Received ${signal}, starting graceful shutdown`);

      try {
        this.healthCheck.markNotReady('Shutting down');
        if (this.server) {
          this.server.close(() => {
            logger.logSystem('info', 'HTTP server closed');
          });
        }

        if (this.rateLimitLayer) {
          await this.rateLimitLayer.close();
          logger.logSystem('info', 'Redis connection closed');
        }
        await new Promise(resolve => setTimeout(resolve, 5000));

        logger.logSystem('info', 'Graceful shutdown completed');
        process.exit(0);

      } catch (error) {
        logger.logSystem('error', 'Error during shutdown', { error: error.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.logSystem('error', 'Uncaught exception', { error: error.message, stack: error.stack });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.logSystem('error', 'Unhandled promise rejection', { 
        reason: reason?.message || reason,
        stack: reason?.stack
      });
      process.exit(1);
    });
  }


  getStatus() {
    return {
      running: !this.isShuttingDown,
      uptime: Date.now() - (this.healthCheck?.startTime || Date.now()),
      metrics: metrics.getSummary(),
      circuitBreakers: this.forwardingLayer?.getHealthStatus() || {},
      routes: this.routingLayer?.getStats() || {}
    };
  }
}

const gateway = new ApiGateway();

if (require.main === module) {
  gateway.start().catch((error) => {
    console.error('Failed to start API Gateway:', error);
    process.exit(1);
  });
}

module.exports = gateway;