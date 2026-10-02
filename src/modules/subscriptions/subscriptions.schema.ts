import { z } from 'zod';

export const testPurchaseSchema = z
  .object({
    product: z.string().trim().min(1).max(64),
  })
  .strict();

export type TestPurchaseBody = z.infer<typeof testPurchaseSchema>;
