#!/usr/bin/env node
import "dotenv/config";
import { createRateBackup } from "../server.mjs";

function usage() {
  return `Usage:
  node scripts/backup-rates.mjs --property berlin-resort --start-date 2027-02-01 --end-date 2027-02-28

Options:
  --property <key>       Cloudbeds property key.
  --start-date <date>    First inclusive night to back up.
  --end-date <date>      Last inclusive night to back up.
  --operator <name>      Operator label for audit history. Defaults to backup-cli.
  --notes <text>         Optional notes stored on the backup.
  --help                 Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    operator: "backup-cli",
    notes: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${arg} requires a value.`);
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--property") {
      options.propertyKey = next();
    } else if (arg === "--start-date") {
      options.startDate = next();
    } else if (arg === "--end-date") {
      options.endDate = next();
    } else if (arg === "--operator") {
      options.operator = next();
    } else if (arg === "--notes") {
      options.notes = next();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.help) {
    for (const key of ["propertyKey", "startDate", "endDate"]) {
      if (!options[key]) throw new Error(`Missing required option: ${key}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const backup = await createRateBackup(options);
  console.log(
    JSON.stringify(
      {
        id: backup.id,
        backupType: backup.backupType,
        propertyKey: backup.propertyKey,
        propertyName: backup.propertyName,
        startDate: backup.startDate,
        endDate: backup.endDate,
        normalizedRowCount: backup.normalizedRows.length,
        baseRowsSnapshotCount: backup.baseRowsSnapshot.length,
        hash: backup.hash,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
