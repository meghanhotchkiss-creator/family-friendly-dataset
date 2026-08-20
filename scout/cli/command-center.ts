/** npm run command-center [-- --json] */

import { openDb } from '../db/index.ts';
import { commandCenter, formatCommandCenter } from '../api/command-center.ts';

const db = openDb();
const cc = commandCenter(db);
console.log(process.argv.includes('--json') ? JSON.stringify(cc, null, 2) : formatCommandCenter(cc));
db.close();
