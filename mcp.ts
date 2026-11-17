// MCP over Streamable HTTP. JSON-RPC 2.0, one response per POST, no sessions required.
// Speaks the 2026-07-28 revision (server/discover) and the legacy handshake revision;
// every tool acts on the SAME ForgeStore instance the REST routes use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type RepoRec } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** Byte-identical across calls: a frozen constant, never built from a clock or random source. */
const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by its number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
]);
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = Object.freeze({ name: 'gitforge', version: '1.0.0' });
const CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });

type StoreLike = import('./store.ts').ForgeStore;

/** Read the exact POST body text (MCP must recognise non-JSON bodies itself). */
function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A tool result carrying JSON in both its text block and structuredContent. */
function toolOk(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolve a tool name that may carry a server prefix (github__create_issue). */
function resolveToolName(raw: string): string | null {
  if (TOOL_NAMES.has(raw)) return raw;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const name of TOOL_NAMES) {
    const plain = name.replace(/_/g, '');
    if (normalized === plain || (normalized.length > plain.length && normalized.endsWith(plain))) return name;
  }
  return null;
}

/** Shared object views, so MCP and REST agree byte for byte. */
function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
  };
}

function findRepo(store: StoreLike, owner: unknown, name: string): RepoRec | undefined {
  return owner === VIEWER_LOGIN ? store.getRepo(VIEWER_LOGIN, name) : undefined;
}

/** Execute one tool call against the store; returns the tool result envelope. */
function callTool(store: StoreLike, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return toolError('name is required');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, str(args.description), Boolean(args.private));
      return repo === null ? toolError('repository already exists') : toolOk(repoView(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args.owner, str(args.repo));
      return repo === undefined ? toolError('repository not found') : toolOk(repoView(repo));
    }
    case 'create_issue': {
      const repo = findRepo(store, args.owner, str(args.repo));
      if (repo === undefined) return toolError('repository not found');
      const title = str(args.title);
      if (title === '') return toolError('title is required');
      const issue = store.createIssue(repo, title, str(args.body), []);
      return issue === null ? toolError('could not create issue') : toolOk(issue);
    }
    case 'list_issues': {
      const repo = findRepo(store, args.owner, str(args.repo));
      if (repo === undefined) return toolError('repository not found');
      const state = str(args.state) || 'open';
      return toolOk(store.listIssues(repo, state, 'created', 'desc'));
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args.owner, str(args.repo));
      if (repo === undefined) return toolError('repository not found');
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      const pull = store.createPull(repo, title, str(args.body), head, base);
      return pull === null ? toolError('could not create pull request') : toolOk(pull);
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args.owner, str(args.repo));
      if (repo === undefined) return toolError('repository not found');
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(number)) return toolError('pull_number is required');
      const merged = store.mergePull(repo, number);
      if (!merged.ok) return toolError(merged.reason === 'not-found' ? 'pull request not found' : 'pull request is not mergeable');
      return toolOk({ number, merged: true, sha: merged.sha });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/** Handle one POST /mcp request. Auth is enforced by the caller. */
export async function handleMcp(store: StoreLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readText(req);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    // The 2026-07-28 transport answers a non-JSON body with HTTP 400 and -32700.
    send(res, 400, error(null, -32700, 'Parse error'));
    return;
  }

  const id = body.id ?? null;
  const method = str(body.method);
  const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
    ? (body.params as Record<string, unknown>)
    : {};

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-type': JSON_TYPE });
    res.end();
    return;
  }
  if (method === 'server/discover') {
    send(res, 200, result(id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      instructions: 'A GitHub-compatible forge over MCP.',
    }));
    return;
  }
  if (method === 'initialize') {
    const offered = str(params.protocolVersion);
    const protocolVersion = offered === '' ? '2026-07-28' : offered;
    send(res, 200, result(id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO }));
    return;
  }
  if (method === 'tools/list') {
    send(res, 200, result(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const rawName = str(params.name);
    const resolved = resolveToolName(rawName);
    if (resolved === null) {
      send(res, 200, error(id, -32602, `Unknown tool: ${rawName}`));
      return;
    }
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const schema = TOOLS.find((tool) => tool.name === resolved)?.inputSchema as { required?: string[] } | undefined;
    const missing = (schema?.required ?? []).filter((key) => !(key in args) || args[key] === '' || args[key] === null || args[key] === undefined);
    if (missing.length > 0) {
      // A missing required argument is a tool-level error (isError:true), not an HTTP failure.
      send(res, 200, result(id, toolError(`missing required argument(s): ${missing.join(', ')}`)));
      return;
    }
    try {
      send(res, 200, result(id, callTool(store, resolved, args)));
    } catch (err) {
      send(res, 200, result(id, toolError(err instanceof Error ? err.message : String(err))));
    }
    return;
  }
  send(res, 200, error(id, -32601, `Method not found: ${method}`));
}
