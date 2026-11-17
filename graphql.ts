// GitHub GraphQL v4 over POST /api/graphql. A small document parser plus a resolver over the
// SAME ForgeStore the REST and MCP surfaces use, so ids and state are shared across all three.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type IssueRec, type PullRec, type RepoRec } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
type StoreLike = import('./store.ts').ForgeStore;

type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | { __var: string };
interface Field {
  kind: 'field' | 'inline';
  alias: string;
  name: string;
  args: Record<string, Value>;
  children: Field[];
  typeCondition?: string;
}
interface Operation { kind: 'query' | 'mutation'; fields: Field[] }
interface Token { kind: 'name' | 'string' | 'number' | 'punct' | 'spread'; value: string }

// ------------------------------------------------------------------ document parser

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s|,/.test(c)) { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { out.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if (c === '"') {
      let text = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { i += 1; text += src[i] ?? ''; i += 1; }
        else { text += src[i]; i += 1; }
      }
      i += 1;
      out.push({ kind: 'string', value: text });
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let text = '';
      while (i < src.length && /[0-9.]/.test(src[i] as string)) { text += src[i]; i += 1; }
      out.push({ kind: 'number', value: text });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let text = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i] as string)) { text += src[i]; i += 1; }
      out.push({ kind: 'name', value: text });
      continue;
    }
    out.push({ kind: 'punct', value: c });
    i += 1;
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private take(): Token | undefined { return this.tokens[this.pos++]; }
  private is(value: string): boolean { return this.peek()?.value === value; }
  private expect(value: string): void { if (this.is(value)) this.pos += 1; }

  parse(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) ops.push(this.operation());
    return ops;
  }

  private operation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    if (this.peek()?.value === 'query' || this.peek()?.value === 'mutation') {
      kind = this.take()?.value === 'mutation' ? 'mutation' : 'query';
      if (this.peek()?.kind === 'name') this.pos += 1; // operation name
    }
    if (this.is('(')) this.skipBalanced('(', ')'); // variable definitions
    while (this.is('@')) { this.pos += 1; if (this.peek()?.kind === 'name') this.pos += 1; if (this.is('(')) this.skipBalanced('(', ')'); }
    return { kind, fields: this.selectionSet() };
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (this.peek() !== undefined && depth > 0) {
      const token = this.take() as Token;
      if (token.value === open) depth += 1;
      else if (token.value === close) depth -= 1;
    }
  }

  private selectionSet(): Field[] {
    const fields: Field[] = [];
    this.expect('{');
    while (this.peek() !== undefined && !this.is('}')) {
      if (this.peek()?.kind === 'spread') {
        this.pos += 1;
        let typeCondition: string | undefined;
        if (this.peek()?.value === 'on') { this.pos += 1; typeCondition = this.take()?.value; }
        while (this.is('@')) { this.pos += 1; if (this.peek()?.kind === 'name') this.pos += 1; }
        fields.push({ kind: 'inline', alias: '', name: '', typeCondition, args: {}, children: this.selectionSet() });
        continue;
      }
      fields.push(this.field());
    }
    this.expect('}');
    return fields;
  }

  private field(): Field {
    const first = this.take()?.value ?? '';
    let alias = first;
    let name = first;
    if (this.is(':')) { this.pos += 1; name = this.take()?.value ?? ''; }
    const args: Record<string, Value> = {};
    if (this.is('(')) {
      this.pos += 1;
      while (this.peek() !== undefined && !this.is(')')) {
        const key = this.take()?.value ?? '';
        this.expect(':');
        args[key] = this.value();
        if (this.is(',')) this.pos += 1;
      }
      this.expect(')');
    }
    while (this.is('@')) {
      this.pos += 1;
      if (this.peek()?.kind === 'name') this.pos += 1;
      if (this.is('(')) this.skipBalanced('(', ')');
    }
    const children = this.is('{') ? this.selectionSet() : [];
    return { kind: 'field', alias, name, args, children };
  }

  private value(): Value {
    const token = this.peek();
    if (token === undefined) return null;
    if (token.value === '$') { this.pos += 1; return { __var: this.take()?.value ?? '' }; }
    if (token.kind === 'string' || token.kind === 'number') { this.pos += 1; return token.kind === 'number' ? Number(token.value) : token.value; }
    if (token.value === '[') {
      this.pos += 1;
      const list: Value[] = [];
      while (this.peek() !== undefined && !this.is(']')) { list.push(this.value()); if (this.is(',')) this.pos += 1; }
      this.expect(']');
      return list;
    }
    if (token.value === '{') {
      this.pos += 1;
      const object: Record<string, Value> = {};
      while (this.peek() !== undefined && !this.is('}')) {
        const key = this.take()?.value ?? '';
        this.expect(':');
        object[key] = this.value();
        if (this.is(',')) this.pos += 1;
      }
      this.expect('}');
      return object;
    }
    this.pos += 1;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return token.value; // enum names ride as strings
  }
}

