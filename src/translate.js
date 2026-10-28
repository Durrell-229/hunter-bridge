import { BridgeError } from './errors.js';
import { clampMaxTokens, KNOWN_MODELS, resolveModel } from './models.js';
import { estimateRequestTokens, estimateTokens, newId, newToolId } from './util.js';

export { estimateRequestTokens };

const IGNORED_BLOCK_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
]);

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === 'object');
  if (content && typeof content === 'object') return [content];
  return [];
}

function textOfBlocks(blocks) {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

export function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return textOfBlocks(asBlocks(system));
}

function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(schema));
  } catch {
    return { type: 'object', properties: {} };
  }
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    return { type: 'object', properties: {} };
  }
  delete copy.$schema;
  if (!copy.type && !copy.$ref && !copy.anyOf && !copy.oneOf && !copy.allOf) {
    copy.type = 'object';
  }
  if (copy.type === 'object' && (!copy.properties || typeof copy.properties !== 'object')) {
    copy.properties = {};
  }
  return copy;
}

export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (typeof tool.name !== 'string' || !tool.name) continue;
    const schema =
      tool.input_schema && typeof tool.input_schema === 'object'
        ? tool.input_schema
        : tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : null;
    // Les outils serveur Anthropic (web_search, computer…) n'ont pas de schéma
    // d'entrée : Groq ne sait pas les exécuter, on ne les expose pas.
    if (!schema && tool.type && tool.type !== 'custom') continue;
    converted.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: sanitizeToolSchema(schema),
      },
    });
    if (converted.length >= 128) break; // limite Groq
  }
  return converted.length ? converted : null;
}

export function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    return ['auto', 'none', 'required'].includes(choice) ? choice : undefined;
  }
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

function normalizeToolInput(input) {
  if (input == null) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toolResultToText(block) {
  let text = '';
  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    text = block.content
      .map((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'image') return '[image]';
        if (part?.type === 'document') return '[document]';
        if (part?.type === 'resource') {
          if (typeof part.resource?.text === 'string') return part.resource.text;
          if (typeof part.resource?.uri === 'string') return `[resource ${part.resource.uri}]`;
          return '[resource]';
        }
        if (part?.type === 'resource_link') {
          return `[resource ${part.uri || part.name || 'sans URI'}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else if (block.content != null) {
    try {
      text = JSON.stringify(block.content);
    } catch {
      text = String(block.content);
    }
  }
  if (block.is_error) text = `[tool_error]\n${text}`;
  // Certains fournisseurs OpenAI-compatibles refusent un contenu vide.
  return text || '[empty tool result]';
}

function documentToText(block) {
  const source = block?.source;
  if (source?.type === 'text' && typeof source.data === 'string') return source.data;
  if (source?.type === 'content' && Array.isArray(source.content)) {
    const text = textOfBlocks(source.content);
    if (text) return text;
  }
  const mediaType = source?.media_type ? ` ${source.media_type}` : '';
  return `[document${mediaType}]`;
}

function imageToOpenAiPart(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && typeof source.data === 'string' && source.data) {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` },
    };
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url) {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** Convertit les messages Anthropic en messages OpenAI/Groq. */
export function convertMessages(messages) {
  const out = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system') {
      const text = textOfBlocks(asBlocks(message.content));
      if (text) out.push({ role: 'system', content: text });
      continue;
    }

    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of asBlocks(message.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.length) textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: typeof block.id === 'string' && block.id ? block.id : newToolId(),
            type: 'function',
            function: {
              name: typeof block.name === 'string' && block.name ? block.name : 'unknown_tool',
              arguments: JSON.stringify(normalizeToolInput(block.input)),
            },
          });
        } else if (!IGNORED_BLOCK_TYPES.has(block.type)) {
          // Bloc inconnu : ignoré volontairement.
        }
      }
      if (textParts.length || toolCalls.length) {
        const converted = {
          role: 'assistant',
          content: textParts.length ? textParts.join('') : null,
        };
        if (toolCalls.length) converted.tool_calls = toolCalls;
        out.push(converted);
      }
      continue;
    }

    if (role === 'user') {
      const toolMessages = [];
      const contentParts = [];
      for (const block of asBlocks(message.content)) {
        if (block.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) {
            throw new BridgeError('tool_result sans tool_use_id', {
              status: 400,
              type: 'invalid_request_error',
            });
          }
          toolMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultToText(block),
          });
        } else if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.length) {
            contentParts.push({ type: 'text', text: block.text });
          }
        } else if (block.type === 'image') {
          const image = imageToOpenAiPart(block);
          contentParts.push(image || { type: 'text', text: '[image]' });
        } else if (block.type === 'document') {
          contentParts.push({ type: 'text', text: documentToText(block) });
        }
      }

      // OpenAI exige que les messages "tool" suivent immédiatement
      // l'assistant qui a émis les tool_calls. On les place donc avant
      // l'éventuel texte utilisateur de la même requête Anthropic.
      out.push(...toolMessages);

      if (contentParts.length) {
        // Pour un message purement texte, une simple chaîne est plus
        // compatible que le tableau de content parts (Groq, vieux proxys).
        if (contentParts.every((part) => part.type === 'text')) {
          out.push({
            role: 'user',
            content: contentParts.map((part) => part.text).join('\n\n'),
          });
        } else {
          out.push({ role: 'user', content: contentParts });
        }
      } else if (toolMessages.length === 0) {
        out.push({ role: 'user', content: '' });
      }
    }
  }

  return mergeAdjacent(out);
}

