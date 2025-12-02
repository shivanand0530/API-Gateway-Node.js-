class GatewayError extends Error {
  constructor(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = 'GatewayError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

class ErrorHandler {
  static createError(message, statusCode = 500, errorCode = 'INTERNAL_ERROR', details = null) {
    return new GatewayError(message, statusCode, errorCode, details);
  }

  static mapUpstreamError(error, serviceName) {
    if (error.code === 'ECONNREFUSED') {
      return new GatewayError(
        `Service ${serviceName} is unavailable`,
        503,
        'SERVICE_UNAVAILABLE',
        { service: serviceName, originalError: error.message }
      );
    }

    if (error.code === 'ETIMEDOUT' || error.name === 'TimeoutError') {
      return new GatewayError(
        `Service ${serviceName} request timed out`,
        504,
        'GATEWAY_TIMEOUT',
        { service: serviceName, originalError: error.message }
      );
    }

    if (error.response) {
      const statusCode = error.response.status || 502;
      const mappedStatusCode = statusCode >= 500 ? 502 : statusCode;
      
      return new GatewayError(
        error.response.data?.message || `Upstream service error: ${error.message}`,
        mappedStatusCode,
        'UPSTREAM_ERROR',
        {
          service: serviceName,
          upstreamStatus: statusCode,
          originalError: error.message
        }
      );
    }

    return new GatewayError(
      `Unknown error from service ${serviceName}`,
      502,
      'BAD_GATEWAY',
      { service: serviceName, originalError: error.message }
    );
  }

  static handleAuthError(error) {
    if (error.name === 'TokenExpiredError') {
      return new GatewayError(
        'Token has expired',
        401,
        'TOKEN_EXPIRED',
        { expiredAt: error.expiredAt }
      );
    }

    if (error.name === 'JsonWebTokenError') {
      return new GatewayError(
        'Invalid token',
        401,
        'INVALID_TOKEN',
        { reason: error.message }
      );
    }

    if (error.name === 'NotBeforeError') {
      return new GatewayError(
        'Token not active',
        401,
        'TOKEN_NOT_ACTIVE',
        { date: error.date }
      );
    }

    return new GatewayError(
      'Authentication failed',
      401,
      'AUTH_FAILED',
      { originalError: error.message }
    );
  }

  static handleRateLimitError(remaining, resetTime, tier) {
    return new GatewayError(
      'Rate limit exceeded',
      429,
      'RATE_LIMIT_EXCEEDED',
      {
        remaining,
        resetTime,
        tier
      }
    );
  }

  static handleCircuitBreakerError(serviceName, state) {
    return new GatewayError(
      `Service ${serviceName} is temporarily unavailable`,
      503,
      'CIRCUIT_BREAKER_OPEN',
      {
        service: serviceName,
        state,
        message: 'Circuit breaker is open due to repeated failures'
      }
    );
  }

  static handleValidationError(errors) {
    return new GatewayError(
      'Request validation failed',
      400,
      'VALIDATION_ERROR',
      { validationErrors: errors }
    );
  }

  static middleware() {
    return (error, req, res, next) => {
      if (res.headersSent) {
        return next(error);
      }

      if (error instanceof GatewayError) {
        return res.status(error.statusCode).json({
          error: error.errorCode,
          message: error.message,
          details: error.details,
          requestId: req.requestId,
          timestamp: error.timestamp
        });
      }

      console.error('Unexpected error:', error);
      
      const statusCode = error.statusCode || error.status || 500;
      const errorResponse = {
        error: 'INTERNAL_SERVER_ERROR',
        message: process.env.NODE_ENV === 'production' 
          ? 'An internal server error occurred' 
          : error.message,
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      };

      if (process.env.NODE_ENV !== 'production') {
        errorResponse.stack = error.stack;
      }

      res.status(statusCode).json(errorResponse);
    };
  }

  static asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  static successResponse(data, message = 'Success', statusCode = 200) {
    return {
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    };
  }
}
ErrorHandler.GatewayError = GatewayError;

ErrorHandler.StatusCodes = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

module.exports = ErrorHandler;