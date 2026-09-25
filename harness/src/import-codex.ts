// ┌─────────────────────────────────────────────────────────────────────┐
// │ Module: Navigator Codex conversation importer                      │
// │ Role: Archive Codex history and explicitly continue it via AgentLoop. │
// │ 模块职责：归档 Codex 历史，并通过明确动作接入上游 AgentLoop。          │
// └─────────────────────────────────────────────────────────────────────┘
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import { SessionId as makeSessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  materializeCreateHeader,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence';
import { record } from './persistence-wire.js';
import { runNativeRequest, type NativeConfig } from './native-ipc.js';

/** Exact authenticated Host route exposed by the Navigator desktop/server host.  中文：由 Navigator 桌面/服务端宿主公开的、经过认证的 Host 路由。 */
export const CODEX_IMPORT_PATH = '/api/cyrene/import/codex';

/** Explicit user action that opens an imported archive in a new live Agent.  中文：显式用户操作：将导入的 archive 作为新的 live Agent 打开。 */
export const CODEX_CONTINUE_PATH = '/api/cyrene/import/codex/continue';

/** Read-only archive preview served from the authoritative Cyrene Session log.  中文：从权威 Cyrene Session log 提供只读 archive 预览。 */
export const CODEX_PREVIEW_PATH = '/api/cyrene/import/codex/preview';

/** Maximum buffered request body accepted by the Host route.  中文：Host 路由接受的缓冲请求体上限。 */
export const MAX_IMPORT_REQUEST_BYTES = 4 * 1024 * 1024;

/** Maximum uploaded JSONL retained inline in the authoritative Session log.  中文：在权威 Session log 中内联保留的 JSONL 上传大小上限。 */
export const MAX_IMPORT_CONTENT_BYTES = 512 * 1024;

const IMPORT_SCHEMA = 'cyrene.navigator.codex-import.v1';
const IMPORT_EVENT_TYPE = 'cyrene/import';
const IMPORT_HISTORY_EVENT_TYPE = 'cyrene/import-history';
const IMPORT_PROVIDER = 'codex';

interface ConnectionFetch {
  register(route: {
    readonly path: string;
    readonly methods: readonly ('GET' | 'POST')[];
    readonly requestBody: 'buffered';
    readonly fetch: (request: Request) => Promise<Response>;
  }): () => Promise<void>;
}

interface NavigatorConnection {
  readonly fetch: ConnectionFetch;
}

interface SessionStoreLike {
  get(id: SessionId): Session | undefined;
  prepare(
    id: SessionId,
    options: {
      readonly seed: SessionEvent[];
      readonly meta: SessionHeader;
      readonly inheritedEventCount: SessionLogOffset;
      readonly seedSource: 'persistence';
    },
  ): Session;
  enter(session: Session): () => void;
  announce(session: Session): void;
}

interface CodexImportRequest {
  readonly filename: string;
  readonly content: string;
}

interface CodexContinueRequest {
  readonly sourceSessionId: SessionId;
  readonly newSessionId: SessionId;
  readonly cwd: string;
  readonly agentPreset?: string;
}

interface CodexImportState {
  readonly inFlight: Map<SessionId, Promise<ImportOutcome>>;
  readonly continueInFlight: Map<SessionId, ContinueInFlight>;
}

interface ContinueInFlight {
  readonly requestKey: string;
  readonly operation: Promise<ContinueOutcome>;
}

interface ImportOutcome {
  readonly sessionId: SessionId;
  readonly duplicate: boolean;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
  readonly importedMessageCount: number;
  readonly conversionReport: Record<string, unknown>;
}

interface ContinueOutcome {
  readonly sourceSessionId: SessionId;
  readonly sessionId: SessionId;
  readonly duplicate: boolean;
  readonly cwd: string;
  readonly agentPreset?: string;
  readonly sourceSha256: string;
}

interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined;
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
}

interface AgentPresetRegistryLike {
  resolve(id?: string): Promise<{ readonly id: string }>;
  mount(agentCtx: Context, id?: string): Promise<{ readonly id: string }>;
}

interface AgentDefaultModelLike {
  currentSelection(): AgentOptions;
}

interface ContinueComposition {
  readonly id?: string;
  readonly setup?: AgentSetup;
}

/** Resolved native-host settings accepted by the import plugin.  中文：导入插件接受的原生宿主解析后配置。 */
export type Config = NativeConfig;

/** Schema used by the fixed Profile/Bundle to resolve the native host settings.  中文：固定 Profile/Bundle 用于解析原生宿主设置的 schema。 */
export const Config: z<Config> = z.object({
  binary: z.string().required(),
  timeoutMs: z.number().min(100).max(120_000).default(60_000),
  cancelGraceMs: z.number().min(100).max(10_000).default(1_000),
  maxResponseBytes: z.number().min(1024).max(4_194_304).default(1_048_576),
});

export const name = 'cyrene-codex-import';
export const inject = ['connection', 'sessionPersistence', 'subprocess'];