function mergeAdjacent(messages) {
  const out = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.role === 'system' &&
      message.role === 'system' &&
      typeof previous.content === 'string' &&
      typeof message.content === 'string'
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    if (
      previous &&
      previous.role === 'user' &&
      message.role === 'user' &&
      typeof previous.content === 'string' &&
      typeof message.content === 'string'
    ) {
      previous.content = previous.content ? `${previous.content}\n\n${message.content}` : message.content;
      continue;
    }
    out.push({ ...message });
  }
  return out;
}

function reasoningEffortFor(body, model) {
  const thinking = body?.thinking;
  if (!thinking || thinking.type !== 'enabled') return undefined;
  const supported = KNOWN_MODELS[model]?.reasoning;
  if (!Array.isArray(supported) || supported.length === 0) return undefined;
  const budget = Number(thinking.budget_tokens) || 0;
  if (supported.includes('high') && budget >= 16000) return 'high';
  if (supported.includes('medium') && budget >= 4096) return 'medium';
  if (supported.includes('low')) return 'low';
  if (supported.includes('default')) return 'default';
  return undefined;
}

/**
 * Traduit une requête Anthropic Messages en requête Groq Chat Completions.
 * Retourne { body, meta }.
 */
export function anthropicToGroq(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BridgeError('Corps de requête JSON invalide', {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new BridgeError('messages doit être un tableau non vide', {
      status: 400,
      type: 'invalid_request_error',
    });
  }

  const inputTokens = estimateRequestTokens(body);
  const groqModel = resolveModel(body.model, config);
  const maxTokens = clampMaxTokens(body.max_tokens, groqModel, config, inputTokens);

  const messages = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...convertMessages(body.messages));

  if (!messages.some((message) => message.role !== 'system')) {
    throw new BridgeError('messages ne contient aucun message user/assistant exploitable', {
      status: 400,
      type: 'invalid_request_error',
    });
  }

  const groq = {
    model: groqModel,
    messages,
    max_completion_tokens: maxTokens,
  };

  if (body.temperature != null) {
    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature)) {
      groq.temperature = Math.max(0, Math.min(2, temperature));
    }
  }
  if (body.top_p != null) {
    const topP = Number(body.top_p);
    if (Number.isFinite(topP)) groq.top_p = Math.max(0, Math.min(1, topP));
  }
  if (Array.isArray(body.stop_sequences)) {
    const stops = body.stop_sequences
      .filter((value) => typeof value === 'string' && value.length > 0)
      .slice(0, 4);
    if (stops.length) groq.stop = stops;
  }

  const tools = convertTools(body.tools);
  if (tools) {
    groq.tools = tools;
    const toolChoice = convertToolChoice(body.tool_choice);
    if (toolChoice) groq.tool_choice = toolChoice;
  }

  const reasoningEffort = reasoningEffortFor(body, groqModel);
  if (reasoningEffort) groq.reasoning_effort = reasoningEffort;

  const clientStream = Boolean(body.stream);
  const upstreamStream = clientStream && config.streaming;
  if (upstreamStream) {
    groq.stream = true;
    groq.stream_options = { include_usage: true };
  }

  return {
    body: groq,
    meta: {
      requestedModel: body.model || config.model,
      groqModel,
      inputTokens,
      maxTokens,
      clientStream,
      upstreamStream,
    },
  };
}

export function parseToolArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

export function mapUsage(usage) {
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;
  const cached =
    Number(usage?.prompt_tokens_details?.cached_tokens) ||
    Number(usage?.prompt_tokens_details?.cache_read) ||
    0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

export function mapStopReason(finishReason, hasTools = false) {
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    return hasTools ? 'tool_use' : 'end_turn';
  }
  if (finishReason === 'content_filter') return 'end_turn';
  if (hasTools) return 'tool_use';
  return 'end_turn';
}

/** Convertit une réponse Groq complète en message Anthropic. */
export function groqToAnthropicMessage(json, meta = {}) {
  const choice = json?.choices?.[0];
  if (!choice || !choice.message) {
    throw new BridgeError('Réponse Groq invalide : choices[0].message absent', {
      status: 502,
      type: 'api_error',
    });
  }

  const message = choice.message;
  const text = extractMessageText(message.content);
  const content = [];
  if (text.length) content.push({ type: 'text', text });

  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : newToolId(),
      name:
        typeof toolCall.function?.name === 'string' && toolCall.function.name
          ? toolCall.function.name
          : 'unknown_tool',
      input: parseToolArguments(toolCall.function?.arguments),
    });
  }

  if (content.length === 0) content.push({ type: 'text', text: '' });

  const hasTools = content.some((block) => block.type === 'tool_use');
  const usage = mapUsage(json?.usage);
  if (!usage.input_tokens && Number(meta.inputTokens) > 0) {
    usage.input_tokens = Number(meta.inputTokens);
  }
  if (!usage.output_tokens) {
    const toolText = content
      .filter((block) => block.type === 'tool_use')
      .map((block) => JSON.stringify(block.input))
      .join('');
    usage.output_tokens = estimateTokens(text + toolText);
  }

  return {
    id: meta.messageId || newId('msg_'),
    type: 'message',
    role: 'assistant',
    model: meta.requestedModel || meta.groqModel || 'unknown',
    content,
    stop_reason: mapStopReason(choice.finish_reason, hasTools),
    stop_sequence: null,
    usage,
  };
}

