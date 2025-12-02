const winston = require('winston');
const config = require('../config');

class Logger {
  constructor() {
    this.logger = winston.createLogger({
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        new winston.transports.File({
          filename: config.logging.file,
          format: winston.format.json()
        })
      ]
    });
    const fs = require('fs');
    const path = require('path');
    const logDir = path.dirname(config.logging.file);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }


  logRequestStart(req) {
    this.logger.info('Request started', {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      path: req.path,
      userAgent: req.headers['user-agent'],
      clientIp: req.context.clientIp,
      timestamp: new Date(req.startTime).toISOString(),
      headers: this.sanitizeHeaders(req.headers)
    });
  }

  logRequestComplete(req, res, duration, statusCode, error = null) {
    const logData = {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      path: req.path,
      statusCode: statusCode || res.statusCode,
      duration: duration,
      clientIp: req.context.clientIp,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
      startTime: new Date(req.startTime).toISOString(),
      user: req.context.user ? req.context.user.id : null
    };

    if (error) {
      logData.error = {
        message: error.message,
        code: error.errorCode || error.code,
        stack: error.stack
      };
      this.logger.error('Request completed with error', logData);
    } else if (statusCode >= 400) {
      this.logger.warn('Request completed with error status', logData);
    } else {
      this.logger.info('Request completed successfully', logData);
    }
  }

  logUpstreamStart(requestId, method, targetUrl, serviceName) {
    this.logger.info('Upstream request started', {
      requestId,
      upstreamMethod: method,
      upstreamUrl: targetUrl,
      serviceName,
      timestamp: new Date().toISOString()
    });
  }

  logUpstreamComplete(requestId, method, targetUrl, serviceName, statusCode, duration, error = null) {
    const logData = {
      requestId,
      upstreamMethod: method,
      upstreamUrl: targetUrl,
      serviceName,
      upstreamStatusCode: statusCode,
      upstreamDuration: duration,
      timestamp: new Date().toISOString()
    };

    if (error) {
      logData.upstreamError = {
        message: error.message,
        code: error.code || 'UNKNOWN'
      };
      this.logger.error('Upstream request failed', logData);
    } else {
      this.logger.info('Upstream request completed', logData);
    }
  }

  logAuth(requestId, event, details = {}) {
    this.logger.info('Authentication event', {
      requestId,
      event, // 'success', 'failure', 'missing_token', etc.
      ...details,
      timestamp: new Date().toISOString()
    });
  }

  logRateLimit(requestId, event, details = {}) {
    const logLevel = event === 'exceeded' ? 'warn' : 'info';
    this.logger[logLevel]('Rate limit event', {
      requestId,
      event, // 'checked', 'exceeded', 'reset'
      ...details,
      timestamp: new Date().toISOString()
    });
  }

  
  logCircuitBreaker(requestId, serviceName, event, details = {}) {
    const logLevel = ['opened', 'failure'].includes(event) ? 'warn' : 'info';
    this.logger[logLevel]('Circuit breaker event', {
      requestId,
      serviceName,
      event, // 'opened', 'closed', 'half-open', 'success', 'failure'
      ...details,
      timestamp: new Date().toISOString()
    });
  }


  logSystem(level, message, details = {}) {
    this.logger[level](message, {
      ...details,
      timestamp: new Date().toISOString()
    });
  }

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    
    sensitiveHeaders.forEach(header => {
      if (sanitized[header]) {
        sanitized[header] = '[REDACTED]';
      }
    });

    return sanitized;
  }

  middleware() {
    return (req, res, next) => {
      this.logRequestStart(req);
      const originalEnd = res.end;
      res.end = (...args) => {
        const duration = Date.now() - req.startTime;
        this.logRequestComplete(req, res, duration, res.statusCode);
        originalEnd.apply(res, args);
      };

      next();
    };
  }
  getLogger() {
    return this.logger;
  }
}
const logger = new Logger();

module.exports = logger;