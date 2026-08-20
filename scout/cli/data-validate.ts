/**
 * npm run data:validate [--json]
 *
 * Answers, for the geography spine: did the data actually land, and can the
 * nine test countries resolve? Exits non-zero when it cannot, so a resolver
 * regression fails a build instead of halving a dataset quietly.
 */

import { openDb } from '../db/index.ts';
import { geographyReport, formatGeographyReport } from '../api/data-validate.ts';

const db = openDb();
const report = geographyReport(db);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatGeographyReport(report));
}

process.exit(report.failures.length === 0 ? 0 : 1);
