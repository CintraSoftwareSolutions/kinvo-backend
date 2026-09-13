import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Spec 0.5: every endpoint validates input with Zod before touching business
 * logic. Validation failures are forwarded to the error handler, which renders
 * them as VALIDATION_FAILED with field-keyed details.
 */
export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }

      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }

      if (schemas.query) {
        // Express 4 exposes `query` as a getter-only accessor on the request
        // prototype, so a plain assignment throws. Redefine it instead, so
        // handlers read coerced, defaulted values rather than raw strings.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
