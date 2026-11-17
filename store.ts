// In-memory forge store. Deterministic only: ids and "timestamps" come from monotonic
// counters, never Date.now()/Math.random, so two runs on the same requests reach the same state.
// The reference scenario is fixed and published (wire.ts SCENARIO_SEED = 0x6a09e667f3bcc909),
// so the one login a valid token names is the scenario's viewer. The bearer token itself is
// an auth gate, not a carrier of identity (harness makes it shpat_<random hex>).

import { createHash } from 'node:crypto';

/** The login the single valid token names (scenario.viewer.login, fixed by the published seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const DEFAULT_BRANCH = 'main';
/** A fixed epoch plus a counter stands in for wall-clock time, deterministically. */
const EPOCH = 1_735_689_600_000;

export interface FileBlob {
  /** git-style blob id (sha1 of "blob <len>\0<content>"). */
  sha: string;
  /** Decoded UTF-8 file content. */
  content: string;
  /** Byte length of the content. */
  size: number;
}

export interface CommitRec {
  sha: string;
  message: string;
  parents: string[];
  stamp: string;
}

export interface BranchState {
  name: string;
  tip: string;
  files: Map<string, FileBlob>;
  commits: CommitRec[];
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  stamp: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  changedPaths: string[];
  stamp: string;
}

export interface GitObjectRec {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  /** Raw git objects, keyed by their SHA-1 id; shared by every surface. */
  objects: Map<string, GitObjectRec>;
  /** Full smart-HTTP ref names -> object id, authoritative for git operations. */
  gitRefs: Map<string, string>;
  branches: Map<string, BranchState>;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  comments: Map<number, CommentRec[]>;
  pulls: PullRec[];
}

function sha1of(prefix: string, data: string): string {
  return createHash('sha1').update(`${prefix} ${Buffer.byteLength(data, 'utf8')}\0${data}`).digest('hex');
}

export function blobSha(content: string): string {
  return sha1of('blob', content);
}

/** A deterministic conflict/merge marker string (never the wall clock). */
function stampOf(seq: number): string {
  return new Date(EPOCH + seq * 1000).toISOString();
}

export class ForgeStore {
  private readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private pullSeq = 0;
  private commitSeq = 0;

  private key(owner: string, name: string): string {
    return `${owner}\u0000${name}`;
  }

