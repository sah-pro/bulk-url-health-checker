import { z } from 'zod';

/**
 * Runtime validation for input that crosses a trust boundary (client -> API).
 * Types in types.ts are inferred from / kept consistent with these where practical.
 */

export const createBatchBodySchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(2000).optional(),
});
export type CreateBatchBody = z.infer<typeof createBatchBodySchema>;

export const batchIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listBatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
