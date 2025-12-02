const jwt = require('jsonwebtoken');
const config = require('../config');
const ErrorHandler = require('../utils/errorHandler');
const logger = require('./logging');

class AuthLayer {
  constructor() {
    this.jwtSecret = config.jwt.secret;
  }

  extractToken(req) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return null;
    }
  
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return authHeader;
  }

  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      return decoded;
    } catch (error) {
      throw ErrorHandler.handleAuthError(error);
    }
  }

  isTokenExpired(decoded) {
    if (!decoded.exp) {
      return false; 
    }

    const currentTime = Math.floor(Date.now() / 1000);
    return decoded.exp < currentTime;
  }

  
  extractUserContext(decoded) {
    return {
      id: decoded.sub || decoded.userId || decoded.id,
      username: decoded.username || decoded.user || null,
      email: decoded.email || null,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
      tier: decoded.tier || 'basic',
      iat: decoded.iat,
      exp: decoded.exp
    };
  }

  optionalAuth() {
    return async (req, res, next) => {
      try {
        const token = this.extractToken(req);
        
        if (!token) {
          logger.logAuth(req.requestId, 'no_token');
          req.context.user = null;
          return next();
        }

        const decoded = await this.verifyToken(token);
        const userContext = this.extractUserContext(decoded);
        
        req.context.user = userContext;
        req.context.authenticated = true;
        
        logger.logAuth(req.requestId, 'success', {
          userId: userContext.id,
          username: userContext.username,
          tier: userContext.tier
        });

        next();
      } catch (error) {
        logger.logAuth(req.requestId, 'optional_auth_failed', {
          error: error.message,
          errorCode: error.errorCode
        });
        
        req.context.user = null;
        req.context.authenticated = false;
        next();
      }
    };
  }

  
  requireAuth() {
    return async (req, res, next) => {
      try {
        const token = this.extractToken(req);
        
        if (!token) {
          logger.logAuth(req.requestId, 'missing_token');
          throw ErrorHandler.createError(
            'Authorization token is required',
            401,
            'MISSING_TOKEN'
          );
        }

        const decoded = await this.verifyToken(token);
        const userContext = this.extractUserContext(decoded);
        
        req.context.user = userContext;
        req.context.authenticated = true;
        
        logger.logAuth(req.requestId, 'success', {
          userId: userContext.id,
          username: userContext.username,
          tier: userContext.tier
        });

        next();
      } catch (error) {
        logger.logAuth(req.requestId, 'failure', {
          error: error.message,
          errorCode: error.errorCode || 'AUTH_ERROR'
        });
        
        next(error);
      }
    };
  }

  requireRole(requiredRoles) {
    if (!Array.isArray(requiredRoles)) {
      requiredRoles = [requiredRoles];
    }

    return (req, res, next) => {
      if (!req.context.user) {
        logger.logAuth(req.requestId, 'authorization_failed', {
          reason: 'no_user_context',
          requiredRoles
        });
        
        return next(ErrorHandler.createError(
          'Authentication required for this endpoint',
          401,
          'AUTHENTICATION_REQUIRED'
        ));
      }

      const userRoles = req.context.user.roles || [];
      const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

      if (!hasRequiredRole) {
        logger.logAuth(req.requestId, 'authorization_failed', {
          userId: req.context.user.id,
          userRoles,
          requiredRoles
        });

        return next(ErrorHandler.createError(
          'Insufficient permissions',
          403,
          'INSUFFICIENT_PERMISSIONS',
          { required: requiredRoles, current: userRoles }
        ));
      }

      logger.logAuth(req.requestId, 'authorization_success', {
        userId: req.context.user.id,
        userRoles,
        requiredRoles
      });

      next();
    };
  }

  requirePermission(requiredPermissions) {
    if (!Array.isArray(requiredPermissions)) {
      requiredPermissions = [requiredPermissions];
    }

    return (req, res, next) => {
      if (!req.context.user) {
        return next(ErrorHandler.createError(
          'Authentication required for this endpoint',
          401,
          'AUTHENTICATION_REQUIRED'
        ));
      }

      const userPermissions = req.context.user.permissions || [];
      const hasRequiredPermission = requiredPermissions.some(permission => 
        userPermissions.includes(permission)
      );

      if (!hasRequiredPermission) {
        logger.logAuth(req.requestId, 'authorization_failed', {
          userId: req.context.user.id,
          userPermissions,
          requiredPermissions
        });

        return next(ErrorHandler.createError(
          'Insufficient permissions',
          403,
          'INSUFFICIENT_PERMISSIONS',
          { required: requiredPermissions, current: userPermissions }
        ));
      }

      next();
    };
  }

  generateToken(payload, options = {}) {
    const defaultOptions = {
      expiresIn: config.jwt.expiry,
      issuer: 'api-gateway',
      audience: 'api-services'
    };

    return jwt.sign(payload, this.jwtSecret, { ...defaultOptions, ...options });
  }

  
  createTestToken(userId, options = {}) {
    const payload = {
      sub: userId,
      username: options.username || `user_${userId}`,
      email: options.email || `user${userId}@example.com`,
      roles: options.roles || ['user'],
      permissions: options.permissions || ['read'],
      tier: options.tier || 'basic',
      iat: Math.floor(Date.now() / 1000)
    };

    return this.generateToken(payload, options);
  }
}

module.exports = AuthLayer;