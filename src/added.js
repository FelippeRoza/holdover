// What each commit added, as line-number ranges in that commit's own version of
// each file. One `git log --patch` process for the whole history; the alternative
// is one `git show` per commit, which is tens of thousands of process spawns.
//
// `-M` is on, so a pure file move contributes no added lines. That is the whole
// of the "exclude commits that are mostly moves" rule: with rename detection on,
// a directory move reports `0 0 old => new` and cannot inflate anything. A prior
// measurement had a single directory-move commit account for 55% of a repo's AI
// lines, which is what happens without it.

import { gitLines } from './git.js';

/** Files whose lines nobody authored, or which blame reads as text and numstat does not. */
const SKIP_PATH = [
  /(^|\/)node_modules\//, /(^|\/)vendor\//, /(^|\/)third_party\//,
  /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)\.yarn\//,
  /\.min\.(js|css|map)$/, /\.map$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/,
  /(^|\/)(Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|uv\.lock|pdm\.lock|flake\.lock)$/,
];

// git blame will happily report a GIF as tens of thousands of lines while numstat
// reports it as `-` and skips it. That asymmetry alone can push a survival rate
// past 200%, so binaries are excluded from both sides by extension.
const BINARY = new RegExp(
  '\\.(gif|png|jpe?g|webp|avif|bmp|ico|tiff?|svgz|mp4|mov|webm|avi|mkv|mp3|wav|ogg|flac|'
  + 'zip|gz|tgz|bz2|xz|7z|rar|zst|pdf|woff2?|ttf|otf|eot|db|sqlite3?|wasm|bin|exe|dll|'
  + 'so|dylib|jar|class|pyc|pyd|o|a|lib|dat|pack|idx|psd|ai|sketch|fig|ico|icns|jks|p12)$',
  'i',
);

export function skipPath(path) {
  return BINARY.test(path) || SKIP_PATH.some((re) => re.test(path));
}

const REC = '\x1e';

/**
 * @returns {Map<string, {added: number, addedInNewFiles: number,
 *   files: Map<string, Array<[number, number]>>}>}
 *   keyed by sha; ranges are inclusive [start, end] line numbers in the commit's
 *   own version of the file.
 */
export async function addedLines(cwd, branch, wanted, skip = skipPath) {
  const out = new Map();
  let cur = null;
  let path = null;
  let inHeader = false;
  let isNew = false;

  const onLine = (line) => {
    if (line.startsWith(REC)) {
      const sha = line.slice(REC.length).trim();
      cur = wanted.has(sha) ? { added: 0, addedInNewFiles: 0, newPaths: new Set(), files: new Map() } : null;
      if (cur) out.set(sha, cur);
      path = null;
      inHeader = false;
      return;
    }
    if (!cur) return;

    if (line.startsWith('diff --git ')) { inHeader = true; isNew = false; return; }
    if (inHeader && line.startsWith('new file mode ')) { isNew = true; return; }
    // Same trap as the old-path side: with -U0 the content line `++ b/x` arrives
    // as `+++ b/x`. Only a header immediately inside a `diff --git` block counts.
    if (line.startsWith('+++ ') && inHeader) {
      inHeader = false;
      // "+++ b/some/path" — the post-image path, which is the coordinate space of
      // the `+` side of every hunk that follows.
      const p = line.slice(4);
      path = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (path && skip(path)) path = null;
      return;
    }
    if (!path || !line.startsWith('@@')) return;

    // "@@ -12,3 +14,5 @@" — with -U0, the + side is exactly the added lines.
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) return;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) return; // pure deletion hunk: nothing was added here
    cur.added += count;
    // Lines in a file the same commit created have nothing to be rewritten by, so
    // the split between new and existing files is a confound, not a detail. On one
    // real repo 67% of agent lines were in newly created files against 26% of human
    // lines, and standardising on that single covariate took the reported gap from
    // +10.0 pp to +0.6 pp.
    if (isNew) { cur.addedInNewFiles += count; cur.newPaths.add(path); }
    let ranges = cur.files.get(path);
    if (!ranges) { ranges = []; cur.files.set(path, ranges); }
    ranges.push([start, start + count - 1]);
  };

  await gitLines(cwd, [
    'log', branch, '--no-merges', '--topo-order', '-U0', '-M', '--patch',
    '--no-color', '--no-textconv', `--format=${REC}%H`,
  ], onLine);

  return out;
}
