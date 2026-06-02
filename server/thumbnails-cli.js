#!/usr/bin/env node
const { runThumbnailScan } = require('./thumbnail-service');

const command = process.argv[2] || 'scan';
const valid = new Set(['dry-run', 'scan', 'force', 'clean']);

if (!valid.has(command)) {
  console.error('Usage: node thumbnails-cli.js <dry-run|scan|force|clean>');
  process.exit(1);
}

const options = {
  dryRun: command === 'dry-run',
  force: command === 'force',
  cleanOnly: command === 'clean'
};

runThumbnailScan(options)
  .then(stats => {
    console.log(JSON.stringify(stats, null, 2));
    if (stats.failed > 0) process.exitCode = 1;
  })
  .catch(error => {
    console.error(`[thumbnails] fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
