// Ambient declarations for deps that ship no TypeScript types.
// (jiti strips these at runtime; they only satisfy tsc.)

declare module "@mozilla/readability" {
	export class Readability {
		constructor(doc: Document);
		parse(): { title?: string; content?: string; textContent?: string; length?: number } | null;
	}
}

declare module "turndown" {
	export default class TurndownService {
		constructor(options?: { headingStyle?: string; codeBlockStyle?: string; bulletListMarker?: string });
		remove(selectors: string | string[]): this;
		turndown(html: string): string;
	}
}

declare module "pi-extensible-workflows" {
	export function registerWorkflowExtension(extension: any): void;
	export const workflowCatalog: any;
	export const beginWorkflowExtensionLoading: any;
	export const resetWorkflowRegistry: any;
}

declare module "pdf-parse" {
	const pdfParse: (buf: Buffer) => Promise<{
		text?: string;
		numpages?: number;
		numrender?: number;
		info?: { Title?: string; Author?: string; Creator?: string; Producer?: string };
		metadata?: unknown;
	}>;
	export default pdfParse;
}
