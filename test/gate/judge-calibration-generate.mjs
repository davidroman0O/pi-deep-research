import { readFile, writeFile } from "node:fs/promises";
const dir = "test/results/judge-calibration";
const topic = "What is the current capital cost per kW of small modular reactors?";
const pairs = JSON.parse(await readFile(dir + "/pairs.json", "utf8"));
const orders = {};
for (const p of pairs) {
  const strong = await readFile(dir + "/pair-" + p.name + "-strong.md", "utf8");
  const degraded = await readFile(dir + "/pair-" + p.name + "-degraded.md", "utf8");
  const swap = Math.random() < 0.5;
  const A = swap ? degraded : strong, B = swap ? strong : degraded;
  orders[p.name] = swap ? { A: "degraded", B: "strong" } : { A: "strong", B: "degraded" };
  const prompt = "You are an expert evaluator scoring two research reports. Score based on EVIDENCE, not eloquence.\n\nTOPIC: \"" + topic + "\"\n\n### REPORT A\n" + A + "\n\n### REPORT B\n" + B + "\n\nScore each report (A and B separately) on each criterion, 1-5. Use the FULL range (5 exceptional, 4 strong, 3 adequate, 2 weak, 1 unacceptable): factual_accuracy, citation_integrity, source_quality, coverage, contradiction_handling, analytical_depth, timeliness, structure_actionability, conciseness.\n\nOutput ONLY a markdown table with columns: | criterion | score_a | score_b | one-line justification |\nThen a final line: composite_a: <number>, composite_b: <number>, preference: <A|B|tie>, confidence: <high|medium|low>";
  await writeFile(dir + "/.cal-" + p.name + ".md", prompt);
}
await writeFile(dir + "/orders.json", JSON.stringify(orders, null, 2));
console.log("PROMPTS:", pairs.map(p => p.name).join(","));
