import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

app.use("/api", router);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found." });
});

// Centralized fallback: express.json() throws on malformed bodies before a
// route handler ever runs, and any handler that forgets its own try/catch
// would otherwise crash the process instead of returning a clean 500.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log?.error({ err }, "Unhandled request error");
  if (res.headersSent) return;
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    500;
  res.status(status).json({ error: status === 400 ? "Malformed request." : "Something went wrong." });
});

export default app;
