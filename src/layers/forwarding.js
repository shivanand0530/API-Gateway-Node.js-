const axios = require('axios');
const config = require('../config');
const ErrorHandler = require('../utils/errorHandler');
const logger = require('./logging');

const CIRCUIT_STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open'
};

class CircuitBreaker {
  constructor(serviceName, options = {}) {
    this.serviceName = serviceName;
    this.failureThreshold = options.failureThreshold || config.circuitBreaker.failureThreshold;
    this.recoveryTimeout = options.recoveryTimeout || config.circuitBreaker.recoveryTimeout;
    this.monitorTimeout = options.monitorTimeout || config.circuitBreaker.monitorTimeout;
    
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.successCount = 0;
  }

  async execute(requestFn, requestId) {
    if (this.state === CIRCUIT_STATES.OPEN) {
      if (Date.now() < this.nextAttempt) {
        logger.logCircuitBreaker(requestId, this.serviceName, 'blocked', {
          state: this.state,
          nextAttempt: new Date(this.nextAttempt).toISOString()
        });
        throw ErrorHandler.handleCircuitBreakerError(this.serviceName, this.state);
      }
      
      this.state = CIRCUIT_STATES.HALF_OPEN;
      this.successCount = 0;
      logger.logCircuitBreaker(requestId, this.serviceName, 'half-open', {
        previousState: CIRCUIT_STATES.OPEN
      });
    }

    try {
      const result = await requestFn();
      this.onSuccess(requestId);
      return result;
    } catch (error) {
      this.onFailure(requestId, error);
      throw error;
    }
  }

  onSuccess(requestId) {
    this.failureCount = 0;
    
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= 3) {
        this.state = CIRCUIT_STATES.CLOSED;
        logger.logCircuitBreaker(requestId, this.serviceName, 'closed', {
          previousState: CIRCUIT_STATES.HALF_OPEN,
          successCount: this.successCount
        });
      } else {
        logger.logCircuitBreaker(requestId, this.serviceName, 'success', {
          state: this.state,
          successCount: this.successCount
        });
      }
    } else {
      logger.logCircuitBreaker(requestId, this.serviceName, 'success', {
        state: this.state
      });
    }
  }

  onFailure(requestId, error) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    logger.logCircuitBreaker(requestId, this.serviceName, 'failure', {
      state: this.state,
      failureCount: this.failureCount,
      error: error.message
    });

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.state = CIRCUIT_STATES.OPEN;
      this.nextAttempt = Date.now() + this.recoveryTimeout;
      logger.logCircuitBreaker(requestId, this.serviceName, 'opened', {
        reason: 'failure_in_half_open',
        nextAttempt: new Date(this.nextAttempt).toISOString()
      });
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = CIRCUIT_STATES.OPEN;
      this.nextAttempt = Date.now() + this.recoveryTimeout;
      logger.logCircuitBreaker(requestId, this.serviceName, 'opened', {
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
        nextAttempt: new Date(this.nextAttempt).toISOString()
      });
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      successCount: this.successCount
    };
  }

  reset() {
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.successCount = 0;
  }
}

class ForwardingLayer {
  constructor() {
    this.circuitBreakers = new Map();
    this.axiosInstance = this.createAxiosInstance();
  }

  createAxiosInstance() {
    return axios.create({
      timeout: 30000, 
      maxRedirects: 5,
      validateStatus: null, 
      headers: {
        'User-Agent': 'API-Gateway/1.0.0'
      }
    });
  }

  getCircuitBreaker(serviceName) {
    if (!this.circuitBreakers.has(serviceName)) {
      this.circuitBreakers.set(serviceName, new CircuitBreaker(serviceName));
    }
    return this.circuitBreakers.get(serviceName);
  }

  extractServiceName(targetUrl) {
    try {
      const url = new URL(targetUrl);
      return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
    } catch (error) {
      return 'unknown-service';
    }
  }

  async forwardRequest(req, res, route, maxRetries = null) {
    const retries = maxRetries !== null ? maxRetries : route.retries;
    const serviceName = this.extractServiceName(route.target);
    const circuitBreaker = this.getCircuitBreaker(serviceName);
    
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const isRetry = attempt > 0;
      
      if (isRetry) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        const jitter = Math.random() * 0.1 * delay;
        await new Promise(resolve => setTimeout(resolve, delay + jitter));
        
        logger.logSystem('info', 'Retrying upstream request', {
          requestId: req.requestId,
          serviceName,
          attempt: attempt + 1,
          maxRetries: retries + 1,
          delay: delay + jitter
        });
      }

