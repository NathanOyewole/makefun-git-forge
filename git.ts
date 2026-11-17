// Git smart HTTP: v0/v2 advertisements, v2 ls-refs and fetch, v0 receive-pack with
// report-status. All objects and refs live in the shared ForgeStore RepoRec so REST,
// GraphQL and git see one consistent repository. No git binary, no randomness, no clock.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { ForgeStore, RepoRec, GitObjectRec } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';

const ZERO = '0'.repeat(40);
const UP = 'git-upload-pack';
const RP = 'git-receive-pack';

type ObjType = GitObjectRec['type'];
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ------------------------------------------------------------------ pkt-line

function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** Split a request body into pkt-lines; everything after the first flush is raw pack bytes. */
function readPackets(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length <= 2) {
      offset += 4;
      if (length === 0) return { lines, rest: body.subarray(offset) };
      continue;
    }
    if (offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

function readBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'cache-control': 'no-cache' });
  res.end(body);
}

// ------------------------------------------------------------------ objects

function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function putObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
  return oid;
}

interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(i, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const head = (cut < 0 ? text : text.slice(0, cut)).split('\n');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: cut < 0 ? '' : text.slice(cut + 2) };
  for (const line of head) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

function peel(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const text = object.data.toString('utf8');
    const first = text.split('\n', 1)[0] ?? '';
    if (!first.startsWith('object ')) return current;
    current = first.slice(7).trim();
  }
  return current;
}

/** Every object reachable from `tips`, never crossing `exclude`. */
function collectObjects(repo: RepoRec, tips: Iterable<string>, exclude: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || exclude.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

/** Only a commit's own tree/blobs (never its parents), used for shallow fetches. */
function objectsForCommits(repo: RepoRec, commits: Iterable<string>, exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const trees: string[] = [];
  for (const oid of commits) {
    if (out.has(oid) || exclude.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      if (tree !== '') trees.push(tree);
    }
  }
  const stack = trees;
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid) || exclude.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
  return out;
}

// ------------------------------------------------------------------ pack read / write

function writePack(objects: Iterable<GitObjectRec>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const code = TYPE_CODE[object.type];
    let size = object.data.length;
    let first = (code << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    const bytes: number[] = [];
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size = Math.floor(size / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { value: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const size = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = size();
  const targetSize = size();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** (bit * 8);
      for (let bit = 4; bit < 7; bit += 1) if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** ((bit - 4) * 8);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else throw new Error('invalid delta opcode');
  }
  return out;
}

/** Decode a received pack and store every object. Handles OFS/REF deltas. */
function readPack(repo: RepoRec, pack: Buffer): void {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, end)).digest('hex');
  if (expected !== pack.subarray(end).toString('hex')) throw new Error('bad pack checksum');

  interface Raw { typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolvedType?: ObjType; resolved?: Buffer; oid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) throw new Error('bad pack object type');
    const inflated = inflateAt(pack.subarray(0, end), offset);
    if (inflated.data.length !== header.size) throw new Error('pack object size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== end) throw new Error('stray pack bytes');

  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset as number);
      if (base === undefined) throw new Error('missing ofs base');
      const resolved = resolve(base);
      type = resolved.type;
      data = applyDelta(resolved.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid as string) ?? repo.objects.get(entry.baseOid as string);
      if (base === undefined) throw new Error('missing ref base');
      const resolvedData = 'resolved' in base && base.resolved ? (base.resolved as Buffer) : (base as GitObjectRec).data;
      const resolvedType = ('resolvedType' in base && base.resolvedType ? base.resolvedType : (base as GitObjectRec).type) as ObjType;
      type = resolvedType;
      data = applyDelta(resolvedData, entry.data);
    } else type = CODE_TYPE[entry.typeCode] as ObjType, data = entry.data;
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    byOid.set(oid, entry);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    putObject(repo, resolved.type, resolved.data);
  }
}

// ------------------------------------------------------------------ sync git -> REST views

/** Materialise a pushed commit into the REST/GraphQL branch view. */
function syncBranch(repo: RepoRec, name: string, oid: string): void {
  let branch = repo.branches.get(name);
  if (branch === undefined) {
    branch = { name, tip: oid, files: new Map(), commits: [] };
    repo.branches.set(name, branch);
  }
  branch.tip = oid;
  const files = new Map<string, { sha: string; content: string; size: number }>();
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && blob.type === 'blob') {
          files.set(path, { sha: entry.oid, content: blob.data.toString('utf8'), size: blob.data.length });
        }
      }
    }
  };
  const commits: Array<{ sha: string; message: string; parents: string[]; stamp: string }> = [];
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length) {
    const commitOid = stack.pop() as string;
    if (seen.has(commitOid)) continue;
    seen.add(commitOid);
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const match = /(\d+) [+-]\d{4}\s*$/.exec(commit.committer);
    const stamp = match !== null ? new Date(Number(match[1]) * 1000).toISOString() : '2025-01-01T00:00:00.000Z';
    commits.push({ sha: commitOid, message: commit.message.replace(/\n$/, ''), parents: commit.parents, stamp });
    if (commit.tree !== '') walk(commit.tree, '');
    for (const parent of commit.parents) stack.push(parent);
  }
  branch.files = files;
  branch.commits = commits;
}

