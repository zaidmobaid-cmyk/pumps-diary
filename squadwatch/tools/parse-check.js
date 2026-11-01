'use strict';
// parse-check — parser coverage report for a real SquadGame.log (SPEC §1).
//
//   node tools/parse-check.js <SquadGame.log>
//
// Streams the file through server/parser.js parseLogLine and reports:
// total lines, counts per event type, match percentage, and up to 20 distinct
// unmatched line samples (each truncated to 160 chars).

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const MAX_SAMPLES = 20;
const SAMPLE_LEN = 160;

function usage() {
  console.error('Usage: node tools/parse-check.js <SquadGame.log>');
  process.exit(1);
}

// Key used to deduplicate unmatched samples: the line without its
// [timestamp][frame] prefix, numbers collapsed, first 80 chars.
function sampleKey(line) {
  return line
    .replace(/^\[[^\]]*\]\[[^\]]*\]/, '')
    .replace(/\d+/g, '#')
    .slice(0, 80);
}

async function main() {
  const file = process.argv[2];
  if (!file) usage();
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error('parse-check: no such file: ' + file);
    process.exit(1);
  }

  // Lazy-require the parser at runtime so this tool is inspectable even while
  // server/parser.js is being built.
  let parseLogLine;
  try {
    ({ parseLogLine } = require(path.join(__dirname, '..', 'server', 'parser.js')));
  } catch (e) {
    console.error('parse-check: could not load server/parser.js: ' + e.message);
    process.exit(1);
  }
  if (typeof parseLogLine !== 'function') {
    console.error('parse-check: server/parser.js does not export parseLogLine');
    process.exit(1);
  }

  let total = 0;
  let matched = 0;
  let empty = 0;
  const perEvent = new Map();
  const unmatchedSamples = new Map(); // key -> {line, count}
  let unmatchedTotal = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    total++;
    if (line.trim() === '') {
      empty++;
      continue;
    }
    let ev = null;
    try {
      ev = parseLogLine(line);
    } catch (e) {
      ev = null; // a throwing parser counts as unmatched, keep streaming
    }
    if (ev && ev.event) {
      matched++;
      perEvent.set(ev.event, (perEvent.get(ev.event) || 0) + 1);
    } else {
      unmatchedTotal++;
      const key = sampleKey(line);
      const hit = unmatchedSamples.get(key);
      if (hit) {
        hit.count++;
      } else if (unmatchedSamples.size < MAX_SAMPLES) {
        unmatchedSamples.set(key, { line, count: 1 });
      }
    }
  }

  const considered = total - empty;
  const pct = considered > 0 ? (matched / considered) * 100 : 0;

  console.log('parse-check: ' + file);
  console.log('');
  console.log('  total lines     : ' + total + (empty ? ' (' + empty + ' empty)' : ''));
  console.log('  matched         : ' + matched);
  console.log('  unmatched       : ' + unmatchedTotal);
  console.log('  match percentage: ' + pct.toFixed(2) + '%');
  console.log('');
  console.log('  events:');
  const events = Array.from(perEvent.entries()).sort((a, b) => b[1] - a[1]);
  if (!events.length) console.log('    (none matched)');
  const width = events.reduce((w, e) => Math.max(w, e[0].length), 0);
  for (const [name, count] of events) {
    console.log('    ' + name.padEnd(width) + '  ' + count);
  }
  if (unmatchedSamples.size) {
    console.log('');
    console.log('  unmatched samples (' + unmatchedSamples.size + ' distinct shapes shown, max ' + MAX_SAMPLES + '):');
    for (const { line, count } of unmatchedSamples.values()) {
      const shown = line.length > SAMPLE_LEN ? line.slice(0, SAMPLE_LEN - 1) + '…' : line;
      console.log('    [x' + count + '] ' + shown);
    }
  }
}

main().catch((e) => {
  console.error('parse-check: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
