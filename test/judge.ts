// test/judge.ts — blind comparison: DRH vs ours, model-judged.
//
//   bun test/judge.ts "topic" [--skip-drh]
//
// Runs both systems on the same topic, then sends both reports (blind-labeled
// A/B, randomly assigned) to gpt_chat agent mode for scoring on a decomposed
// rubric (per DRH guidance). Outputs a structured verdict.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TOPIC = process.argv[2] ?? "What is the current capital cost per kW of small modular reactors?";
const SKIP_DRH = process.argv.includes("--skip-drh");
const OUT_DIR = "logs/judge";
mkdirSync(OUT_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

console.log(`topic: "${TOPIC.slice(0, 80)}"\n`);

// ── step 1: get DRH report (or skip) ─────────────────────────────────────
let drhReport = "";
if (!SKIP_DRH) {
	console.log("getting DRH report via gpt_chat (agent mode)...");
	// DRH report is obtained via the gpt_chat tool in the interactive session.
	// For now, check if a cached one exists; if not, instruct the user.
	const cached = join(OUT_DIR, "drh-latest.md");
	if (existsSync(cached)) {
		drhReport = readFileSync(cached, "utf8");
		console.log(`  loaded cached DRH report (${drhReport.split(/\s+/).length} words)`);
	} else {
		console.log("  no cached DRH report. Run gpt_chat deep_research_heavy on this topic first,");
		console.log("  save to logs/judge/drh-latest.md, then re-run this script.");
		console.log("  Or use --skip-drh to judge only our report.");
		process.exit(1);
	}
} else {
	console.log("skipping DRH (--skip-drh)");
}

// ── step 2: get our report ───────────────────────────────────────────────
const oursPath = join(OUT_DIR, "ours-latest.md");
if (!existsSync(oursPath)) {
	console.log("no cached ours report at logs/judge/ours-latest.md.");
	console.log("Run our dr_research first, copy report.md there.");
	process.exit(1);
}
const oursReport = readFileSync(oursPath, "utf8");
console.log(`  loaded ours report (${oursReport.split(/\s+/).length} words)`);

// ── step 3: blind-label and send to judge ────────────────────────────────
// Randomly assign A/B to avoid position bias
const oursFirst = Math.random() < 0.5;
const reportA = oursFirst ? oursReport : drhReport;
const reportB = oursFirst ? drhReport : oursReport;
const labelA = oursFirst ? "ours" : "drh";
const labelB = oursFirst ? "drh" : "ours";

if (SKIP_DRH) {
	// single-report evaluation (no comparison)
	console.log("\nsingle-report evaluation (no DRH comparison)...");
} else {
	console.log("\nsending both reports (blind-labeled A/B) to judge...");
}

const judgePrompt = `You are an expert evaluator scoring research reports. ${
	SKIP_DRH ? "Evaluate this single report." : "Two reports on the same topic are provided, labeled A and B. You do not know which system produced which."
}

Topic: "${TOPIC}"

${SKIP_DRH ? "### REPORT\n\n" + oursReport : `### REPORT A\n\n${reportA}\n\n---\n\n### REPORT B\n\n${reportB}`}

Score each ${SKIP_DRH ? "report" : "report (A and B separately)"} on a 0-10 scale for each dimension. Be rigorous — a 7 means genuinely good, a 9 means exceptional.

## Evidence Quality (weight 40%)
- **accuracy**: Are factual claims correct? Are numbers properly represented?
- **citation_integrity**: Do cited sources actually support the adjacent claims?
- **source_quality**: Primary sources? Independent? Good methodology?
- **corroboration**: Are important claims independently supported (≥2 sources)?

## Reasoning Quality (weight 30%)
- **coverage**: Does it answer the actual decision/question fully?
- **contradiction_handling**: Does it surface disagreements rather than averaging?
- **uncertainty_calibration**: Does stated confidence match evidence strength?

## Report Usefulness (weight 30%)
- **structure**: Is the report well-organized?
- **actionability**: Can a decision-maker act on this?
- **writing_clarity**: Is it clear, precise, free of filler?

Output JSON:
{
  ${SKIP_DRH ? `"report": {` : `"A": {` + `"accuracy": N, "citation_integrity": N, "source_quality": N, "corroboration": N, "coverage": N, "contradiction_handling": N, "uncertainty_calibration": N, "structure": N, "actionability": N, "writing_clarity": N, "evidence_score": N, "reasoning_score": N, "usefulness_score": N, "total": N}` + `, "B": { same fields }}`}
}

${SKIP_DRH ? "" : `Then state: "VERDICT: [A or B] is better because [reason]." Do not reveal which is which — just use the labels.`}`;

writeFileSync(join(OUT_DIR, `judge-prompt-${ts}.md`), judgePrompt);
console.log(`judge prompt saved to logs/judge/judge-prompt-${ts}.md`);
console.log(`\nTo run the judge: use gpt_chat agent mode with this prompt file.`);
console.log(`Then check: ${labelA} = A, ${labelB} = B`);

// save the label mapping (secret until verdict is in)
writeFileSync(join(OUT_DIR, `labels-${ts}.json`), JSON.stringify({ labelA, labelB, ts }));
