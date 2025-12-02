class MetricsCollector {
  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        byMethod: {},
        byRoute: {},
        byStatus: {},
        byUser: {}
      },

      responseTime: {
        total: 0,
        count: 0,
        min: Infinity,
        max: 0,
        buckets: {
          '<50ms': 0,
          '50-100ms': 0,
          '100-200ms': 0,
          '200-500ms': 0,
          '500ms-1s': 0,
          '1-2s': 0,
          '2-5s': 0,
          '>5s': 0
        },
        byRoute: {}
      },

      errors: {
        total: 0,
        byType: {},
        byRoute: {},
        byStatusCode: {},
        upstream: {
          total: 0,
          byService: {},
          byErrorType: {}
        }
      },

      rateLimiting: {
        total: 0,
        byTier: {},
        byUser: {},
        resets: 0
      },

      circuitBreaker: {
        states: {},
        transitions: {
          opened: 0,
          closed: 0,
          halfOpen: 0
        },
        byService: {}
      },

      authentication: {
        total: 0,
        successful: 0,
        failed: 0,
        byReason: {},
        tokenTypes: {}
      },

      system: {
        uptime: Date.now(),
        memory: 0,
        cpu: 0
      }
    };

    this.startTime = Date.now();
    this.lastReset = Date.now();
    this.startSystemMetricsCollection();
  }

  recordRequest(req, res, duration, error = null) {
    const method = req.method;
    const route = req.context.route?.path || 'unknown';
    const statusCode = res.statusCode;
    const userId = req.context.user?.id || 'anonymous';

    this.metrics.requests.total++;
    this.incrementCounter(this.metrics.requests.byMethod, method);
    this.incrementCounter(this.metrics.requests.byRoute, route);
    this.incrementCounter(this.metrics.requests.byStatus, statusCode.toString());
    this.incrementCounter(this.metrics.requests.byUser, userId);

    this.recordResponseTime(duration, route);

    if (error || statusCode >= 400) {
      this.recordError(error, route, statusCode, req);
    }
  }

  recordResponseTime(duration, route) {
    this.metrics.responseTime.total += duration;
    this.metrics.responseTime.count++;
    this.metrics.responseTime.min = Math.min(this.metrics.responseTime.min, duration);
    this.metrics.responseTime.max = Math.max(this.metrics.responseTime.max, duration);

    if (duration < 50) {
      this.metrics.responseTime.buckets['<50ms']++;
    } else if (duration < 100) {
      this.metrics.responseTime.buckets['50-100ms']++;
    } else if (duration < 200) {
      this.metrics.responseTime.buckets['100-200ms']++;
    } else if (duration < 500) {
      this.metrics.responseTime.buckets['200-500ms']++;
    } else if (duration < 1000) {
      this.metrics.responseTime.buckets['500ms-1s']++;
    } else if (duration < 2000) {
      this.metrics.responseTime.buckets['1-2s']++;
    } else if (duration < 5000) {
      this.metrics.responseTime.buckets['2-5s']++;
    } else {
      this.metrics.responseTime.buckets['>5s']++;
    }

    if (!this.metrics.responseTime.byRoute[route]) {
      this.metrics.responseTime.byRoute[route] = {
        total: 0,
        count: 0,
        min: Infinity,
        max: 0,
        average: 0
      };
    }

    const routeMetrics = this.metrics.responseTime.byRoute[route];
    routeMetrics.total += duration;
    routeMetrics.count++;
    routeMetrics.min = Math.min(routeMetrics.min, duration);
    routeMetrics.max = Math.max(routeMetrics.max, duration);
    routeMetrics.average = routeMetrics.total / routeMetrics.count;
  }

  recordError(error, route, statusCode, req) {
    this.metrics.errors.total++;
    
    if (error) {
      this.incrementCounter(this.metrics.errors.byType, error.errorCode || error.name || 'UnknownError');
      
      if (error.errorCode === 'UPSTREAM_ERROR' || error.errorCode === 'SERVICE_UNAVAILABLE') {
        this.metrics.errors.upstream.total++;
        const serviceName = error.details?.service || 'unknown';
        this.incrementCounter(this.metrics.errors.upstream.byService, serviceName);
        this.incrementCounter(this.metrics.errors.upstream.byErrorType, error.errorCode);
      }
    }

    this.incrementCounter(this.metrics.errors.byRoute, route);
    this.incrementCounter(this.metrics.errors.byStatusCode, statusCode.toString());
  }

 
  recordRateLimiting(event, tier, userId, req) {
    if (event === 'exceeded') {
      this.metrics.rateLimiting.total++;
      this.incrementCounter(this.metrics.rateLimiting.byTier, tier);
      this.incrementCounter(this.metrics.rateLimiting.byUser, userId || req.context.clientIp);
    } else if (event === 'reset') {
      this.metrics.rateLimiting.resets++;
    }
  }

  recordCircuitBreaker(serviceName, event, state) {
    if (!this.metrics.circuitBreaker.byService[serviceName]) {
      this.metrics.circuitBreaker.byService[serviceName] = {
        opened: 0,
        closed: 0,
        halfOpen: 0,
        failures: 0,
        successes: 0,
        currentState: 'closed'
      };
    }

    const serviceMetrics = this.metrics.circuitBreaker.byService[serviceName];
    
    if (event === 'opened') {
      this.metrics.circuitBreaker.transitions.opened++;
      serviceMetrics.opened++;
      serviceMetrics.currentState = 'open';
    } else if (event === 'closed') {
      this.metrics.circuitBreaker.transitions.closed++;
      serviceMetrics.closed++;
      serviceMetrics.currentState = 'closed';
    } else if (event === 'half-open') {
      this.metrics.circuitBreaker.transitions.halfOpen++;
      serviceMetrics.halfOpen++;
      serviceMetrics.currentState = 'half-open';
    } else if (event === 'failure') {
      serviceMetrics.failures++;
    } else if (event === 'success') {
      serviceMetrics.successes++;
    }

    this.metrics.circuitBreaker.states[serviceName] = serviceMetrics.currentState;
  }

  recordAuthentication(event, reason = null, tokenType = null) {
    this.metrics.authentication.total++;

    if (event === 'success') {
      this.metrics.authentication.successful++;
    } else if (event === 'failure') {
      this.metrics.authentication.failed++;
      if (reason) {
        this.incrementCounter(this.metrics.authentication.byReason, reason);
      }
    }

    if (tokenType) {
      this.incrementCounter(this.metrics.authentication.tokenTypes, tokenType);
    }
  }

  incrementCounter(map, key, amount = 1) {
    map[key] = (map[key] || 0) + amount;
  }

  getMetrics() {
    const uptime = Date.now() - this.startTime;
    const averageResponseTime = this.metrics.responseTime.count > 0 
      ? this.metrics.responseTime.total / this.metrics.responseTime.count 
      : 0;

    return {
      ...this.metrics,
      computed: {
        uptime,
        averageResponseTime: Math.round(averageResponseTime * 100) / 100,
        requestsPerSecond: this.metrics.requests.total / (uptime / 1000),
        errorRate: this.metrics.requests.total > 0 
          ? (this.metrics.errors.total / this.metrics.requests.total) * 100 
          : 0,
        successRate: this.metrics.requests.total > 0 
          ? ((this.metrics.requests.total - this.metrics.errors.total) / this.metrics.requests.total) * 100 
          : 100
      },
      timestamp: new Date().toISOString(),
      collectionPeriod: {
        start: new Date(this.startTime).toISOString(),
        duration: uptime
      }
    };
  }

  getSummary() {
    const metrics = this.getMetrics();
    
    return {
      requests: {
        total: metrics.requests.total,
        perSecond: Math.round(metrics.computed.requestsPerSecond * 100) / 100,
        errorRate: Math.round(metrics.computed.errorRate * 100) / 100,
        successRate: Math.round(metrics.computed.successRate * 100) / 100
      },
      responseTime: {
        average: metrics.computed.averageResponseTime,
        min: metrics.responseTime.min === Infinity ? 0 : metrics.responseTime.min,
        max: metrics.responseTime.max
      },
      errors: {
        total: metrics.errors.total,
        upstream: metrics.errors.upstream.total,
        rateLimiting: metrics.rateLimiting.total
      },
      circuitBreakers: {
        services: Object.keys(metrics.circuitBreaker.states).length,
        openCircuits: Object.values(metrics.circuitBreaker.states)
          .filter(state => state === 'open').length
      },
      system: {
        uptime: metrics.computed.uptime,
        memory: metrics.system.memory,
        cpu: metrics.system.cpu
      }
    };
  }

  reset() {
    const oldStartTime = this.startTime;
    this.__init__();
    this.lastReset = Date.now();
    
    return {
      message: 'Metrics reset successfully',
      previousCollectionPeriod: Date.now() - oldStartTime,
      resetAt: new Date().toISOString()
    };
  }

  startSystemMetricsCollection() {
    setInterval(() => {
      const memUsage = process.memoryUsage();
      this.metrics.system.memory = Math.round(memUsage.heapUsed / 1024 / 1024); // MB
      
      const startUsage = process.cpuUsage();
      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const totalUsage = endUsage.user + endUsage.system;
        this.metrics.system.cpu = Math.round((totalUsage / 1000) / 10); // Rough percentage
      }, 100);
    }, 30000); 
  }

  middleware() {
    return (req, res, next) => {
      const startTime = Date.now();
      const originalEnd = res.end;
      
      res.end = (...args) => {
        const duration = Date.now() - startTime;

        this.recordRequest(req, res, duration);
        originalEnd.apply(res, args);
      };

      next();
    };
  }

  getTopRoutes(limit = 10) {
    return Object.entries(this.metrics.requests.byRoute)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([route, count]) => ({ route, count }));
  }

  getTopErrorRoutes(limit = 10) {
    return Object.entries(this.metrics.errors.byRoute)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([route, count]) => ({ route, count }));
  }

  getSlowestRoutes(limit = 10) {
    return Object.entries(this.metrics.responseTime.byRoute)
      .sort(([, a], [, b]) => b.average - a.average)
      .slice(0, limit)
      .map(([route, metrics]) => ({ 
        route, 
        average: Math.round(metrics.average * 100) / 100,
        max: metrics.max,
        count: metrics.count
      }));
  }
}

const metricsCollector = new MetricsCollector();

module.exports = metricsCollector;