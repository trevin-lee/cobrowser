/**
 * Imported FIRST by the harness: AppClient reads COBROWSER_STATE_DIR when its module loads, so
 * the scratch dirs must exist in the environment before that import runs. Every suite gets its
 * own scratch tree, and the app it spawns points at the same one — a suite can never reach the
 * user's real app, tabs or vault.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scratch = path.join(os.tmpdir(), 'cobrowser-e2e', `${process.pid}-${Date.now().toString(36)}`);
fs.mkdirSync(scratch, { recursive: true });
process.env.COBROWSER_E2E_SCRATCH = scratch;
process.env.COBROWSER_STATE_DIR = path.join(scratch, 'state');
