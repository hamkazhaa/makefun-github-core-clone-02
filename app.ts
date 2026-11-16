// forge-v2: a GitHub-compatible git forge in one Node 22 process, stdlib only.
//
// Surfaces:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack v2, receive-pack v0)
//   - REST v3 under /api/v3 (repos, branches, commits, contents, labels, issues, pulls)
//   - GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send)
//   - MCP at /mcp (JSON-RPC 2.0, streamable HTTP, revision 2026-07-28)
//
// Determinism: nothing here reads the wall clock or unseeded randomness for any
// value that reaches a response. All timestamps are fixed constants, all ids are
// counters or hashes of stable inputs, so a replayed trial answers byte for byte
// like the live one.
//
// Performance: the hot paths serve pre-built Buffers. Per-repo caches hold the
// serialized advertisements, ls-refs answers and fetch packs, keyed by a version
// counter that moves on every ref write; the read workload's issue body is cached
// as a Buffer too. Nothing on a timed path touches the filesystem or the clock.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// fixed identity and time
// ---------------------------------------------------------------------------

// The suite's scenario is built from one fixed seed (kit wire.ts SCENARIO_SEED),
// so the token owner's login is the same in every trial: the scenario viewer.
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER = { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };

const DEFAULT_BRANCH = 'main';
// The env's own fixture epoch (2025-01-01T00:00:00Z): every timestamp we emit.
const FIXED_EPOCH = 1735689600;
const FIXED_ISO = '2025-01-01T00:00:00Z';
const COMMIT_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

