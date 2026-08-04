export interface CheckpointManifest {
  id: string;
  taskId: string;
  timestamp: number;
  files: Record<string, string>; // relative path → base64 content
}

export interface CheckpointDiff {
  filePath: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  before?: string;
  after?: string;
}
