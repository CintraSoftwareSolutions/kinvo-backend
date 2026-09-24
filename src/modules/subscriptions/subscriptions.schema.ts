import { z } from 'zod';

/**
 * A test purchase names a plan by its catalogue slug, and nothing else.
 *
 * No user — it is always the caller. No tier, price or period — the server
 * derives all three from the product. `.strict()` refuses a body that tries to
 * say otherwise, rather than quietly ignoring it.
 */
export const testPurchaseSchema = z
  .object({
    product: z.string().trim().min(1).max(64),
  })
  .strict();

export type TestPurchaseBody = z.infer<typeof testPurchaseSchema>;