/** Register the authenticated Host route for Codex rollout imports.  中文：注册经过认证的 Codex rollout 导入 Host 路由。 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.binary)) {
    throw new Error('Native executable path must be absolute');
  }
  const state: CodexImportState = {
    inFlight: new Map(),
    continueInFlight: new Map(),
  };
  const connection = connectionOf(ctx);
  ctx.effect(
    () => connection.fetch.register({
      path: CODEX_IMPORT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleCodexImportRequest(ctx, config, request, state),
    }),
    'cyrene-codex-import: fetch route',
  );
  ctx.effect(
    () => connection.fetch.register({
      path: CODEX_PREVIEW_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleCodexPreviewRequest(ctx, request),
    }),
    'cyrene-codex-import: preview route',
  );
  ctx.effect(
    () => connection.fetch.register({
      path: CODEX_CONTINUE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleCodexContinueRequest(ctx, request, state),
    }),
    'cyrene-codex-import: continue route',
  );
}

/**
 * Handle one authenticated import request. The Connection host performs
 * Host/Origin/cookie authentication before this route is called.
 *
 * The function is exported so integration tests can exercise the exact route
 * handler while mounting the real upstream Session and persistence services.
 * 中文：处理一条经过认证的导入请求。Connection host 会在调用此路由前完成 Host/Origin/cookie 认证。导出函数用于集成测试挂载真实上游 Session 和持久化服务，并测试完全相同的路由处理器。
 */
export async function handleCodexImportRequest(
  ctx: Context,
  config: Config,
  request: Request,
  state: CodexImportState = {
    inFlight: new Map(),
    continueInFlight: new Map(),
  },
): Promise<Response> {
  try {
    if (request.method !== 'POST') return problem(405, 'IMPORT_METHOD_NOT_ALLOWED', 'Only POST is accepted.');
    const input = await decodeRequest(request);
    const native = await runCodexNativeImport(ctx, config, input, request.signal);
    const outcome = await persistImport(ctx, state, native, input.filename, request.signal);
    return Response.json({
      sessionId: outcome.sessionId,
      duplicate: outcome.duplicate,
      sourceSha256: outcome.sourceSha256,
      sourceSizeBytes: outcome.sourceSizeBytes,
      importedMessageCount: outcome.importedMessageCount,
      conversionReport: outcome.conversionReport,
    });
  } catch (error: unknown) {
    return importProblem(error);
  }
}

/**
 * Open an imported archive as a new, explicitly configured live Agent.
 *
 * The source remains a read-only archive. Only a balanced completed-turn
 * prefix is copied as a seed; source tool, approval, system and raw-import
 * records are never submitted to the Agent loop for execution.
 * 中文：将已导入的 archive 作为新建且显式配置的 live Agent 打开。来源始终是只读 archive。仅将完整闭合 turn 的前缀复制为 seed；来源中的 tool、approval、system 和原始导入记录绝不会提交给 Agent loop 执行。
 */
export async function handleCodexContinueRequest(
  ctx: Context,
  request: Request,
  state: CodexImportState = {
    inFlight: new Map(),
    continueInFlight: new Map(),
  },
): Promise<Response> {
  try {
    if (request.method !== 'POST') return problem(405, 'IMPORT_CONTINUE_METHOD_NOT_ALLOWED', 'Only POST is accepted.');
    const input = await decodeContinueRequest(request);
    const outcome = await continueCodexSession(ctx, state, input, request.signal);
    return Response.json({
      sourceSessionId: outcome.sourceSessionId,
      sessionId: outcome.sessionId,
      duplicate: outcome.duplicate,
      cwd: outcome.cwd,
      ...(outcome.agentPreset === undefined ? {} : { agentPreset: outcome.agentPreset }),
      sourceSha256: outcome.sourceSha256,
    });
  } catch (error: unknown) {
    return importProblem(error);
  }
}

/**
 * Read an imported archive without creating or restoring an Agent.
 *
 * The preview is projected from the same Cyrene persistence events used by
 * Session restore. Historical tool records are returned as data with an
 * explicit non-executable flag; the route never submits them to ToolRuntime.
 * 中文：读取已导入的 archive，但不创建或恢复 Agent。预览从与 Session restore 相同的 Cyrene 持久化事件投影生成。历史工具记录以数据形式返回，并明确标记为不可执行；此路由绝不会将它们提交给 ToolRuntime。
 */
export async function handleCodexPreviewRequest(
  ctx: Context,
  request: Request,
): Promise<Response> {
  try {
    if (request.method !== 'GET') return problem(405, 'IMPORT_PREVIEW_METHOD_NOT_ALLOWED', 'Only GET is accepted.');
    const url = new URL(request.url);
    const sessionId = previewSessionId(url.searchParams.getAll('sessionId'));
    const stored = await storedOrContinueError(
      persistenceOf(ctx),
      sessionId,
      request.signal,
      'IMPORT_PREVIEW_SESSION_NOT_FOUND',
    );
    const marker = importMarkerOf(stored.events);
    if (marker === undefined) {
      throw new ImportRouteError(409, 'IMPORT_PREVIEW_SOURCE_NOT_ARCHIVE', 'sessionId is not a Codex read-only archive.');
    }
    return Response.json(buildPreview(stored, marker));
  } catch (error: unknown) {
    return importProblem(error);
  }
}

