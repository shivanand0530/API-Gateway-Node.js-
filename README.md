# GuardianGate

A production-ready API Gateway with authentication, rate limiting, circuit breaker, and comprehensive monitoring.

## Tech Stack

- **Node.js** - JavaScript runtime environment
- **Express.js** - Web framework for HTTP server
- **Redis** - In-memory data store for rate limiting and caching
- **JWT (jsonwebtoken)** - Token-based authentication
- **Winston** - Structured logging framework
- **Axios** - HTTP client for upstream requests
- **Helmet** - Security headers middleware
- **CORS** - Cross-origin resource sharing
- **Joi** - Request validation library
- **UUID** - Request ID generation
- **Docker** - Containerization platform
- **path-to-regexp** - Route pattern matching
- **Nodemon** - Development auto-reload tool
- **dotenv** - Environment variable management

##  Architecture

### Core Components

- **Entry Layer**: HTTP server with request normalization, security headers, and global limits
- **Auth Layer**: JWT verification with role-based authorization
- **Rate Limiting**: Redis-based token bucket with multi-tier limits
- **Routing**: Static route matching with per-route configuration
- **Forwarding**: HTTP proxy with circuit breaker and retries
- **Logging**: Structured logging with Winston
- **Metrics**: Request/response metrics and performance tracking
- **Health Checks**: Kubernetes-compatible readiness and liveness probes

##  Quick Start

### Prerequisites

- Node.js 18+
- Redis 6+

### Installation

1. Clone and install:
```bash
npm install
```

2. Configure environment:
```bash
cp .env .env.local
# Edit .env.local with your settings
```

3. Start Redis (if not already running):
```bash
redis-server
```

4. Start the gateway:
```bash
npm run dev
```

The gateway will be available at `http://localhost:3000`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP server port |
| `NODE_ENV` | development | Environment (development/production) |
| `JWT_SECRET` |  change-me | JWT signing secret |
| `REDIS_HOST` | localhost | Redis host |
| `REDIS_PORT` | 6379 | Redis port |
| `LOG_LEVEL` | info | Winston log level |

### Routes Configuration

Routes are configured in `src/config/index.js`:

```javascript
routes: [
  {
    path: '/api/users',
    target: 'http://localhost:3001',
    timeout: 5000,
    retries: 3,
    authRequired: true,
    rateLimitTier: 'basic',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
]
```

##  Authentication

### JWT Token Structure

```json
{
  "sub": "user-id",
  "username": "user@example.com",
  "roles": ["user", "admin"],
  "permissions": ["read", "write"],
  "tier": "premium",
  "exp": 1640995200
}
```

### Creating Test Tokens (Development)

```bash
curl -X POST http://localhost:3000/admin/test-token \
  -H "Content-Type: application/json" \
  -d '{"userId": "test", "roles": ["user"], "tier": "premium"}'
```

##  Rate Limiting

### Tiers

- **Basic**: 100 requests/minute
- **Premium**: 1000 requests/minute  
- **Enterprise**: 10000 requests/minute

### Headers

The gateway adds rate limit headers to responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640995200
X-RateLimit-Tier: basic
```

##  Circuit Breaker

Automatic failover with three states:

- **Closed**: Normal operation
- **Open**: Failing fast (no upstream calls)
- **Half-Open**: Testing recovery

##  Monitoring

### Health Endpoints

- `GET /health` - Overall health status
- `GET /health/live` - Liveness probe (Kubernetes)
- `GET /health/ready` - Readiness probe (Kubernetes)
- `GET /health/deep` - Detailed diagnostics

### Metrics

- `GET /admin/metrics` - Performance metrics
- `GET /admin/metrics?detailed=true` - Detailed metrics

### Circuit Breakers

- `GET /admin/circuit-breakers` - Circuit breaker states
- `POST /admin/circuit-breakers/:service/reset` - Reset circuit breaker

### Rate Limits

- `GET /admin/rate-limits/:identifier` - Check rate limit status
- `POST /admin/rate-limits/:identifier/reset` - Reset rate limit

##  Development

### Scripts

- `npm run dev` - Start with nodemon (auto-reload)
- `npm start` - Production start
- `npm test` - Run tests (TODO)

### API Examples

#### With Authentication

```bash
# Get a test token
TOKEN=$(curl -s -X POST http://localhost:3000/admin/test-token \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user"}' | jq -r '.token')

# Make authenticated request
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/users
```

#### Without Authentication

```bash
curl http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "user", "password": "pass"}'
```

##  Deployment

### Docker

```bash
# Build image
docker build -t api-gateway .

# Run with Redis
docker-compose up
```

### Environment-specific configs

- Development: Auto-reload, detailed errors, test token endpoint
- Production: Optimized logging, security headers, no test endpoints

##  Architecture Details

### Request Flow

1. **Entry Layer**: Normalize request, validate method, enforce limits
2. **Routing**: Match route, extract parameters, validate method
3. **Authentication**: Verify JWT, extract user context (if required)
4. **Rate Limiting**: Check token bucket, decrement counter
5. **Forwarding**: Proxy to upstream with circuit breaker
6. **Response**: Forward upstream response with gateway headers

### Error Handling

All errors are normalized with consistent structure:

```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded",
  "details": {
    "remaining": 0,
    "resetTime": 1640995200,
    "tier": "basic"
  },
  "requestId": "req-123",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Logging

Structured JSON logging with:
- Request/response logs
- Authentication events
- Rate limiting events  
- Circuit breaker state changes
- System events and errors

## Security

- Helmet.js security headers
- JWT signature verification
- Request size limits
- Header count/size limits
- CORS configuration
- Input sanitization

##  API Reference

### Routes

All API routes are proxied to upstream services based on configuration.

### Admin Routes

- `/admin/metrics` - Gateway metrics
- `/admin/routes` - Route configuration
- `/admin/circuit-breakers` - Circuit breaker management
- `/admin/rate-limits` - Rate limit management

### Health Routes

- `/ping` - Simple ping/pong
- `/version` - Gateway version info
- `/health/*` - Health check endpoints
