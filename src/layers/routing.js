const { pathToRegexp } = require('path-to-regexp');
const config = require('../config');
const ErrorHandler = require('../utils/errorHandler');
const logger = require('./logging');

class RoutingLayer {
  constructor() {
    this.routes = [];
    this.compiledRoutes = [];
    this.initializeRoutes();
  }
  initializeRoutes() {
    this.routes = config.routes.map(route => ({
      ...route,
      timeout: route.timeout || 5000,
      retries: route.retries || 3,
      authRequired: route.authRequired !== false, // Default to true
      rateLimitTier: route.rateLimitTier || 'basic',
      methods: route.methods || ['GET'],
      stripPath: route.stripPath !== false, // Default to true
      preserveHost: route.preserveHost === true, // Default to false
      changeOrigin: route.changeOrigin !== false // Default to true
    }));

    this.compiledRoutes = this.routes.map(route => ({
      ...route,
      regexp: pathToRegexp(route.path, [], { sensitive: false, strict: false }),
      originalPath: route.path
    }));

    logger.logSystem('info', 'Routes initialized', { 
      routeCount: this.routes.length,
      routes: this.routes.map(r => ({ path: r.path, target: r.target, methods: r.methods }))
    });
  }

  findRoute(req) {
    const { method, path } = req;
    
    for (const route of this.compiledRoutes) {
      if (!route.methods.includes(method)) {
        continue;
      }
      const match = route.regexp.exec(path);
      if (match) {
        return {
          route,
          match,
          params: this.extractParams(route.originalPath, path)
        };
      }
    }

    return null;
  }

  extractParams(pattern, path) {
    const keys = [];
    const regexp = pathToRegexp(pattern, keys, { sensitive: false, strict: false });
    const match = regexp.exec(path);
    
    if (!match) return {};

    const params = {};
    keys.forEach((key, index) => {
      params[key.name] = match[index + 1];
    });

    return params;
  }