async function decodeRequest(request: Request): Promise<CodexImportRequest> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_IMPORT_REQUEST_BYTES) {
    throw new ImportRouteError(413, 'IMPORT_REQUEST_TOO_LARGE', 'The buffered import request exceeds its byte limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ImportRouteError(400, 'IMPORT_INVALID_JSON', 'The import request must be UTF-8 JSON.');
  }
  let body: Record<string, unknown>;
  try {
    body = record(value);
  } catch {
    throw new ImportRouteError(400, 'IMPORT_INVALID_REQUEST', 'The import request must be a JSON object.');
  }
  if (typeof body.filename !== 'string' || body.filename.length === 0 || body.filename.length > 512
    || [...body.filename].some(character => character < ' ' || character === '\u007f')) {
    throw new ImportRouteError(400, 'IMPORT_INVALID_FILENAME', 'filename must be a printable string of at most 512 characters.');
  }
  if (typeof body.content !== 'string') {
    throw new ImportRouteError(400, 'IMPORT_INVALID_CONTENT', 'content must be a UTF-8 JSONL string.');
  }
  const contentBytes = new TextEncoder().encode(body.content);
  if (contentBytes.byteLength > MAX_IMPORT_CONTENT_BYTES) {
    throw new ImportRouteError(413, 'IMPORT_CONTENT_TOO_LARGE', 'The Codex rollout exceeds the inline import byte limit.');
  }
  return { filename: body.filename, content: body.content };
}

async function decodeContinueRequest(request: Request): Promise<CodexContinueRequest> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_IMPORT_REQUEST_BYTES) {
    throw new ImportRouteError(413, 'IMPORT_CONTINUE_REQUEST_TOO_LARGE', 'The buffered Continue request exceeds its byte limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ImportRouteError(400, 'IMPORT_CONTINUE_INVALID_JSON', 'The Continue request must be UTF-8 JSON.');
  }
  let body: Record<string, unknown>;
  try {
    body = record(value);
  } catch {
    throw new ImportRouteError(400, 'IMPORT_CONTINUE_INVALID_REQUEST', 'The Continue request must be a JSON object.');
  }
  const sourceSessionId = sessionIdField(body, 'sourceSessionId');
  const newSessionId = sessionIdField(body, 'newSessionId');
  if (sourceSessionId === newSessionId) {
    throw new ImportRouteError(400, 'IMPORT_CONTINUE_SAME_SESSION', 'sourceSessionId and newSessionId must differ.');
  }
  if (typeof body.cwd !== 'string' || body.cwd.length === 0 || body.cwd.length > 4_096
    || [...body.cwd].some(character => character < ' ' || character === '\u007f') || !isAbsolute(body.cwd)) {
    throw new ImportRouteError(400, 'IMPORT_CONTINUE_INVALID_CWD', 'cwd must be an absolute printable path.');
  }
  let agentPreset: string | undefined;
  if (body.agentPreset !== undefined) {
    if (typeof body.agentPreset !== 'string' || body.agentPreset.length === 0 || body.agentPreset.length > 256
      || [...body.agentPreset].some(character => character < ' ' || character === '\u007f')) {
      throw new ImportRouteError(400, 'IMPORT_CONTINUE_INVALID_PRESET', 'agentPreset must be a printable string of at most 256 characters.');
    }
    agentPreset = body.agentPreset;
  }
  return { sourceSessionId, newSessionId, cwd: body.cwd, ...(agentPreset === undefined ? {} : { agentPreset }) };
}

function sessionIdField(body: Record<string, unknown>, field: string): SessionId {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || [...value].some(character => character < ' ' || character === '\u007f')) {
    throw new ImportRouteError(400, 'IMPORT_CONTINUE_INVALID_SESSION_ID', `${field} must be a printable string of at most 256 characters.`);
  }
  return makeSessionId(value);
}

function previewSessionId(values: readonly string[]): SessionId {
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.length === 0 || value.length > 256
    || [...value].some(character => character < ' ' || character === '\u007f')) {
    throw new ImportRouteError(400, 'IMPORT_PREVIEW_INVALID_SESSION_ID', 'sessionId must be provided exactly once as a printable string of at most 256 characters.');
  }
  return makeSessionId(value);
}

async function runCodexNativeImport(
  ctx: Context,
  config: Config,
  input: CodexImportRequest,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), 'cyrene-codex-import-'));
  const path = join(directory, 'rollout.jsonl');
  try {
    await writeFile(path, new TextEncoder().encode(input.content), { flag: 'wx' });
    const result = record(await runNativeRequest(
      ctx,
      config,
      directory,
      'import_codex_rollout',
      { path, include_raw: true, max_bytes: MAX_IMPORT_CONTENT_BYTES },
      signal,
    ));
    validateNativeResult(result, input.content);
    return result;
  } catch (error: unknown) {
    if (error instanceof ImportRouteError) throw error;
    throw new ImportRouteError(502, 'IMPORT_NATIVE_FAILED', 'The Rust Codex importer did not return a usable result.', error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateNativeResult(value: Record<string, unknown>, expectedContent: string): void {
  if (value.schema !== IMPORT_SCHEMA || value.source !== 'codex') {
    throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native importer returned an unexpected schema.');
  }
  const digest = value.source_sha256;
  const size = value.source_size_bytes;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
    throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native importer returned an invalid source digest.');
  }
  const raw = record(value.raw);
  const expectedSize = new TextEncoder().encode(expectedContent).byteLength;
  if (raw.sha256 !== digest || raw.encoding !== 'utf-8' || raw.content !== expectedContent
    || raw.size_bytes !== expectedSize || size !== expectedSize) {
    throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native importer did not return the requested raw archive.');
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.events)
    || !Array.isArray(value.unknown_records) || typeof value.conversion_report !== 'object'
    || value.conversion_report === null || Array.isArray(value.conversion_report)) {
    throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native importer returned incomplete conversion data.');
  }
}

