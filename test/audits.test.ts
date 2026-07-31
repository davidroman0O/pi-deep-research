import { expect, test } from "bun:test";
import { extractCitedSentences } from "../src/audits.ts";

test("citation audit scopes each citation to its sentence", () => {
	const report = `## Findings
The modeled overnight cost was $5,233/kW in 2022 [6]. The independently reported range was $4,254–$6,399/kW [7].

## Sources
[6] Model study
[7] Independent study`;

	expect(extractCitedSentences(report)).toEqual([
		{ sentence: "The modeled overnight cost was $5,233/kW in 2022 [6].", raw: "The modeled overnight cost was $5,233/kW in 2022 [6].", citationNum: 6 },
		{ sentence: "The independently reported range was $4,254–$6,399/kW [7].", raw: "The independently reported range was $4,254–$6,399/kW [7].", citationNum: 7 },
	]);
});
