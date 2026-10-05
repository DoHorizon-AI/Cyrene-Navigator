// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Cyrene Exchange LLM adapter                       │
// │ Role: Stream OpenAI-compatible model responses from Exchange.      │
// │ 模块职责：通过 OpenAI 兼容协议从 Exchange 流式获取模型响应。          │
// └─────────────────────────────────────────────────────────────────────┘

import { attributionHeaders, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';

interface ExchangeAdapterConfig {
  readonly baseUrl: string;
  readonly tokenEnv?: string;
  readonly requestTimeoutMs?: number;
}

interface ToolCallAssembly {
  readonly index: number;
  id: string;
  name: string;
  arguments: string;
}

function usableToken(envName: string): string {
  const token = process.env[envName]?.trim();
  if (!token) throw new Error(`Missing Exchange credential in ${envName}`);
  if (/[^\x21-\x7e]/u.test(token)) throw new Error(`Invalid Exchange credential in ${envName}`);
  return token;
}

function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid Exchange URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Remote Exchange requires HTTPS; HTTP is limited to loopback');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  const prefix = path.endsWith('/v1') ? path : `${path}/v1`;
  return `${url.origin}${prefix}/chat/completions`;
}

function roleMessage(message: GenerateOptions['messages'][number]): Record<string, unknown> {
  const content = message.content.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'reasoning') return [block.text];
    if (block.type === 'file') return [`[File ${block.attachment.name}: ${block.attachment.bytes} bytes]`];
    if (block.type === 'image') return [`[Image ${block.attachment.name ?? block.attachment.attachmentId}: ${block.attachment.bytes} bytes${block.offloaded ? ', offloaded' : ''}]`];
    return [];
  }).join('');
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content };
  }
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }));
    return { role: 'assistant', content: content || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  }
  return { role: message.role, content };
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageChunk(value: unknown): StreamChunk | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const prompt = numeric(row.prompt_tokens ?? row.input_tokens);
  const completion = numeric(row.completion_tokens ?? row.output_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const total = numeric(row.total_tokens);
  const usage: TokenUsage = {
    inputTokens: prompt,
    outputTokens: completion,
    ...(total === undefined ? {} : { totalTokens: total }),
  };
  return { type: 'usage', usage };
}

/** Provider adapter for one workspace-configured OpenAI-compatible Exchange endpoint.  中文：绑定配置 Exchange endpoint 的 Provider adapter。 */
export class ExchangeLlmAdapter extends LlmAdapter {
  private readonly url: string;

  constructor(private readonly config: ExchangeAdapterConfig) {
    super();
    this.url = endpoint(config.baseUrl);
  }