async function persistImport(
  ctx: Context,
  state: CodexImportState,
  native: Record<string, unknown>,
  filename: string,
  signal: AbortSignal,
): Promise<ImportOutcome> {
  const digest = stringField(native, 'source_sha256');
  const sessionId = makeSessionId(`codex-${digest.slice('sha256:'.length)}`);
  const running = state.inFlight.get(sessionId);
  if (running !== undefined) {
    const completed = await running;
    return { ...completed, duplicate: true };
  }
  const operation = persistImportOnce(ctx, native, filename, sessionId, signal);
  state.inFlight.set(sessionId, operation);
  try {
    return await operation;
  } finally {
    if (state.inFlight.get(sessionId) === operation) state.inFlight.delete(sessionId);
  }
}

async function persistImportOnce(
  ctx: Context,
  native: Record<string, unknown>,
  filename: string,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<ImportOutcome> {
  const persistence = persistenceOf(ctx);
  const sessions = sessionsOf(ctx);
  const digest = stringField(native, 'source_sha256');
  const sourceSizeBytes = integerField(native, 'source_size_bytes');
  const messages = messageRecords(native);
  const conversionReport = record(native.conversion_report);
  const existing = await persistence.stat(sessionId, { signal });
  if (existing !== undefined) {
    const stored = await readStored(persistence, sessionId, signal);
    if (!hasImportMarker(stored.events, digest)) {
      if (stored.events.length === 0) {
        const events = buildEvents(native, filename, sessionId);
        let writer: SessionHandle | undefined;
        try {
          writer = await persistence.open(sessionId, 'write', { signal });
          await writer.append(events, { signal });
          await writer.flush({ signal });
        } catch (error: unknown) {
          if (error instanceof SessionAlreadyOwnedError) {
            throw new ImportRouteError(409, 'IMPORT_SESSION_INCOMPLETE', 'A prior import owns this deterministic Session and has not completed.');
          }
          throw error;
        } finally {
          await writer?.close();
        }
        await publishExisting(sessions, await readStored(persistence, sessionId, signal));
      } else {
        throw new ImportRouteError(409, 'IMPORT_SESSION_INCOMPLETE', 'A prior import left this deterministic Session incomplete; an owner must recover it before retrying.');
      }
    } else {
      await publishExisting(sessions, stored);
    }
    return {
      sessionId,
      duplicate: true,
      sourceSha256: digest,
      sourceSizeBytes,
      importedMessageCount: messages.length,
      conversionReport,
    };
  }

  const events = buildEvents(native, filename, sessionId);
  let writer: SessionHandle | undefined;
  let duplicate = false;
  try {
    writer = await persistence.create(materializeCreateHeader({
      version: 2,
      id: sessionId,
      createdAt: createdAtOf(native),
      isSeeded: false,
    }));
    await writer.append(events, { signal });
    await writer.flush({ signal });
  } catch (error: unknown) {
    if (error instanceof SessionAlreadyExistsError) {
      const stored = await readStored(persistence, sessionId, signal);
      if (hasImportMarker(stored.events, digest)) {
        await publishExisting(sessions, stored);
        duplicate = true;
      }
      else throw new ImportRouteError(409, 'IMPORT_SESSION_INCOMPLETE', 'A concurrent import owns this deterministic Session and has not completed.');
    } else {
      throw error;
    }
  } finally {
    await writer?.close();
  }
  if (!duplicate) {
    await publishExisting(sessions, await readStored(persistence, sessionId, signal));
  }
  return {
    sessionId,
    duplicate,
    sourceSha256: digest,
    sourceSizeBytes,
    importedMessageCount: messages.length,
    conversionReport,
  };
}

async function continueCodexSession(
  ctx: Context,
  state: CodexImportState,
  input: CodexContinueRequest,
  signal: AbortSignal,
): Promise<ContinueOutcome> {
  const requestKey = continueRequestKey(input);
  const running = state.continueInFlight.get(input.newSessionId);
  if (running !== undefined) {
    if (running.requestKey !== requestKey) {
      throw new ImportRouteError(409, 'IMPORT_CONTINUE_CONFLICT', 'newSessionId is already being opened from a different source or workspace path.');
    }
    const completed = await running.operation;
    return { ...completed, duplicate: true };
  }
  const operation = continueCodexSessionOnce(ctx, input, signal);
  state.continueInFlight.set(input.newSessionId, { requestKey, operation });
  try {
    return await operation;
  } finally {
    const current = state.continueInFlight.get(input.newSessionId);
    if (current?.operation === operation) state.continueInFlight.delete(input.newSessionId);
  }
}

async function continueCodexSessionOnce(
  ctx: Context,
  input: CodexContinueRequest,
  signal: AbortSignal,
): Promise<ContinueOutcome> {
  const persistence = persistenceOf(ctx);
  const source = await storedOrContinueError(persistence, input.sourceSessionId, signal, 'IMPORT_CONTINUE_SOURCE_NOT_FOUND');
  const marker = importMarkerOf(source.events);
  if (marker === undefined) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_SOURCE_NOT_ARCHIVE', 'sourceSessionId is not a Codex read-only archive.');
  }
  const seed = continuationSeed(source.events);
  const composition = await continueComposition(ctx, input.agentPreset);
  const agentOptions = defaultAgentOptions(ctx);
  const agents = agentsOf(ctx);
  const existing = await persistence.stat(input.newSessionId, { signal });
  if (existing !== undefined) {
    const target = await storedOrContinueError(persistence, input.newSessionId, signal, 'IMPORT_CONTINUE_TARGET_NOT_FOUND');
    validateContinuationTarget(target, input, source.header.id, seed, composition.id);
    await ensureContinuationAgent(ctx, agents, target, composition, agentOptions, signal);
    return continueOutcome(input, marker.sourceSha256, target.header.agentPreset, true);
  }

  const options: CreateAgentOptions = {
    sessionId: input.newSessionId,
    seed: structuredClone(seed),
    inheritedEventCount: SessionLogOffset(seed.length),
    meta: {
      cwd: input.cwd,
      parentSession: source.header.id,
      isSeeded: true,
      ...(composition.id === undefined ? {} : { agentPreset: composition.id }),
    },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(composition.setup === undefined ? {} : { setup: composition.setup }),
    signal,
  };
  try {
    await agents.create(options);
  } catch (error: unknown) {
    if (error instanceof SessionAlreadyExistsError) {
      const target = await storedOrContinueError(persistence, input.newSessionId, signal, 'IMPORT_CONTINUE_TARGET_NOT_FOUND');
      validateContinuationTarget(target, input, source.header.id, seed, composition.id);
      await ensureContinuationAgent(ctx, agents, target, composition, agentOptions, signal);
      return continueOutcome(input, marker.sourceSha256, target.header.agentPreset, true);
    }
    if (error instanceof SessionAlreadyOwnedError) {
      throw new ImportRouteError(409, 'IMPORT_CONTINUE_SESSION_BUSY', 'newSessionId is currently owned by another live Agent.');
    }
    throw new ImportRouteError(502, 'IMPORT_CONTINUE_AGENT_FAILED', 'The upstream Agent could not be created for this continuation.', error);
  }
  return continueOutcome(input, marker.sourceSha256, composition.id, false);
}

