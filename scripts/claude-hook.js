#!/usr/bin/env node
/**
 * Register analyst-harness's SessionStart hook in your user-level Claude Code settings
 * (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json), so every Claude Code session
 * on this machine starts the harness and learns how to use it.
 *
 *   node scripts/claude-hook.js install     add or update the hook (keeps everything else)
 *   node scripts/claude-hook.js uninstall   remove it again
 *   node scripts/claude-hook.js status      show whether it is registered
 *
 * The settings file is backed up before every change and never rewritten if it is not valid JSON.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'claude-session-start.js');
const MARK = 'claude-session-start.js';

function settingsFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function read(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // fall through
  }
  throw new Error(`${file} is not a JSON object; fix it by hand, then run this again`);
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Hook groups that run this checkout's session script. */
const isOurs = (group) =>
  Array.isArray(group && group.hooks) &&
  group.hooks.some(
    (h) => typeof h.command === 'string' && h.command.includes(MARK) && h.command.includes(ROOT),
  );

function command() {
  // The absolute Node path keeps the hook working when Claude Code starts with a short PATH.
  return `"${process.execPath}" "${SCRIPT}"`;
}

function install() {
  const file = settingsFile();
  const data = read(file);
  const hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart.filter((g) => !isOurs(g)) : [];
  groups.push({ hooks: [{ type: 'command', command: command(), timeout: 600 }] });
  write(file, { ...data, hooks: { ...hooks, SessionStart: groups } });
  return file;
}

function uninstall() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return { file, removed: false };
  const data = read(file);
  const groups = (data.hooks && Array.isArray(data.hooks.SessionStart) && data.hooks.SessionStart) || [];
  const kept = groups.filter((g) => !isOurs(g));
  if (kept.length === groups.length) return { file, removed: false };
  const hooks = { ...data.hooks, SessionStart: kept };
  if (!kept.length) delete hooks.SessionStart;
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  write(file, next);
  return { file, removed: true };
}

function status() {
  const file = settingsFile();
  const data = fs.existsSync(file) ? read(file) : {};
  const groups = (data.hooks && Array.isArray(data.hooks.SessionStart) && data.hooks.SessionStart) || [];
  return { file, installed: groups.some(isOurs) };
}

function main(argv) {
  const cmd = argv[0] || 'status';
  try {
    if (cmd === 'install') {
      const file = install();
      console.log(
        `Every Claude Code session on this machine now starts analyst-harness (hook added to ${file}).`,
      );
    } else if (cmd === 'uninstall') {
      const { file, removed } = uninstall();
      console.log(
        removed ? `Removed the analyst-harness hook from ${file}.` : `No analyst-harness hook in ${file}.`,
      );
    } else if (cmd === 'status') {
      const { file, installed } = status();
      console.log(`${installed ? 'installed' : 'not installed'}: ${file}`);
      return installed ? 0 : 3;
    } else {
      console.error('Usage: node scripts/claude-hook.js install|uninstall|status');
      return 2;
    }
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { install, uninstall, status, settingsFile };