// ------------------------------------------------------------------ ids

function gid(kind: string, num: number): string {
  return Buffer.from(`${kind}:${num}`, 'utf8').toString('base64url');
}

function decodeGid(value: unknown): { kind: string; num: number } | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const [kind, raw] = Buffer.from(value, 'base64url').toString('utf8').split(':');
    const num = Number(raw);
    if (kind === undefined || kind === '' || !Number.isInteger(num)) return null;
    return { kind, num };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ views

function issueView(issue: IssueRec): Record<string, unknown> {
  return {
    id: gid('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
  };
}

function pullView(pull: PullRec): Record<string, unknown> {
  return {
    id: gid('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: 'MERGEABLE',
    files: () => ({ nodes: pull.changedPaths.map((path) => ({ path })) }),
  };
}

type Resolver = (args: Record<string, unknown>, ctx: Context) => unknown;

interface Context {
  store: StoreLike;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: Context): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__var' in value) {
    return ctx.variables[(value as { __var: string }).__var] ?? null;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, Value>)) out[key] = resolveValue(entry, ctx);
    return out;
  }
  return value;
}

function resolveArgs(field: Field, ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx);
  return out;
}

function allRepos(ctx: Context): RepoRec[] {
  return ctx.store.listRepos(VIEWER_LOGIN);
}

function repoById(ctx: Context, value: unknown): RepoRec | undefined {
  const decoded = decodeGid(value);
  const target = decoded === null ? Number(value) : decoded.num;
  return allRepos(ctx).find((repo) => repo.id === target);
}

function issueByGid(ctx: Context, value: unknown): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGid(value);
  if (decoded === null) return null;
  for (const repo of allRepos(ctx)) {
    const issue = repo.issues.find((entry) => entry.id === decoded.num);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function pullByGid(ctx: Context, value: unknown): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGid(value);
  if (decoded === null) return null;
  for (const repo of allRepos(ctx)) {
    const pull = repo.pulls.find((entry) => entry.id === decoded.num);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

/** The introspected schema (only the fields gh and the checks probe need). */
const SCHEMA: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeObject(name: string): Record<string, unknown> {
  const fields = SCHEMA[name] ?? [];
  const enumValues = ENUMS[name] ?? [];
  return { name, fields: fields.map((field) => ({ name: field })), enumValues: enumValues.map((value) => ({ name: value })) };
}

/** A repository's GraphQL view: plain fields plus the connection resolvers. */
function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.default_branch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: ((args) => {
      const number = Number(args.number);
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueView(issue);
    }) as Resolver,
    issues: ((args, ctx) => {
      let list = repo.issues.slice();
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const order = args.orderBy as Record<string, unknown> | undefined;
      if (order !== undefined && order.direction === 'DESC') list.sort((a, b) => b.number - a.number);
      else list.sort((a, b) => a.number - b.number);
      const first = args.first === undefined ? list.length : Math.max(0, Math.min(Number(args.first), list.length));
      const after = args.after;
      const start = typeof after === 'string' && /^\d+$/.test(after) ? Number(after) : 0;
      const page = list.slice(start, start + first);
      const end = start + page.length;
      return {
        nodes: page.map(issueView),
        pageInfo: { hasNextPage: end < list.length, endCursor: String(end) },
      };
    }) as Resolver,
    pullRequests: ((args) => {
      const list = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => a.number - b.number);
      const first = args.first === undefined ? list.length : Math.max(0, Math.min(Number(args.first), list.length));
      return { nodes: list.slice(0, first).map(pullView) };
    }) as Resolver,
    pullRequest: ((args) => {
      const number = Number(args.number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullView(pull);
    }) as Resolver,
  };
}

