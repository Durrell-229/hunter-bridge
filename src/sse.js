/**
 * Parseur SSE tolérant : gère les events séparés par \n\n ou \r\n\r\n,
 * les data: multi-lignes, les commentaires et la sentinelle [DONE].
 */
export async function* parseSse(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    buffer = buffer.replace(/\r\n/g, '\n');
    // Un \r isolé est un séparateur de ligne SSE valide.
    buffer = buffer.replace(/\r(?!\n)/g, '\n');

    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseEvent(raw);
      if (parsed === DONE) return;
      if (parsed !== null) yield parsed;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const parsed = parseEvent(tail);
    if (parsed !== DONE && parsed !== null) yield parsed;
  }
}

const DONE = Symbol('sse-done');

function parseEvent(raw) {
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n').trim();
  if (!data) return null;
  if (data === '[DONE]') return DONE;
  try {
    return JSON.parse(data);
  } catch {
    // Un chunk malformé ne doit pas tuer tout le stream.
    return null;
  }
}

/** Écrit des événements SSE au format Anthropic. */
export class SseWriter {
  constructor(res) {
    this.res = res;
    this.closed = false;
  }

  event(type, payload = {}) {
    if (this.closed || !this.res || this.res.destroyed || this.res.writableEnded) return false;
    // Le type est ajouté en dernier pour ne jamais être écrasé par le payload.
    const data = { ...payload, type };
    try {
      this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.res && !this.res.destroyed && !this.res.writableEnded) this.res.end();
    } catch {
      // Le client est déjà parti.
    }
  }
}
