const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

class EntryLayer {
  constructor() {
    this.app = express();
    this.setupMiddleware();
  }

  setupMiddleware() {
    this.app.use(helmet({
      contentSecurityPolicy: false, 
      crossOriginEmbedderPolicy: false
    }));

    this.app.use(cors({
      origin: true, 
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      credentials: true
    }));

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    this.app.use(this.normalizeRequest.bind(this));
    this.app.use(this.validateMethod.bind(this));
    this.app.use(this.enforceGlobalLimits.bind(this));
  }

  
  normalizeRequest(req, res, next) {
    
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.requestId);
    req.startTime = Date.now();

    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }
    req.normalizedHeaders = normalizedHeaders;
    req.originalMethod = req.method;
    req.originalUrl = req.url;
    req.originalPath = req.path;

    req.context = {
      requestId: req.requestId,
      startTime: req.startTime,
      userAgent: req.headers['user-agent'] || 'unknown',
      clientIp: this.getClientIp(req),
      user: null 
    };

    next();
  }

  validateMethod(req, res, next) {
    const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
    
    if (!allowedMethods.includes(req.method)) {
      return res.status(405).json({
        error: 'Method Not Allowed',
        message: `HTTP method ${req.method} is not supported`,
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      });
    }

    next();
  }

  enforceGlobalLimits(req, res, next) {
    if (req.url.length > 2048) {
      return res.status(414).json({
        error: 'URI Too Long',
        message: 'Request URL exceeds maximum length of 2048 characters',
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      });
    }

    const headerCount = Object.keys(req.headers).length;
    if (headerCount > 100) {
      return res.status(400).json({
        error: 'Too Many Headers',
        message: 'Request contains too many headers (max: 100)',
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      });
    }

    for (const [key, value] of Object.entries(req.headers)) {
      if (key.length > 256 || (typeof value === 'string' && value.length > 4096)) {
        return res.status(400).json({
          error: 'Header Too Large',
          message: `Header ${key} exceeds size limits`,
          requestId: req.requestId,
          timestamp: new Date().toISOString()
        });
      }
    }

    next();
  }

  getClientIp(req) {
    return req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
           '0.0.0.0';
  }

  listen(port, callback) {
    this.server = this.app.listen(port, callback);
    return this.server;
  }

  getApp() {
    return this.app;
  }

  
  close(callback) {
    if (this.server) {
      this.server.close(callback);
    } else if (callback) {
      callback();
    }
  }
}

module.exports = EntryLayer;