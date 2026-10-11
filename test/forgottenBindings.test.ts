import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test("a forgotten workspace's binding is noted for its own window, and taken once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobrowser-forgotten-'));
  const was = process.env.COBROWSER_STATE_DIR;
  process.env.COBROWSER_STATE_DIR = dir; // never the real ~/.cobrowser
  try {
    const { forgetBinding, takeForgottenBinding } = await import('../src/forgottenBindings');
    forgetBinding('/a'); forgetBinding('/a'); forgetBinding('/b');
    assert.equal(takeForgottenBinding('/c'), false);
    assert.equal(takeForgottenBinding('/a'), true);
    assert.equal(takeForgottenBinding('/a'), false, 'said once');
    assert.equal(takeForgottenBinding('/b'), true);
    assert.equal(fs.existsSync(path.join(dir, 'forgotten-bindings.json')), false, 'nothing left behind');
  } finally {
    if (was === undefined) delete process.env.COBROWSER_STATE_DIR; else process.env.COBROWSER_STATE_DIR = was;
  }
});
