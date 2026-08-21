// Thin wrappers over the git CLI. Everything holdover knows comes from these.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Prepended to every git invocation.
 *
 * `core.quotePath=false` is not cosmetic. With the default on, `git log --patch`
 * emits `+++ "b/caf\303\251.py"` and blame emits `filename "caf\303\251.py"`,
 * while `ls-files -z` emits the raw bytes — so the two sides of the measurement
 * never join and every line in any non-ASCII path scores 0% kept. Measured on a
 * fixture: 4 lines added, 0 kept, where the truth is 4 of 4.
 */
const GLOBAL = ['-c', 'core.quotePath=false'];

// git blame output for one file is bounded by the file; 256 MB is far past any
// real source file and still small enough to fail loudly on a pathological one.
const MAX_BUFFER = 256 * 1024 * 1024;

export async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', [...GLOBAL, ...args], { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Same as git(), but a non-zero exit yields null instead of throwing. */
export async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Stream a git command line by line. Used for `git log --patch`, whose output
 * on a large repo is far too big to hold in a string.
 */
export function gitLines(cwd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GLOBAL, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const parts = (tail + chunk).split('\n');
      tail = parts.pop();
      for (const line of parts) onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (tail) onLine(tail);
      if (code === 0) resolve();
      else reject(new Error(`git ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/** Run `worker` over `items` with at most `limit` in flight. Order preserved. */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Agent A measured near-linear speedup up to core count and flat past it, so
 * this is the right width for the blame pass and oversubscribing is harmless.
 */
export const CONCURRENCY = Math.max(2, availableParallelism());

/**
 * A blobless or shallow clone cannot answer this question. On a `blob:none`
 * clone every diff is a network round trip to the promisor remote — measured at
 * 77 seconds for a single `git log --numstat` on a 5,460-commit repo, against
 * 0.7s for 500 commits with the blobs present — and a shallow clone simply does
 * not contain the history the cohorts are built from.
 */
export async function cloneDefects(cwd) {
  const defects = [];
  const filter = await gitOrNull(cwd, ['config', '--get', 'remote.origin.partialclonefilter']);
  if (filter?.trim()) defects.push(`partial clone (filter: ${filter.trim()})`);
  const shallow = await gitOrNull(cwd, ['rev-parse', '--is-shallow-repository']);
  if (shallow?.trim() === 'true') defects.push('shallow clone');
  return defects;
}

export async function isRepo(cwd) {
  return (await gitOrNull(cwd, ['rev-parse', '--git-dir'])) !== null;
}

/**
 * The repository root. Everything must run from here: `git log` is repo-wide but
 * `git ls-files -- .` is relative to the working directory, so measuring from a
 * subdirectory counted every line the repo ever added against only the files
 * under that subdirectory. Measured on a fixture: 4 lines added, 2 kept, where
 * the truth is 4 of 4.
 */
export async function toplevel(cwd) {
  const root = await gitOrNull(cwd, ['rev-parse', '--show-toplevel']);
  return root?.trim() || cwd;
}

/**
 * The branch whose history we treat as "landed". Prefers the remote's own idea
 * of its default branch, because that is the branch arrival dates are about.
 */
export async function defaultBranch(cwd) {
  const remote = await gitOrNull(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote?.trim()) return remote.trim();
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return 'HEAD';
}
