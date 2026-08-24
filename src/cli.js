#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRepo, toplevel } from './git.js';
import { measure, repoName } from './measure.js';
import { decompose, renderDecomposition } from './decompose.js';
import { human, json } from './report.js';

const exec = promisify(execFile);

const USAGE = `holdover — how much of an agent's output is still in the repo

  holdover                     measure the repo in the current directory
  holdover <path>              measure a local repo
  holdover <owner/repo>        clone a public GitHub repo and measure it

  --horizons 30,90,180         days since arrival on the default branch
  --json                       machine-readable output
  --winsor 0.99                clamp per-commit line counts at this percentile
  --branch <ref>               measure a ref other than the detected default
  --quiet                      no progress output
  --decompose                  show what each definitional choice is worth
  --version                    print the version and exit
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    horizons: { type: 'string', default: '30,90,180' },
    json: { type: 'boolean', default: false },
    winsor: { type: 'string', default: '0.99' },
    branch: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    decompose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', default: false },
  },
});

const VERSION = JSON.parse(await readFile(
  new URL('../package.json', import.meta.url), 'utf8')).version;

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (values.version) {
  process.stdout.write(VERSION + '\n');
  process.exit(0);
}

const horizons = values.horizons.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
if (horizons.length === 0) {
  process.stderr.write('--horizons needs at least one positive number of days\n');
  process.exit(2);
}
const winsor = Number(values.winsor);
if (!(winsor > 0 && winsor <= 1)) {
  process.stderr.write('--winsor must be a percentile between 0 and 1 (1 disables)\n');
  process.exit(2);
}

const target = positionals[0] ?? '.';
const isSlug = /^[\w.-]+\/[\w.-]+$/.test(target) && !await isRepo(target).catch(() => false);

const progress = values.quiet || values.json
  ? () => {}
  : (msg) => process.stderr.write(`\r\x1b[2K  ${msg}...`);

let cwd = target;
let scratch = null;
try {
  if (isSlug) {
    scratch = await mkdtemp(join(tmpdir(), 'holdover-'));
    cwd = join(scratch, 'repo');
    progress(`cloning ${target}`);
    // A full clone: the whole point is history, so --depth would defeat it.
    await exec('git', ['clone', '--quiet', `https://github.com/${target}.git`, cwd],
      { maxBuffer: 1 << 26 });
  }

  // Exit code is set, never taken. `process.exit` with a report already handed
  // to `process.stdout` truncates it at the pipe buffer — 64 KiB on macOS — so
  // `holdover --json | jq` silently lost every repo bigger than a toy, and the
  // `finally` below never ran, leaking the clone. Falling off the end instead
  // lets stdout drain and the scratch directory go away.
  if (!await isRepo(cwd)) {
    process.stderr.write(`not a git repository: ${cwd}\n`);
    process.exitCode = 1;
  } else {
    cwd = await toplevel(cwd);
    const name = isSlug ? target : await repoName(cwd);

    if (values.decompose) {
      let n = 0;
      const rows = await decompose(cwd, () => progress(`definition ${++n}`));
      if (!values.quiet && !values.json) process.stderr.write('\r\x1b[2K');
      process.stdout.write((values.json
        ? JSON.stringify({ repo: name, decomposition: rows }, null, 2)
        : renderDecomposition(rows, name)) + '\n');
    } else {
      const result = await measure(cwd, {
        horizons, winsor, branch: values.branch, onProgress: progress,
      });
      if (!values.quiet && !values.json) process.stderr.write('\r\x1b[2K');

      process.stdout.write((values.json
        ? json(result, name, { version: VERSION, measuredAt: new Date().toISOString() })
        : human(result, name)) + '\n');
      process.exitCode = result.unmeasurable ? 3 : 0;
    }
  }
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
