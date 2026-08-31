import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/validation";

const app: Express = express();

// Security middleware
app.use(
  helmet({
    // This process only ever serves a JSON API (the frontend is a
    // separately-built static site), so a strict CSP with no HTML
    // rendering surface is safe here and blocks nothing legitimate.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

// Logging middleware
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
          userAgent: req.get("user-agent"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
          responseTime: res.getHeader("x-response-time"),
        };
      },
    },
  }),
);

// CORS and body parsing
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// Response time tracking
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    res.setHeader("x-response-time", `${duration}ms`);
    if (duration > 5000) {
      logger.warn({ duration, method: req.method, url: req.url }, "Slow response");
    }
  });
  next();
});

// Routes
app.use("/api", router);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Centralized error handler (must be last)
// Catches errors from express.json(), route handlers, and middleware
app.use(errorHandler);

export default app;
