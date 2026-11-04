/** Helpers live next to (outside) the app being replaced, with no shell interpolation of paths. */
export interface InstallJob {
  directory: string;
  target: string;
  next: string;
  token: string;
  version: string;
  pids: number[];
  exitTimeout?: number;
  startupTimeout?: number;
}

export const MAC_HELPER = String.raw`#!/bin/bash
set -u
job=$1; target=$2; next=$3; token=$4; exit_timeout=$5; startup_timeout=$6
shift 6
backup="$job/previous"
exec >> "$job/install.log" 2>&1
result() { printf '%s' "$1" > "$job/result"; }
alive() { kill -0 "$1" 2>/dev/null; }
start_app() {
  (cd "$target" && exec "$target/Contents/MacOS/Orrery" "$@") >> "$job/install.log" 2>&1 &
  child=$!
}
wait_exit() {
  local pid=$1 count=0
  while alive "$pid"; do
    if [ "$count" -ge "$exit_timeout" ]; then return 1; fi
    sleep 1; count=$((count + 1))
  done
}
printf '%s' "$$" > "$job/helper-pid"
printf ready > "$job/helper-ready"
count=0
while [ ! -f "$job/commit" ]; do
  if [ "$count" -ge 30 ]; then result cancelled; exit 1; fi
  sleep 1; count=$((count + 1))
done
for pid in "$@"; do
  if ! wait_exit "$pid"; then result unchanged; exit 1; fi
done
if ! /bin/mv "$target" "$backup"; then
  result unchanged
  start_app
  exit 1
fi
rollback() {
  if [ -e "$target" ]; then
    if ! /bin/mv "$target" "$job/failed-app"; then result failed; exit 1; fi
  fi
  if ! /bin/mv "$backup" "$target"; then result failed; exit 1; fi
  result rolled-back
  start_app
  exit 1
}
if ! /bin/mv "$next" "$target"; then rollback; fi
start_app "--orrery-update=$token"
count=0
while [ "$count" -lt "$startup_timeout" ]; do
  if [ -f "$job/ready" ]; then result success; exit 0; fi
  if ! alive "$child"; then break; fi
  sleep 1; count=$((count + 1))
done
if alive "$child"; then
  kill -TERM "$child" 2>/dev/null || true
  if ! wait_exit "$child"; then
    kill -KILL "$child" 2>/dev/null || true
    if ! wait_exit "$child"; then result failed; exit 1; fi
  fi
fi
wait "$child" 2>/dev/null || true
rollback
`;

/** JSON is base64 data, never executable PowerShell syntax (including quotes, $, backticks and Unicode paths). */
export function windowsHelper(job: InstallJob): string {
  const encoded = Buffer.from(JSON.stringify(job)).toString('base64');
  return `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n` + String.raw`
$ErrorActionPreference = 'Stop'
$job = $config.directory
$target = $config.target
$backup = Join-Path $job 'previous'
$swapped = $false
$restored = $false
$exitTimeout = 60
$startupTimeout = 60
if ($config.exitTimeout) { $exitTimeout = $config.exitTimeout }
if ($config.startupTimeout) { $startupTimeout = $config.startupTimeout }
function Result($value) { [IO.File]::WriteAllText((Join-Path $job 'result'), $value) }
function Move-Retry($source, $destination) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { [IO.Directory]::Move($source, $destination); return } catch {
      if ($attempt -eq 29) { throw }
      Start-Sleep -Seconds 1
    }
  }
}
try {
  [IO.File]::WriteAllText((Join-Path $job 'helper-pid'), [string]$PID)
  [IO.File]::WriteAllText((Join-Path $job 'helper-ready'), 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path -LiteralPath (Join-Path $job 'commit'))) {
    if ([DateTime]::UtcNow -gt $deadline) { Result 'cancelled'; exit 1 }
    Start-Sleep -Milliseconds 200
  }
  foreach ($parentId in $config.pids) {
    $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
    if ($parent -and !$parent.WaitForExit($exitTimeout * 1000)) { throw 'Orrery did not exit' }
  }
  Move-Retry $target $backup
  $swapped = $true
  try {
    Move-Retry $config.next $target
    $child = Start-Process -FilePath (Join-Path $target 'Orrery.exe') -ArgumentList ('--orrery-update=' + $config.token) -WorkingDirectory $target -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds($startupTimeout)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-Path -LiteralPath (Join-Path $job 'ready')) { Result 'success'; exit 0 }
      if ($child.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    throw 'Updated Orrery did not become ready'
  } catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $job 'install.log')
    if ($child -and !$child.HasExited) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null
      if (!$child.WaitForExit($exitTimeout * 1000)) { throw 'Updated Orrery is still running' }
    }
    if (Test-Path -LiteralPath $target) { Move-Retry $target (Join-Path $job 'failed-app') }
    Move-Retry $backup $target
    $restored = $true
    Result 'rolled-back'
    Start-Process -FilePath (Join-Path $target 'Orrery.exe') -WorkingDirectory $target
    exit 1
  }
} catch {
  $_ | Out-String | Add-Content -LiteralPath (Join-Path $job 'install.log')
  if ($restored) { Result 'rolled-back' } elseif (!$swapped) { Result 'unchanged' } else { Result 'failed' }
  if (!(Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath (Join-Path $target 'Orrery.exe'))) {
    try { Start-Process -FilePath (Join-Path $target 'Orrery.exe') -WorkingDirectory $target } catch {}
  }
  exit 1
}
`;
}

export function macHelperArgs(job: InstallJob): string[] {
  return [job.directory, job.target, job.next, job.token, String(job.exitTimeout ?? 60), String(job.startupTimeout ?? 60), ...job.pids.map(String)];
}
