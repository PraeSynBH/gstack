/**
 * /plan-ceo-review section-loading E2E (periodic, paid, real-PTY) — v2 plan
 * Phase B carve backstop. The per-PR guard is the free static test
 * skill-ceo-section-ordering.test.ts; THIS is the behavioral proof that a real
 * agent actually Reads the carved section instead of working from memory.
 *
 * After the carve, plan-ceo-review is a skeleton whose single STOP-Read directive
 * (fired after Step 0 mode selection) points at sections/review-sections.md. This
 * test runs the REAL /plan-ceo-review skill in plan mode against a fixture branch
 * that has a plan worth reviewing, drives Step 0 to HOLD SCOPE (the simplest mode
 * that still requires all 11 review sections), and asserts the agent Read
 * review-sections.md before producing the review report.
 *
 * Codex outside-voice P1 fixes vs the naive port of the ship test:
 *  - REFRESH THE INSTALL FIRST. The skill loads from the installed copy at
 *    ~/.claude/skills/gstack/plan-ceo-review (a real copy on dev machines, fresh
 *    on CI). A test that didn't refresh would assert against the pre-carve
 *    monolith and trivially "pass" with zero section reads. beforeAll copies the
 *    freshly-generated skeleton + sections into the install; afterAll restores the
 *    prior state so a local run doesn't leave the active skill mutated.
 *  - HANDLE THE FULL STEP 0. plan-ceo's Step 0 can fire a system audit, WebSearch,
 *    and several AskUserQuestion calls before mode selection — the answer loop
 *    replies to every permission dialog / numbered list, not just two.
 *
 * Plan-mode framing keeps the agent from editing/committing. Cost: ~$3-5/run.
 * Periodic tier.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  launchClaudePty,
  isPermissionDialogVisible,
  isNumberedOptionListVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const INSTALL_DIR = path.join(os.homedir(), '.claude', 'skills', 'gstack', 'plan-ceo-review');

// Sections every plan-ceo-review run must consult after Step 0.
const REQUIRED_SECTIONS = ['review-sections.md'];

/** Copy the freshly-generated skeleton + sections into the installed skill so the
 *  PTY agent loads the carve under test. Returns a restore() that puts the install
 *  back exactly as it was (content of SKILL.md + presence/content of sections/). */
function refreshInstall(): () => void {
  const repoSkill = path.join(REPO_ROOT, 'plan-ceo-review', 'SKILL.md');
  const repoSections = path.join(REPO_ROOT, 'plan-ceo-review', 'sections');
  const installSkill = path.join(INSTALL_DIR, 'SKILL.md');
  const installSections = path.join(INSTALL_DIR, 'sections');

  // Snapshot prior state for restore.
  const priorSkill = fs.existsSync(installSkill) ? fs.readFileSync(installSkill) : null;
  const hadSections = fs.existsSync(installSections);
  const priorSections: Record<string, Buffer> = {};
  if (hadSections) {
    for (const f of fs.readdirSync(installSections)) {
      priorSections[f] = fs.readFileSync(path.join(installSections, f));
    }
  }

  // Apply: skeleton + every generated section file (.md) + manifest.
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(repoSkill, installSkill);
  fs.mkdirSync(installSections, { recursive: true });
  for (const f of fs.readdirSync(repoSections)) {
    if (f.endsWith('.md.tmpl')) continue; // install carries generated files, not templates
    fs.copyFileSync(path.join(repoSections, f), path.join(installSections, f));
  }

  return function restore(): void {
    try {
      if (priorSkill) fs.writeFileSync(installSkill, priorSkill);
      if (hadSections) {
        // Restore the prior section files; drop any we added.
        for (const f of fs.readdirSync(installSections)) {
          if (!(f in priorSections)) fs.rmSync(path.join(installSections, f), { force: true });
        }
        for (const [f, buf] of Object.entries(priorSections)) {
          fs.writeFileSync(path.join(installSections, f), buf);
        }
      } else {
        fs.rmSync(installSections, { recursive: true, force: true });
      }
    } catch { /* best-effort restore */ }
  };
}

