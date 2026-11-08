import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));

export function setupTarget(accountId, workerName, origin) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Enter a 32-character Cloudflare account ID.');
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/.test(workerName)) throw new Error('Enter a valid lowercase Worker name.');
  let url;
  try { url = new URL(origin); } catch { throw new Error('Enter the full HTTPS Worker origin.'); }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    throw new Error('Use an HTTPS origin without a path, trailing slash, or credentials.');
  }
  return { accountId, workerName, origin };
}

export function commandEnvironment(env) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY', 'WAYLAND_DISPLAY', 'BROWSER', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries([
    ...allowed.filter(name => typeof env[name] === 'string').map(name => [name, env[name]]),
    ['WRANGLER_WRITE_LOGS', 'false'], ['WRANGLER_SEND_METRICS', 'false'], ['NO_COLOR', '1'],
  ]);
}

export function runCommand(command, args, { input = '', env = commandEnvironment(process.env), cwd = project } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    function collect(stream, chunk) {
      if (output[stream].length + chunk.length > 1024 * 1024) child.kill('SIGKILL');
      else output[stream] += chunk;
    }
    child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start the required local command. Check Node.js and uv are installed.')); });
    child.on('close', code => { clearTimeout(timer); resolveResult({ code, ...output }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function requireSuccess(result, message) {
  if (result.code !== 0) throw new Error(message);
  return result.stdout;
}

export function parseSession(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Local Garmin sign-in did not return a valid session.'); }
  const fields = ['di_token', 'di_refresh_token', 'di_client_id'];
  if (!value || typeof value !== 'object' || fields.some(name => typeof value[name] !== 'string' || !value[name].length)
    || value.di_token.length > 16000 || value.di_refresh_token.length > 16000
    || !/^[A-Za-z0-9_-]{1,200}$/.test(value.di_client_id)) {
    throw new Error('Local Garmin sign-in did not return a valid session.');
  }
  return Object.fromEntries(fields.map(name => [name, value[name]]));
}

async function readState(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) {
      throw new Error('Setup state must be a private regular file (mode 0600).');
    }
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state.ownerCode) || typeof state.encryptionKey !== 'string'
      || Buffer.from(state.encryptionKey, 'base64').length !== 32) throw new Error('Setup state is invalid. Restore its backup before deploying.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('Cannot safely read the saved setup state. Restore its private backup before deploying.');
  }
}

async function configure(target, root) {
  const path = join(root, 'wrangler.local.jsonc');
  const base = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  const config = { ...base, name: target.workerName, account_id: target.accountId,
    vars: { ...base.vars, PUBLIC_ORIGIN: target.origin } };
  try { await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Cannot write the local deployment configuration.');
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (existing.name !== target.workerName || existing.account_id !== target.accountId || existing.vars?.PUBLIC_ORIGIN !== target.origin) {
      throw new Error('The local deployment configuration belongs to a different target. Use a separate checkout.');
    }
  }
  return path;
}

export async function install(target, { root = project,
  stateRoot = join(homedir(), '.config/cloudflare-garmin-mcp'), run = runCommand,
  report = console.log, dryRun = false } = {}) {
  const config = await configure(target, root);
  const cli = (args, input = '') => run(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', config], { input, cwd: root });
  if (dryRun) {
    requireSuccess(await cli(['deploy', '--dry-run']), 'Local deployment validation failed. Run npm run build for diagnostics.');
    report('Local deployment validation passed. No sign-in, secrets, or Cloudflare writes were performed.');
    return;
  }
  let identity = await cli(['whoami', '--json']);
  if (identity.code !== 0) {
    report('Opening Cloudflare sign-in in your browser.');
    requireSuccess(await cli(['login']), 'Cloudflare sign-in failed. Run npx wrangler login, then try setup again.');
    identity = await cli(['whoami', '--json']);
  }
  let member;
  try { member = JSON.parse(requireSuccess(identity, 'Cannot verify the Cloudflare login.')); }
  catch { throw new Error('Cannot verify the Cloudflare login.'); }
  if (member.loggedIn !== true || !Array.isArray(member.accounts) || !member.accounts.some(account => account.id === target.accountId)) {
    throw new Error('The signed-in Cloudflare identity cannot access the selected account.');
  }
  const stateDirectory = join(stateRoot, target.accountId, target.workerName);
  const statePath = join(stateDirectory, 'setup.json');
  let state = await readState(statePath);
  const remote = await cli(['secret', 'list', '--format', 'json']);
  const missingWorker = remote.code !== 0 && remote.stderr.includes(`Worker "${target.workerName}" not found.`);
  if (remote.code !== 0 && !missingWorker) throw new Error('Cannot inspect the target Worker. Check Cloudflare access before trying again.');
  if (!missingWorker && !state) throw new Error('This Worker already exists. Restore its setup backup or choose a new Worker name; its secrets will not be replaced.');
  if (!state) {
    state = { encryptionKey: randomBytes(32).toString('base64'), ownerCode: randomBytes(32).toString('base64url') };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const ownerCodePath = join(stateDirectory, 'owner-access-code.txt');
  try { await writeFile(ownerCodePath, state.ownerCode + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Cannot save the private owner access code.');
    const info = await lstat(ownerCodePath);
    if (!info.isFile() || (info.mode & 0o077) || (await readFile(ownerCodePath, 'utf8')).trim() !== state.ownerCode) {
      throw new Error('The private owner access code file does not match the setup backup. Restore it before deploying.');
    }
  }
  report('Sign in to Garmin in this terminal. Credentials are sent only to Garmin.');
  const login = await run('uv', ['run', '--python', '3.12', '--with', 'garminconnect==0.3.20', 'python', 'scripts/login.py'], { cwd: root });
  const session = parseSession(requireSuccess(login, 'Garmin sign-in failed. No deployment was attempted. Avoid repeated retries if Garmin rate-limits sign-in.'));
  const secrets = {
    GARMIN_SESSION: JSON.stringify(session),
    GARMIN_ENCRYPTION_KEY: state.encryptionKey,
    OWNER_ACCESS_HASH: createHash('sha256').update(state.ownerCode).digest('hex'),
  };
  report('Deploying the Worker, OAuth KV, and encrypted session storage.');
  requireSuccess(await cli(['deploy', '--secrets-file', '/dev/stdin', '--no-upload-source-maps', '--strict'], JSON.stringify(secrets)),
    'Deployment did not complete. Keep the setup backup and rerun setup; the encryption key will be preserved.');
  report(`MCP endpoint: ${target.origin}/mcp`);
  report(`Your private access code is in ${join(stateDirectory, 'owner-access-code.txt')}. Open it privately and save it in your password manager.`);
  report(`Back up ${statePath} privately. It contains the encryption key; losing it can prevent future deployment recovery.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run setup [-- --dry-run]\nPrompts for Cloudflare account ID, Worker name, and HTTPS origin. Signs in locally and deploys secrets privately.\n--dry-run only validates local deployment packaging; it does not sign in or write to Cloudflare.');
    return;
  }
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Unknown option. Use npm run setup -- --help.');
  if (process.platform === 'win32') throw new Error('Run setup in WSL, Linux, or macOS; private stdin upload requires /dev/stdin.');
  if (!process.stdin.isTTY) throw new Error('Run setup in an interactive terminal. Do not pipe credentials into it.');
  process.umask(0o077);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let target;
  try {
    const account = (await prompt.question('Cloudflare account ID (Dashboard > Account home): ')).trim();
    const name = (await prompt.question('Worker name [garmin]: ')).trim() || 'garmin';
    const origin = (await prompt.question(`Full Worker origin (https://${name}.YOUR-SUBDOMAIN.workers.dev): `)).trim();
    target = setupTarget(account, name, origin);
  } finally { prompt.close(); }
  await install(target, { dryRun: args.includes('--dry-run') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Setup failed.'); process.exitCode = 1; });
}
