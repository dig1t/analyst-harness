import { promises as fsp } from 'node:fs';
import { ToolError } from '../util/errors';
import { sha256 } from '../util/hash';

interface FileRecord {
  hash: string;
  fullRead: boolean;
}

/**
 * Session-level file state for the read-before-write gate (paper section 2.4 and Appendix
 * B.1). Editing or overwriting an existing file requires a full read in this session, and a
 * content hash detects modification by anything else since that read.
 */
export class FileStateTracker {
  private readonly files = new Map<string, FileRecord>();
  private readonly changed = new Set<string>();

  recordRead(abs: string, content: string | Buffer, fullRead: boolean): void {
    const prev = this.files.get(abs);
    const hash = sha256(content);
    // A partial read never downgrades an earlier full read of identical content.
    const keepFull = prev?.fullRead === true && prev.hash === hash;
    this.files.set(abs, { hash, fullRead: fullRead || keepFull });
  }

  recordWrite(abs: string, content: string): void {
    this.files.set(abs, { hash: sha256(content), fullRead: true });
    this.changed.add(abs);
  }

  hasFullRead(abs: string): boolean {
    return this.files.get(abs)?.fullRead === true;
  }

  /** Throws a ToolError unless `abs` (which must exist) may be modified now. */
  async assertCanModify(abs: string, display: string): Promise<string> {
    const record = this.files.get(abs);
    if (!record) {
      throw new ToolError(
        `Refusing to modify ${display}: it has not been read in this session. Call read_file on it first (a full read).`,
        'read_before_write',
      );
    }
    if (!record.fullRead) {
      throw new ToolError(
        `Refusing to modify ${display}: only part of it was read. Read the whole file with read_file (offset=1 and a limit that covers every line) first.`,
        'read_before_write',
      );
    }
    const current = await fsp.readFile(abs, 'utf8');
    if (sha256(current) !== record.hash) {
      throw new ToolError(
        `Refusing to modify ${display}: it changed on disk since you read it. Read it again before editing.`,
        'external_modification',
      );
    }
    return current;
  }

  get changedFiles(): string[] {
    return [...this.changed];
  }
}