  override providerInfo(provider: string) { return { id: provider, name: 'Cyrene Exchange' }; }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> { return []; }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 8192 } };
  }

  /** Translate Harness messages/tools, consume SSE frames, and emit typed model chunks.  中文：转换 Harness 消息/工具，读取 SSE 帧并输出类型化模型分片。 */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const tokenEnv = this.config.tokenEnv ?? 'CYRENE_EXCHANGE_TOKEN';
    const token = usableToken(tokenEnv);
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const messages = options.messages.map(roleMessage);
    if (options.system) messages.unshift({ role: 'system', content: options.system });
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.stop !== undefined) body.stop = options.stop;
    if (options.tools !== undefined) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Exchange request failed (${response.status})`);
    }
    if (!response.body) throw new Error('Exchange response did not include a stream');

    let buffer = '';
    let textIndex = 0;
    let hasTextBlock = false;
    let fullText = '';
    let reasoningIndex = 1;
    let hasReasoningBlock = false;
    let fullReasoning = '';
    let finished = false;
    let sawDone = false;
    let finishReason: string | undefined;
    let toolSequence = 0;
    const calls = new Map<number, ToolCallAssembly>();
    const decoder = new TextDecoder();

    const processLine = (line: string): { chunks: StreamChunk[]; done: boolean } => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return { chunks: [], done: false };
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return { chunks: [], done: true };
      let frame: unknown;
      try { frame = JSON.parse(data); } catch { throw new Error('Exchange returned malformed stream data'); }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Exchange returned malformed stream data');
      const responseFrame = frame as Record<string, unknown>;
      if (responseFrame.error !== undefined) throw new Error('Exchange reported a provider stream error');
      const chunks: StreamChunk[] = [];
      const usage = usageChunk(responseFrame.usage);
      if (usage) chunks.push(usage);
      const choices = Array.isArray(responseFrame.choices) ? responseFrame.choices : [];
      const first = choices[0];
      if (first === null || typeof first !== 'object' || Array.isArray(first)) return { chunks, done: false };
      const choice = first as Record<string, unknown>;
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) return { chunks, done: false };
      const item = delta as Record<string, unknown>;
      const text = typeof item.content === 'string' ? item.content : '';
      if (text) {
        if (!hasTextBlock) {
          chunks.push({ type: 'block-start', index: textIndex, blockType: 'text' });
          hasTextBlock = true;
        }
        fullText += text;
        chunks.push({ type: 'text-delta', index: textIndex, text });
      }
      const reasoning = typeof item.reasoning_content === 'string'
        ? item.reasoning_content
        : typeof item.reasoning === 'string' ? item.reasoning : '';
      if (reasoning) {
        if (!hasReasoningBlock) {
          chunks.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' });
          hasReasoningBlock = true;
        }
        fullReasoning += reasoning;
        chunks.push({ type: 'reasoning-delta', index: reasoningIndex, text: reasoning });
      }
      if (Array.isArray(item.tool_calls)) {
        for (const partialValue of item.tool_calls) {
          if (partialValue === null || typeof partialValue !== 'object' || Array.isArray(partialValue)) continue;
          const partial = partialValue as Record<string, unknown>;
          const providerIndex = numeric(partial.index) ?? toolSequence++;
          let call = calls.get(providerIndex);
          if (!call) {
            call = { index: textIndex + 2 + providerIndex, id: '', name: '', arguments: '' };
            calls.set(providerIndex, call);
            chunks.push({ type: 'block-start', index: call.index, blockType: 'tool-call' });
          }
          if (!call.id && typeof partial.id === 'string') call.id = partial.id;
          const fn = partial.function;
          if (fn !== null && typeof fn === 'object' && !Array.isArray(fn)) {
            const functionDelta = fn as Record<string, unknown>;
            if (typeof functionDelta.name === 'string') call.name += functionDelta.name;
            if (typeof functionDelta.arguments === 'string') call.arguments += functionDelta.arguments;
          }
          const argumentDelta = fn !== null && typeof fn === 'object' && !Array.isArray(fn)
            ? (fn as Record<string, unknown>).arguments
            : undefined;
          chunks.push({
            type: 'tool-call-delta',
            index: call.index,
            id: ToolCallId(call.id || `exchange-tool-${providerIndex}`),
            ...(call.name ? { name: call.name } : {}),
            argumentsDelta: typeof argumentDelta === 'string' ? argumentDelta : '',
          });
          if (!call.id) call.id = `exchange-tool-${providerIndex}`;
        }
      }
      return { chunks, done: false };
    };

    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/u, '');
          buffer = buffer.slice(newline + 1);
          const parsed = processLine(line);
          for (const next of parsed.chunks) yield next;
          if (parsed.done) { sawDone = true; break; }
          newline = buffer.indexOf('\n');
        }
        if (sawDone) break;
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = processLine(buffer.replace(/\r$/u, ''));
        for (const next of parsed.chunks) yield next;
        sawDone ||= parsed.done;
      }
      signal.throwIfAborted();
      if (!sawDone) throw new Error('Exchange stream ended before terminal completion');

      for (const call of calls.values()) {
        if (!call.name) throw new Error('Exchange returned an incomplete tool call');
        yield {
          type: 'block-end', index: call.index,
          block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments },
        };
      }
      if (hasTextBlock) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: fullText } };
      }
      if (hasReasoningBlock) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: fullReasoning } };
      }
      const kind = finishReason === 'length' ? 'max-tokens' : calls.size > 0 || finishReason === 'tool_calls' || finishReason === 'function_call' ? 'tool-calls' : 'stop';
      yield { type: 'finish', reason: { kind } };
      finished = true;
    } finally {
      if (!finished && !signal.aborted) await response.body.cancel().catch(() => undefined);
    }
  }
}
