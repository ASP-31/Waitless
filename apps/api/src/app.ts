import { randomUUID } from "node:crypto";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { allowedOrigins, env, isProd } from "./config/env";
import { logger } from "./config/logger";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { idempotency } from "./middleware/idempotency";
import {
  apiRateLimit,
  hardwareEventRateLimit,
  writeRateLimit,
} from "./middleware/rate-limit";
import { apiRouter } from "./routes";

export function createApp(): Express {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      // The API serves JSON, not pages; CSP only matters for the web app.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: {
        ignore: (req) => req.url?.startsWith("/api/v1/health") ?? false,
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use("/api/v1", apiRateLimit, writeRateLimit);
  app.use("/api/v1/hardware/events", hardwareEventRateLimit);
  // Before auth so the fingerprint includes the caller's bearer token without
  // needing to decode it twice; protected routes are matched by path.
  app.use(idempotency);
  app.use("/api/v1", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (isProd) logger.info({ allowedOrigins }, "api initialised");
  return app;
}

export { env };
