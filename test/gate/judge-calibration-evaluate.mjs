import { readFile, writeFile } from "node:fs/promises";
const dir = "test/results/judge-calibration";
const pairs = JSON.parse(await readFile(dir + "/pairs.json", "utf8"));
const orders = JSON.parse(await readFile(dir + "/orders.json", "utf8"));
const targets = { "verbosity-padding": "conciseness", "citation-padding": "citation_integrity", "unit-confusion": "factual_accuracy", "source-degradation": "source_quality" };
const report = [];
for (const p of pairs) {
  const raw = await readFile(dir + "/cal-" + p.name + "-response.md", "utf8");
  const order = orders[p.name];
  const rows = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\|\s*([\w\s]+?)\s*\|\s*(\d)\s*\|\s*(\d)\s*\|/);
    if (m) rows[m[1].trim().replace(/^\d+\.\s*/, "").toLowerCase().replace(/\s*\(.*\)$/, "")] = [Number(m[2]), Number(m[3])];
  }
  const target = targets[p.name];
  const rowKey = Object.keys(rows).find(k => k.startsWith(target.split("_")[0]));
  let result = { name: p.name, target, order, detected: null, strong: null, degraded: null, raw_rows: rows };
  if (rowKey && rows[rowKey]) {
    const [a, b] = rows[rowKey];
    const strongScore = order.A === "strong" ? a : b;
    const degradedScore = order.A === "strong" ? b : a;
    result.strong = strongScore; result.degraded = degradedScore;
    result.detected = target === "unit-confusion" ? degradedScore <= strongScore - 1 : degradedScore <= strongScore;
    result.row_key = rowKey;
  }
  const pref = raw.match(/preference:?\s*\**\s*(A|B|tie)/i);
  const conf = raw.match(/confidence:?\s*\**\s*(high|medium|low)/i);
  result.preference = pref ? pref[1] : null;
  result.confidence = conf ? conf[1] : null;
  result.expected_preference = order.A === "degraded" ? "A" : "B";
  report.push(result);
}
const detected = report.filter(r => r.detected === true).length;
const scored = report.filter(r => r.detected !== null).length;
await writeFile(dir + "/calibration-report.json", JSON.stringify({ generated: new Date().toISOString(), judge: "gpt-5-6-thinking/max", pairs: report, summary: { detected: detected + "/" + scored, verdict: detected >= 3 ? "JUDGE VALIDATED (>=3/4 adversarial discriminations)" : "JUDGE FAILED CALIBRATION" } }, null, 2));
console.log("DETECTED:", detected + "/" + scored);
for (const r of report) console.log(r.name, "| target:", r.target, "| strong:", r.strong, "degraded:", r.degraded, "| detected:", r.detected);
