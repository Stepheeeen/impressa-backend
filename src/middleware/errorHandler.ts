import { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// Express 4 doesn't catch rejected promises from async handlers; unhandled, one bad request can crash the process.
export const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: err.issues[0]?.message ?? "Invalid request.",
      details: err.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: "Invalid ID." });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    return res.status(400).json({ error: first?.message ?? "Invalid request." });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: "That record already exists." });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body isn't valid JSON." });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }

  console.error(err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
};