/**
 * Traduit un flux SSE Groq vers les événements SSE Anthropic.
 * Les tool_calls sont bufferisés puis émis en fin de message : c'est plus
 * simple et tout aussi compatible avec Claude Code.
 */
export async function streamGroqToAnthropic(upstream, writer, meta = {}) {
  const state = {
    nextIndex: 0,
    textIndex: -1,
    textOpen: false,
    text: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
  };

  writer.event('message_start', {
    message: {
      id: meta.messageId || newId('msg_'),
      type: 'message',
      role: 'assistant',
      model: meta.requestedModel || meta.groqModel || 'unknown',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: Number(meta.inputTokens) || 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  for await (const chunk of upstream) {
    if (chunk?.error) {
      const message = chunk.error.message || chunk.error.type || 'Erreur Groq pendant le stream';
      const rateLimited = /rate|quota|limit/i.test(String(chunk.error.type || ''));
      throw new BridgeError(message, {
        status: rateLimited ? 429 : 502,
        type: rateLimited ? 'rate_limit_error' : 'api_error',
      });
    }

    if (chunk?.usage) state.usage = chunk.usage;

    const choice = chunk?.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta || {};
    const contentText = extractMessageText(delta.content);

    if (contentText.length > 0) {
      if (!state.textOpen) {
        state.textIndex = state.nextIndex++;
        state.textOpen = true;
        writer.event('content_block_start', {
          index: state.textIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      state.text += contentText;
      writer.event('content_block_delta', {
        index: state.textIndex,
        delta: { type: 'text_delta', text: contentText },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const rawIndex = Number(toolCall.index);
        const index = Number.isInteger(rawIndex) ? rawIndex : 0;
        let acc = state.toolCalls.get(index);
        if (!acc) {
          acc = { id: null, name: '', arguments: '' };
          state.toolCalls.set(index, acc);
        }
        if (typeof toolCall.id === 'string' && toolCall.id) acc.id = toolCall.id;
        if (typeof toolCall.function?.name === 'string' && toolCall.function.name) {
          if (!acc.name) acc.name = toolCall.function.name;
          else if (!acc.name.endsWith(toolCall.function.name)) acc.name += toolCall.function.name;
        }
        if (toolCall.function?.arguments != null) {
          acc.arguments +=
            typeof toolCall.function.arguments === 'string'
              ? toolCall.function.arguments
              : JSON.stringify(toolCall.function.arguments);
        }
      }
    }

    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }

  if (state.textOpen) {
    writer.event('content_block_stop', { index: state.textIndex });
    state.textOpen = false;
  }

  const sortedToolCalls = [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, toolCall] of sortedToolCalls) {
    const index = state.nextIndex++;
    const input = parseToolArguments(toolCall.arguments);
    writer.event('content_block_start', {
      index,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || newToolId(),
        name: toolCall.name || 'unknown_tool',
        input: {},
      },
    });
    writer.event('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    writer.event('content_block_stop', { index });
  }

  if (state.nextIndex === 0) {
    writer.event('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    writer.event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: '' },
    });
    writer.event('content_block_stop', { index: 0 });
    state.nextIndex = 1;
  }

  const hasTools = state.toolCalls.size > 0;
  const usage = mapUsage(state.usage);
  if (!usage.output_tokens) {
    const toolText = sortedToolCalls.map(([, toolCall]) => toolCall.arguments).join('');
    usage.output_tokens = estimateTokens(state.text + toolText);
  }
  const stopReason = mapStopReason(state.finishReason, hasTools);
  writer.event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  writer.event('message_stop', {});

  return { usage, stopReason, text: state.text, toolCount: state.toolCalls.size };
}

/**
 * Rejoue un message Anthropic complet sous forme de flux SSE.
 * Utile quand le streaming Groq est désactivé (STREAMING=0).
 */
export function synthesizeAnthropicStream(message, writer) {
  writer.event('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...message.usage, output_tokens: 0 },
    },
  });

  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === 'text') {
      writer.event('content_block_start', {
        index,
        content_block: { type: 'text', text: '' },
      });
      writer.event('content_block_delta', {
        index,
        delta: { type: 'text_delta', text: block.text || '' },
      });
      writer.event('content_block_stop', { index });
    } else if (block.type === 'tool_use') {
      writer.event('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      writer.event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
      writer.event('content_block_stop', { index });
    }
  }

  writer.event('message_delta', {
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: message.usage?.output_tokens || 0 },
  });
  writer.event('message_stop', {});
}