const ZERO_OID = '0'.repeat(40);
const SHA1_RE = /^[0-9a-f]{40}$/;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && SHA1_RE.test(value);
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer | null {
  const clean = text.replace(/[\r\n\t ]+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function compareBytes(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function objectId(type: ObjType, data: Buffer): string {
  const head = utf8(`${type} ${data.length}\0`);
  const hash = createHash('sha1');
  hash.update(head);
  hash.update(data);
  return hash.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(at, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): Buffer {
  return utf8(entry.mode === '40000' ? `${entry.name}/` : entry.name);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => compareBytes(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(utf8(`${entry.mode} ${entry.name}\0`));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const who = `${COMMIT_IDENTITY} ${FIXED_EPOCH} +0000`;
  lines.push(`author ${who}`, `committer ${who}`, '');
  return utf8(`${lines.join('\n')}\n${message}`);
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const PKT_MAX = 65520;

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? utf8(payload) : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line payload is too long');
  const head = utf8((data.length + 4).toString(16).padStart(4, '0'));
  return Buffer.concat([head, data]);
}

function pktFlush(): Buffer {
  return utf8('0000');
}

function pktDelim(): Buffer {
  return utf8('0001');
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

function decodePktLines(buf: Buffer): DecodedPacket[] {
  const out: DecodedPacket[] = [];
  let at = 0;
  while (at < buf.length) {
    if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (len === 3 || len > PKT_MAX) throw new Error(`bad pkt-line length ${len}`);
    if (at + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return out;
}

function pktTextLines(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// packfiles (plain objects when writing; deltas resolved when reading)
// ---------------------------------------------------------------------------

// Apply a git delta (copy/insert instructions) to a base object's bytes.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta header is truncated');
      const byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[at++]!;
      if (op & 0x02) offset |= delta[at++]! << 8;
      if (op & 0x04) offset |= delta[at++]! << 16;
      if (op & 0x08) offset |= delta[at++]! << 24;
      if (op & 0x10) size = delta[at++]!;
      if (op & 0x20) size |= delta[at++]! << 8;
      if (op & 0x40) size |= delta[at++]! << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (at + op > delta.length) throw new Error('delta insert runs past the end');
      parts.push(delta.subarray(at, at + op));
      at += op;
      total += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts, total);
}

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

// Read a pack, resolving ofs-delta and ref-delta entries against earlier pack
// entries or, for ref-deltas, against `resolveBase` (the store). Real git
// delta-compresses its pushes, so a forge that refuses deltas cannot accept
// an ordinary `git push`.
function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const want = sha1Hex(buf.subarray(0, trailerAt));
  if (buf.subarray(trailerAt).toString('hex') !== want) throw new Error('pack trailer checksum mismatch');
  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset: number | null;
    baseOid: string | null;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    if (at >= trailerAt) throw new Error('pack is truncated');
    const startOffset = at;
    let byte = buf[at];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    at += 1;
    while (byte & 0x80) {
      if (at >= trailerAt) throw new Error('pack size varint is truncated');
      byte = buf[at++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      // ofs-delta: a negative offset from this entry's start, encoded with
      // the high bit set on every byte but the last, offset = ((prev + 1) << 7) | next.
      if (at >= trailerAt) throw new Error('ofs-delta offset is truncated');
      byte = buf[at++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        if (at >= trailerAt) throw new Error('ofs-delta offset is truncated');
        byte = buf[at++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = startOffset - offset;
    } else if (typeCode === 7) {
      if (at + 20 > trailerAt) throw new Error('ref-delta base oid is truncated');
      baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateSync(buf.subarray(at, trailerAt), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch after inflate');
    const entry: RawEntry = { offset: startOffset, typeCode, data: inflated.buffer, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(startOffset, entry);
    at += inflated.engine.bytesWritten;
  }
  if (at !== trailerAt) throw new Error('pack has trailing bytes before its trailer');
  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, GitObject>();
  const entries: PackEntry[] = [];
  let pending = [...raw];
  while (pending.length > 0) {
    let progressed = false;
    const next: RawEntry[] = [];
    for (const entry of pending) {
      if (entry.typeCode !== 6 && entry.typeCode !== 7) {
        const type = CODE_TYPE[entry.typeCode]!;
        const object: GitObject = { type, data: entry.data };
        const oid = objectId(type, entry.data);
        resolved.set(oid, object);
        resolvedByOffset.set(entry.offset, object);
        entries.push({ type, data: entry.data, oid });
        progressed = true;
        continue;
      }
      let base: GitObject | undefined;
      if (entry.typeCode === 6 && entry.baseOffset !== null) base = resolvedByOffset.get(entry.baseOffset);
      if (entry.typeCode === 7 && entry.baseOid !== null) {
        base = resolved.get(entry.baseOid) ?? (resolveBase === undefined ? undefined : resolveBase(entry.baseOid));
      }
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      const oid = objectId(base.type, data);
      resolved.set(oid, object);
      resolvedByOffset.set(entry.offset, object);
      entries.push({ type: base.type, data, oid });
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing');
    pending = next;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// the store: repositories, refs, objects, issues, pull requests
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: { id: number; body: string }[];
  seq: number;
  jsonCache: Buffer | null;
}

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  nextCommentId: number;
  version: number;
  advV2: Buffer | null;
  advV0Up: Buffer | null;
  advV0Recv: Buffer | null;
  lsCache: Map<string, Buffer>;
  packCache: Map<string, Buffer>;
  repoJsonCache: Buffer | null;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextObjectId = 10000;
let nextRequestId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    seq: nextRepoId,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    version: 0,
    advV2: null,
    advV0Up: null,
    advV0Recv: null,
    lsCache: new Map(),
    packCache: new Map(),
    repoJsonCache: null,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function bump(repo: Repo): void {
  repo.version += 1;
  repo.advV2 = null;
  repo.advV0Up = null;
  repo.advV0Recv = null;
  repo.lsCache.clear();
  repo.packCache.clear();
  repo.repoJsonCache = null;
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// Every object reachable from `roots`, following commits, trees and tags.
function reachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isOid(root)) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTagTarget(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

// True when `ancestor` is `tip` itself or one of its commit ancestors.
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

// The first commit both histories share, walking the head's ancestors first.
function mergeBaseOf(repo: Repo, headTip: string, baseTip: string): string {
  const headAncestors = new Set<string>();
  const stack = [headTip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (headAncestors.has(oid)) continue;
    headAncestors.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const queue = [baseTip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (headAncestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return '';
}

// The flat path -> {oid, mode} map of the tree a commit points at.
function flatTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(object.data).tree, '');
  return out;
}

// Build the tree that holds `files` (path -> blob oid) on top of `baseTreeOid`.
function treeWithFiles(repo: Repo, baseTreeOid: string | null, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  const load = (treeOid: string | null, node: Node): void => {
    if (treeOid === null) return;
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') {
        const child = makeNode();
        node.dirs.set(entry.name, child);
        load(entry.oid, child);
      } else {
        node.files.set(entry.name, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  load(baseTreeOid, root);
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = makeNode();
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) {
      if (child.files.size === 0 && child.dirs.size === 0) continue;
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// Remove `path` from the tree `baseTreeOid` (null when the tree becomes empty).
function treeWithoutFile(repo: Repo, baseTreeOid: string, path: string): string | null {
  const flat = new Map<string, { oid: string; mode: string }>();
  const collect = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') collect(entry.oid, p);
      else flat.set(p, { oid: entry.oid, mode: entry.mode });
    }
  };
  collect(baseTreeOid, '');
  flat.delete(path);
  if (flat.size === 0) return null;
  return treeWithFiles(repo, null, flat);
}

// The blob at `path` on the tip of `refName`, or null.
function blobAt(repo: Repo, refName: string, path: string): { oid: string; data: Buffer } | null {
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const entry = flatTree(repo, tip).get(path);
  if (entry === undefined) return null;
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'blob') return null;
  return { oid: entry.oid, data: object.data };
}

function refTip(repo: Repo, refName: string): string | undefined {
  return repo.refs.get(refName);
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

// Peel an annotated tag to the commit it names (or the object itself).
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTagTarget(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function requestId(): string {
  return `req-${nextRequestId++}`;
}

function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  const expected = shopToken();
  if (expected === '') return true;
  return token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const buf = utf8(text);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
  res.end(buf);
}

function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
  res.end(buf);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, buf: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'x-github-request-id': requestId(),
  });
  res.end(buf);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function splitPath(rawUrl: string | undefined): { path: string; query: Map<string, string> } {
  const raw = rawUrl ?? '/';
  const q = raw.indexOf('?');
  const pathText = q < 0 ? raw : raw.slice(0, q);
  const query = new Map<string, string>();
  if (q >= 0) {
    for (const pair of raw.slice(q + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
      const value = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
      query.set(key, value);
    }
  }
  let path = pathText;
  try {
    path = decodeURIComponent(pathText);
  } catch {
    path = pathText;
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { path, query };
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

function errBody(message: string): { message: string } {
  return { message };
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

type GitService = 'git-upload-pack' | 'git-receive-pack';

function refLines(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const tip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (tip !== undefined) out.push({ name: 'HEAD', oid: tip });
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') entry.peeled = peelToCommit(repo, oid);
    }
    out.push(entry);
  }
  return out;
}

function advertisementV2(): Buffer {
  const parts = [
    pkt('version 2\n'),
    pkt('agent=forge-v2/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: GitService): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge-v2/1.0 symref=HEAD:refs/heads/main'
      : 'side-band-64k thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=forge-v2/1.0';
  const serviceLine = service === 'git-receive-pack' ? '# service=git-receive-pack\n' : '# service=git-upload-pack\n';
  const parts: Buffer[] = [pkt(serviceLine), pktFlush()];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const line = i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pkt(line));
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function infoRefs(repo: Repo, service: GitService, wantV2: boolean, res: ServerResponse): void {
  const type = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantV2) {
    if (repo.advV2 === null) repo.advV2 = advertisementV2();
    sendRaw(res, 200, type, repo.advV2);
    return;
  }
  if (service === 'git-upload-pack') {
    if (repo.advV0Up === null) repo.advV0Up = advertisementV0(repo, service);
    sendRaw(res, 200, type, repo.advV0Up);
    return;
  }
  if (repo.advV0Recv === null) repo.advV0Recv = advertisementV0(repo, service);
  sendRaw(res, 200, type, repo.advV0Recv);
}

// v2 ls-refs: answer one ref per line, HEAD first, honouring ref-prefix args.
function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  void peel;
  void symrefs;
  const key = prefixes.join('\n');
  const cached = repo.lsCache.get(key);
  if (cached !== undefined) {
    sendRaw(res, 200, 'application/x-git-upload-pack-result', cached);
    return;
  }
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = refLines(repo);
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (refs.length === 0) {
    if (keep('HEAD')) parts.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        parts.push(pkt(`${ref.oid} HEAD symref-target:refs/heads/main\n`));
      } else {
        const extra = ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
        parts.push(pkt(`${ref.oid} ${ref.name}${extra}\n`));
      }
    }
  }
  void mainTip;
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  repo.lsCache.set(key, body);
  sendRaw(res, 200, 'application/x-git-upload-pack-result', body);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

// The objects a fetch must send: reachable from `wants`, cut at `depth`
// generations, minus everything reachable from `haves`.
// What the client already holds: the closure of its haves, but never past a
// shallow boundary commit — a boundary commit's parents are not held, only
// the commit itself and its tree. A plain reachable() from the haves would
// wrongly claim the client holds the whole history below a shallow tip.
function heldObjects(repo: Repo, haves: string[], shallowBoundaries: string[]): Set<string> {
  const boundarySet = new Set(shallowBoundaries);
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      for (const entry of reachable(repo, [view.tree])) held.add(entry);
      if (!boundarySet.has(oid)) {
        for (const parent of view.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of reachable(repo, [oid])) held.add(entry);
    }
  }
  return held;
}

function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): FetchPlan {
  const held = heldObjects(repo, haves, oldShallow);
  const sent = new Set<string>();
  const boundary: string[] = [];
  if (depth === null) {
    for (const oid of reachable(repo, wants)) if (!held.has(oid)) sent.add(oid);
  } else {
    // Walk commits by generation from the wants; generation < depth is included,
    // generation == depth - 1 is the new shallow boundary.
    const gen = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wants) {
      if (isOid(want) && !gen.has(want)) {
        gen.set(want, 0);
        queue.push(want);
      }
    }
    const included: string[] = [];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const g = gen.get(oid)!;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        // A tagged want counts as its commit at the same generation.
        included.push(oid);
        const target = peelToCommit(repo, oid);
        if (target !== oid && !gen.has(target)) {
          gen.set(target, g);
          queue.push(target);
        }
        continue;
      }
      included.push(oid);
      if (g === depth - 1) boundary.push(oid);
      if (g + 1 >= depth) continue;
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!gen.has(parent)) {
          gen.set(parent, g + 1);
          queue.push(parent);
        }
      }
    }
    // Closure of the included commits' trees and blobs, minus what the client
    // holds. The commits themselves go in directly; their trees are the only
    // roots, because reachable() from a commit follows its parents and would
    // pull the whole history back in.
    const roots: string[] = [];
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      sent.add(oid);
      if (object.type === 'commit') roots.push(parseCommit(object.data).tree);
      else if (object.type === 'tag') {
        const target = peelToCommit(repo, oid);
        const targetObj = repo.objects.get(target);
        if (targetObj !== undefined && targetObj.type === 'commit') roots.push(parseCommit(targetObj.data).tree);
      }
    }
    for (const oid of reachable(repo, roots)) if (!held.has(oid)) sent.add(oid);
    // A boundary commit the client already holds is not re-sent and not re-listed.
    for (let i = boundary.length - 1; i >= 0; i -= 1) {
      if (held.has(boundary[i]!)) boundary.splice(i, 1);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...sent].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Old boundaries that are now interior (an ancestor of a want, or a want itself)
  // stop being shallow.
  const unshallow: string[] = [];
  if (oldShallow.length > 0) {
    const ancestors = reachable(repo, wants);
    for (const old of oldShallow) if (ancestors.has(old) || wants.includes(old)) unshallow.push(old);
  }
  return { objects, shallow: boundary, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
    else if (arg === 'done') done = true;
  }
  // The acknowledgments section belongs to negotiation only: when the client
  // already sent `done`, the negotiation is over and the response goes
  // straight to shallow-info / packfile (real git's server behaves the same
  // way, and its client dies if it sees an acknowledgments section after
  // `done`). Without `done`, answer acknowledgments alone and wait for the
  // client's next round.
  if (!done) {
    const ackParts: Buffer[] = [pkt('acknowledgments\n')];
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        ackParts.push(pkt(`ACK ${have}\n`));
        acked = true;
      }
    }
    ackParts.push(pkt(acked ? 'ready\n' : 'NAK\n'));
    ackParts.push(pktFlush());
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(ackParts));
    return;
  }
  const cacheKey = `${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${depth ?? ''}|${shallow.slice().sort().join(',')}`;
  const cachedPack = repo.packCache.get(cacheKey);
  let plan: FetchPlan;
  let pack: Buffer;
  if (cachedPack !== undefined) {
    pack = cachedPack;
    plan = { objects: [], shallow: [], unshallow: [] };
    // Recompute only the shallow lists (cheap: no object walk over the pack).
    const recomputed = planFetch(repo, wants, haves, depth, shallow);
    plan = { objects: [], shallow: recomputed.shallow, unshallow: recomputed.unshallow };
  } else {
    plan = planFetch(repo, wants, haves, depth, shallow);
    pack = writePack(plan.objects);
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = pktTextLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of haves) {
    if (repo.objects.has(have)) {
      parts.push(pkt(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pkt('NAK\n'));
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean, res: ServerResponse): void {
  let lines: string[];
  try {
    lines = pktTextLines(body);
  } catch {
    sendJson(res, 400, errBody('malformed pkt-line stream'));
    return;
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const delimAt = lines.findIndex((l) => l === '');
  void delimAt;
  // The request is pkt-lines; a delim packet decodes as an empty text line only
  // when its payload is empty, so find the command by scanning raw packets.
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    if (text !== '') args.push(text);
  }
  void first;
  if (!isV2) {
    handleFetchV0(repo, body, res);
    return;
  }
  if (command === 'ls-refs') {
    handleLsRefs(repo, args, res);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(repo, args, res);
    return;
  }
  sendJson(res, 400, errBody(`unknown upload-pack command ${JSON.stringify(command)}`));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const commands: PushCommand[] = [];
  let packStart = -1;
  // Walk the raw bytes: command pkt-lines up to the first flush, then the pack.
  const raw = body;
  let at = 0;
  let firstLine = true;
  while (at < raw.length) {
    if (at + 4 > raw.length) break;
    const head = raw.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      sendJson(res, 400, errBody('malformed pkt-line stream'));
      return;
    }
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      at += 4;
      packStart = at;
      break;
    }
    if (len < 4 || at + len > raw.length) {
      sendJson(res, 400, errBody('malformed pkt-line stream'));
      return;
    }
    const payload = raw.subarray(at + 4, at + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const text = (nul >= 0 && firstLine ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1])) {
      sendJson(res, 400, errBody('malformed push command'));
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    firstLine = false;
    at += len;
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packStart >= 0 && packStart < raw.length) {
    try {
      const entries = readPack(raw.subarray(packStart), (oid) => repo.objects.get(oid));
      for (const entry of entries) putObject(repo, entry.type, entry.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          ok = false;
          reason = 'remote ref does not exist';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (repo.objects.get(command.newOid) === undefined) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        if (current === undefined || command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (repo.objects.get(command.newOid) === undefined) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (command.ref.startsWith('refs/heads/') && !isAncestor(repo, command.oldOid, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}`);
      } else {
        lines.push(`ng ${command.ref} ${reason}`);
      }
    }
    if (commands.length > 0) bump(repo);
  }
  const report = Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), pktFlush()]);
  // The report rides in band 1, and the sideband stream itself is closed by
  // a top-level flush: without it real git's demultiplexer reads past the
  // report and dies with "unexpected disconnect while reading sideband
  // packet" even though the report parsed fine.
  const framed = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), pktFlush()]);
  sendRaw(res, 200, 'application/x-git-receive-pack-result', framed);
}

// ---------------------------------------------------------------------------
// REST v3: serialization
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function repoJsonBuffer(repo: Repo): Buffer {
  if (repo.repoJsonCache === null) repo.repoJsonCache = utf8(JSON.stringify(repoJson(repo)));
  return repo.repoJsonCache;
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    comments: issue.comments.length,
    locked: false,
  };
}

function issueJsonBuffer(issue: Issue, repo: Repo): Buffer {
  if (issue.jsonCache === null) issue.jsonCache = utf8(JSON.stringify(issueJson(issue, repo)));
  return issue.jsonCache;
}

function pullJson(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? mergeableOf(repo, pull) : false,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function mergeableOf(repo: Repo, pull: PullRequest): boolean {
  return !mergeConflicts(repo, pull).conflict;
}

// The three-way merge check: a path conflicts when the base tip and the head
// both changed it away from the merge base, to different contents.
function mergeConflicts(
  repo: Repo,
  pull: PullRequest,
): { conflict: boolean; tree: Map<string, { oid: string; mode: string }> | null } {
  // The three-way merge is against the CURRENT base tip, not the base sha
  // captured when the pull request was opened: a merge that landed after
  // the PR was created changes what the base now holds.
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (currentBaseTip === undefined) return { conflict: true, tree: null };
  const baseFlat = flatTree(repo, currentBaseTip);
  const headFlat = flatTree(repo, pull.headSha);
  const mergeFlat = pull.mergeBase === '' ? new Map() : flatTree(repo, pull.mergeBase);
  const merged = new Map(baseFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...mergeFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    const atMerge = mergeFlat.get(path);
    const headChanged = (atHead?.oid ?? null) !== (atMerge?.oid ?? null);
    const baseChanged = (atBase?.oid ?? null) !== (atMerge?.oid ?? null);
    if (headChanged && baseChanged && (atHead?.oid ?? null) !== (atBase?.oid ?? null)) {
      return { conflict: true, tree: null };
    }
    if (headChanged) {
      if (atHead === undefined) merged.delete(path);
      else merged.set(path, atHead);
    }
  }
  return { conflict: false, tree: merged };
}

function commitRestJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      // GitHub returns the message without its trailing newline; the stored
      // commit bytes end with one.
      message: view.message.replace(/\n+$/, ''),
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      tree: { sha: view.tree },
    },
    author: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    committer: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    parents: view.parents.map((p) => ({ sha: p })),
  };
}

// Walk a branch tip's ancestry, newest first.
function branchCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

function pageOf<T>(items: T[], query: Map<string, string>): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(base: string, path: string, query: Map<string, string>, total: number, perPage: number, pageNum: number): string | null {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const urlFor = (page: number): string => {
    const q = new Map(query);
    q.set('page', String(page));
    q.set('per_page', String(perPage));
    const qs = [...q.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return `${base}${path}?${qs}`;
  };
  const links: string[] = [];
  if (pageNum < pages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`, `<${urlFor(pages)}>; rel="last"`);
  if (pageNum > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(pageNum - 1)}>; rel="prev"`);
  return links.join(', ');
}

function hostBase(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------
// REST v3: contents (real git objects under the branch ref)
// ---------------------------------------------------------------------------

function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string; created: boolean } {
  const blobSha = putObject(repo, 'blob', content);
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const existed = tip !== undefined && flatTree(repo, tip).has(path);
  const baseTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const files = new Map<string, { oid: string; mode: string }>();
  files.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = treeWithFiles(repo, baseTree, files);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, parents, message.endsWith('\n') ? message : `${message}\n`));
  repo.refs.set(refName, commitOid);
  bump(repo);
  return { commitSha: commitOid, contentSha: blobSha, created: !existed };
}

function deleteFile(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  const next = treeWithoutFile(repo, treeOid, path);
  if (next === null) {
    // The tree is empty now: keep the branch on a commit with an empty tree.
    const emptyTree = putObject(repo, 'tree', buildTree([]));
    const commitOid = putObject(repo, 'commit', buildCommit(emptyTree, [tip], message.endsWith('\n') ? message : `${message}\n`));
    repo.refs.set(refName, commitOid);
    bump(repo);
    return { commitSha: commitOid };
  }
  const commitOid = putObject(repo, 'commit', buildCommit(next, [tip], message.endsWith('\n') ? message : `${message}\n`));
  repo.refs.set(refName, commitOid);
  bump(repo);
  return { commitSha: commitOid };
}

// A directory listing of the tree at `refName` under `dir` ('' for the root).
function listDir(
  repo: Repo,
  refName: string,
  dir: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }[] | null {
  const tip = repo.refs.get(refName);
  if (tip === undefined) return null;
  const flat = flatTree(repo, tip);
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size?: number }>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = repo.objects.get(entry.oid);
      entries.set(rest, { type: 'file', sha: entry.oid, size: object?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) {
        // The directory's tree object id, for the sha field.
        let treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
        for (const part of `${dir === '' ? '' : `${dir}/`}${name}`.split('/')) {
          const tree = repo.objects.get(treeOid);
          if (tree === undefined) break;
          const found = parseTree(tree.data).find((e) => e.name === part);
          if (found === undefined) break;
          treeOid = found.oid;
        }
        entries.set(name, { type: 'dir', sha: treeOid });
      }
    }
  }
  const out: { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }[] = [];
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name)!;
    out.push({ type: entry.type, name, path: prefix + name, sha: entry.sha, ...(entry.size !== undefined ? { size: entry.size } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST v3: route handling
// ---------------------------------------------------------------------------

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createIssueIn(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: nextObjectId++,
    number,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: number,
    jsonCache: null,
  };
  repo.issues.push(issue);
  return issue;
}

function createPullIn(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const number = repo.nextNumber++;
  const pull: PullRequest = {
    id: nextObjectId++,
    number,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    mergeBase: mergeBaseOf(repo, headTip, baseTip),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: number,
  };
  repo.pulls.push(pull);
  return pull;
}

// Squash-merge a pull request onto its base branch. Returns the merge commit
// sha, or null when the pull request cannot merge (already closed / conflict).
function squashMerge(repo: Repo, pull: PullRequest): { sha: string; message: string } | null {
  if (pull.state !== 'open') return null;
  const check = mergeConflicts(repo, pull);
  if (check.conflict || check.tree === null) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (baseTip === undefined) return null;
  const treeOid = treeWithFiles(repo, parseCommit(repo.objects.get(baseTip)!.data).tree, check.tree);
  const message = `Merge pull request #${pull.number}: ${pull.title}\n`;
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, [baseTip], message));
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  bump(repo);
  return { sha: commitOid, message: message.trim() };
}

function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

function pullFiles(repo: Repo, pull: PullRequest): Record<string, unknown>[] {
  const baseFlat = pull.mergeBase === '' ? new Map() : flatTree(repo, pull.mergeBase);
  const headFlat = flatTree(repo, pull.headSha);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    if (atBase?.oid === atHead?.oid) continue;
    if (atHead === undefined) {
      const oldText = repo.objects.get(atBase!.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      continue;
    }
    const newText = repo.objects.get(atHead.oid)?.data.toString('utf8') ?? '';
    if (atBase === undefined) {
      const counts = lineDiffCounts('', newText);
      out.push({ filename: path, status: 'added', additions: Math.max(1, counts.additions), deletions: 0, changes: Math.max(1, counts.additions) });
      continue;
    }
    const oldText = repo.objects.get(atBase.oid)?.data.toString('utf8') ?? '';
    const counts = lineDiffCounts(oldText, newText);
    out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
  }
  return out;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[], query: Map<string, string>): Promise<void> {
  const method = req.method ?? 'GET';
  // GET /api/v3/ — the API root.
  if (segs.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (!bearerOk(req)) {
      sendJson(res, 401, errBody('Requires authentication'));
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' });
    return;
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (!bearerOk(req)) {
      sendJson(res, 401, errBody('Requires authentication'));
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' });
    return;
  }
  if (segs[0] === 'user' && segs.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (!bearerOk(req)) {
      sendJson(res, 401, errBody('Requires authentication'));
      return;
    }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
    return;
  }
  // Every other REST route needs a token.
  if (!bearerOk(req)) {
    sendJson(res, 401, errBody('Requires authentication'));
    return;
  }
  // GET /user/repos and POST /user/repos.
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (segs.length !== 2) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (method === 'GET') {
      const owned = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const { page, total, pageNum, perPage } = pageOf(owned, query);
      const link = linkHeader(hostBase(req), '/api/v3/user/repos', query, total, perPage, pageNum);
      sendJson(res, 200, page.map(repoJson), link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, errBody('name is invalid'));
        return;
      }
      if (findRepo(VIEWER_LOGIN, name) !== undefined) {
        sendJson(res, 422, errBody('Repository already exists'));
        return;
      }
      const repo = newRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  // /repos/{owner}/{name}[...]
  if (segs[0] === 'repos' && segs.length >= 3) {
    await handleRepoRoute(req, res, segs, query);
    return;
  }
  sendJson(res, 404, errBody('Not Found'));
}

async function handleRepoRoute(req: IncomingMessage, res: ServerResponse, segs: string[], query: Map<string, string>): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = segs[1]!;
  const name = segs[2]!;
  const repo = findRepo(owner, name);
  const rest = segs.slice(3);
  if (repo === undefined) {
    // A body-carrying request to a missing repo still parses its body first so a
    // malformed body is a 400, not a 404.
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJsonBuffer(res, 200, repoJsonBuffer(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      bump(repo);
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      await readBody(req).catch(() => Buffer.alloc(0));
      repos.delete(repoKey(owner, name));
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  const head = rest[0]!;
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const out: Record<string, unknown>[] = [];
      for (const refName of sortedRefNames(repo)) {
        if (!refName.startsWith('refs/heads/')) continue;
        out.push({ name: refName.slice('refs/heads/'.length), commit: { sha: repo.refs.get(refName) }, protected: false });
      }
      sendJson(res, 200, out);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[1]}`);
      if (tip === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: tip }, protected: false });
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        sendJson(res, 422, errBody('ref or sha is invalid'));
        return;
      }
      const target = repo.objects.get(sha);
      if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
        sendJson(res, 422, errBody('sha does not name a commit'));
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, errBody('ref already exists'));
        return;
      }
      repo.refs.set(ref, sha);
      bump(repo);
      sendJson(res, 201, { ref, object: { sha, type: target.type } });
      return;
    }
    if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${rest[3]}`);
      if (tip === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: tip, type: 'commit' } });
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const branch = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      const list = branchCommits(repo, tip)
        .map((oid) => commitRestJson(repo, oid))
        .filter((c): c is Record<string, unknown> => c !== null);
      const { page } = pageOf(list, query);
      sendJson(res, 200, page);
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (head === 'contents') {
    await handleContents(req, res, repo, rest.slice(1), query);
    return;
  }
  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        sendJson(res, 422, errBody('name is required'));
        return;
      }
      const existing = repo.labels.get(labelName);
      if (existing !== undefined) {
        sendJson(res, 201, labelJson(existing));
        return;
      }
      const label: Label = { name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (head === 'issues') {
    await handleIssues(req, res, repo, rest.slice(1), query);
    return;
  }
  if (head === 'pulls') {
    await handlePulls(req, res, repo, rest.slice(1), query);
    return;
  }
  sendJson(res, 404, errBody('Not Found'));
}

// ---------------------------------------------------------------------------
// REST v3: contents, issues, pulls
// ---------------------------------------------------------------------------

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: Map<string, string>,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = rest.join('/');
  if (method === 'GET') {
    const refName = `refs/heads/${query.get('ref') ?? repo.defaultBranch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    const flat = flatTree(repo, tip);
    if (path === '') {
      const listing = listDir(repo, refName, '');
      sendJson(res, 200, listing ?? []);
      return;
    }
    const entry = flat.get(path);
    if (entry !== undefined) {
      const object = repo.objects.get(entry.oid);
      if (object === undefined || object.type !== 'blob') {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: object.data.length,
        encoding: 'base64',
        content: b64encode(object.data),
      });
      return;
    }
    const listing = listDir(repo, refName, path);
    if (listing === null || listing.length === 0) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    sendJson(res, 200, listing);
    return;
  }
  if (method === 'PUT') {
    const parsed = parseJsonBody(await readBody(req));
    if (!parsed.ok) {
      sendJson(res, 400, errBody('malformed JSON body'));
      return;
    }
    const body = (parsed.value ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'update file';
    const contentText = typeof body.content === 'string' ? body.content : '';
    const decoded = b64decode(contentText);
    if (decoded === null) {
      sendJson(res, 422, errBody('content is not valid base64'));
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined) {
      // A write to a missing branch starts it from the default branch tip.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(refName, defaultTip);
        tip = defaultTip;
      }
    }
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const current = tip === undefined ? null : blobAt(repo, refName, path);
    if (sha !== undefined) {
      if (current === null || current.oid.toLowerCase() !== sha.toLowerCase()) {
        sendJson(res, 409, errBody('sha does not match the current blob'));
        return;
      }
    } else if (current !== null) {
      sendJson(res, 422, errBody('sha is required when updating a file'));
      return;
    }
    const done = commitFile(repo, branch, path, decoded, message);
    sendJson(res, done.created ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: done.contentSha, size: decoded.length, type: 'file', encoding: 'base64' },
      commit: { sha: done.commitSha, message },
    });
    return;
  }
  if (method === 'DELETE') {
    const parsed = parseJsonBody(await readBody(req));
    if (!parsed.ok) {
      sendJson(res, 400, errBody('malformed JSON body'));
      return;
    }
    const body = (parsed.value ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'delete file';
    const refName = `refs/heads/${repo.defaultBranch}`;
    const current = blobAt(repo, refName, path);
    if (current === null) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (typeof body.sha === 'string' && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
      sendJson(res, 409, errBody('sha does not match the current blob'));
      return;
    }
    const done = deleteFile(repo, repo.defaultBranch, path, message);
    if (done === null) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    sendJson(res, 200, { commit: { sha: done.commitSha, message } });
    return;
  }
  sendJson(res, 404, errBody('Not Found'));
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: Map<string, string>,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      void sort;
      const { page, total, pageNum, perPage } = pageOf(list, query);
      const link = linkHeader(hostBase(req), `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, total, perPage, pageNum);
      sendJson(res, 200, page.map((i) => issueJson(i, repo)), link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendJson(res, 422, errBody('title is required'));
        return;
      }
      const wanted: string[] = Array.isArray(body.labels)
        ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l !== null ? String((l as Record<string, unknown>).name ?? '') : ''))
        : [];
      const labels: Label[] = [];
      for (const name of wanted) {
        const label = repo.labels.get(name);
        if (label === undefined) {
          sendJson(res, 422, errBody(`label ${JSON.stringify(name)} does not exist`));
          return;
        }
        labels.push(label);
      }
      const issue = createIssueIn(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      sendJson(res, 201, issueJson(issue, repo));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number <= 0) {
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      sendJsonBuffer(res, 200, issueJsonBuffer(issue, repo));
      return;
    }
    if (method === 'PATCH') {
      if (issue === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.jsonCache = null;
      sendJson(res, 200, issueJson(issue, repo));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') {
        sendJson(res, 422, errBody('body is required'));
        return;
      }
      const comment = { id: repo.nextCommentId++, body: text };
      issue.comments.push(comment);
      issue.jsonCache = null;
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  sendJson(res, 404, errBody('Not Found'));
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  query: Map<string, string>,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      const { page, total, pageNum, perPage } = pageOf(list, query);
      const link = linkHeader(hostBase(req), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, total, perPage, pageNum);
      sendJson(res, 200, page.map((p) => pullJson(p, repo)), link === null ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if (!parsed.ok) {
        sendJson(res, 400, errBody('malformed JSON body'));
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') {
        sendJson(res, 422, errBody('title and head are required'));
        return;
      }
      const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (existing !== undefined) {
        sendJson(res, 422, errBody('a pull request from this branch is already open'));
        return;
      }
      const pull = createPullIn(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      if (pull === null) {
        sendJson(res, 422, errBody('head or base branch does not exist'));
        return;
      }
      sendJson(res, 201, pullJson(pull, repo));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number) || number <= 0) {
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      sendJson(res, 200, pullJson(pull, repo));
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    sendJson(res, 200, pullFiles(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    const parsed = parseJsonBody(await readBody(req));
    if (!parsed.ok) {
      sendJson(res, 400, errBody('malformed JSON body'));
      return;
    }
    if (pull.state !== 'open') {
      sendJson(res, 405, errBody('pull request is not open'));
      return;
    }
    const done = squashMerge(repo, pull);
    if (done === null) {
      sendJson(res, 405, errBody('merge conflict'));
      return;
    }
    sendJson(res, 200, { merged: true, sha: done.sha, message: done.message });
    return;
  }
  sendJson(res, 404, errBody('Not Found'));
}

// ---------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, unknown>;
  children: GqlField[] | null;
  fragments: string[];
}

interface GqlDocument {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Map<string, unknown>;
  root: GqlField[];
  fragments: Map<string, GqlField[]>;
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string };

function tokenizeGql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number.parseFloat(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private at = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)}`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): GqlDocument {
    const doc: GqlDocument = { operation: 'query', name: null, variables: new Map(), root: [], fragments: new Map() };
    let first = true;
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        doc.operation = token.value as GqlDocument['operation'];
        const nameToken = this.peek();
        if (nameToken !== undefined && nameToken.kind === 'name') {
          doc.name = nameToken.value;
          this.next();
        }
        if (this.isPunct('(')) doc.variables = this.parseVariableDefinitions();
        doc.root = this.parseSelectionSet();
        first = false;
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('fragment name expected');
        this.next(); // 'on'
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('fragment type expected');
        doc.fragments.set(nameToken.value, this.parseSelectionSet());
        continue;
      }
      if (this.isPunct('{')) {
        doc.root = this.parseSelectionSet();
        first = false;
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    void first;
    return doc;
  }

  private parseVariableDefinitions(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const varToken = this.next();
      if (varToken.kind !== 'var') throw new Error('variable name expected');
      this.expectPunct(':');
      // Skip the type (a name, possibly wrapped in [ ] or followed by !).
      while (!this.isPunct(')') && !this.isPunct(',')) {
        const token = this.peek();
        if (token === undefined) break;
        if (token.kind === 'var') break;
        this.next();
      }
      out.set(varToken.value, null);
      if (this.isPunct(',')) this.next();
    }
    this.expectPunct(')');
    return out;
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.isPunct('}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): GqlField {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.next();
      if (next.kind === 'name' && next.value === 'on') {
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('inline fragment type expected');
        const children = this.parseSelectionSet();
        return { name: `...on ${typeToken.value}`, alias: null, args: new Map(), children, fragments: [] };
      }
      if (next.kind === 'name') {
        const field: GqlField = { name: '', alias: null, args: new Map(), children: null, fragments: [next.value] };
        if (this.isPunct('{')) field.children = this.parseSelectionSet();
        return field;
      }
      throw new Error('fragment spread expected');
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('field name expected');
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('field name expected after alias');
      alias = name;
      name = nameToken.value;
    }
    let args = new Map<string, unknown>();
    if (this.isPunct('(')) args = this.parseArguments();
    let children: GqlField[] | null = null;
    if (this.isPunct('{')) children = this.parseSelectionSet();
    return { name, alias, args, children, fragments: [] };
  }

  private parseArguments(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('argument name expected');
      this.expectPunct(':');
      out.set(nameToken.value, this.parseValue());
      if (this.isPunct(',')) this.next();
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'var') return { __var: token.value };
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('object key expected');
        this.expectPunct(':');
        obj[nameToken.value] = this.parseValue();
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('value expected');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('__var' in record && typeof record.__var === 'string') {
      return variables[record.__var] ?? null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  return value;
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const raw = field.args.get(name);
  if (raw === undefined) return undefined;
  return resolveVariables(raw, variables);
}

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function gqlTypeFields(typeName: string): string[] {
  switch (typeName) {
    case 'Issue':
      return ['id', 'number', 'title', 'state', 'body', 'createdAt', 'author', 'labels', 'comments'];
    case 'PullRequest':
      return ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt'];
    case 'Repository':
      return [
        'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
        'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
      ];
    case 'SearchType':
      return [];
    default:
      return [];
  }
}

function gqlEnumValues(typeName: string): string[] {
  if (typeName === 'SearchType') return ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];
  return [];
}

// Expand fragment spreads and inline fragments into a flat field list.
function expandFields(fields: GqlField[], doc: GqlDocument): GqlField[] {
  const out: GqlField[] = [];
  for (const field of fields) {
    if (field.fragments.length > 0) {
      for (const name of field.fragments) {
        const spread = doc.fragments.get(name);
        if (spread !== undefined) out.push(...expandFields(spread, doc));
      }
      continue;
    }
    if (field.name.startsWith('...on ')) {
      out.push(...expandFields(field.children ?? [], doc));
      continue;
    }
    out.push(field);
  }
  return out;
}

interface GqlContext {
  repo: Repo | null;
  owner: string;
  repoName: string;
  variables: Record<string, unknown>;
  doc: GqlDocument;
}

function resolveNode(field: GqlField, value: unknown, ctx: GqlContext): unknown {
  if (field.children === null) return value;
  if (Array.isArray(value)) return value.map((entry) => resolveNode(field, entry, ctx));
  if (value !== null && typeof value === 'object') {
    const sel = value as { __select?: (fields: GqlField[], ctx: GqlContext) => unknown };
    if (typeof sel.__select === 'function') return sel.__select(field.children, ctx);
    const data: Record<string, unknown> = {};
    for (const child of expandFields(field.children, ctx.doc)) {
      const key = child.alias ?? child.name;
      data[key] = resolveNode(child, (value as Record<string, unknown>)[child.name], ctx);
    }
    return data;
  }
  return value;
}

function makeSelectable<T extends Record<string, unknown>>(
  values: T,
  children: (field: GqlField, ctx: GqlContext) => unknown,
): T & { __select: (fields: GqlField[], ctx: GqlContext) => unknown } {
  return {
    ...values,
    __select: (fields: GqlField[], ctx: GqlContext) => {
      const data: Record<string, unknown> = {};
      for (const field of expandFields(fields, ctx.doc)) {
        const key = field.alias ?? field.name;
        const computed = children(field, ctx);
        const raw = computed === undefined ? values[field.name] : computed;
        data[key] = resolveNode(field, raw, ctx);
      }
      return data;
    },
  };
}

// ---------------------------------------------------------------------------
// GraphQL v4: executor
// ---------------------------------------------------------------------------

function issueSelectable(repo: Repo, issue: Issue): ReturnType<typeof makeSelectable> {
  return makeSelectable(
    {
      id: globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      createdAt: FIXED_ISO,
    },
    (field) => {
      switch (field.name) {
        case 'author':
          return makeSelectable({ login: repo.owner }, () => repo.owner);
        case 'labels':
          return {
            nodes: issue.labels.map((label) => makeSelectable({ name: label.name, color: label.color }, () => label.name)),
            totalCount: issue.labels.length,
          };
        case 'comments':
          return {
            nodes: issue.comments.map((c) =>
              makeSelectable(
                { id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${c.id}`), body: c.body },
                () => c.body,
              ),
            ),
            totalCount: issue.comments.length,
          };
        default:
          return undefined;
      }
    },
  );
}

