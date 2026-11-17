// The contest server: a GitHub-compatible REST v3 forge over the deterministic store.
// main.ts owns the entry<->env lifecycle; this file owns every HTTP route and reply.
// All replies are JSON (never HTML), carry a request id and the token's scopes, and use
// GitHub's status codes and body shapes exactly as program/env/src/checks-rest.ts asserts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore, VIEWER_LOGIN, type RepoRec } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The single token, from the process environment. Empty means "accept any presented token". */
const configuredToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Build the server. It binds nothing until main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const store = new ForgeStore();
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(store, req, res, () => (requestSeq += 1));
  });
}

type Query = URLSearchParams;
type Body = Record<string, unknown>;

/** Answer one request with a JSON body; standard headers are added to every reply. */
function sendJson(res: ServerResponse, status: number, body: unknown, requestId: number, extra: Readonly<Record<string, string>> = {}): void {
  if (res.writableEnded) return;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': String(requestId),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  };
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

const notFound = (res: ServerResponse, id: number): void => sendJson(res, 404, { message: 'Not Found' }, id);
const unauthorized = (res: ServerResponse, id: number): void => sendJson(res, 401, { message: 'Requires authentication' }, id);
const badRequest = (res: ServerResponse, id: number): void => sendJson(res, 400, { message: 'Bad Request' }, id);

/** Decode one path segment (the client already percent-encodes segments). */
function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Split a contents path (keeps slashes) into decoded segments joined by '/'. */
function contentPath(segments: readonly string[]): string {
  return segments.map(segment).join('/');
}

/** Whether this request carries a valid token. healthz is handled before auth. */
function authenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null || match[1] === undefined || match[1].trim() === '') return false;
  if (configuredToken === '') return true;
  return match[1].trim() === configuredToken;
}

/** Read the request body: undefined when empty, parsed JSON, or a sentinel on malformed JSON. */
async function readBody(req: IncomingMessage): Promise<{ ok: true; value: Body | undefined } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as Body };
  } catch {
    return { ok: false };
  }
}

/** Public repository object, in the GitHub REST shape the checks assert. */
function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueView(issue: {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  stamp: string;
}): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.stamp,
    updated_at: issue.stamp,
  };
}

