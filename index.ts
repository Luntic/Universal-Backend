import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { secureHeaders } from 'hono/secure-headers'
import { timeout } from 'hono/timeout'
import { HTTPException } from 'hono/http-exception'
import { HandleNotFound } from './utils/HandleNotFound'
import { Connect } from './utils/Connect'
import { LoadRoutes } from './utils/LoadRoutes'
import { GenerateShop } from './utils/Shop'

interface Env {
  PORT: string
  NODE_ENV: string
  MONGODB_URI: string
  JWT_SECRET: string
  CORS_ORIGIN: string
}

const rateLimitStore = new Map<string, { count: number; resetTime: number }>()

function rateLimit(windowMs = 15 * 60 * 1000, max = 100) {
  return async (c: any, next: any) => {
    const key = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'anonymous'
    const now = Date.now()
    const record = rateLimitStore.get(key)

    if (!record || now > record.resetTime) {
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs })
      return next()
    }

    if (record.count >= max) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    record.count++
    return next()
  }
}

function requireAuth(c: any, next: any) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return next()
}

const app = new Hono()

app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['*'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
  })
)

app.use('*', logger())
app.use('*', secureHeaders())
app.use('*', prettyJSON())
app.use('*', timeout(30000))
app.use('*', rateLimit())

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message,
        status: err.status,
        timestamp: new Date().toISOString()
      },
      err.status
    )
  }

  return c.json(
    {
      error: 'Internal server error',
      status: 500,
      timestamp: new Date().toISOString()
    },
    500
  )
})

async function startServer() {
  await Connect()
  await LoadRoutes(app)

  app.get('/fortnite/api/storefront/v2/catalog', async (c) => {
    const catalog = await GenerateShop()
    if (!catalog) throw new HTTPException(500, { message: 'Failed to generate shop catalog' })
    return c.json(catalog, 200, {
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    })
  })

  app.get('/fortnite/api/player/:playerId/stats', requireAuth, async (c) => {
    const playerId = c.req.param('playerId')
    if (!playerId || playerId.length < 3) {
      throw new HTTPException(400, { message: 'Invalid player ID' })
    }
    return c.json({
      playerId,
      stats: { wins: 0, kills: 0, matches: 0 },
      lastUpdated: new Date().toISOString()
    })
  })

  app.get('/', (c) => {
    return c.json({
      message: 'Universal Backend Online',
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      timestamp: new Date().toISOString(),
      version: '2.0.0'
    })
  })

  app.get('/health', async (c) => {
    return c.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    })
  })

  app.notFound(HandleNotFound)
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('unhandledRejection', (reason) => console.error('[ERROR] Unhandled Rejection:', reason))
process.on('uncaughtException', (error) => {
  console.error('[ERROR] Uncaught Exception:', error)
  process.exit(1)
})

await startServer()

try {
  await import('./bot/index')
} catch {}
try {
  await import('./matchmaker/index')
} catch {}

const port = parseInt(process.env.PORT || '5595')
console.log(`[INFO] Universal Backend listening on port ${port}`)

export default {
  port,
  fetch: app.fetch
}