  buildTargetUrl(route, req) {
    let targetPath = req.path;

    if (route.stripPath) {
      const routePathRegex = new RegExp(`^${route.originalPath.replace(/\/\*$/, '')}`);
      targetPath = req.path.replace(routePathRegex, '') || '/';
    }
    if (!targetPath.startsWith('/')) {
      targetPath = '/' + targetPath;
    }
    const targetBase = route.target.replace(/\/$/, '');
    const targetUrl = `${targetBase}${targetPath}`;
    if (req.query && Object.keys(req.query).length > 0) {
      const queryString = new URLSearchParams(req.query).toString();
      return `${targetUrl}?${queryString}`;
    }

    return targetUrl;
  }
  validateRoute(route) {
    const errors = [];

    if (!route.path) {
      errors.push('Route path is required');
    }

    if (!route.target) {
      errors.push('Route target is required');
    }

    if (route.target && !this.isValidUrl(route.target)) {
      errors.push('Route target must be a valid URL');
    }

    if (route.timeout && (typeof route.timeout !== 'number' || route.timeout <= 0)) {
      errors.push('Route timeout must be a positive number');
    }

    if (route.retries && (typeof route.retries !== 'number' || route.retries < 0)) {
      errors.push('Route retries must be a non-negative number');
    }

    if (route.methods && !Array.isArray(route.methods)) {
      errors.push('Route methods must be an array');
    }

    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    if (route.methods) {
      const invalidMethods = route.methods.filter(method => !validMethods.includes(method));
      if (invalidMethods.length > 0) {
        errors.push(`Invalid HTTP methods: ${invalidMethods.join(', ')}`);
      }
    }

    return errors;
  }

  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }

  middleware() {
    return (req, res, next) => {
      try {
        const routeMatch = this.findRoute(req);
        
        if (!routeMatch) {
          logger.logSystem('warn', 'No route found', {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            availableRoutes: this.routes.map(r => r.path)
          });

          return next(ErrorHandler.createError(
            `No route found for ${req.method} ${req.path}`,
            404,
            'ROUTE_NOT_FOUND',
            {
              method: req.method,
              path: req.path,
              availableRoutes: this.routes.map(r => ({
                path: r.path,
                methods: r.methods
              }))
            }
          ));
        }

        const { route, params } = routeMatch;

        const targetUrl = this.buildTargetUrl(route, req);

        req.context.route = {
          path: route.path,
          target: route.target,
          targetUrl,
          timeout: route.timeout,
          retries: route.retries,
          authRequired: route.authRequired,
          rateLimitTier: route.rateLimitTier,
          methods: route.methods,
          stripPath: route.stripPath,
          preserveHost: route.preserveHost,
          changeOrigin: route.changeOrigin,
          params
        };

        logger.logSystem('debug', 'Route matched', {
          requestId: req.requestId,
          method: req.method,
          originalPath: req.path,
          matchedRoute: route.path,
          targetUrl,
          authRequired: route.authRequired,
          rateLimitTier: route.rateLimitTier
        });

        next();
      } catch (error) {
        logger.logSystem('error', 'Route resolution failed', {
          requestId: req.requestId,
          error: error.message,
          method: req.method,
          path: req.path
        });

        next(ErrorHandler.createError(
          'Route resolution failed',
          500,
          'ROUTE_RESOLUTION_ERROR',
          { originalError: error.message }
        ));
      }
    };
  }

  addRoute(routeConfig) {
    const errors = this.validateRoute(routeConfig);
    if (errors.length > 0) {
      throw ErrorHandler.createError(
        'Invalid route configuration',
        400,
        'INVALID_ROUTE_CONFIG',
        { errors }
      );
    }
    const route = {
      ...routeConfig,
      timeout: routeConfig.timeout || 5000,
      retries: routeConfig.retries || 3,
      authRequired: routeConfig.authRequired !== false,
      rateLimitTier: routeConfig.rateLimitTier || 'basic',
      methods: routeConfig.methods || ['GET'],
      stripPath: routeConfig.stripPath !== false,
      preserveHost: routeConfig.preserveHost === true,
      changeOrigin: routeConfig.changeOrigin !== false
    };

    this.routes.push(route);
    this.compiledRoutes.push({
      ...route,
      regexp: pathToRegexp(route.path, [], { sensitive: false, strict: false }),
      originalPath: route.path
    });

    logger.logSystem('info', 'Route added', {
      path: route.path,
      target: route.target,
      methods: route.methods
    });

    return route;
  }

  removeRoute(path) {
    const initialLength = this.routes.length;
    
    this.routes = this.routes.filter(route => route.path !== path);
    this.compiledRoutes = this.compiledRoutes.filter(route => route.originalPath !== path);

    const removed = initialLength - this.routes.length;
    
    if (removed > 0) {
      logger.logSystem('info', 'Route removed', { path, routesRemoved: removed });
    }

    return removed > 0;
  }

  getRoutes() {
    return this.routes.map(route => ({
      path: route.path,
      target: route.target,
      methods: route.methods,
      timeout: route.timeout,
      retries: route.retries,
      authRequired: route.authRequired,
      rateLimitTier: route.rateLimitTier
    }));
  }

  getStats() {
    const methodCounts = {};
    const tierCounts = {};
    
    this.routes.forEach(route => {
      route.methods.forEach(method => {
        methodCounts[method] = (methodCounts[method] || 0) + 1;
      });
      
      tierCounts[route.rateLimitTier] = (tierCounts[route.rateLimitTier] || 0) + 1;
    });

    return {
      totalRoutes: this.routes.length,
      methodCounts,
      tierCounts,
      authRequiredCount: this.routes.filter(r => r.authRequired).length,
      authOptionalCount: this.routes.filter(r => !r.authRequired).length
    };
  }
}

module.exports = RoutingLayer;