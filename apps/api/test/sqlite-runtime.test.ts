import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../src/paths.js';

test('addon SQLite suporta coleta de wrappers fechados durante alocações JS', () => {
  const result = spawnSync(process.execPath, ['--eval', `
    const Database = require('better-sqlite3');
    for (let round = 0; round < 10000; round++) {
      const db = new Database(':memory:');
      db.exec('CREATE TABLE teste(id INTEGER); INSERT INTO teste VALUES(1)');
      db.prepare('SELECT * FROM teste').all();
      db.close();
      const allocations = Array.from({length: 100}, () => ({content: 'x'.repeat(200)}));
    }
    console.log('Coleta nativa concluída');
  `], { cwd: projectRoot, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coleta nativa concluída/);
});