/** The query/mutation root. */
function root(ctx: Context): Record<string, Resolver> {
  return {
    viewer: () => ({ login: VIEWER_LOGIN, name: 'ada iversen' }),
    __type: (args) => typeObject(String(args.name ?? '')),
    repository: (args) => {
      if (args.owner !== VIEWER_LOGIN) return null;
      const repo = allRepos(ctx).find((entry) => entry.name === String(args.name ?? ''));
      return repo === undefined ? null : repoView(repo);
    },
    node: (args) => {
      const decoded = decodeGid(args.id);
      if (decoded === null || decoded.kind !== 'Repository') return null;
      const repo = allRepos(ctx).find((entry) => entry.id === decoded.num);
      return repo === undefined ? null : repoView(repo);
    },
    createIssue: (args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoById(ctx, input.repositoryId);
      if (repo === undefined) return null;
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return issue === null ? null : { issue: issueView(issue) };
    },
    closeIssue: (args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(ctx, input.issueId);
      if (found === null) return null;
      const updated = ctx.store.setIssueState(found.repo, found.issue.number, 'closed');
      return updated === undefined ? null : { issue: issueView(updated) };
    },
    createPullRequest: (args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoById(ctx, input.repositoryId);
      if (repo === undefined) return null;
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      return pull === null ? null : { pullRequest: pullView(pull) };
    },
    mergePullRequest: (args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGid(ctx, input.pullRequestId);
      if (found === null) return null;
      ctx.store.mergePull(found.repo, found.pull.number);
      return { pullRequest: pullView(found.pull) };
    },
    addComment: (args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(ctx, input.subjectId);
      if (found === null) return null;
      const comment = ctx.store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
      if (comment === null) return null;
      return { commentEdge: { node: { id: gid('Comment', comment.id), body: comment.body } } };
    },
  };
}

/** Resolve one field against a parent value, collecting GraphQL errors for unknown fields. */
function resolveField(parent: unknown, field: Field, ctx: Context): unknown {
  if (field.kind === 'inline') return resolveSet(parent, field.children, ctx);
  const args = resolveArgs(field, ctx);
  let value: unknown;
  if (parent !== null && typeof parent === 'object' && Object.hasOwn(parent, field.name)) {
    const candidate = (parent as Record<string, unknown>)[field.name];
    value = typeof candidate === 'function' ? (candidate as Resolver)(args, ctx) : candidate;
  } else {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on this type.` });
    return null;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => resolveSet(entry, field.children, ctx));
  if (typeof value === 'object' && field.children.length > 0) return resolveSet(value, field.children, ctx);
  return value;
}

function resolveSet(parent: unknown, fields: Field[], ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.kind === 'inline' ? '' : field.alias;
    const value = resolveField(parent, field, ctx);
    if (field.kind === 'inline') Object.assign(out, value as Record<string, unknown>);
    else out[key] = value;
  }
  return out;
}

/** Execute one operation into a {data, errors} envelope. */
function execute(operation: Operation, variables: Record<string, unknown>, store: StoreLike): Record<string, unknown> {
  const ctx: Context = { store, variables, errors: [] };
  const source = root(ctx);
  const data = resolveSet(source, operation.fields, ctx);
  return { data, errors: ctx.errors };
}

// ------------------------------------------------------------------ HTTP

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function runOne(store: StoreLike, entry: Record<string, unknown>): Record<string, unknown> {
  const query = typeof entry.query === 'string' ? entry.query : '';
  const variables = entry.variables !== null && typeof entry.variables === 'object' && !Array.isArray(entry.variables)
    ? (entry.variables as Record<string, unknown>)
    : {};
  const operations = new Parser(tokenize(query)).parse();
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation in document.' }] };
  // A document with several named operations answers the first, as gh sends one per request.
  const wanted = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  const operation = wanted === undefined ? operations[0] as Operation : (operations.find((op, index) => index >= 0 && (op.kind === 'query' || op.kind === 'mutation') && index === 0) ?? operations[0]) as Operation;
  return execute(operation, variables, store);
}

/** Handle one POST /api/graphql request. Auth is enforced by the caller. */
export async function handleGraphql(store: StoreLike, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readText(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    send(res, 400, { data: null, errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  if (Array.isArray(body)) {
    send(res, 200, body.map((entry) => runOne(store, entry as Record<string, unknown>)));
    return;
  }
  if (body === null || typeof body !== 'object') {
    send(res, 400, { data: null, errors: [{ message: 'Expected a JSON object.' }] });
    return;
  }
  send(res, 200, runOne(store, body as Record<string, unknown>));
}
