const config = require('../config');
const ErrorHandler = require('../utils/errorHandler');

class HealthCheck {
  constructor(dependencies = {}) {
    this.dependencies = dependencies;
    this.startTime = Date.now();
    this.healthStatus = {
      status: 'starting',
      timestamp: new Date().toISOString(),
      uptime: 0,
      version: '1.0.0',
      dependencies: {}
    };
  }

  registerDependency(name, healthCheckFn) {
    this.dependencies[name] = healthCheckFn;
  }

  async checkDependencies() {
    const results = {};

    for (const [name, healthCheckFn] of Object.entries(this.dependencies)) {
      try {
        const startTime = Date.now();
        const result = await Promise.race([
          healthCheckFn(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          )
        ]);
        
        results[name] = {
          status: result.status || 'healthy',
          message: result.message || 'OK',
          responseTime: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          details: result.details || null
        };
      } catch (error) {
        results[name] = {
          status: 'unhealthy',
          message: error.message || 'Health check failed',
          responseTime: null,
          timestamp: new Date().toISOString(),
          error: error.message
        };
      }
    }

    return results;
  }

  async liveness(req, res) {
    try {
      const uptime = Date.now() - this.startTime;
      const memUsage = process.memoryUsage();

      const livenessData = {
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: uptime,
        pid: process.pid,
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
          external: Math.round(memUsage.external / 1024 / 1024), // MB
          rss: Math.round(memUsage.rss / 1024 / 1024) // MB
        },
        version: this.healthStatus.version,
        node: {
          version: process.version,
          platform: process.platform,
          arch: process.arch
        }
      };

      res.status(200).json(livenessData);
    } catch (error) {
      res.status(500).json({
        status: 'dead',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  }

  async readiness(req, res) {
    try {
      const uptime = Date.now() - this.startTime;
      const dependencyResults = await this.checkDependencies();

      const criticalDependencies = ['redis']; 
      const isReady = Object.entries(dependencyResults).every(([name, result]) => {
        if (criticalDependencies.includes(name)) {
          return result.status === 'healthy';
        }
        return true;
      });

      const overallStatus = isReady ? 'ready' : 'not_ready';
      const statusCode = isReady ? 200 : 503;

      const readinessData = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptime: uptime,
        dependencies: dependencyResults,
        version: this.healthStatus.version,
        ready: isReady
      };

      res.status(statusCode).json(readinessData);
    } catch (error) {
      res.status(503).json({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        error: error.message,
        ready: false
      });
    }
  }

  async health(req, res) {
    try {
      const uptime = Date.now() - this.startTime;
      const dependencyResults = await this.checkDependencies();
      const memUsage = process.memoryUsage();

      let metrics = null;
      if (this.dependencies.metrics && typeof this.dependencies.metrics.getSummary === 'function') {
        try {
          metrics = this.dependencies.metrics.getSummary();
        } catch (error) {

        }
      }

      let circuitBreakers = null;
      if (this.dependencies.forwardingLayer && typeof this.dependencies.forwardingLayer.getHealthStatus === 'function') {
        try {
          circuitBreakers = this.dependencies.forwardingLayer.getHealthStatus();
        } catch (error) {

        }
      }

      const overallHealthy = Object.values(dependencyResults).every(result => 
        result.status === 'healthy'
      );

      const healthData = {
        status: overallHealthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: uptime,
        version: this.healthStatus.version,
        system: {
          pid: process.pid,
          memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024)
          },
          node: {
            version: process.version,
            platform: process.platform,
            arch: process.arch
          }
        },
        dependencies: dependencyResults,
        metrics: metrics,
        circuitBreakers: circuitBreakers,
        configuration: {
          environment: config.server.nodeEnv,
          port: config.server.port,
          routeCount: config.routes.length
        }
      };

      const statusCode = overallHealthy ? 200 : 503;
      res.status(statusCode).json(healthData);
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  }

  async deep(req, res) {
    try {
      const uptime = Date.now() - this.startTime;
      const dependencyResults = await this.checkDependencies();

      const deepChecks = {
        fileSystem: await this.checkFileSystem(),
        eventLoop: this.checkEventLoop(),
        configuration: this.validateConfiguration()
      };

      const deepHealthData = {
        status: 'deep_check_complete',
        timestamp: new Date().toISOString(),
        uptime: uptime,
        version: this.healthStatus.version,
        dependencies: dependencyResults,
        deepChecks: deepChecks,
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          ppid: process.ppid,
          uid: process.getuid ? process.getuid() : null,
          gid: process.getgid ? process.getgid() : null
        }
      };

      res.status(200).json(deepHealthData);
    } catch (error) {
      res.status(500).json({
        status: 'deep_check_failed',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  }

  async checkFileSystem() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      
      const logDir = path.dirname(config.logging.file);
      const testFile = path.join(logDir, 'health-check-test.tmp');
      
      await fs.writeFile(testFile, 'health check test');
      await fs.unlink(testFile);

      return {
        status: 'healthy',
        message: 'File system access OK'
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `File system check failed: ${error.message}`
      };
    }
  }

  checkEventLoop() {
    const startTime = process.hrtime.bigint();
    
    return new Promise((resolve) => {
      setImmediate(() => {
        const endTime = process.hrtime.bigint();
        const lag = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds

        resolve({
          status: lag < 100 ? 'healthy' : 'degraded',
          lag: Math.round(lag * 100) / 100,
          message: lag < 100 ? 'Event loop lag OK' : 'Event loop lag detected'
        });
      });
    });
  }

  validateConfiguration() {
    const issues = [];

    if (!config.jwt.secret || config.jwt.secret === 'default-secret-change-me') {
      issues.push('JWT secret not properly configured');
    }

    if (!config.redis.host) {
      issues.push('Redis host not configured');
    }

    if (config.routes.length === 0) {
      issues.push('No routes configured');
    }

    return {
      status: issues.length === 0 ? 'healthy' : 'warning',
      issues: issues,
      message: issues.length === 0 ? 'Configuration OK' : `Configuration issues: ${issues.length}`
    };
  }

  
  setupRoutes(app) {
    app.get('/health/live', ErrorHandler.asyncHandler(this.liveness.bind(this)));
    app.get('/health/ready', ErrorHandler.asyncHandler(this.readiness.bind(this)));
    app.get('/health', ErrorHandler.asyncHandler(this.health.bind(this)));
    app.get('/health/deep', ErrorHandler.asyncHandler(this.deep.bind(this)));
    
    app.get('/ping', (req, res) => {
      res.status(200).json({
        status: 'pong',
        timestamp: new Date().toISOString(),
        requestId: req.requestId
      });
    });

    app.get('/version', (req, res) => {
      res.status(200).json({
        version: this.healthStatus.version,
        name: 'API Gateway',
        description: 'API Gateway with authentication, rate limiting, and circuit breaker',
        node: process.version,
        timestamp: new Date().toISOString()
      });
    });
  }

  updateStatus(status, message = null) {
    this.healthStatus.status = status;
    this.healthStatus.timestamp = new Date().toISOString();
    this.healthStatus.uptime = Date.now() - this.startTime;
    
    if (message) {
      this.healthStatus.message = message;
    }
  }

  
  markReady() {
    this.updateStatus('ready', 'Gateway is ready to serve traffic');
  }

  markNotReady(reason) {
    this.updateStatus('not_ready', reason);
  }
}

module.exports = HealthCheck;