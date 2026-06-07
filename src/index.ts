/**
 * CanaryUsers GitHub Action entry point.
 *
 * Flow:
 *  1. POST /api/ci/scan  → get { id, pollUrl, freeRun, reportUrl }
 *  2. Poll GET /api/scan/<id>  until status === "done" | "error" or timeout
 *  3. Write GitHub Actions job summary with score + top issues
 *  4. Set outputs (scan-id, score, grade, report-url, free-run)
 *  5. Set check conclusion based on fail-on input
 */

import * as core from "@actions/core";
import * as fs from "fs";

// Default to www: the apex (canaryusers.ai) 301-redirects to www, and a POST
// following that cross-host redirect drops the Authorization header → 401.
const API_BASE = (core.getInput("canaryusers-url") || "https://www.canaryusers.ai").replace(/\/+$/, "");
const TOKEN = core.getInput("token");
const URL_INPUT = core.getInput("url");
const REPO = core.getInput("repo");
const FAIL_ON = core.getInput("fail-on") || "off";
const TIMEOUT_MIN = parseInt(core.getInput("timeout-minutes") || "5", 10);
const GH_TOKEN = core.getInput("github-token");

const COMMENT_MARKER = "<!-- canaryusers-scan -->";

interface ScanResponse {
  id: string;
  pollUrl: string;
  reportUrl: string;
  freeRun: boolean;
  repo: string | null;
  status: string;
  error?: string;
  delivery?: { prComment?: boolean };
}

