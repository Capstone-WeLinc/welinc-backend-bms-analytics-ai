import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const accessLog = new Logger('HTTP');
  app.use((request, response, next) => {
    const supplied = request.header('x-request-id');
    const requestId = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    const started = Date.now();
    response.setHeader('X-Request-Id', requestId);
    response.on('finish', () => accessLog.log(JSON.stringify({
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Date.now() - started,
    })));
    next();
  });
  const origins = process.env['CORS_ORIGINS']
    ? process.env['CORS_ORIGINS'].split(',').map((origin) => origin.trim()).filter(Boolean)
    : process.env['NODE_ENV'] === 'production'
      ? []
      : ['http://127.0.0.1:5174', 'http://localhost:5174'];
  app.enableCors({ origin: origins });
  await app.listen(process.env['PORT'] ?? 3001);
}
bootstrap();