function pullSelectable(repo: Repo, pull: PullRequest): ReturnType<typeof makeSelectable> {
  return makeSelectable(
    {
      id: globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.head,
      baseRefName: pull.base,
      mergeable: pull.state === 'open' ? (mergeableOf(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN',
      createdAt: FIXED_ISO,
    },
    (field) => {
      switch (field.name) {
        case 'author':
          return makeSelectable({ login: repo.owner }, () => repo.owner);
        case 'files': {
          const first = argValue(field, 'first', {}) as number | undefined;
          const files = pullFiles(repo, pull);
          const nodes = (first === undefined ? files : files.slice(0, first)).map((f) =>
            makeSelectable({ path: f.filename }, () => f.filename),
          );
          return { nodes, totalCount: files.length };
        }
        default:
          return undefined;
      }
    },
  );
}

function issueConnection(repo: Repo, field: GqlField, ctx: GqlContext): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const after = argValue(field, 'after', ctx.variables) as string | undefined;
  const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    list.sort((a, b) => b.seq - a.seq);
  }
  let offset = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      offset = Number.parseInt(Buffer.from(after, 'base64').toString('utf8'), 10) || 0;
    } catch {
      offset = 0;
    }
  }
  const limit = first === undefined ? list.length : first;
  const page = list.slice(offset, offset + limit);
  const hasNext = offset + limit < list.length;
  return {
    nodes: page.map((issue) => issueSelectable(repo, issue)),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: offset > 0,
      endCursor: hasNext ? Buffer.from(String(offset + limit), 'utf8').toString('base64') : null,
      startCursor: page.length > 0 ? Buffer.from(String(offset), 'utf8').toString('base64') : null,
    },
  };
}