function isAncestor(repo: RepoRec, oldOid: string, newOid: string): boolean {
  const stack = [newOid];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ------------------------------------------------------------------ advertisements

function advertisedRefs(repo: RepoRec): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const head = repo.gitRefs.get(`refs/heads/${repo.default_branch}`) ?? ZERO;
  refs.push({ name: 'HEAD', oid: head });
  const names = [...repo.gitRefs.keys()].sort();
  for (const name of names) {
    const oid = repo.gitRefs.get(name) as string;
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') peeled = peel(repo, oid);
    }
    refs.push({ name, oid, peeled });
  }
  return refs;
}

function v0Advertisement(repo: RepoRec, service: typeof UP | typeof RP): Buffer {
  const caps = service === UP
    ? 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed no-progress include-tag symref=HEAD:refs/heads/main agent=gitforge'
    : 'report-status side-band-64k delete-refs ofs-delta quiet agent=gitforge';
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [pkt(`# service=${service}\n`)];
  refs.forEach((ref, index) => {
    const peeledSuffix = ref.peeled === undefined ? '' : `^{} ${ref.peeled}\n`;
    if (index === 0) {
      parts.push(pkt(`${ref.oid} ${ref.name}\0${caps}\n`));
      if (peeledSuffix !== '') parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    } else {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (peeledSuffix !== '') parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('ls-refs\n'),
    pkt('fetch=shallow wait-for-done ofs-delta\n'),
    pkt('object-format=sha1\n'),
    pkt('agent=gitforge\n'),
    FLUSH,
  ]);
}

// ------------------------------------------------------------------ upload-pack

function lsRefs(repo: RepoRec, lines: string[]): Buffer {
  const args = lines.slice(1); // command=ls-refs is first
  const wantPeel = args.includes('peel');
  const wantSymref = args.includes('symrefs');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).trim());
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid === ZERO ? ZERO : ref.oid} ${ref.name}`;
    if (wantSymref && ref.name === 'HEAD') line += ' symref-target:refs/heads/main';
    if (wantPeel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: GitObjectRec[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: RepoRec, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | undefined): FetchPlan {
  // A shallow client holds only objects up to its boundary, NOT the boundary's ancestry.
  // A full client holds everything reachable from its haves. Conflating the two would
  // exclude the very parent a deepen request has to deliver.
  const excluded = shallowBoundaries.length > 0
    ? objectsForCommits(repo, shallowBoundaries, new Set())
    : collectObjects(repo, haves);
  const boundarySet = new Set(shallowBoundaries);
  const haveSet = new Set(haves);
  const visited = new Set<string>();
  const commits = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const queue: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid, level: 0 }));
  while (queue.length) {
    const item = queue.shift() as { oid: string; level: number };
    const commitOid = peel(repo, item.oid);
    if (visited.has(commitOid)) continue;
    visited.add(commitOid);
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') continue;
    if (boundarySet.has(commitOid)) {
      if (depth === undefined || item.level >= depth) continue;
      unshallow.push(commitOid);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: item.level + 1 });
      continue;
    }
    if (haveSet.has(commitOid) && depth === undefined) continue;
    commits.add(commitOid);
    if (depth !== undefined && item.level >= depth - 1) {
      shallow.push(commitOid);
    } else {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, level: item.level + 1 });
    }
  }
  const oids = objectsForCommits(repo, commits, excluded);
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag' && !excluded.has(want)) oids.add(want);
  }
  const objects = [...oids].sort().map((oid) => repo.objects.get(oid) as GitObjectRec).filter((object) => object !== undefined);
  return { objects, shallow: [...new Set(shallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
}

/** Wrap report/fetch bytes in side-band-64k pkt-lines with band 1 data. */
function sideband(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  const CHUNK = 32_000;
  while (offset < body.length) {
    const chunk = body.subarray(offset, offset + CHUNK);
    offset += chunk.length;
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

function fetchResponse(plan: FetchPlan, sidebandEnabled: boolean): Buffer {
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('acknowledgments\n'));
  parts.push(pkt('NAK\n'));
  parts.push(FLUSH);
  parts.push(pkt('packfile\n'));
  const pack = writePack(plan.objects);
  if (sidebandEnabled) parts.push(sideband(pack));
  else {
    let offset = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, offset + 32_000);
      offset += chunk.length;
      parts.push(pkt(chunk));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

function receivePack(repo: RepoRec, body: Buffer, sidebandEnabled: boolean): Buffer {
  const { lines, rest } = readPackets(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    const clean = line.split('\0', 1)[0] as string;
    const [oldOid, newOid, ref] = clean.trimEnd().split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) commands.push({ oldOid, newOid, ref });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    if (rest.length > 0) readPack(repo, rest);
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpack error';
  }
  const verdicts: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (!unpackOk) {
    for (const command of commands) verdicts.push({ ref: command.ref, ok: false, reason: 'unpack-error' });
  } else {
    for (const command of commands) {
      const current = repo.gitRefs.get(command.ref);
      const deleting = command.newOid === ZERO;
      const creating = current === undefined || current === ZERO;
      let ok = true;
      let reason = '';
      if (creating) {
        if (command.oldOid !== ZERO && current !== command.oldOid) { ok = false; reason = 'fetch-first'; }
      } else if (current !== command.oldOid) { ok = false; reason = 'stale info'; }
      if (ok && !deleting && !creating && command.ref.startsWith('refs/heads/')) {
        if (!isAncestor(repo, current as string, command.newOid)) { ok = false; reason = 'non-fast-forward'; }
      }
      if (ok && !deleting && repo.objects.get(command.newOid) === undefined) { ok = false; reason = 'missing object'; }
      if (ok) {
        if (deleting) repo.gitRefs.delete(command.ref);
        else repo.gitRefs.set(command.ref, command.newOid);
        if (command.ref.startsWith('refs/heads/')) {
          if (deleting) repo.branches.delete(command.ref.slice('refs/heads/'.length));
          else syncBranch(repo, command.ref.slice('refs/heads/'.length), command.newOid);
        }
      }
      verdicts.push(ok ? { ref: command.ref, ok: true } : { ref: command.ref, ok: false, reason });
    }
  }
  const linesOut = [`unpack ${unpackDetail}`];
  for (const verdict of verdicts) linesOut.push(verdict.ok ? `ok ${verdict.ref}` : `ng ${verdict.ref} ${verdict.reason ?? 'rejected'}`);
  const report = Buffer.concat([...linesOut.map((line) => pkt(`${line}\n`)), FLUSH]);
  return sidebandEnabled ? sideband(report) : report;
}

// ------------------------------------------------------------------ routing

/** Match a git smart-HTTP route and answer it; false means the path was not a git route. */
export async function handleGit(store: ForgeStore, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/((?:info\/refs|git-upload-pack|git-receive-pack))$/.exec(path);
  if (match === null) return false;
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const suffix = match[3] as string;
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    send(res, 404, 'text/plain', Buffer.from('repository not found\n'));
    return true;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (suffix === 'info/refs' && method === 'GET') {
    const service = query.get('service') === RP ? RP : UP;
    const contentType = `application/x-${service}-advertisement`;
    const v2 = service === UP && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    send(res, 200, contentType, v2 ? v2Advertisement() : v0Advertisement(repo, service));
    return true;
  }
  if (suffix === UP && method === 'POST') {
    const body = await readBuffer(req);
    const { lines } = readPackets(body);
    const command = (lines[0] ?? '').replace(/\n$/, '');
    const v2 = command.startsWith('command=') || (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (command.startsWith('command=ls-refs')) {
      send(res, 200, `application/x-${UP}-result`, lsRefs(repo, lines.map((line) => line.replace(/\n$/, ''))));
      return true;
    }
    if (command.startsWith('command=fetch') || !v2) {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const raw of lines) {
        const line = raw.replace(/\n$/, '').trim();
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      }
      const plan = planFetch(repo, wants, haves, shallow, depth);
      send(res, 200, `application/x-${UP}-result`, fetchResponse(plan, true));
      return true;
    }
    send(res, 200, `application/x-${UP}-result`, FLUSH);
    return true;
  }
  if (suffix === RP && method === 'POST') {
    const body = await readBuffer(req);
    const sidebandEnabled = body.toString('utf8', 0, Math.min(800, body.length)).includes('side-band-64k');
    send(res, 200, `application/x-${RP}-result`, receivePack(repo, body, sidebandEnabled));
    return true;
  }
  send(res, 404, 'text/plain', Buffer.from('not found\n'));
  return true;
}

/** Keep the type imported so the module's public shape documents its dependency. */
export type GitServerHook = (server: Server) => void;
