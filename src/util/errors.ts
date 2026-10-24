/** Base class for errors raised by the harness itself (not by tools or providers). */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly code: string = 'harness_error',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A recoverable tool failure. The agent loop turns it into an error observation so the
 * model can fix its input; it never crashes the loop (paper section 2.4, "Safety").
 */
export class ToolError extends HarnessError {
  constructor(message: string, code = 'tool_error') {
    super(message, code);
  }
}

/** Raised when a path resolves outside every allowed workspace mount. */
export class WorkspaceViolationError extends ToolError {
  constructor(message: string) {
    super(message, 'workspace_violation');
  }
}

/** Raised when the permission layer (or a human approver) denies an action. */
export class PermissionDeniedError extends ToolError {
  constructor(message: string) {
    super(message, 'permission_denied');
  }
}

export class BudgetExceededError extends HarnessError {
  constructor(message: string) {
    super(message, 'budget_exceeded');
  }
}

export class ConfigError extends HarnessError {
  constructor(message: string) {
    super(message, 'config_error');
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