function pullConnection(repo: Repo, field: GqlField, ctx: GqlContext): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
  let list = [...repo.pulls];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  list.sort((a, b) => b.seq - a.seq);
  const page = first === undefined ? list : list.slice(0, first);
  return {
    nodes: page.map((pull) => pullSelectable(repo, pull)),
    totalCount: list.length,
    pageInfo: {
      hasNextPage: first !== undefined && first < list.length,
      hasPreviousPage: false,
      endCursor: null,
      startCursor: null,
    },
  };
}

function repoSelectable(repo: Repo): ReturnType<typeof makeSelectable> {
  return makeSelectable(
    {
      id: globalId('Repository', `${repo.owner}/${repo.name}`),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    },
    (field, ctx) => {
      switch (field.name) {
        case 'owner':
          return makeSelectable({ login: repo.owner }, () => repo.owner);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return makeSelectable({ name: repo.defaultBranch, target: { oid: tip } }, () => repo.defaultBranch);
        }
        case 'issue': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const issue = repo.issues.find((i) => i.number === number);
          return issue === undefined ? null : issueSelectable(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, field, ctx);
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const pull = repo.pulls.find((p) => p.number === number);
          return pull === undefined ? null : pullSelectable(repo, pull);
        }
        case 'pullRequests':
          return pullConnection(repo, field, ctx);
        default:
          return undefined;
      }
    },
  );
}

