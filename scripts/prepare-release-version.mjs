#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const tag = (process.argv[2] ?? process.env.RELEASE_TAG ?? "").trim();
const version = tag.replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Release tag must be semantic version such as v0.2.0; received: ${tag || "<empty>"}`);
  process.exit(1);
}

const output = process.argv[3] ?? "src-tauri/tauri.version.generated.conf.json";
writeFileSync(output, `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`Prepared TechProposal Studio ${version}`);
