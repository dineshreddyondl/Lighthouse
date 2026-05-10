/**
 * Run the classifier on a labeled eval set and report accuracy.
 *
 * Expected file: data/eval/labeled.json
 * Format:
 *   [
 *     { "text": "Sir order kab milega...", "expected": "update_needed", "groupName": "Acme Ops", "groupType": "operator" },
 *     ...
 *   ]
 *
 * Output: data/eval/results/<timestamp>.json with per-row predictions and a summary.
 */

import fs from 'fs';
import path from 'path';
import { classify } from '../src/ai/classifier';
import { logger } from '../src/utils/logger';
import type { MessageCategory } from '../src/types/domain';

interface LabeledRow {
  text: string;
  expected: MessageCategory;
  groupName?: string;
  groupType?: string;
  senderName?: string;
}

const labeledPath = path.join(__dirname, '..', 'data', 'eval', 'labeled.json');
if (!fs.existsSync(labeledPath)) {
  logger.error(`Missing ${labeledPath}. Create a JSON array of labeled examples.`);
  process.exit(1);
}

const rows: LabeledRow[] = JSON.parse(fs.readFileSync(labeledPath, 'utf-8'));
logger.info(`Loaded ${rows.length} labeled examples`);

interface Result {
  text: string;
  expected: MessageCategory;
  predicted: MessageCategory;
  correct: boolean;
  summary: string;
  reasoning: string;
}

async function run() {
  const results: Result[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const out = await classify({
      text: row.text,
      hasMedia: false,
      groupName: row.groupName ?? 'Test Group',
      groupType: row.groupType ?? 'internal',
      senderName: row.senderName ?? null,
    });
    const correct = out.category === row.expected;
    results.push({
      text: row.text,
      expected: row.expected,
      predicted: out.category,
      correct,
      summary: out.summary,
      reasoning: out.reasoning,
    });
    process.stdout.write(correct ? '.' : 'X');
  }
  process.stdout.write('\n');

  // Overall accuracy
  const correct = results.filter((r) => r.correct).length;
  const acc = ((correct / results.length) * 100).toFixed(1);
  logger.info(`Accuracy: ${correct}/${results.length} = ${acc}%`);

  // Per-category breakdown
  const cats: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    cats[r.expected] ??= { total: 0, correct: 0 };
    cats[r.expected].total++;
    if (r.correct) cats[r.expected].correct++;
  }
  console.log('\nPer-category accuracy:');
  for (const [cat, s] of Object.entries(cats)) {
    const pct = ((s.correct / s.total) * 100).toFixed(1);
    console.log(`  ${cat.padEnd(15)} ${s.correct}/${s.total}  (${pct}%)`);
  }

  // Confusion: where did we miss?
  console.log('\nMisclassifications:');
  for (const r of results.filter((x) => !x.correct)) {
    console.log(`  expected=${r.expected.padEnd(15)} got=${r.predicted.padEnd(15)} | ${r.text.slice(0, 80)}`);
  }

  // Save results
  const outDir = path.join(__dirname, '..', 'data', 'eval', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ accuracy: acc, results }, null, 2));
  logger.info(`Saved detailed results to ${outPath}`);
}

run().catch((err) => {
  logger.error({ err }, 'eval failed');
  process.exit(1);
});