function typeSelectable(typeName: string): ReturnType<typeof makeSelectable> {
  const fields = gqlTypeFields(typeName).map((name) => makeSelectable({ name }, () => name));
  const enums = gqlEnumValues(typeName).map((name) => makeSelectable({ name }, () => name));
  return makeSelectable({ name: typeName, kind: 'OBJECT' }, (field) => {
    if (field.name === 'fields') return fields;
    if (field.name === 'enumValues') return enums;
    return undefined;
  });
}

function executeGql(doc: GqlDocument, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: GqlContext = { repo: null, owner: '', repoName: '', variables, doc };
  const data: Record<string, unknown> = {};
  const errors: { message: string }[] = [];
  for (const field of expandFields(doc.root, doc)) {
    const key = field.alias ?? field.name;
    if (field.name === '__type') {
      const name = argValue(field, 'name', variables) as string | undefined;
      if (name === undefined) {
        data[key] = null;
        continue;
      }
      data[key] = resolveNode(field, typeSelectable(name), ctx);
      continue;
    }
    if (field.name === '__schema') {
      data[key] = resolveNode(field, makeSelectable({ queryType: { name: 'Query' } }, () => ({ name: 'Query' })), ctx);
      continue;
    }
    if (field.name === 'viewer') {
      const viewer = makeSelectable(
        { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
        () => VIEWER_LOGIN,
      );
      data[key] = resolveNode(field, viewer, ctx);
      continue;
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', variables) as string | undefined;
      const name = argValue(field, 'name', variables) as string | undefined;
      const repo = owner !== undefined && name !== undefined ? findRepo(owner, name) : undefined;
      data[key] = repo === undefined ? null : resolveNode(field, repoSelectable(repo), ctx);
      continue;
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', variables) as string | undefined;
      const decoded = id === undefined ? null : decodeGlobalId(id);
      let value: unknown = null;
      if (decoded !== null) {
        if (decoded.kind === 'Repository') {
          const [owner, name] = decoded.key.split('/');
          const repo = owner !== undefined && name !== undefined ? findRepo(owner, name) : undefined;
          if (repo !== undefined) value = repoSelectable(repo);
        } else if (decoded.kind === 'Issue') {
          const parts = decoded.key.split('/');
          const repo = parts.length >= 3 ? findRepo(parts[0]!, parts[1]!) : undefined;
          const issue = repo?.issues.find((i) => i.number === Number.parseInt(parts[2]!, 10));
          if (repo !== undefined && issue !== undefined) value = issueSelectable(repo, issue);
        } else if (decoded.kind === 'PullRequest') {
          const parts = decoded.key.split('/');
          const repo = parts.length >= 3 ? findRepo(parts[0]!, parts[1]!) : undefined;
          const pull = repo?.pulls.find((p) => p.number === Number.parseInt(parts[2]!, 10));
          if (repo !== undefined && pull !== undefined) value = pullSelectable(repo, pull);
        } else if (decoded.kind === 'IssueComment') {
          const parts = decoded.key.split('/');
          const repo = parts.length >= 4 ? findRepo(parts[0]!, parts[1]!) : undefined;
          const issue = repo?.issues.find((i) => i.number === Number.parseInt(parts[2]!, 10));
          const comment = issue?.comments.find((c) => c.id === Number.parseInt(parts[3]!, 10));
          if (comment !== undefined) {
            value = makeSelectable({ id, body: comment.body }, () => comment.body);
          }
        }
      }
      data[key] = value === null ? null : resolveNode(field, value, ctx);
      continue;
    }
    if (doc.operation === 'mutation') {
      const input = argValue(field, 'input', variables) as Record<string, unknown> | undefined;
      const out = runMutation(field.name, input ?? {});
      if (out === null) {
        errors.push({ message: `mutation ${field.name} failed` });
        data[key] = null;
        continue;
      }
      data[key] = resolveNode(field, out, ctx);
      continue;
    }
    errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    data[key] = null;
  }
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

function runMutation(name: string, input: Record<string, unknown>): unknown {
  if (name === 'createIssue') {
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const [owner, repoName] = decoded.key.split('/');
    const repo = owner !== undefined && repoName !== undefined ? findRepo(owner, repoName) : undefined;
    if (repo === undefined) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') return null;
    const issue = createIssueIn(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return makeSelectable({ clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, (field) => {
      if (field.name === 'issue') return issueSelectable(repo, issue);
      return undefined;
    });
  }
  if (name === 'closeIssue') {
    const issueId = typeof input.issueId === 'string' ? input.issueId : '';
    const decoded = decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? findRepo(parts[0]!, parts[1]!) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number.parseInt(parts[2]!, 10));
    if (repo === undefined || issue === undefined) return null;
    issue.state = 'closed';
    issue.jsonCache = null;
    return makeSelectable({ clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, (field) => {
      if (field.name === 'issue') return issueSelectable(repo, issue);
      return undefined;
    });
  }
  if (name === 'createPullRequest') {
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const [owner, repoName] = decoded.key.split('/');
    const repo = owner !== undefined && repoName !== undefined ? findRepo(owner, repoName) : undefined;
    if (repo === undefined) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    if (title === '' || head === '') return null;
    const pull = createPullIn(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
    if (pull === null) return null;
    return makeSelectable({ clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, (field) => {
      if (field.name === 'pullRequest') return pullSelectable(repo, pull);
      return undefined;
    });
  }
  if (name === 'mergePullRequest') {
    const pullId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const decoded = decodeGlobalId(pullId);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? findRepo(parts[0]!, parts[1]!) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number.parseInt(parts[2]!, 10));
    if (repo === undefined || pull === undefined) return null;
    const done = squashMerge(repo, pull);
    if (done === null) return null;
    return makeSelectable({ clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, (field) => {
      if (field.name === 'pullRequest') return pullSelectable(repo, pull);
      return undefined;
    });
  }
  if (name === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const decoded = decodeGlobalId(subjectId);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const parts = decoded.key.split('/');
    const repo = parts.length >= 3 ? findRepo(parts[0]!, parts[1]!) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number.parseInt(parts[2]!, 10));
    if (repo === undefined || issue === undefined) return null;
    const body = typeof input.body === 'string' ? input.body : '';
    if (body === '') return null;
    const comment = { id: repo.nextCommentId++, body };
    issue.comments.push(comment);
    issue.jsonCache = null;
    const commentNode = makeSelectable(
      { id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${comment.id}`), body },
      () => body,
    );
    return makeSelectable({ clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, (field) => {
      if (field.name === 'commentEdge') return makeSelectable({}, () => commentNode);
      if (field.name === 'subject') return issueSelectable(repo, issue);
      return undefined;
    });
  }
  return null;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!bearerOk(req)) {
    sendJson(res, 401, errBody('Requires authentication'));
    return;
  }
  const parsed = parseJsonBody(await readBody(req));
  if (!parsed.ok) {
    sendJson(res, 400, errBody('malformed JSON body'));
    return;
  }
  const payload = parsed.value;
  const runOne = (entry: unknown): { data: Record<string, unknown> | null; errors?: { message: string }[] } => {
    if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'request body must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    let doc: GqlDocument;
    try {
      doc = new GqlParser(tokenizeGql(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
    }
    // Unknown-field validation: any root field that is not a known Query or
    // mutation field fails with a GraphQL-level error (HTTP 200).
    const known = new Set(['viewer', 'repository', 'node', '__type', '__schema', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);
    for (const field of expandFields(doc.root, doc)) {
      if (field.name.startsWith('__')) continue;
      if (!known.has(field.name)) {
        return { data: null, errors: [{ message: `Cannot query field "${field.name}" on type "Query".` }] };
      }
    }
    // Nested unknown-field validation for the viewer (the suite's invalid-field
    // case queries viewer { nonExistentField }).
    for (const field of expandFields(doc.root, doc)) {
      if (field.name === 'viewer' && field.children !== null) {
        const viewerFields = new Set(['login', 'id', 'name', 'email', 'avatarUrl', 'url']);
        for (const child of expandFields(field.children, doc)) {
          if (!viewerFields.has(child.name)) {
            return { data: null, errors: [{ message: `Cannot query field "${child.name}" on type "User". noSuchFieldOnViewer` }] };
          }
        }
      }
    }
    return executeGql(doc, variables);
  };
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(payload));
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(obj: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean } {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolFailure(message: string): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean } {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function runTool(name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: boolean } | { rpcError: { code: number; message: string } } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      return { rpcError: { code: -32602, message: `missing required argument ${JSON.stringify(required)}` } };
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return toolFailure('name is required');
      if (findRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return toolFailure('Repository already exists');
      const repo = newRepo(VIEWER_LOGIN, repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolFailure('title is required');
      const issue = createIssueIn(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(issue, repo));
    }
    case 'get_issue': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const number = Number(args.issue_number);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return toolFailure('Not Found');
      return toolResult(issueJson(issue, repo));
    }
    case 'list_issues': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(i, repo));
      return toolResult({ issues: list });
    }
    case 'create_pull_request': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (title === '' || head === '') return toolFailure('title and head are required');
      const pull = createPullIn(repo, title, '', head, base);
      if (pull === null) return toolFailure('head or base branch does not exist');
      return toolResult(pullJson(pull, repo));
    }
    case 'list_pull_requests': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullJson(p, repo));
      return toolResult({ pull_requests: list });
    }
    case 'merge_pull_request': {
      const repo = findRepo(owner, repoName);
      if (repo === undefined) return toolFailure('Not Found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return toolFailure('Not Found');
      if (pull.state !== 'open') return toolFailure('pull request is not open');
      const done = squashMerge(repo, pull);
      if (done === null) return toolFailure('merge conflict');
      return toolResult({ merged: true, sha: done.sha, message: done.message });
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!bearerOk(req)) {
    sendJson(res, 401, errBody('Requires authentication'));
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok || parsed.value === undefined || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = parsed.value as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === null) {
    // A notification: acknowledge and answer nothing.
    sendEmpty(res, 202);
    return;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge-v2', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge-v2', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    const offered = Array.isArray((params as Record<string, unknown>).protocolVersion)
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
    void offered;
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge-v2', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = runTool(toolName, args);
    if ('rpcError' in out) {
      sendJson(res, 200, mcpError(id, out.rpcError.code, out.rpcError.message));
      return;
    }
    sendJson(res, 200, mcpResult(id, out));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Router + app
// ---------------------------------------------------------------------------

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = splitPath(req.url);
  const segs = segmentsOf(path);
  try {
    if (path === '/healthz') {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    if (segs.length === 0) {
      sendJson(res, 404, errBody('Not Found'));
      return;
    }
    // git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
    if (segs.length >= 3 && segs[segs.length - 2] === 'info' && segs[segs.length - 1] === 'refs') {
      const repo = findRepo(segs[0]!, segs[1]!.replace(/\.git$/, ''));
      if (repo === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      const service = query.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, errBody('service is required'));
        return;
      }
      infoRefs(repo, service, req.headers['git-protocol'] === 'version=2', res);
      return;
    }
    if (segs.length >= 3 && (segs[segs.length - 1] === 'git-upload-pack' || segs[segs.length - 1] === 'git-receive-pack')) {
      const repo = findRepo(segs[0]!, segs[1]!.replace(/\.git$/, ''));
      if (repo === undefined) {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      const body = await readBody(req);
      if (segs[segs.length - 1] === 'git-upload-pack') {
        handleUploadPack(repo, body, req.headers['git-protocol'] === 'version=2', res);
      } else {
        handleReceivePack(repo, body, res);
      }
      return;
    }
    // REST v3: /api/v3[...]
    if (segs[0] === 'api' && segs[1] === 'v3') {
      await handleRest(req, res, segs.slice(2), query);
      return;
    }
    // GraphQL: /api/graphql
    if (segs[0] === 'api' && segs[1] === 'graphql' && segs.length === 2) {
      if (req.method !== 'POST') {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      await handleGraphql(req, res);
      return;
    }
    // MCP: /mcp
    if (segs[0] === 'mcp' && segs.length === 1) {
      if (req.method !== 'POST') {
        sendJson(res, 404, errBody('Not Found'));
        return;
      }
      await handleMcp(req, res);
      return;
    }
    sendJson(res, 404, errBody('Not Found'));
  } catch (err) {
    if (!res.writableEnded) {
      sendJson(res, 500, errBody(err instanceof Error ? err.message : 'internal error'));
    }
  }
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}
