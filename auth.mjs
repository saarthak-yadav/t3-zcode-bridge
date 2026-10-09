import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export function readAccounts(path) {
  if (!existsSync(path)) return {};
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.version !== 1 || !config.accounts) throw new Error('Invalid bridge account configuration');
  return config.accounts;
}
export async function saveAccount(path, family, apiKey) {
  if (!['zai', 'bigmodel'].includes(family) || typeof apiKey !== 'string' || !apiKey.trim() || /[\s\x00-\x1f]/.test(apiKey)) throw new Error('Invalid Coding Plan account');
  const accounts = readAccounts(path);
  accounts[family] = {apiKey};
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({version: 1, accounts})}\n`, {flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function hiddenKey(input, output) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('API-key setup requires an interactive terminal'));
  output.write('Coding Plan API key (hidden): ');
  const previousRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let key = '';
    const finish = (error) => {
      input.off('data', onData); input.off('end', onEnd); input.setRawMode(previousRaw); input.pause(); output.write('\n');
      error ? reject(error) : resolve(key);
    };
    const onEnd = () => finish(new Error('Setup cancelled'));
    const onData = data => {
      for (const char of data.toString('utf8')) {
        if (char === '\x03' || char === '\x04') return finish(new Error('Setup cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\x7f' || char === '\b') key = key.slice(0, -1);
        else if (char >= ' ' && char <= '~' && key.length < 4096) key += char;
      }
    };
    input.on('data', onData); input.once('end', onEnd);
  });
}
export async function setup({path, connected, cliPath, input = process.stdin, output = process.stdout}) {
  if (!existsSync(cliPath)) throw new Error('Install ZCode Desktop first, or configure ZCODE_CLI_PATH and provider resources.');
  if (connected()) { output.write('An existing Coding Plan account is configured. Ready to use ACP.\n'); return; }
  if (!input.isTTY) throw new Error('Run zcode-acp --setup in an interactive terminal');
  output.write('ZCode ACP Coding Plan setup\nUse a Z.ai or BigModel Coding Plan API key. The key is stored locally with owner-only permissions; it is sent to ZCode for model requests.\n');
  const rl = createInterface({input, output});
  let family;
  try {
    const answer = (await rl.question('Provider: 1 = Z.ai, 2 = BigModel [1]: ')).trim();
    if (!['', '1', '2'].includes(answer)) throw new Error('Choose provider 1 or 2');
    family = answer === '2' ? 'bigmodel' : 'zai';
  } finally { rl.close(); }
  const key = await hiddenKey(input, output);
  await saveAccount(path, family, key);
  output.write('Account saved privately. Your first model request verifies the key with the provider.\n');
}
