import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config';
import { AppError, toAppError } from './errors';
import { registerRoutes } from './routes';

export async function buildApp(opts: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest ? false : { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    let e: AppError;
    if (err instanceof ZodError) {
      e = new AppError('VALIDATION_ERROR', err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), { details: err.issues });
    } else if ((err as { validation?: unknown }).validation || (err as { statusCode?: number }).statusCode === 400) {
      e = new AppError('VALIDATION_ERROR', (err as Error).message);
    } else if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      e = new AppError('UPLOAD_REJECTED', `File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit`);
    } else {
      e = toAppError(err);
    }
    if (e.httpStatus >= 500) req.log.error({ err }, 'request failed');
    void reply.status(e.httpStatus).send({ error: { code: e.code, message: e.message, details: e.details ?? null } });
  });

  await app.register(registerRoutes, { prefix: '/api' });

  if (opts.serveWeb) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDir = [path.resolve(process.cwd(), 'dist/web'), path.resolve(here, '../web')].find((p) => existsSync(path.join(p, 'index.html')));
    if (webDir) {
      await app.register(fastifyStatic, { root: webDir, wildcard: true });
      // SPA fallback: deep links like /projects/:id/storyboard survive refresh.
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', details: null } });
        return reply.sendFile('index.html');
      });
    } else {
      app.log.warn('dist/web not found — run `npm run build:web` (or use `npm run dev`)');
    }
  }
  return app;
}
