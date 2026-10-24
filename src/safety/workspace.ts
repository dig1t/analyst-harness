import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { WorkspaceViolationError } from '../util/errors';
import { FileStateTracker } from './file-state';

export interface Mount {
  /** Path prefix that addresses this mount (`knowledge`), or '' for the primary root. */
  alias: string;
  dir: string;
  mode: 'rw' | 'ro';
}

export interface ResolvedPath {
  abs: string;
  display: string;
  mount: Mount;
}

const SENSITIVE_RE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?(\/|\.|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/i,
  /(^|\/)\.ssh\//,
  /credentials/i,
];

/**
 * Workspace guard (paper section 2.4): every path is resolved against a set of mounts and
 * rejected if it escapes them, including through symlinks. The primary mount is the agent's
 * working directory; extra mounts (`knowledge/...`, `skills/...`) expose other folders under
 * a stable alias, read-only or read-write.
 */
export class Workspace {
  readonly fileState = new FileStateTracker();
  private readonly mounts: Mount[];
  private realDirs = new Map<string, string>();

  constructor(mounts: Mount[]) {
    if (!mounts.some((m) => m.alias === ''))
      throw new Error('A workspace needs a primary mount with alias ""');
    this.mounts = mounts.map((m) => ({ ...m, dir: path.resolve(m.dir) }));
    // Longest alias first so `knowledge/wiki` style aliases resolve before shorter ones.
    this.mounts.sort((a, b) => b.alias.length - a.alias.length);
  }

  get root(): string {
    return this.primary.dir;
  }

  get primary(): Mount {
    return this.mounts.find((m) => m.alias === '')!;
  }

  get allMounts(): readonly Mount[] {
    return this.mounts;
  }

  isSensitive(displayPath: string): boolean {
    return SENSITIVE_RE.some((re) => re.test(displayPath));
  }

  private async realDir(mount: Mount): Promise<string> {
    let real = this.realDirs.get(mount.dir);
    if (!real) {
      try {
        real = await fsp.realpath(mount.dir);
      } catch {
        real = mount.dir;
      }
      this.realDirs.set(mount.dir, real);
    }
    return real;
  }

  /** Pick the mount and the absolute path for a user-supplied path, lexically. */
  locate(userPath: string): { mount: Mount; abs: string } {
    const raw = (userPath ?? '').trim();
    if (raw.includes('\0')) throw new WorkspaceViolationError('Path contains a NUL byte.');
    if (path.isAbsolute(raw)) {
      const abs = path.resolve(raw);
      for (const m of this.mounts) if (isInside(m.dir, abs)) return { mount: m, abs };
      throw new WorkspaceViolationError(
        `Path ${raw} is outside the workspace. Use a path relative to the workspace root.`,
      );
    }
    const normalized = raw === '' ? '.' : raw.replace(/\\/g, '/');
    for (const m of this.mounts) {
      if (m.alias !== '' && (normalized === m.alias || normalized.startsWith(m.alias + '/'))) {
        const rest = normalized === m.alias ? '.' : normalized.slice(m.alias.length + 1);
        return { mount: m, abs: path.resolve(m.dir, rest) };
      }
    }
    return { mount: this.primary, abs: path.resolve(this.primary.dir, normalized) };
  }

  async resolve(userPath: string, access: 'read' | 'write'): Promise<ResolvedPath> {
    const { mount, abs } = this.locate(userPath);
    if (!isInside(mount.dir, abs)) {
      throw new WorkspaceViolationError(`Path ${userPath} escapes the workspace root.`);
    }
    // Resolve symlinks on the deepest existing ancestor and require it to stay inside the mount.
    const realRoot = await this.realDir(mount);
    const realTarget = await realpathOfExistingAncestor(abs);
    if (!isInside(realRoot, realTarget.real)) {
      throw new WorkspaceViolationError(`Path ${userPath} resolves outside the workspace through a symlink.`);
    }
    if (access === 'write' && mount.mode === 'ro') {
      throw new WorkspaceViolationError(`Path ${userPath} is in the read-only mount "${mount.alias}".`);
    }
    return { abs, display: this.display(abs, mount), mount };
  }

  display(abs: string, mount?: Mount): string {
    const m = mount ?? this.mounts.find((x) => isInside(x.dir, abs)) ?? this.primary;
    const rel = path.relative(m.dir, abs).split(path.sep).join('/');
    if (m.alias === '') return rel === '' ? '.' : rel;
    return rel === '' ? m.alias : `${m.alias}/${rel}`;
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realpathOfExistingAncestor(abs: string): Promise<{ real: string; exists: boolean }> {
  let current = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return { real: path.join(real, ...suffix.reverse()), exists: suffix.length === 0 };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { real: abs, exists: false };
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}
