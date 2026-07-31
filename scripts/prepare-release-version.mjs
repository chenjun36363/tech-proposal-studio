#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const tag = (process.argv[2] ?? process.env.RELEASE_TAG ?? "").trim();
const version = tag.replace(/^v/i, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Release tag must be semantic version such as v0.2.0; received: ${tag || "<empty>"}`);
  process.exit(1);
}

const updaterPublicKey = (process.env.TECH_PROPOSAL_UPDATER_PUBLIC_KEY ?? "").trim();
const updateEndpoint = (process.env.TECH_PROPOSAL_UPDATE_ENDPOINT ?? "").trim();
const config = { version };

// Release builds need the updater public key in Tauri's merged configuration so
// the bundler can create signed updater artifacts and latest.json. Runtime code
// also receives these values through compile-time environment variables.
if (updaterPublicKey) {
  config.plugins = {
    updater: {
      pubkey: updaterPublicKey,
      ...(updateEndpoint ? { endpoints: [updateEndpoint] } : {}),
    },
  };
}

const output = process.argv[3] ?? "src-tauri/tauri.version.generated.conf.json";
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared TechProposal Studio ${version}${updaterPublicKey ? " with updater configuration" : ""}`);
