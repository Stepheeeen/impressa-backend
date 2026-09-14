import { RequestHandler } from "express";

const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const isObjectId = (value: unknown): value is string => typeof value === "string" && OBJECT_ID.test(value);

export const validateObjectId =
  (param: string): RequestHandler =>
  (req, res, next) => {
    if (!isObjectId(req.params[param])) {
      res.status(400).json({ error: "Invalid ID." });
      return;
    }
    next();
  };
