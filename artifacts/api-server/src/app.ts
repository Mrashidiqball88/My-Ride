import express, { type Express } from "express";
import cors from "cors";
import http from "node:http";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── Health endpoints — respond immediately so deployment probes never 500 ────
app.get("/api/health",  (_req, res) => res.json({ status: "ok" }));
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/api",         (_req, res) => res.json({ status: "ok" }));

// ── Proxy — forward all other requests to the ride-hailing server ────────────
// The Replit workspace proxy routes /api/* to this artifact. The ride-hailing
// server (port 3000) is the single source of truth for all API routes, HTML
// pages, and Socket.io — so we delegate everything else to it.
const RIDE_HAILING_PORT = parseInt(process.env.RIDE_HAILING_PORT ?? "3000", 10);

app.use((req, res) => {
  const hasBody = ["POST", "PUT", "PATCH"].includes(req.method ?? "");
  const rawBody  = hasBody ? JSON.stringify(req.body ?? {}) : "";

  // Forward all original headers, then override host + content metadata
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
    host: `localhost:${RIDE_HAILING_PORT}`,
  };
  if (hasBody) {
    headers["content-type"]   = "application/json";
    headers["content-length"] = String(Buffer.byteLength(rawBody));
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port:     RIDE_HAILING_PORT,
      path:     req.originalUrl,
      method:   req.method,
      headers,
    },
    (proxyRes) => {
      if (res.headersSent) return;
      // Strip hop-by-hop headers before forwarding
      const forwarded = { ...proxyRes.headers };
      delete forwarded["transfer-encoding"];
      delete forwarded["connection"];
      res.writeHead(proxyRes.statusCode ?? 502, forwarded);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on("error", (err) => {
    logger.error({ err }, "Ride-hailing proxy error");
    if (!res.headersSent) {
      res.status(502).json({ error: "Service temporarily unavailable" });
    }
  });

  if (hasBody) proxyReq.write(rawBody);
  proxyReq.end();
});

export default app;
