import { expect, test } from "bun:test";
import { POOLS } from "./pools.ts";

const all = [...POOLS.dev, ...POOLS.shadow, ...POOLS.sealed];

test("pools are disjoint and cover all 20 topics", () => {
	expect(new Set(all).size).toBe(all.length);
	expect(all.length).toBe(20);
});

test("pool sizes are 8/6/6 with finance stratified into every pool", () => {
	expect(POOLS.dev.length).toBe(8);
	expect(POOLS.shadow.length).toBe(6);
	expect(POOLS.sealed.length).toBe(6);
	for (const pool of [POOLS.dev, POOLS.shadow, POOLS.sealed]) {
		expect(pool.some((t) => t.startsWith("finance-"))).toBe(true);
	}
});