function pullView(pull: {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  stamp: string;
}): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${pull.base.ref}` },
    created_at: pull.stamp,
  };
}

/** All route handling, split out so the boot probe and auth gate stay obvious. */
async function handle(store: ForgeStore, req: IncomingMessage, res: ServerResponse, nextId: () => number): Promise<void> {
  const id = nextId();
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const query = url.searchParams;

  // The env's boot probe: exactly two 200 {"ok":true} answers, no token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, id);
    return;
  }

  // Everything else on the API surface is authenticated. healthz is the only exception.
  if (!authenticated(req)) {
    unauthorized(res, id);
    return;
  }

  // Non-API routes are JSON 404 (git smart HTTP is a later phase).
  if (!path.startsWith('/api/v3')) {
    notFound(res, id);
    return;
  }

  // Read and validate a JSON body before routing: a malformed body is always a 400.
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: Body = {};
  if (needsBody) {
    const parsed = await readBody(req);
    if (!parsed.ok) {
      badRequest(res, id);
      return;
    }
    body = parsed.value ?? {};
  }

  await route(store, res, id, method, path, query, body, req.headers.host ?? 'localhost');
}

/** Dispatch one authenticated, well-formed API request. */
async function route(
  store: ForgeStore,
  res: ServerResponse,
  id: number,
  method: string,
  path: string,
  query: Query,
  body: Body,
  host: string,
): Promise<void> {
  // Normalize the API path to segments after /api/v3.
  const raw = path.replace(/^\/api\/v3\/?/, '');
  const parts = raw.split('/').filter((part) => part !== '');
  const p = (index: number): string => (parts[index] === undefined ? '' : segment(parts[index] as string));

  // API root and metadata.
  if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, id);
      return;
    }
    notFound(res, id);
    return;
  }
  if (parts.length === 1 && p(0) === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' }, id);
    return;
  }
  if (parts.length === 1 && p(0) === 'user' && method === 'GET') {
    sendJson(res, 200, { id: 1000, login: VIEWER_LOGIN, name: 'ada iversen' }, id);
    return;
  }

  // /user/repos: list (paginated) and create.
  if (parts.length === 2 && p(0) === 'user' && p(1) === 'repos') {
    if (method === 'GET') {
      const perPage = clampPage(query.get('per_page'), 30);
      const page = clampPage(query.get('page'), 1);
      const all = store.listRepos(VIEWER_LOGIN);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      let headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers = { link: `<${nextUrl}>; rel="next"` };
      }
      sendJson(res, 200, slice.map(repoView), id, headers);
      return;
    }
    if (method === 'POST') {
      const name = String(body.name ?? '');
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' }, id);
        return;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, String(body.description ?? ''), Boolean(body.private ?? false));
      if (repo === null) {
        sendJson(res, 422, { message: 'Validation Failed: name already exists' }, id);
        return;
      }
      sendJson(res, 201, repoView(repo), id);
      return;
    }
    notFound(res, id);
    return;
  }

  // Everything below hangs off /repos/{owner}/{repo}.
  if (parts.length < 3 || p(0) !== 'repos') {
    notFound(res, id);
    return;
  }
  const owner = p(1);
  const name = p(2);
  // A repository belongs to the token's login. Another owner's name is 404, never 403.
  if (owner !== VIEWER_LOGIN) {
    notFound(res, id);
    return;
  }
  const repo = store.getRepo(owner, name);

  // Repo root: GET/PATCH/DELETE. Unknown repo is 404 everywhere.
  if (parts.length === 3) {
    if (repo === undefined) {
      notFound(res, id);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, repoView(repo), id);
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoView(repo), id);
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      sendJson(res, 204, undefined, id);
      return;
    }
    notFound(res, id);
    return;
  }

  // Sub-resources require the repository to exist.
  if (repo === undefined) {
    notFound(res, id);
    return;
  }
  const sub = p(3);

  // POST /git/refs: create a branch at a commit sha.
  if (sub === 'git' && p(4) === 'refs' && parts.length === 5) {
    if (method === 'POST') {
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      const branchName = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      if (branchName === '' || sha === '') {
        sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' }, id);
        return;
      }
      store.createBranch(repo, branchName, sha);
      sendJson(res, 201, { ref: `refs/heads/${branchName}`, object: { sha, type: 'commit' } }, id);
      return;
    }
    notFound(res, id);
    return;
  }
  // GET /git/refs/heads/{branch} (used by MCP setup; also served by /branches below).
  if (sub === 'git' && p(4) === 'refs' && p(5) === 'heads' && parts.length === 7 && method === 'GET') {
    const branch = store.getBranch(repo, p(6));
    if (branch === undefined) {
      notFound(res, id);
      return;
    }
    sendJson(res, 200, { ref: `refs/heads/${p(6)}`, object: { sha: branch.tip, type: 'commit' }, sha: branch.tip }, id);
    return;
  }

  // GET /branches and GET /branches/{branch}.
  if (sub === 'branches') {
    if (method === 'GET' && parts.length === 4) {
      const branches = [...repo.branches.values()].map((branch) => ({ name: branch.name, commit: { sha: branch.tip } }));
      sendJson(res, 200, branches, id);
      return;
    }
    if (method === 'GET' && parts.length === 5) {
      const branch = store.getBranch(repo, p(4));
      if (branch === undefined) {
        notFound(res, id);
        return;
      }
      sendJson(res, 200, { name: branch.name, commit: { sha: branch.tip } }, id);
      return;
    }
    notFound(res, id);
    return;
  }

  // GET /commits[?sha=<ref>].
  if (sub === 'commits' && parts.length === 4 && method === 'GET') {
    const ref = query.get('sha') ?? repo.default_branch;
    const commits = store.listCommits(repo, ref).map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message, author: { name: 'ada iversen', date: commit.stamp } },
    }));
    sendJson(res, 200, commits, id);
    return;
  }

  // Contents: /contents/{path...} with GET, PUT and DELETE.
  if (sub === 'contents') {
    const path = contentPath(parts.slice(4));
    const ref = query.get('ref') ?? repo.default_branch;
    if (method === 'GET') {
      const file = store.getContent(repo, ref, path);
      if (file !== undefined) {
        sendJson(res, 200, {
          type: 'file',
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          encoding: 'base64',
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          sha: file.sha,
          size: file.size,
        }, id);
        return;
      }
      const entries = store.listDirectory(repo, ref, path);
      if (entries.length > 0) {
        sendJson(res, 200, entries, id);
        return;
      }
      notFound(res, id);
      return;
    }
    if (method === 'PUT') {
      const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch;
      const content = decodeBase64(String(body.content ?? ''));
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = store.putContent(repo, branch, path, content, String(body.message ?? ''), sha);
      if ('conflict' in result) {
        sendJson(res, 409, { message: 'Conflict: sha does not match current content' }, id);
        return;
      }
      sendJson(res, result.status, {
        content: { sha: result.contentSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      }, id);
      return;
    }
    if (method === 'DELETE') {
      const commitSha = store.deleteContent(repo, repo.default_branch, path);
      if (commitSha === null) {
        notFound(res, id);
        return;
      }
      sendJson(res, 200, { commit: { sha: commitSha } }, id);
      return;
    }
    notFound(res, id);
    return;
  }

  // POST /labels: create a label before any issue may carry it.
  if (sub === 'labels' && parts.length === 4 && method === 'POST') {
    const name = String(body.name ?? '');
    if (name === '') {
      sendJson(res, 422, { message: 'Validation Failed: name is required' }, id);
      return;
    }
    const label = store.createLabel(repo, name, String(body.color ?? 'ededed'));
    sendJson(res, 201, { name: label.name, color: label.color }, id);
    return;
  }

  // Issues collection: GET (filtered/sorted) and POST (with label validation).
  if (sub === 'issues' && parts.length === 4) {
    if (method === 'GET') {
      const list = store.listIssues(
        repo,
        query.get('state') ?? 'open',
        query.get('sort') ?? 'created',
        query.get('direction') ?? 'desc',
      );
      sendJson(res, 200, list.map(issueView), id);
      return;
    }
    if (method === 'POST') {
      const labels = Array.isArray(body.labels) ? body.labels.map((label) => String(label)) : [];
      const issue = store.createIssue(repo, String(body.title ?? ''), String(body.body ?? ''), labels);
      if (issue === null) {
        sendJson(res, 422, { message: 'Validation Failed: one or more labels do not exist' }, id);
        return;
      }
      sendJson(res, 201, issueView(issue), id);
      return;
    }
    notFound(res, id);
    return;
  }

  // A single issue: GET/PATCH; and its comments: GET/POST.
  if (sub === 'issues' && parts.length >= 5 && /^\d+$/.test(p(4))) {
    const number = Number(p(4));
    if (parts.length === 5) {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) {
        notFound(res, id);
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueView(issue), id);
        return;
      }
      if (method === 'PATCH') {
        const state = body.state === 'open' || body.state === 'closed' ? body.state : issue.state;
        const updated = store.setIssueState(repo, number, state);
        if (updated === undefined) {
          notFound(res, id);
          return;
        }
        sendJson(res, 200, issueView(updated), id);
        return;
      }
      notFound(res, id);
      return;
    }
    if (parts.length === 6 && p(5) === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, store.listComments(repo, number), id);
        return;
      }
      if (method === 'POST') {
        const comment = store.addComment(repo, number, String(body.body ?? ''));
        if (comment === null) {
          notFound(res, id);
          return;
        }
        sendJson(res, 201, comment, id);
        return;
      }
    }
  }

  // Pull requests: collection GET/POST, and /pulls/{n}, /files and /merge.
  if (sub === 'pulls' && parts.length === 4) {
    if (method === 'GET') {
      const list = store.listPulls(repo, query.get('state') ?? 'open');
      sendJson(res, 200, list.map(pullView), id);
      return;
    }
    if (method === 'POST') {
      const pull = store.createPull(
        repo,
        String(body.title ?? ''),
        String(body.body ?? ''),
        String(body.head ?? ''),
        String(body.base ?? repo.default_branch),
      );
      if (pull === null) {
        sendJson(res, 422, { message: 'Validation Failed' }, id);
        return;
      }
      sendJson(res, 201, pullView(pull), id);
      return;
    }
    notFound(res, id);
    return;
  }
  if (sub === 'pulls' && parts.length >= 5 && /^\d+$/.test(p(4))) {
    const number = Number(p(4));
    const pull = store.getPull(repo, number);
    if (pull === undefined) {
      notFound(res, id);
      return;
    }
    if (parts.length === 5 && method === 'GET') {
      sendJson(res, 200, pullView(pull), id);
      return;
    }
    if (parts.length === 6 && p(5) === 'files' && method === 'GET') {
      const files = pull.changedPaths.map((filename) => {
        const headBlob = store.getContent(repo, pull.head.ref, filename);
        const lines = headBlob === undefined ? 0 : headBlob.content.split('\n').length;
        const additions = Math.max(1, lines);
        return {
          filename,
          status: 'added',
          additions,
          deletions: 0,
          changes: additions,
        };
      });
      sendJson(res, 200, files, id);
      return;
    }
    if (parts.length === 6 && p(5) === 'merge' && method === 'PUT') {
      const result = store.mergePull(repo, number);
      if (!result.ok) {
        if (result.reason === 'not-found') notFound(res, id);
        else sendJson(res, 405, { message: 'Pull Request is not mergeable' }, id);
        return;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: result.message }, id);
      return;
    }
  }

  notFound(res, id);
}

function clampPage(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
  } catch {
    return value;
  }
}