interface PollResponse {
  id: string;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  report?: {
    canaryScore: number;
    grade: string;
    summary?: string;
    topFixes: Array<{ title: string; severity: string; fix: string; location?: string }>;
    completionRate: number;
    findings: Array<unknown>;
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startScan(): Promise<ScanResponse> {
  const res = await fetch(`${API_BASE}/api/ci/scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ url: URL_INPUT, repo: REPO }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to start scan (HTTP ${res.status}): ${body}`);
  }
  return res.json() as Promise<ScanResponse>;
}

async function pollScan(id: string): Promise<PollResponse> {
  const res = await fetch(`${API_BASE}/api/scan/${id}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`Poll failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<PollResponse>;
}

function gradeEmoji(grade: string): string {
  const map: Record<string, string> = { A: "🟢", B: "🟡", C: "🟠", D: "🔴", F: "🚨" };
  return map[grade] ?? "⚪";
}

async function writeSummary(scan: ScanResponse, result: PollResponse): Promise<void> {
  if (!result.report) return;
  const { canaryScore, grade, topFixes, completionRate, findings } = result.report;
  const dropPct = Math.round((1 - completionRate) * 100);
  const emoji = gradeEmoji(grade);

  await core.summary
    .addHeading(`${emoji} CanaryScore ${canaryScore} (${grade})`, 2)
    .addRaw(`**${dropPct}% drop-off** · ${findings.length} issue${findings.length === 1 ? "" : "s"} found`)
    .addBreak()
    .addRaw(scan.freeRun ? "✨ *Free first-run for this repo*" : "")
    .addBreak()
    .addLink("View full report →", scan.reportUrl)
    .write();

  if (topFixes.length > 0) {
    const rows = topFixes.slice(0, 5).map((f) => [
      f.severity.toUpperCase(),
      f.title,
      f.fix,
      f.location ?? "",
    ]);
    await core.summary
      .addHeading("Top fixes", 3)
      .addTable([
        [
          { data: "Severity", header: true },
          { data: "Issue", header: true },
          { data: "Fix", header: true },
          { data: "Location", header: true },
        ],
        ...rows,
      ])
      .write();
  }
}

/** Markdown body for the sticky PR comment. */
function buildComment(scan: ScanResponse, result: PollResponse): string {
  const r = result.report!;
  const dropPct = Math.round((1 - r.completionRate) * 100);
  const lines = [
    COMMENT_MARKER,
    `## 🐤 CanaryUsers — CanaryScore ${r.canaryScore} (${r.grade})`,
    ``,
    `**${dropPct}% drop-off** · ${r.findings.length} issue${r.findings.length === 1 ? "" : "s"} found` +
      (scan.freeRun ? ` · 🎁 free run` : ``),
  ];
  if (r.summary) lines.push(``, `> ${r.summary}`);
  if (r.topFixes.length > 0) {
    lines.push(``, `| Severity | Issue | Fix |`, `|---|---|---|`);
    for (const f of r.topFixes.slice(0, 5)) {
      const cell = (s: string) => (s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${cell(f.severity.toUpperCase())} | ${cell(f.title)} | ${cell(f.fix)} |`);
    }
  }
  lines.push(``, `[View the full report →](${scan.reportUrl})`, ``, `<sub>Tested by CanaryUsers — a flock of AI users that click through your app.</sub>`);
  return lines.join("\n");
}

/** Read the PR number + repo from the Actions event payload, if this is a PR run. */
function prContext(): { owner: string; repo: string; number: number } | null {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return null;
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const ev = JSON.parse(fs.readFileSync(path, "utf8"));
    const number = ev?.pull_request?.number;
    const full = ev?.repository?.full_name || process.env.GITHUB_REPOSITORY || "";
    const [owner, repo] = String(full).split("/");
    if (!number || !owner || !repo) return null;
    return { owner, repo, number };
  } catch {
    return null;
  }
}

/**
 * Post or update one sticky PR comment (found by COMMENT_MARKER). Best-effort:
 * a failure here never fails the build. Only runs on pull_request events with a
 * github-token and when the account has PR comments enabled.
 */
async function upsertPrComment(scan: ScanResponse, result: PollResponse): Promise<void> {
  if (scan.delivery?.prComment === false) {
    core.info("PR comment disabled in CanaryUsers delivery settings — skipping.");
    return;
  }
  if (!GH_TOKEN) return;
  const ctx = prContext();
  if (!ctx) return; // not a PR run

  const api = "https://api.github.com";
  const headers = {
    authorization: `Bearer ${GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "canaryusers-scan-action",
    "x-github-api-version": "2022-11-28",
  };
  const body = buildComment(scan, result);

  try {
    const listRes = await fetch(
      `${api}/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments?per_page=100`,
      { headers }
    );
    const comments = listRes.ok ? await listRes.json() : [];
    const existing = Array.isArray(comments)
      ? comments.find((c) => typeof c?.body === "string" && c.body.includes(COMMENT_MARKER))
      : null;

    const target = existing
      ? `${api}/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`
      : `${api}/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`;
    const method = existing ? "PATCH" : "POST";
    const res = await fetch(target, { method, headers, body: JSON.stringify({ body }) });
    if (!res.ok) {
      core.warning(
        `Couldn't ${existing ? "update" : "post"} PR comment (HTTP ${res.status}). ` +
          `Ensure the job has \`permissions: pull-requests: write\`.`
      );
    } else {
      core.info(`PR comment ${existing ? "updated" : "posted"} on #${ctx.number}.`);
    }
  } catch (err) {
    core.warning(`PR comment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function shouldFail(result: PollResponse, failOn: string): boolean {
  if (failOn === "off" || !result.report) return false;
  const score = result.report.canaryScore;
  // score<NN: fail if score is below the floor.
  const scoreMatch = failOn.match(/^score<(\d+)$/i);
  if (scoreMatch) {
    return score < parseInt(scoreMatch[1], 10);
  }
  // regression: fail if there are critical/high findings on changed routes.
  // For MVP we don't have the base-branch comparison yet, so this is a
  // simple "any critical finding" gate.
  if (failOn === "regression") {
    const hasCritical = result.report.findings.some(
      (f) => (f as { severity: string }).severity === "critical"
    );
    return hasCritical;
  }
  return false;
}

async function run(): Promise<void> {
  try {
    core.info(`🐦 Starting CanaryUsers scan on ${URL_INPUT} …`);

    const scan = await startScan();
    core.info(`Scan queued: ${scan.id}${scan.freeRun ? " (free first-run! 🎁)" : ""}`);
    core.info(`Poll URL: ${scan.pollUrl}`);

    core.setOutput("scan-id", scan.id);
    core.setOutput("report-url", scan.reportUrl);
    core.setOutput("free-run", String(scan.freeRun));

    // Poll until done or timeout.
    const deadline = Date.now() + TIMEOUT_MIN * 60_000;
    let result: PollResponse | null = null;
    while (Date.now() < deadline) {
      await sleep(8_000);
      const poll = await pollScan(scan.id);
      if (poll.status === "done") {
        result = poll;
        break;
      }
      if (poll.status === "error") {
        core.setFailed(`Scan failed: ${poll.error ?? "unknown error"}`);
        return;
      }
      core.info(`  … ${poll.status}`);
    }

    if (!result) {
      core.warning(`Scan timed out after ${TIMEOUT_MIN} minutes. Check ${scan.reportUrl} manually.`);
      return;
    }

    const score = result.report?.canaryScore ?? 0;
    const grade = result.report?.grade ?? "?";
    core.setOutput("score", String(score));
    core.setOutput("grade", grade);

    core.info(`✅ Scan done — CanaryScore ${score} (${grade})`);

    await writeSummary(scan, result);
    await upsertPrComment(scan, result);

    if (shouldFail(result, FAIL_ON)) {
      core.setFailed(
        `CanaryUsers: score ${score} (${grade}) failed the "${FAIL_ON}" gate. See ${scan.reportUrl}`
      );
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
