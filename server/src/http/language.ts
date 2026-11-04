import type { FastifyInstance } from 'fastify';
import type { Language } from '@orrery/shared';

/** The existing local-origin and bearer-token guards protect this preference endpoint too. */
export function registerLanguageRoute(app: FastifyInstance, notify: (language: Language) => void): void {
  app.post<{ Body: { language: Language } }>('/api/preferences/language', {
    bodyLimit: 128,
    schema: { body: { type: 'object', required: ['language'], additionalProperties: false, properties: { language: { type: 'string', enum: ['ko', 'en'] } } } },
  }, async (request) => {
    notify(request.body.language);
    return { language: request.body.language };
  });
}
