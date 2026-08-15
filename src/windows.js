import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function powershellJson(script, timeout = 20_000) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)],
    { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export async function readHardwareSensors() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {
  $items = @(Get-CimInstance -Namespace $ns -ClassName Sensor | Where-Object SensorType -eq 'Temperature')
  foreach ($item in $items) {
    $rows += [pscustomobject]@{ Name=$item.Name; Value=[double]$item.Value; Source=$ns }
  }
  if ($rows.Count -gt 0) { break }
}
if ($rows.Count -eq 0) {
  $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature)
  foreach ($zone in $zones) {
    $value = ([double]$zone.CurrentTemperature / 10) - 273.15
    if ($value -gt 0 -and $value -lt 150) {
      $rows += [pscustomobject]@{ Name=$zone.InstanceName; Value=[math]::Round($value,1); Source='ACPI' }
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
  try {
    return (await powershellJson(script)) || [];
  } catch {
    return [];
  }
}

export async function readImportantWindowsEvents(lookbackMinutes = 5) {
  const safeLookback = Math.max(1, Math.min(60, Number(lookbackMinutes) || 5));
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$start = (Get-Date).AddMinutes(-${safeLookback})
$importantProviders = @('disk','Ntfs','stornvme','storahci','WHEA-Logger','Display','Microsoft-Windows-Kernel-Power','Application Error','Application Hang')
$events = @(Get-WinEvent -FilterHashtable @{ LogName=@('System','Application'); StartTime=$start; Level=@(1,2,3) } -MaxEvents 120 |
  Where-Object { $_.Level -le 2 -or $importantProviders -contains $_.ProviderName } |
  Select-Object -First 60 |
  ForEach-Object {
    $message = [string]$_.Message
    if ($message.Length -gt 1200) { $message = $message.Substring(0,1200) }
    [pscustomobject]@{
      RecordId=$_.RecordId
      LogName=$_.LogName
      TimeCreated=$_.TimeCreated.ToString('o')
      Id=$_.Id
      Level=$_.LevelDisplayName
      Provider=$_.ProviderName
      Message=$message
    }
  })
ConvertTo-Json -InputObject @($events) -Compress -Depth 4
`;
  try {
    return (await powershellJson(script, 30_000)) || [];
  } catch {
    return [];
  }
}

export async function terminateProcess({ pid, expectedName }) {
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid <= 4) throw new Error('Gecersiz PID.');
  const encodedName = Buffer.from(String(expectedName), 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$pidValue = ${safePid}
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))
$blocked = @('System','Registry','smss.exe','csrss.exe','wininit.exe','services.exe','lsass.exe','winlogon.exe','svchost.exe','dwm.exe')
$target = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue"
if (-not $target) { throw 'Proses artik calismiyor.' }
$pattern = [System.Management.Automation.WildcardPattern]::Escape($expected) + '*'
if ($target.Name -notlike $pattern) { throw "PID yeniden kullanilmis olabilir: $($target.Name)" }
if ($blocked -contains $target.Name) { throw 'Korunan Windows prosesi.' }
$before = [pscustomobject]@{ Name=$target.Name; PID=$target.ProcessId; CommandLine=[string]$target.CommandLine; Started=$target.CreationDate }
Stop-Process -Id $pidValue -Force
Start-Sleep -Milliseconds 500
$stillThere = [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
[pscustomobject]@{ Success=(-not $stillThere); Before=$before; StillRunning=$stillThere } | ConvertTo-Json -Compress -Depth 4
`;
  return powershellJson(script, 10_000);
}

export async function readSoftwareInventory() {
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = @(Get-ItemProperty -Path $paths | Where-Object DisplayName | ForEach-Object {
  [pscustomobject]@{
    Name=[string]$_.DisplayName
    Version=[string]$_.DisplayVersion
    Publisher=[string]$_.Publisher
    InstallDate=[string]$_.InstallDate
    EstimatedSizeKB=if($_.EstimatedSize){[double]$_.EstimatedSize}else{0}
    SystemComponent=([int]$_.SystemComponent -eq 1)
    WindowsInstaller=([int]$_.WindowsInstaller -eq 1)
  }
} | Sort-Object Name -Unique)
$startup = @()
$startup += @(Get-CimInstance Win32_StartupCommand | ForEach-Object {
  [pscustomobject]@{ Name=[string]$_.Name; Command=[string]$_.Command; Location=[string]$_.Location; User=[string]$_.User }
})
[pscustomobject]@{ Apps=$apps; Startup=$startup } | ConvertTo-Json -Compress -Depth 5
`;
  return (await powershellJson(script, 35_000)) || { Apps: [], Startup: [] };
}
