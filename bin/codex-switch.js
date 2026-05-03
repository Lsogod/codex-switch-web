#!/usr/bin/env node
const { run } = require("./codex-switch-core");

run(process.argv.slice(2))
  .then((result) => {
    if (result.stdout) {
      process.stdout.write(`${result.stdout}\n`);
    }
    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }
    process.exitCode = result.exitCode || 0;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${error.message || error}\n`);
    process.exitCode = error.exitCode || 1;
  });
