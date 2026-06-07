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

// Default to www: the apex (canaryusers.ai) 301-redirects to www, and a POST
// following that cross-host redirect drops the Authorization header → 401.
const API_BASE = (core.getInput("canaryusers-url") || "https://www.canaryusers.ai").replace(/\/+$/, "");
const TOKEN = core.getInput("token");
const URL_INPUT = core.getInput("url");
const REPO = core.getInput("repo");
const FAIL_ON = core.getInput("fail-on") || "off";
const TIMEOUT_MIN = parseInt(core.getInput("timeout-minutes") || "5", 10);

interface ScanResponse {
  id: string;
  pollUrl: string;
  reportUrl: string;
  freeRun: boolean;
  repo: string | null;
  status: string;
  error?: string;
}

interface PollResponse {
  id: string;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  report?: {
    canaryScore: number;
    grade: string;
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
