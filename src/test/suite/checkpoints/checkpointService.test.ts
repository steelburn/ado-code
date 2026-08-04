import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointService } from '../../../services/checkpoints/CheckpointService';

suite('CheckpointService', () => {
  let tmpDir: string;
  let service: CheckpointService;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-checkpoint-'));
    service = new CheckpointService(tmpDir);
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('save creates a checkpoint file', () => {
    // Create a test file in workspace
    const filePath = 'src/test.ts';
    const absolutePath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'console.log("hello");');

    const checkpointId = service.save('task-1', [filePath]);

    assert.ok(checkpointId, 'checkpoint ID should be returned');
    assert.ok(checkpointId.length > 0, 'checkpoint ID should not be empty');

    // Verify checkpoint file exists
    const taskDir = path.join(tmpDir, '.ado-code', 'checkpoints', 'task-1');
    assert.ok(fs.existsSync(taskDir), 'task checkpoint directory should exist');

    const manifestPath = path.join(taskDir, `${checkpointId}.json`);
    assert.ok(fs.existsSync(manifestPath), 'manifest file should exist');

    // Verify manifest content
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.taskId, 'task-1');
    assert.strictEqual(manifest.files[filePath], Buffer.from('console.log("hello");').toString('base64'));
  });

  test('listCheckpoints returns saved checkpoints', () => {
    // Create test files
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), 'content1');
    fs.writeFileSync(path.join(tmpDir, 'file2.ts'), 'content2');

    const id1 = service.save('task-1', ['file1.ts']);
    // Ensure unique timestamp+random for second checkpoint
    const start = Date.now(); while (Date.now() === start) { /* spin */ }
    const id2 = service.save('task-1', ['file2.ts']);

    const checkpoints = service.listCheckpoints('task-1');

    assert.strictEqual(checkpoints.length, 2, 'should return 2 checkpoints');

    // Should be sorted by timestamp descending (newest first)
    assert.strictEqual(checkpoints[0].id, id2);
    assert.strictEqual(checkpoints[1].id, id1);

    assert.deepStrictEqual(Object.keys(checkpoints[0].files), ['file2.ts']);
    assert.deepStrictEqual(Object.keys(checkpoints[1].files), ['file1.ts']);
  });

  test('getDiff shows modified files', () => {
    // Create a test file
    const filePath = 'src/app.ts';
    const absolutePath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'original content');

    // Save checkpoint
    const checkpointId = service.save('task-1', [filePath]);

    // Modify the file
    fs.writeFileSync(absolutePath, 'modified content');

    // Get diff
    const diffs = service.getDiff(checkpointId, 'task-1');

    assert.strictEqual(diffs.length, 1, 'should return 1 diff');
    assert.strictEqual(diffs[0].filePath, filePath);
    assert.strictEqual(diffs[0].status, 'modified');
    assert.strictEqual(diffs[0].before, 'original content');
    assert.strictEqual(diffs[0].after, 'modified content');
  });

  test('restore writes files back', () => {
    // Create a test file
    const filePath = 'src/config.ts';
    const absolutePath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'original config');

    // Save checkpoint
    const checkpointId = service.save('task-1', [filePath]);

    // Delete the file (simulate accidental deletion)
    fs.unlinkSync(absolutePath);

    // Restore checkpoint
    const restoredPaths = service.restore(checkpointId, 'task-1');

    assert.deepStrictEqual(restoredPaths, [filePath]);
    assert.ok(fs.existsSync(absolutePath), 'file should be restored');

    const restoredContent = fs.readFileSync(absolutePath, 'utf8');
    assert.strictEqual(restoredContent, 'original config');
  });

  test('deleteCheckpoint removes the manifest', () => {
    // Create a test file
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');

    const checkpointId = service.save('task-1', ['file.txt']);

    // Verify it exists
    let checkpoints = service.listCheckpoints('task-1');
    assert.strictEqual(checkpoints.length, 1);

    // Delete
    service.deleteCheckpoint(checkpointId, 'task-1');

    // Verify it's gone
    checkpoints = service.listCheckpoints('task-1');
    assert.strictEqual(checkpoints.length, 0);
  });

  test('evictOld keeps only maxCount checkpoints', async () => {
    // Create a test file
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'content');

    // Create 55 checkpoints with small delays to ensure unique timestamps
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      ids.push(service.save('task-1', ['file.ts']));
      // Small delay to ensure unique timestamps for sorting
      await new Promise(resolve => setTimeout(resolve, 2));
    }

    const checkpoints = service.listCheckpoints('task-1');
    assert.strictEqual(checkpoints.length, 50, 'should keep only 50 checkpoints');

    // Verify the newest checkpoint is still present
    const checkpointIds = checkpoints.map(c => c.id);
    assert.ok(checkpointIds.includes(ids[54]), 'newest checkpoint should exist');

    // Verify oldest checkpoints are evicted (IDs start with earlier timestamps)
    assert.ok(!checkpointIds.includes(ids[0]), 'oldest checkpoint should be evicted');
    assert.ok(!checkpointIds.includes(ids[4]), '5th oldest checkpoint should be evicted');
  });
});