/** Fixture: a feature branch with a real change + a plan file worth reviewing. */
function buildPlanFixture(): { workTree: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ceo-secload-'));
  const workTree = path.join(root, 'workspace');
  const bareRemote = path.join(root, 'origin.git');
  fs.mkdirSync(workTree, { recursive: true });
  const sh = (cmd: string, cwd: string): void => {
    const r = spawnSync('bash', ['-c', cmd], { cwd, stdio: 'pipe', timeout: 15_000 });
    if (r.status !== 0) throw new Error(`fixture setup failed at "${cmd}":\n${r.stderr?.toString()}`);
  };
  sh(`git init --bare "${bareRemote}"`, root);
  sh('git init -b main', workTree);
  sh('git config user.email "t@t.com" && git config user.name "T" && git config commit.gpgsign false', workTree);
  fs.writeFileSync(path.join(workTree, 'app.js'), '// base\n');
  sh('git add -A && git commit -m "chore: initial"', workTree);
  sh(`git remote add origin "${bareRemote}" && git push -u origin main`, workTree);
  // Feature branch with a real change + a plan describing it (something to review).
  sh('git checkout -b feat/cache-layer', workTree);
  fs.writeFileSync(
    path.join(workTree, 'PLAN.md'),
    [
      '# Plan: add an in-memory cache layer',
      '',
      '## Context',
      'Reads hit the DB on every request. Add a process-local LRU cache in front of',
      'the read path to cut DB load.',
      '',
      '## Approach',
      '- Wrap the read repository in a cache that stores the last 1000 keys.',
      '- Invalidate on write.',
      '',
      '## Out of scope',
      'Distributed cache, cross-process coherence.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(workTree, 'app.js'), '// base\nexport function read(k) { return db.get(k); }\n');
  sh('git add -A && git commit -m "feat: cache layer plan + stub"', workTree);
  sh('git push -u origin feat/cache-layer', workTree);
  return { workTree, root };
}

describeE2E('/plan-ceo-review section-loading E2E (periodic, real-PTY, installed skill)', () => {
  test(
    'a real review Reads the carved section before producing the report',
    async () => {
      const restore = refreshInstall();
      const { workTree, root } = buildPlanFixture();
      const session = await launchClaudePty({
        permissionMode: 'plan',
        cwd: workTree,
        timeoutMs: 900_000,
        env: { NO_COLOR: '1' },
      });

      const readSections = new Set<string>();
      let reportReady = false;
      try {
        await Bun.sleep(8000);
        const since = session.mark();
        // HOLD SCOPE = simplest mode that still walks all 11 review sections.
        session.send('/plan-ceo-review review PLAN.md, hold scope\r');
        const start = Date.now();
        let lastPermSig = '';
        while (Date.now() - start < 780_000) {
          await Bun.sleep(3000);
          if (session.exited()) break;
          const visible = session.visibleSince(since);
          const tail = visible.slice(-1500);
          // Answer EVERY permission dialog / numbered option list (system audit,
          // WebSearch, and the several Step 0 questions) by taking option 1.
          if (isNumberedOptionListVisible(tail) && isPermissionDialogVisible(tail)) {
            const sig = visible.slice(-500);
            if (sig !== lastPermSig) { lastPermSig = sig; session.send('1\r'); await Bun.sleep(1500); continue; }
          }
          for (const m of visible.matchAll(/sections\/([A-Za-z0-9._-]+\.md)/g)) readSections.add(m[1]);
          if (/GSTACK REVIEW REPORT|COMPLETION SUMMARY|ready to execute/i.test(visible)) {
            reportReady = true;
            break;
          }
        }
      } finally {
        await session.close();
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
        restore();
      }

      const missing = REQUIRED_SECTIONS.filter(s => !readSections.has(s));
      expect({ reportReady, read: [...readSections], missing }).toEqual({
        reportReady: true,
        read: expect.any(Array),
        missing: [],
      });
    },
    1_020_000,
  );
});
