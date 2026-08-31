import { type Express, type Request, type Response, type NextFunction } from "express";
import { type ZodSchema } from "zod";
import { logger } from "../lib/logger";

export class ValidationError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Validates request body against a Zod schema.
 * Returns 400 with validation errors if schema fails.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      logger.debug({ errors, body: req.body }, "Request validation failed");
      res.status(400).json({
        error: "Validation failed",
        details: errors,
      });
      return;
    }
    // Attach validated data to request for type safety
    (req as any).validatedBody = parsed.data;
    next();
  };
}

/**
 * Validates request query against a Zod schema.
 * Returns 400 with validation errors if schema fails.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      const errors = parsed.error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      logger.debug({ errors, query: req.query }, "Query validation failed");
      res.status(400).json({
        error: "Validation failed",
        details: errors,
      });
      return;
    }
    (req as any).validatedQuery = parsed.data;
    next();
  };
}

/**
 * Validates request params against a Zod schema.
 * Returns 400 with validation errors if schema fails.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      const errors = parsed.error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      logger.debug({ errors, params: req.params }, "Params validation failed");
      res.status(404).json({
        error: "Resource not found",
      });
      return;
    }
    (req as any).validatedParams = parsed.data;
    next();
  };
}

/**
 * Wrapper for async route handlers to catch errors and pass to error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * High-level error handler middleware. Attach to Express with:
 * app.use(errorHandler);
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  req.log?.error({ err }, "Unhandled request error");

  if (res.headersSent) {
    return;
  }

  if (err instanceof ValidationError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ??
    500;

  const isDevelopment = process.env.NODE_ENV === "development";
  const message =
    status === 400
      ? "Malformed request"
      : status === 429
        ? "Rate limit exceeded"
        : status === 404
          ? "Resource not found"
          : "Internal server error";

  const errorResponse: any = { error: message };

  if (isDevelopment && err instanceof Error) {
    errorResponse.details = {
      message: err.message,
      stack: err.stack,
    };
  }

  res.status(status).json(errorResponse);
}
