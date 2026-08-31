import { FastifyInstance } from 'fastify';
import { parse as parseCsv } from 'csv-parse/sync';
import { createBatchBodySchema, batchIdParamSchema, listBatchesQuerySchema } from '@bulk-url/shared';
import {
  createBatch,
  listBatches,
  getBatchDetail,
  cancelBatch,
  retryFailedUrls,
  ValidationError,
  NotFoundError,
} from '../services/batchService';
import { env } from '../config';

export function extractUrlColumn(records: Record<string, string>[]): string[] {
  if (records.length === 0) return [];
  const headerKeys = Object.keys(records[0]!);
  const urlKey = headerKeys.find((k) => k.trim().toLowerCase() === 'url') ?? headerKeys[0]!;
  return records.map((r) => r[urlKey] ?? '').filter((v) => v.length > 0);
}

export async function batchRoutes(app: FastifyInstance) {
  app.post('/api/batches', async (request, reply) => {
    const contentType = request.headers['content-type'] ?? '';

    let rawUrls: string[];

    if (contentType.includes('multipart/form-data')) {
      const file = await request.file({ limits: { fileSize: env.MAX_CSV_SIZE_BYTES } });
      if (!file) {
        return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'No file uploaded.' } });
      }
      if (!file.mimetype.includes('csv') && !file.filename.toLowerCase().endsWith('.csv')) {
        return reply
          .status(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'File must be a .csv file.' } });
      }

      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        return reply.status(413).send({
          error: { code: 'FILE_TOO_LARGE', message: `CSV exceeds ${env.MAX_CSV_SIZE_BYTES} bytes.` },
        });
      }

      let records: Record<string, string>[];
      try {
        records = parseCsv(buffer, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        });
      } catch {
        return reply.status(400).send({ error: { code: 'BAD_CSV', message: 'Could not parse CSV file.' } });
      }
      rawUrls = extractUrlColumn(records);
    } else {
      const parseResult = createBatchBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body.',
            details: parseResult.error.flatten(),
          },
        });
      }
      rawUrls = parseResult.data.urls ?? [];
    }

    if (rawUrls.length > env.MAX_URLS_PER_BATCH) {
      return reply.status(400).send({
        error: {
          code: 'TOO_MANY_URLS',
          message: `A batch may contain at most ${env.MAX_URLS_PER_BATCH} URLs.`,
        },
      });
    }

    try {
      const batch = await createBatch(rawUrls);
      return reply.status(201).send({ batch });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      }
      throw err;
    }
  });

  app.get('/api/batches', async (request, reply) => {
    const parseResult = listBatchesQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid query params.' } });
    }
    const { limit, offset } = parseResult.data;
    const { batches, cached } = await listBatches(limit, offset);
    return reply.send({ batches, cached });
  });

  app.get('/api/batches/:id', async (request, reply) => {
    const parseResult = batchIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid batch id.' } });
    }
    try {
      const detail = await getBatchDetail(parseResult.data.id);
      return reply.send(detail);
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      throw err;
    }
  });

  app.post('/api/batches/:id/cancel', async (request, reply) => {
    const parseResult = batchIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid batch id.' } });
    }
    try {
      const batch = await cancelBatch(parseResult.data.id);
      return reply.send({ batch });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      throw err;
    }
  });

  app.post('/api/batches/:id/retry-failed', async (request, reply) => {
    const parseResult = batchIdParamSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid batch id.' } });
    }
    try {
      const batch = await retryFailedUrls(parseResult.data.id);
      return reply.send({ batch });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } });
      }
      if (err instanceof ValidationError) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      }
      throw err;
    }
  });
}
