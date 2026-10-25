// Inference client: forward a grid job to the local llama-server
// (OpenAI-compatible) and stream deltas back.

import type { ChatMessage, ChatParams } from '@masscompute/protocol';

export interface EngineResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  msTotal: number;
}

export class EngineClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(messages: ChatMessage[], params: ChatParams, onDelta?: (t: string) => void, signal?: AbortSignal): Promise<EngineResult> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        messages,
        temperature: params.temperature ?? 0.7,
        top_p: params.top_p ?? 0.95,
        max_tokens: params.max_tokens ?? 512,
        stop: params.stop,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`engine HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta?.(delta);
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }
        } catch {
          /* tolerate junk lines */
        }
      }
    }
    if (completionTokens === 0) completionTokens = Math.max(1, Math.ceil(text.length / 4));
    return { text, promptTokens, completionTokens, msTotal: Date.now() - started };
  }

  /** Probe path: single user prompt, temp 0. */
  async prompt(prompt: string, maxTokens: number): Promise<EngineResult> {
    return this.chat([{ role: 'user', content: prompt }], { temperature: 0, max_tokens: maxTokens });
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}
