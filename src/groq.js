import {
  listUpstreamModels,
  requestUpstream,
  simpleChat as upstreamSimpleChat,
} from './upstream.js';

/**
 * Couche de compatibilité pour l'ancien module `src/groq.js`.
 * Hunter Bridge utilise désormais `src/upstream.js`, générique.
 */
function groqProvider(config) {
  return {
    id: 'groq',
    label: 'Groq',
    baseUrl: config.groqBaseUrl,
    apiKey: config.apiKey,
    apiKeyEnv: 'GROQ_API_KEY',
    maxTokensField: 'max_completion_tokens',
    streamUsage: true,
    reasoning: true,
    tools: true,
    retries: config.retries,
    requestTimeoutMs: config.requestTimeoutMs,
    streamTimeoutMs: config.streamTimeoutMs,
  };
}

export function requestGroq(config, body, options = {}) {
  return requestUpstream(groqProvider(config), body, options);
}

export function listGroqModels(config, options = {}) {
  return listUpstreamModels(groqProvider(config), options);
}

export function simpleChat(config, options = {}) {
  return upstreamSimpleChat(groqProvider(config), options);
}
