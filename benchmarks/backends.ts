import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"

import { open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import type { GitomicBackend } from "../src/types.js"

const execFileAsync = promisify(execFile)
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const iterations = Number(process.env.GITOMIC_BENCH_ITERATIONS ?? "20")
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "gitomic",
  GIT_AUTHOR_EMAIL: "gitomic@localhost",
  GIT_COMMITTER_NAME: "gitomic",
  GIT_COMMITTER_EMAIL: "gitomic@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  GIT_TERMINAL_PROMPT: "0",
}

async function fixture(): Promise<{ repo: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "gitomic-benchmark-"))
  const repo = join(directory, "state.git")
  await execFileAsync("git", ["init", "--bare", "--quiet", repo], { env: gitEnv })
  const { stdout } = await execFileAsync("git", ["--git-dir", repo, "commit-tree", EMPTY_TREE, "-m", "initial"], {
    env: gitEnv,
    encoding: "utf8",
  })
  const initial = stdout.trim()
  await execFileAsync("git", ["--git-dir", repo, "update-ref", "refs/heads/main", initial], {
    env: gitEnv,
  })
  return { repo, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

async function measure(name: string, backend?: GitomicBackend) {
  const target = await fixture()
  try {
    const store = await open({
      repo: target.repo,
      ref: "main",
      writer: `benchmark-${name}`,
      ...(backend === undefined ? {} : { backend }),
    })
    await store.transact(async (map) => map.set("warmup", "1"), "warmup")
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      await store.transact(async (map) => {
        map.set(`items/${index}.txt`, String(index))
      }, `item ${index}`)
    }
    const milliseconds = performance.now() - started
    return {
      milliseconds: Math.round(milliseconds * 100) / 100,
      commitsPerSecond: Math.round((iterations / milliseconds) * 100_000) / 100,
    }
  } finally {
    await target.cleanup()
  }
}

if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new TypeError("GITOMIC_BENCH_ITERATIONS must be a positive integer")
}

const shell = await measure("shell")
const iso = await measure("iso", createIsoBackend())
const speedup = Math.round((iso.commitsPerSecond / shell.commitsPerSecond) * 100) / 100
console.log(JSON.stringify({ iterations, shell, iso, speedup }, null, 2))
