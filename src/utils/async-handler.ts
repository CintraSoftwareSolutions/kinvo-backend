import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Spec 0.5: every async operation has error handling, no unhandled promise
 * rejections. Express 4 does not catch rejections from async handlers — without
 * this wrapper a rejected promise hangs the request until the client times out.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
