const { createClient } = require('redis');
const config = require('../config');
const ErrorHandler = require('../utils/errorHandler');
const logger = require('./logging');

class RateLimitLayer {
  constructor() {
    this.redisClient = null;
    this.isConnected = false;
    this.rateLimitTiers = config.rateLimiting.tiers;
    this.defaultTier = {
      requests: config.rateLimiting.defaultRequests,
      windowMs: config.rateLimiting.defaultWindowMs
    };
  }

  async initialize() {
    try {
      this.redisClient = createClient({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      });

      this.redisClient.on('error', (error) => {
        logger.logSystem('error', 'Redis connection error', { error: error.message });
        this.isConnected = false;
        setTimeout(() => {
          if (!this.isConnected) {
            logger.logSystem('info', 'Attempting Redis reconnection');
          }
        }, 30000);
      });

      this.redisClient.on('connect', () => {
        logger.logSystem('info', 'Redis connected successfully');
        this.isConnected = true;
      });

      this.redisClient.on('disconnect', () => {
        logger.logSystem('warn', 'Redis disconnected');
        this.isConnected = false;
      });

      await this.redisClient.connect();
    } catch (error) {
      logger.logSystem('error', 'Failed to initialize Redis', { error: error.message });
      throw error;
    }
  }

  getRateLimitKey(req, tier) {
    const identifier = req.context.user 
      ? `user:${req.context.user.id}`
      : `ip:${req.context.clientIp}`;
    
    return `rate_limit:${tier}:${identifier}`;
  }

  getTierConfig(tierName) {
    return this.rateLimitTiers[tierName] || this.defaultTier;
  }

  async checkRateLimit(req, tierName = 'basic') {
    if (!this.isConnected) {
      logger.logSystem('warn', 'Redis not connected, skipping rate limit check');
      return { allowed: true, remaining: -1, resetTime: Date.now() + 60000 };
    }

    const key = this.getRateLimitKey(req, tierName);
    const tierConfig = this.getTierConfig(tierName);
    const now = Date.now();
    const windowStart = Math.floor(now / tierConfig.windowMs) * tierConfig.windowMs;
    const windowKey = `${key}:${windowStart}`;

    try {
      const pipeline = this.redisClient.multi();
      
      pipeline.get(windowKey);
      
      const results = await pipeline.exec();
      const currentCount = parseInt(results[0] || 0);

      logger.logRateLimit(req.requestId, 'checked', {
        key: windowKey,
        currentCount,
        limit: tierConfig.requests,
        tier: tierName,
        windowStart: new Date(windowStart).toISOString()
      });

      if (currentCount >= tierConfig.requests) {
        const resetTime = windowStart + tierConfig.windowMs;
        
        logger.logRateLimit(req.requestId, 'exceeded', {
          key: windowKey,
          currentCount,
          limit: tierConfig.requests,
          tier: tierName,
          resetTime: new Date(resetTime).toISOString()
        });

        return {
          allowed: false,
          remaining: 0,
          resetTime,
          tier: tierName
        };
      }

      const incrementPipeline = this.redisClient.multi();
      incrementPipeline.incr(windowKey);
      incrementPipeline.expire(windowKey, Math.ceil(tierConfig.windowMs / 1000));
      
      await incrementPipeline.exec();

      const remaining = tierConfig.requests - currentCount - 1;
      const resetTime = windowStart + tierConfig.windowMs;

      return {
        allowed: true,
        remaining,
        resetTime,
        tier: tierName
      };

    } catch (error) {
      logger.logSystem('error', 'Rate limit check failed', {
        error: error.message,
        key: windowKey,
        tier: tierName
      });

      return { allowed: true, remaining: -1, resetTime: now + tierConfig.windowMs };
    }
  }

  middleware(tierName = 'basic') {
    return async (req, res, next) => {
      try {
        const userTier = req.context.user?.tier || tierName;
        const result = await this.checkRateLimit(req, userTier);

        res.setHeader('X-RateLimit-Limit', this.getTierConfig(userTier).requests);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));
        res.setHeader('X-RateLimit-Tier', result.tier || userTier);

        if (!result.allowed) {
          const error = ErrorHandler.handleRateLimitError(
            result.remaining,
            result.resetTime,
            result.tier
          );
          return next(error);
        }

        next();
      } catch (error) {
        logger.logSystem('error', 'Rate limiting middleware error', {
          error: error.message,
          requestId: req.requestId
        });
        
        next();
      }
    };
  }

  async resetRateLimit(identifier, tier = 'basic') {
    if (!this.isConnected) {
      throw new Error('Redis not connected');
    }

    try {
      const pattern = `rate_limit:${tier}:${identifier}:*`;
      const keys = await this.redisClient.keys(pattern);
      
      if (keys.length > 0) {
        await this.redisClient.del(keys);
        logger.logSystem('info', 'Rate limit reset', { identifier, tier, keysDeleted: keys.length });
      }

      return { success: true, keysDeleted: keys.length };
    } catch (error) {
      logger.logSystem('error', 'Failed to reset rate limit', {
        error: error.message,
        identifier,
        tier
      });
      throw error;
    }
  }

  async getRateLimitStatus(identifier, tier = 'basic') {
    if (!this.isConnected) {
      return { error: 'Redis not connected' };
    }

    const tierConfig = this.getTierConfig(tier);
    const now = Date.now();
    const windowStart = Math.floor(now / tierConfig.windowMs) * tierConfig.windowMs;
    const key = `rate_limit:${tier}:${identifier}:${windowStart}`;

    try {
      const currentCount = parseInt(await this.redisClient.get(key) || 0);
      const remaining = Math.max(0, tierConfig.requests - currentCount);
      const resetTime = windowStart + tierConfig.windowMs;

      return {
        tier,
        limit: tierConfig.requests,
        used: currentCount,
        remaining,
        resetTime,
        windowStart
      };
    } catch (error) {
      logger.logSystem('error', 'Failed to get rate limit status', {
        error: error.message,
        identifier,
        tier
      });
      throw error;
    }
  }

  async close() {
    if (this.redisClient) {
      await this.redisClient.disconnect();
      logger.logSystem('info', 'Redis connection closed');
    }
  }

  async healthCheck() {
    if (!this.redisClient || !this.isConnected) {
      return { status: 'unhealthy', message: 'Redis not connected' };
    }

    try {
      await this.redisClient.ping();
      return { status: 'healthy', message: 'Redis connection OK' };
    } catch (error) {
      return { status: 'unhealthy', message: error.message };
    }
  }
}

module.exports = RateLimitLayer;