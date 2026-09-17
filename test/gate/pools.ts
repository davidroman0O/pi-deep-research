// Evaluation pools (DRH review 5): dev iterates freely, shadow validates keeps
// without feeding optimization, sealed is locked until the recalibrated gate
// passes on dev+shadow. Finance is stratified 4/3/3 so no pool is domain-pure.

export const POOLS = {
	dev: [
		"smr-cost.json",
		"vaccine-platforms.json",
		"green-hydrogen-economics.json",
		"semiconductor-export-controls.json",
		"finance-private-credit-risk.json",
		"finance-hyperscaler-ai-capex-financing.json",
		"finance-stablecoin-reserve-run.json",
		"finance-basel3-endgame.json",
	],
	shadow: [
		"battery-storage.json",
		"data-center-power-demand.json",
		"ai-regulation.json",
		"finance-cat-bond-ilS-market.json",
		"finance-cre-debt-maturity-wall.json",
		"finance-pe-exit-drought-nav.json",
	],
	sealed: [
		"desalination-scaleup.json",
		"glp1-supply-and-cost.json",
		"quantum-error-correction.json",
		"finance-treasury-basis-trade.json",
		"finance-us-sovereign-sustainability.json",
		"finance-yen-carry-unwind.json",
	],
} as const;

export type PoolName = keyof typeof POOLS;
