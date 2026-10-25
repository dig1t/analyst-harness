const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM', 'USER', 'SHELL'];
const SECRET_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/**
 * Build the environment for child processes. Only a small allow-list passes through, so a
 * shell command (or a prompt-injected script) cannot read the bot token or the API key from
 * its environment. Extra keys must be named explicitly and still may not look like secrets
 * unless `allowSecretLooking` is set by the operator.
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
  allowSecretLooking = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...extraKeys]) {
    const value = source[key];
    if (value === undefined) continue;
    if (!allowSecretLooking && extraKeys.includes(key) && SECRET_RE.test(key)) continue;
    out[key] = value;
  }
  out.PYTHONUNBUFFERED = '1';
  out.NO_COLOR = '1';
  return out;
}

export function looksSecret(key: string): boolean {
  return SECRET_RE.test(key);
}