function continueOutcome(
  input: CodexContinueRequest,
  sourceSha256: string,
  agentPreset: string | undefined,
  duplicate: boolean,
): ContinueOutcome {
  return {
    sourceSessionId: input.sourceSessionId,
    sessionId: input.newSessionId,
    duplicate,
    cwd: input.cwd,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    sourceSha256,
  };
}

async function storedOrContinueError(
  persistence: SessionPersistence,
  id: SessionId,
  signal: AbortSignal,
  notFoundCode: string,
): Promise<StoredSession> {
  if (await persistence.stat(id, { signal }) === undefined) {
    throw new ImportRouteError(404, notFoundCode, `Session ${id} was not found in the current Workspace.`);
  }
  try {
    return await readStored(persistence, id, signal);
  } catch (error: unknown) {
    if (error instanceof SessionPersistenceNotFoundError) {
      throw new ImportRouteError(404, notFoundCode, `Session ${id} was not found in the current Workspace.`, error);
    }
    throw error;
  }
}

function continuationSeed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const lastCompletedTurn = events.findLastIndex(event => event.type === 'turn/end');
  if (lastCompletedTurn < 0) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_UNAVAILABLE', 'The imported archive has no completed turn that can be continued.');
  }
  const seed = events.slice(0, lastCompletedTurn + 1);
  if (seed.length === 0) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_UNAVAILABLE', 'The imported archive has no completed turn that can be continued.');
  }
  return seed;
}

function validateContinuationTarget(
  target: StoredSession,
  input: CodexContinueRequest,
  sourceSessionId: SessionId,
  seed: readonly SessionEvent[],
  agentPreset: string | undefined,
): void {
  const header = target.header;
  if (header.parentSession !== sourceSessionId || header.cwd !== input.cwd || !header.isSeeded
    || target.inheritedEventCount !== seed.length || !startsWithEvents(target.events, seed)) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_CONFLICT', 'newSessionId already contains a different continuation.');
  }
  if (agentPreset !== undefined && header.agentPreset !== agentPreset) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_CONFLICT', 'newSessionId was created with a different Agent preset.');
  }
  if (input.agentPreset === undefined && header.agentPreset !== undefined && agentPreset === undefined) {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The target continuation requires its original Agent preset to be installed.');
  }
}