      try {
        const startTime = Date.now();
        
        const result = await circuitBreaker.execute(async () => {
          logger.logUpstreamStart(req.requestId, req.method, route.targetUrl, serviceName);
          
          const response = await this.makeRequest(req, route);
          
          const duration = Date.now() - startTime;
          logger.logUpstreamComplete(
            req.requestId, 
            req.method, 
            route.targetUrl, 
            serviceName, 
            response.status, 
            duration
          );
          
          return response;
        }, req.requestId);

        return this.forwardResponse(result, res, req.requestId);

      } catch (error) {
        lastError = error;
        const duration = Date.now() - startTime;
        
        logger.logUpstreamComplete(
          req.requestId, 
          req.method, 
          route.targetUrl, 
          serviceName, 
          error.response?.status || 0, 
          duration,
          error
        );

        if (error.errorCode === 'CIRCUIT_BREAKER_OPEN' || 
            (error.response && [400, 401, 403, 404, 422].includes(error.response.status))) {
          break;
        }
      }
    }

    throw ErrorHandler.mapUpstreamError(lastError, serviceName);
  }

  async makeRequest(req, route) {
    const requestConfig = {
      method: req.method.toLowerCase(),
      url: route.targetUrl,
      timeout: route.timeout,
      headers: this.buildUpstreamHeaders(req, route),
      validateStatus: null
    };
  
    if (req.body && ['post', 'put', 'patch'].includes(requestConfig.method)) {
      requestConfig.data = req.body;
    }

    if (req.query && Object.keys(req.query).length > 0) {
      requestConfig.params = req.query;
    }

    try {
      return await this.axiosInstance(requestConfig);
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw ErrorHandler.createError(
          'Request timeout',
          504,
          'GATEWAY_TIMEOUT',
          { timeout: route.timeout, service: this.extractServiceName(route.target) }
        );
      }
      
      throw error;
    }
  }

  buildUpstreamHeaders(req, route) {
    const headers = { ...req.headers };

    const hopByHopHeaders = [
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade'
    ];

    hopByHopHeaders.forEach(header => {
      delete headers[header];
    });

    if (!route.preserveHost) {
      const targetUrl = new URL(route.target);
      headers.host = targetUrl.host;
    }

    headers['x-forwarded-for'] = req.context.clientIp;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-host'] = req.get('host');
    headers['x-request-id'] = req.requestId;

    if (req.context.user) {
      headers['x-user-id'] = req.context.user.id;
      headers['x-user-roles'] = req.context.user.roles.join(',');
      headers['x-user-tier'] = req.context.user.tier;
    }

    return headers;
  }

  forwardResponse(upstreamResponse, clientResponse, requestId) {
    try {
      clientResponse.status(upstreamResponse.status);
      const hopByHopHeaders = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade'
      ];

      Object.entries(upstreamResponse.headers || {}).forEach(([key, value]) => {
        if (!hopByHopHeaders.includes(key.toLowerCase())) {
          clientResponse.setHeader(key, value);
        }
      });
      clientResponse.setHeader('X-Gateway-Service', 'api-gateway');
      clientResponse.setHeader('X-Request-ID', requestId);

      if (upstreamResponse.data) {
        clientResponse.send(upstreamResponse.data);
      } else {
        clientResponse.end();
      }

    } catch (error) {
      logger.logSystem('error', 'Failed to forward response', {
        requestId,
        error: error.message,
        upstreamStatus: upstreamResponse.status
      });
      
      throw ErrorHandler.createError(
        'Failed to forward response',
        502,
        'RESPONSE_FORWARD_ERROR',
        { originalError: error.message }
      );
    }
  }

  middleware() {
    return async (req, res, next) => {
      try {
        if (!req.context.route) {
          return next(ErrorHandler.createError(
            'No route context found',
            500,
            'MISSING_ROUTE_CONTEXT'
          ));
        }

        await this.forwardRequest(req, res, req.context.route);
      } catch (error) {
        next(error);
      }
    };
  }

  getCircuitBreakerStates() {
    const states = {};
    this.circuitBreakers.forEach((breaker, serviceName) => {
      states[serviceName] = breaker.getState();
    });
    return states;
  }

  resetCircuitBreaker(serviceName) {
    const breaker = this.circuitBreakers.get(serviceName);
    if (breaker) {
      breaker.reset();
      logger.logSystem('info', 'Circuit breaker reset', { serviceName });
      return true;
    }
    return false;
  }

  getHealthStatus() {
    const states = this.getCircuitBreakerStates();
    const unhealthyServices = Object.entries(states)
      .filter(([_, state]) => state.state === CIRCUIT_STATES.OPEN)
      .map(([service]) => service);

    return {
      healthy: unhealthyServices.length === 0,
      totalServices: this.circuitBreakers.size,
      unhealthyServices,
      states
    };
  }
}

module.exports = ForwardingLayer;