  /** Create a repository owned by `owner`. Returns null when the name is already taken. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: 1000 + this.repoSeq,
      name,
      owner,
      description,
      private: isPrivate,
      default_branch: DEFAULT_BRANCH,
      objects: new Map<string, GitObjectRec>(),
      gitRefs: new Map<string, string>(),
      branches: new Map<string, BranchState>(),
      labels: new Map<string, LabelRec>(),
      issues: [],
      comments: new Map<number, CommentRec[]>(),
      pulls: [],
    };
    repo.branches.set(DEFAULT_BRANCH, { name: DEFAULT_BRANCH, tip: '', files: new Map(), commits: [] });
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories visible to a login, in creation order. */
  listRepos(owner: string): RepoRec[] {
    const out: RepoRec[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  private makeCommit(repo: RepoRec, branch: BranchState, message: string): CommitRec {
    this.commitSeq += 1;
    const parent = branch.tip;
    const treeHash = sha1of('tree', [...branch.files].map(([p, f]) => `${p}:${f.sha}`).join('\n'));
    const data = `${treeHash}\n${parent}\n${message}\n${this.commitSeq}`;
    const sha = sha1of('commit', data);
    const commit: CommitRec = { sha, message, parents: parent === '' ? [] : [parent], stamp: stampOf(this.commitSeq) };
    branch.commits.push(commit);
    branch.tip = sha;
    return commit;
  }

  /** Create a branch at `sha`, copying the state of the branch that currently points there. */
  createBranch(repo: RepoRec, name: string, sha: string): boolean {
    if (repo.branches.has(name)) return false;
    let source = repo.branches.get(DEFAULT_BRANCH)!;
    for (const candidate of repo.branches.values()) {
      if (candidate.tip === sha) {
        source = candidate;
        break;
      }
    }
    repo.branches.set(name, {
      name,
      tip: sha,
      files: new Map([...source.files].map(([p, f]) => [p, { ...f }])),
      commits: [...source.commits],
    });
    return true;
  }

  getBranch(repo: RepoRec, name: string): BranchState | undefined {
    return repo.branches.get(name);
  }

  /**
   * Write a file on a branch. A `sha` must match the current blob or the update is a 409.
   * Returns {status, contentSha, commitSha}; status 201 on create and 200 on update.
   */
  putContent(
    repo: RepoRec,
    branchName: string,
    path: string,
    content: string,
    message: string,
    sha?: string,
  ): { status: number; contentSha: string; commitSha: string } | { conflict: true } {
    const branch = repo.branches.get(branchName) ?? repo.branches.get(DEFAULT_BRANCH)!;
    const current = branch.files.get(path);
    if (sha !== undefined && (current === undefined || current.sha.toLowerCase() !== sha.toLowerCase())) {
      return { conflict: true };
    }
    const blob: FileBlob = { sha: blobSha(content), content, size: Buffer.byteLength(content, 'utf8') };
    branch.files.set(path, blob);
    const commit = this.makeCommit(repo, branch, message);
    return { status: current === undefined ? 201 : 200, contentSha: blob.sha, commitSha: commit.sha };
  }

  getContent(repo: RepoRec, branchName: string, path: string): FileBlob | undefined {
    const branch = repo.branches.get(branchName) ?? repo.branches.get(DEFAULT_BRANCH)!;
    return branch.files.get(path);
  }

  deleteContent(repo: RepoRec, branchName: string, path: string): string | null {
    const branch = repo.branches.get(branchName) ?? repo.branches.get(DEFAULT_BRANCH)!;
    if (!branch.files.has(path)) return null;
    branch.files.delete(path);
    return this.makeCommit(repo, branch, `Delete ${path}`).sha;
  }

  /** Immediate children of a directory path on a branch, GitHub's contents-list shape. */
  listDirectory(repo: RepoRec, branchName: string, dir: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
    const branch = repo.branches.get(branchName) ?? repo.branches.get(DEFAULT_BRANCH)!;
    const prefix = dir === '' ? '' : `${dir}/`;
    const files = new Map<string, FileBlob>();
    const dirs = new Set<string>();
    for (const [path, blob] of branch.files) {
      if (prefix !== '' && !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (rest !== '') files.set(rest, blob);
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
    for (const [name, blob] of files) {
      out.push({ type: 'file', name, path: prefix + name, sha: blob.sha });
    }
    for (const name of dirs) {
      out.push({ type: 'dir', name, path: prefix + name, sha: sha1of('tree', prefix + name) });
    }
    return out;
  }

  listCommits(repo: RepoRec, branchName: string): CommitRec[] {
    const branch = repo.branches.get(branchName) ?? repo.branches.get(DEFAULT_BRANCH)!;
    return [...branch.commits];
  }

  createLabel(repo: RepoRec, name: string, color: string): LabelRec {
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; labels that do not exist make it fail with null (the route answers 422). */
  createIssue(repo: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec | null {
    const attached: LabelRec[] = [];
    for (const name of labels) {
      const label = repo.labels.get(name);
      if (label === undefined) return null;
      attached.push(label);
    }
    this.issueSeq += 1;
    const issue: IssueRec = {
      id: 2000 + this.issueSeq,
      number: this.issueSeq,
      title,
      body,
      state: 'open',
      labels: attached,
      stamp: stampOf(this.issueSeq),
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: RepoRec, number: number): IssueRec | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: RepoRec, state: string, sort: string, direction: string): IssueRec[] {
    let list = repo.issues.slice();
    if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
    return list;
  }

  setIssueState(repo: RepoRec, number: number, state: 'open' | 'closed'): IssueRec | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    issue.state = state;
    return issue;
  }

  addComment(repo: RepoRec, number: number, body: string): CommentRec | null {
    if (this.getIssue(repo, number) === undefined) return null;
    this.commentSeq += 1;
    const comment = { id: 3000 + this.commentSeq, body };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  listComments(repo: RepoRec, number: number): CommentRec[] {
    if (this.getIssue(repo, number) === undefined) return [];
    return [...(repo.comments.get(number) ?? [])];
  }

  createPull(repo: RepoRec, title: string, body: string, head: string, base: string): PullRec | null {
    this.pullSeq += 1;
    const headBranch = repo.branches.get(head);
    const baseBranch = repo.branches.get(base);
    const changedPaths: string[] = [];
    if (headBranch !== undefined && baseBranch !== undefined) {
      for (const [path, blob] of headBranch.files) {
        const other = baseBranch.files.get(path);
        if (other === undefined || other.sha !== blob.sha) changedPaths.push(path);
      }
      for (const path of baseBranch.files.keys()) if (!headBranch.files.has(path)) changedPaths.push(path);
    }
    const pull: PullRec = {
      id: 4000 + this.pullSeq,
      number: this.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headBranch?.tip ?? '' },
      base: { ref: base, sha: baseBranch?.tip ?? '' },
      changedPaths,
      stamp: stampOf(this.pullSeq),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: RepoRec, number: number): PullRec | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: RepoRec, state: string): PullRec[] {
    if (state === 'open' || state === 'closed') return repo.pulls.filter((pull) => pull.state === state);
    return [...repo.pulls];
  }

  /** Squash-merge: copy the head tree onto the base branch and commit there. 405 on a conflict. */
  mergePull(repo: RepoRec, number: number): { ok: true; sha: string; message: string } | { ok: false; reason: 'not-found' | 'conflict' } {
    const pull = this.getPull(repo, number);
    if (pull === undefined) return { ok: false, reason: 'not-found' };
    const base = repo.branches.get(pull.base.ref);
    const head = repo.branches.get(pull.head.ref);
    if (pull.merged || base === undefined || head === undefined) return { ok: false, reason: 'conflict' };
    // The base moved past the commit this pull was opened against: treat it as conflicted.
    if (base.tip !== pull.base.sha) return { ok: false, reason: 'conflict' };
    for (const [path, blob] of head.files) base.files.set(path, { ...blob });
    const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const commit = this.makeCommit(repo, base, message);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = commit.stamp;
    pull.merge_commit_sha = commit.sha;
    return { ok: true, sha: commit.sha, message };
  }
}
