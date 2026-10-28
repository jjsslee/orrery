import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** No chmod-only fallback on Windows: inability to protect data must fail closed. */
async function restrict(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('보안 저장 경로가 일반 파일/폴더가 아닙니다.');
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid?.()) throw new Error('보안 저장 경로의 소유자가 현재 사용자와 다릅니다.');
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  const script = `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${directory ? 'ContainerInherit, ObjectInherit' : 'None'}', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:ORRERY_PRIVATE_PATH -AclObject $acl
  `;
  await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15_000, env: { ...process.env, ORRERY_PRIVATE_PATH: path } });
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await restrict(path, true);
}

export async function readPrivateFile(path: string): Promise<string> {
  await restrict(path, false);
  const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}

export async function protectPrivateFile(path: string): Promise<void> { await restrict(path, false); }

/** Write a new inode, then replace the old file without following a symlink. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
    // Windows files inherit the private parent DACL; Unix files are created with 0600.
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