async function ensureContinuationAgent(
  ctx: Context,
  agents: AgentRegistryLike,
  target: StoredSession,
  composition: ContinueComposition,
  agentOptions: AgentOptions | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (agents.get(target.header.id) !== undefined) return;
  if (target.header.agentPreset !== undefined && composition.setup === undefined) {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The target continuation requires its original Agent preset to be installed.');
  }
  try {
    await agents.resume({
      resumeSessionId: target.header.id,
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(composition.setup === undefined ? {} : { setup: composition.setup }),
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof SessionAlreadyOwnedError) {
      throw new ImportRouteError(409, 'IMPORT_CONTINUE_SESSION_BUSY', 'newSessionId is currently owned by another live Agent.');
    }
    throw new ImportRouteError(502, 'IMPORT_CONTINUE_AGENT_FAILED', 'The persisted continuation could not be reopened as an Agent.', error);
  }
}

async function continueComposition(ctx: Context, requested: string | undefined): Promise<ContinueComposition> {
  const value = ctx.get('agentPresets');
  if (value === undefined) {
    if (requested !== undefined) {
      throw new ImportRouteError(503, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The requested Agent preset service is unavailable.');
    }
    return {};
  }
  const presets = value as unknown as AgentPresetRegistryLike;
  if (typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The Agent preset service is incomplete.');
  }
  let resolvedValue: unknown;
  try {
    resolvedValue = await presets.resolve(requested);
  } catch (error: unknown) {
    throw new ImportRouteError(409, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The requested Agent preset could not be resolved.', error);
  }
  if (resolvedValue === null || typeof resolvedValue !== 'object' || Array.isArray(resolvedValue)
    || typeof (resolvedValue as { readonly id?: unknown }).id !== 'string'
    || (resolvedValue as { readonly id: string }).id.length === 0) {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_PRESET_UNAVAILABLE', 'The Agent preset service returned an invalid preset identity.');
  }
  const resolved = resolvedValue as { readonly id: string };
  return {
    id: resolved.id,
    setup: async agentCtx => { await presets.mount(agentCtx, resolved.id); },
  };
}

function defaultAgentOptions(ctx: Context): AgentOptions | undefined {
  const value = ctx.get('agentDefaultModel');
  if (value === undefined) return undefined;
  const selection = (value as unknown as AgentDefaultModelLike).currentSelection();
  if (typeof selection.provider !== 'string' || selection.provider.length === 0
    || typeof selection.model !== 'string' || selection.model.length === 0) {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_MODEL_UNAVAILABLE', 'No valid default model is configured for Continue.');
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  };
}

function agentsOf(ctx: Context): AgentRegistryLike {
  const agents = ctx.get('agents');
  if (agents === undefined) {
    throw new ImportRouteError(503, 'IMPORT_CONTINUE_AGENT_UNAVAILABLE', 'The upstream AgentRegistry/AgentLoop is unavailable.');
  }
  return agents as unknown as AgentRegistryLike;
}

function continueRequestKey(input: CodexContinueRequest): string {
  return JSON.stringify([input.sourceSessionId, input.newSessionId, input.cwd, input.agentPreset ?? null]);
}

function startsWithEvents(actual: readonly SessionEvent[], expected: readonly SessionEvent[]): boolean {
  if (actual.length < expected.length) return false;
  return expected.every((event, index) => JSON.stringify(actual[index]) === JSON.stringify(event));
}

interface StoredSession {
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly events: readonly SessionEvent[];
}

async function readStored(
  persistence: SessionPersistence,
  id: SessionId,
  signal: AbortSignal,
): Promise<StoredSession> {
  const reader = await persistence.open(id, 'read', { signal });
  try {
    return {
      header: reader.header,
      inheritedEventCount: reader.inheritedEventCount,
      events: await reader.read(0, Number.MAX_SAFE_INTEGER, { signal }),
    };
  } finally {
    await reader.close();
  }
}

interface CodexPreviewMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp: number;
  readonly model?: string;
}

interface CodexImportMarker {
  readonly sourceSha256: string;
  readonly data: Record<string, unknown>;
}

function buildPreview(stored: StoredSession, marker: CodexImportMarker): Record<string, unknown> {
  const markerIndex = stored.events.findIndex(event => importMarkerOf([event])?.sourceSha256 === marker.sourceSha256);
  const archiveEvents = markerIndex < 0 ? stored.events : stored.events.slice(0, markerIndex);
  const messages = archiveEvents.flatMap(event => {
    const message = previewMessageOf(event);
    return message === undefined ? [] : [message];
  });
  const history = archiveEvents
    .filter(event => (event as unknown as { readonly type?: unknown }).type === IMPORT_HISTORY_EVENT_TYPE)
    .map((event, index) => previewHistoryOf(event, index));
  const source = record(marker.data.source);
  const raw = record(marker.data.raw);
  const conversionReport = record(marker.data.conversionReport);
  const safety = record(marker.data.safety);
  const sourceSizeBytes = previewInteger(source.sizeBytes, 'source.sizeBytes');
  const rawSizeBytes = previewInteger(raw.sizeBytes, 'raw.sizeBytes');
  const rawReference = record(raw.reference);
  return {
    schema: IMPORT_SCHEMA,
    sessionId: stored.header.id,
    readOnly: true,
    sourceSha256: marker.sourceSha256,
    sourceSizeBytes,
    importedMessageCount: messages.length,
    messages,
    history,
    source: structuredClone(source),
    // The authoritative event keeps the raw upload. The preview only exposes
    // its digest and retrieval reference, so a large archive is not duplicated
    // into the browser response or rendered accidentally.
    // 中文：权威事件保留原始上传。预览只公开摘要和可检索引用，因此不会把大型 archive 重复放入浏览器响应或意外渲染。
    raw: {
      sha256: stringPreviewField(raw.sha256, 'raw.sha256'),
      sizeBytes: rawSizeBytes,
      encoding: stringPreviewField(raw.encoding, 'raw.encoding'),
      reference: structuredClone(rawReference),
    },
    conversionReport: structuredClone(conversionReport),
    safety: structuredClone(safety),
  };
}

function previewMessageOf(event: SessionEvent): CodexPreviewMessage | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined;
  const eventData = eventRecord(event);
  if (eventData === undefined) return undefined;
  const message = event.type === 'assistant/message' ? recordOrUndefined(eventData.message) : eventData;
  if (message === undefined) return undefined;
  const text = previewContentText(message.content);
  if (text.length === 0) return undefined;
  const source = recordOrUndefined(message.source);
  const model = source !== undefined && typeof source.model === 'string' && source.model.length > 0
    ? source.model
    : undefined;
  const timestamp = previewTimestamp(event);
  return {
    role: event.type === 'user/message' ? 'user' : 'assistant',
    text,
    timestamp,
    ...(model === undefined ? {} : { model }),
  };
}

function previewHistoryOf(event: SessionEvent, index: number): Record<string, unknown> {
  const data = eventRecord(event);
  if (data === undefined) {
    return {
      index,
      kind: 'invalid_historical_record',
      timestamp: previewTimestamp(event),
      executable: false,
    };
  }
  return {
    ...structuredClone(data),
    index,
    timestamp: previewTimestamp(event),
    executable: false,
  };
}

function eventRecord(event: SessionEvent): Record<string, unknown> | undefined {
  return recordOrUndefined((event as unknown as { readonly data?: unknown }).data);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  try {
    return record(value);
  } catch {
    return undefined;
  }
}

function previewContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(block => {
    if (typeof block === 'string') return block;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return '';
    const text = (block as { readonly text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('');
}

function previewTimestamp(event: SessionEvent): number {
  const value = (event as unknown as { readonly time?: unknown }).time;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function previewInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ImportRouteError(500, 'IMPORT_PREVIEW_CORRUPT_ARCHIVE', `The imported archive has an invalid ${field}.`);
  }
  return value;
}

function stringPreviewField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ImportRouteError(500, 'IMPORT_PREVIEW_CORRUPT_ARCHIVE', `The imported archive has an invalid ${field}.`);
  }
  return value;
}

function hasImportMarker(events: readonly SessionEvent[], digest: string): boolean {
  return events.some(event => importMarkerOf([event])?.sourceSha256 === digest);
}

function importMarkerOf(events: readonly SessionEvent[]): { readonly sourceSha256: string; readonly data: Record<string, unknown> } | undefined {
  return events.reduce<{ readonly sourceSha256: string; readonly data: Record<string, unknown> } | undefined>((found, event) => {
    if (found !== undefined) return found;
    const extension = event as unknown as { readonly type?: unknown; readonly data?: unknown };
    if (extension.type !== IMPORT_EVENT_TYPE) return undefined;
    try {
      const data = record(extension.data);
      const source = record(data.source);
      if (data.schema !== IMPORT_SCHEMA || source.provider !== IMPORT_PROVIDER) return undefined;
      const direct = data.sourceSha256;
      if (typeof direct === 'string' && direct === source.sha256) return { sourceSha256: direct, data };
      return typeof source.sha256 === 'string' ? { sourceSha256: source.sha256, data } : undefined;
    } catch {
      return undefined;
    }
  }, undefined);
}

async function publishExisting(sessions: SessionStoreLike, stored: StoredSession): Promise<Session> {
  const current = sessions.get(stored.header.id);
  if (current !== undefined) return current;
  return publishRestored(sessions, stored.header.id, structuredClone(stored.events), stored.header, stored.inheritedEventCount);
}

async function publishRestored(
  sessions: SessionStoreLike,
  id: SessionId,
  events: readonly SessionEvent[],
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): Promise<Session> {
  const current = sessions.get(id);
  if (current !== undefined) return current;
  const session = sessions.prepare(id, {
    seed: structuredClone([...events]),
    meta: structuredClone(header),
    inheritedEventCount,
    seedSource: 'persistence',
  });
  const detach = sessions.enter(session);
  try {
    sessions.announce(session);
  } catch (error: unknown) {
    detach();
    throw error;
  }
  return session;
}

function buildEvents(
  native: Record<string, unknown>,
  filename: string,
  sessionId: SessionId,
): SessionEvent[] {
  const messages = messageRecords(native);
  const history = eventRecords(native);
  const unknownRecords = native.unknown_records as unknown[];
  const raw = record(native.raw);
  const sourceSession = record(native.session);
  const safety = record(native.safety);
  const conversionReport = record(native.conversion_report);
  const digest = stringField(native, 'source_sha256');
  const sourceSizeBytes = integerField(native, 'source_size_bytes');
  const safeRaw = {
    sha256: stringField(raw, 'sha256'),
    sizeBytes: integerField(raw, 'size_bytes'),
    encoding: 'utf-8',
    reference: { kind: 'upload', filename },
    content: stringField(raw, 'content'),
  };
  const events: SessionEvent[] = [];
  let sequence = 0;
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let fallbackTime = Date.now();
  const push = (
    type: string,
    data: unknown,
    time = fallbackTime,
    surfaceOp?: 'append',
    ignorable = false,
  ): void => {
    const event = {
      type,
      seq: SessionSeq(sequence++),
      time: safeTime(time, fallbackTime),
      data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(ignorable ? { ignorable: true } : {}),
    } as unknown as SessionEvent;
    events.push(event);
    fallbackTime = event.time + 1;
  };

  for (const message of messages) {
    const role = stringField(message, 'role');
    const text = stringField(message, 'text');
    const time = timestampOf(message.timestamp, fallbackTime);
    if (role === 'user') {
      if (turnOpen) {
        push('step/end', { turn, step }, time);
        push('turn/end', { turn, reason: { kind: 'completed' } }, time);
      }
      turn += 1;
      step = 1;
      turnOpen = true;
      push('turn/start', { turn }, time);
      push('step/start', { turn, step }, time);
      push('user/message', createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      }), time, 'append');
    } else {
      if (!turnOpen) {
        turn += 1;
        step = 1;
        turnOpen = true;
        push('turn/start', { turn }, time);
        push('step/start', { turn, step }, time);
      }
      push('assistant/message', {
        turn,
        step,
        message: createAssistantMessage({
          source: { provider: IMPORT_PROVIDER, model: modelOf(message) },
          content: [{ type: 'text', text }],
        }),
        stream: [],
      }, time, 'append');
      push('step/end', { turn, step }, time);
      push('turn/end', { turn, reason: { kind: 'completed' } }, time);
      turnOpen = false;
    }
  }
  if (turnOpen) {
    push('step/end', { turn, step }, fallbackTime);
    push('turn/end', { turn, reason: { kind: 'completed' } }, fallbackTime);
  }

  for (const historyRecord of history) {
    push(IMPORT_HISTORY_EVENT_TYPE, { ...historyRecord, executable: false }, timestampOf(historyRecord.timestamp, fallbackTime), undefined, true);
  }
  for (const unknown of unknownRecords) {
    const unknownRecord = record(unknown);
    push(IMPORT_HISTORY_EVENT_TYPE, { kind: 'unknown_record', ...unknownRecord, executable: false }, fallbackTime, undefined, true);
  }
  push(IMPORT_EVENT_TYPE, {
    schema: IMPORT_SCHEMA,
    sessionId,
    sourceSha256: digest,
    source: {
      kind: 'codex-rollout',
      provider: IMPORT_PROVIDER,
      filename,
      sha256: digest,
      sizeBytes: sourceSizeBytes,
      originalSession: sourceSession,
    },
    raw: safeRaw,
    conversionReport,
    safety: {
      ...safety,
      historicalToolCallsExecutable: false,
      historicalSystemContentLive: false,
      historyReplayed: false,
    },
  }, fallbackTime, undefined, true);
  // A restored Session uses this marker to distinguish imported seed history
  // from events appended later by a real user prompt.
  // 中文：恢复后的 Session 使用此标记区分导入的 seed 历史和真实用户 prompt 追加的事件。
  push('session/end-seed', {}, fallbackTime);
  return events;
}

