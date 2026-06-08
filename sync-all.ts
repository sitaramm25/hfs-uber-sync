// scripts/sync-all.ts

import { execSync } from "node:child_process";

const jobs = [
  {
    name: "Uber Eats",
    command: "npx tsx scripts/uber-sync.ts",
  },
  {
    name: "Rocket Now",
    command: "npx tsx scripts/rocket-sync.ts",
  },
  {
    name: "menu",
    command: "npx tsx scripts/menu-sync.ts",
  },
];

async function run() {
  console.log("=================================");
  console.log("DELIVERY SALES SYNC START");
  console.log("=================================");

  for (const job of jobs) {
    try {
      console.log(`\nStarting ${job.name}...`);

      execSync(job.command, {
        stdio: "inherit",
      });

      console.log(`✅ ${job.name} completed`);
    } catch (error) {
      console.error(`❌ ${job.name} failed`);
      console.error(error);

      // Continue to next platform
    }
  }

  console.log("\n=================================");
  console.log("SYNC FINISHED");
  console.log("=================================");
}

run();