function messageRecords(native: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(native.messages)) throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native message projection is not an array.');
  return native.messages.map((value, index) => {
    const message = record(value);
    const role = message.role;
    if ((role !== 'user' && role !== 'assistant') || typeof message.text !== 'string' || message.text.length === 0) {
      throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', `The native message at index ${index} has an invalid role or text.`);
    }
    return message;
  });
}

function eventRecords(native: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(native.events)) throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', 'The native history projection is not an array.');
  return native.events.map((value, index) => {
    const event = record(value);
    if (event.kind === 'message') {
      // Message mirrors are already represented by real upstream message events.
      // 中文：消息镜像已经由真实的上游 message 事件表示。
      return { kind: 'message', executable: false, skipped: true, sourceIndex: index };
    }
    return event;
  }).filter(event => event.skipped !== true);
}

function modelOf(message: Record<string, unknown>): string {
  return typeof message.model === 'string' && message.model.length > 0 ? message.model : 'unknown';
}

function createdAtOf(native: Record<string, unknown>): number {
  const session = record(native.session);
  return timestampOf(session.created_at, Date.now());
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function safeTime(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', `The native result field ${field} is missing.`);
  return result;
}

function integerField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
    throw new ImportRouteError(502, 'IMPORT_RESULT_INVALID', `The native result field ${field} is invalid.`);
  }
  return result;
}

function persistenceOf(ctx: Context): SessionPersistence {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) throw new ImportRouteError(503, 'IMPORT_PERSISTENCE_UNAVAILABLE', 'Cyrene Session persistence is unavailable.');
  return persistence as SessionPersistence;
}

function sessionsOf(ctx: Context): SessionStoreLike {
  const sessions = ctx.get('sessions');
  if (sessions === undefined) throw new ImportRouteError(503, 'IMPORT_SESSION_STORE_UNAVAILABLE', 'The upstream Session store is unavailable.');
  return sessions as SessionStoreLike;
}

function connectionOf(ctx: Context): NavigatorConnection {
  return Reflect.get(ctx, 'connection') as NavigatorConnection;
}

class ImportRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

function importProblem(error: unknown): Response {
  if (error instanceof ImportRouteError) return problem(error.status, error.code, error.message);
  const detail = error instanceof Error ? error.message : 'The Codex import failed.';
  return problem(500, 'IMPORT_FAILED', detail);
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({
    type: 'about:blank',
    title: code,
    status,
    code,
    detail,
  }), {
    status,
    headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
  });
}
