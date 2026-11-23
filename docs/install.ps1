#requires -version 5.1
<#
  Pi Harness installer for Windows.
  Usage:
    irm https://<owner>.github.io/<repo>/install.ps1 | iex
  or with parameters:
    .\install.ps1 -Repo owner/repo -NoLaunch
#>
[CmdletBinding()]
param(
  [string]$Repo = 'dengarIicdk/pi-harness',
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppName = 'Pi Harness'
$ExeName = 'Pi-Harness-Setup.exe'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Pi Harness'
$AppExe = Join-Path $InstallDir ($AppName + '.exe')

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host ('==> ' + $Text) -ForegroundColor White
}

function Write-Ok([string]$Text) {
  Write-Host ('    ' + $Text) -ForegroundColor Green
}

function Write-Note([string]$Text) {
  Write-Host ('    ' + $Text) -ForegroundColor DarkGray
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $combined = @($machine, $user, $env:Path) -join ';'
  $seen = New-Object System.Collections.Generic.HashSet[string]
  $parts = @()
  foreach ($piece in ($combined -split ';')) {
    $item = $piece.Trim()
    if (-not $item) { continue }
    if ($seen.Add($item.ToLowerInvariant())) { $parts += $item }
  }
  $env:Path = ($parts -join ';')
  $npmDir = Join-Path $env:APPDATA 'npm'
  if ((Test-Path -LiteralPath $npmDir) -and ($env:Path -notlike ('*' + $npmDir + '*'))) {
    $env:Path = $npmDir + ';' + $env:Path
  }
}

function Get-NodeVersion {
  try {
    $raw = (& node --version 2>$null)
    if (-not $raw) { return $null }
    return [version]($raw.ToString().TrimStart('v'))
  } catch {
    return $null
  }
}

function Install-Node {
  Write-Step 'Installing Node.js LTS'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Note 'winget install OpenJS.NodeJS.LTS'
    & winget install --id OpenJS.NodeJS.LTS -e --source winget `
      --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  } else {
    $url = 'https://nodejs.org/dist/latest-v22.x/'
    Write-Note 'winget is unavailable, downloading the Node.js MSI'
    $index = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 60
    $match = [regex]::Match($index.Content, 'node-v([0-9.]+)-x64\.msi')
    if (-not $match.Success) { throw 'Could not find a Node.js MSI to download.' }
    $msi = Join-Path $env:TEMP ('node-' + $match.Groups[1].Value + '-x64.msi')
    Invoke-WebRequest -UseBasicParsing -Uri ($url + $match.Value) -OutFile $msi -TimeoutSec 300
    $proc = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart') -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw ('Node.js MSI failed with exit code ' + $proc.ExitCode) }
  }
  Update-SessionPath
  $version = Get-NodeVersion
  if (-not $version) { throw 'Node.js was installed but is not on PATH yet. Close this window and run the command again.' }
  Write-Ok ('Node.js ' + $version)
}

function Ensure-Node {
  Update-SessionPath
  $version = Get-NodeVersion
  if ($version -and $version.Major -ge 22) {
    Write-Ok ('Node.js ' + $version + ' found')
    return
  }
  if ($version) {
    Write-Note ('Node.js ' + $version + ' is too old for the free-pi agent (22 or newer).')
  }
  Install-Node
}

function Ensure-FreePi {
  Write-Step 'Installing the free-pi runtime'
  Update-SessionPath
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { throw 'npm was not found even after installing Node.js.' }
  Write-Note 'npm install -g free-pi-cli@latest'
  & npm install -g free-pi-cli@latest | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'npm could not install free-pi-cli.' }
  Update-SessionPath
  Write-Ok 'free-pi-cli is installed'
}

function Download-App {
  Write-Step 'Downloading Pi Harness'
  if (-not $Repo -or $Repo -like '*dengarIicdk/pi-harness*') {
    throw 'This script does not know which GitHub repository to download from. Re-run with -Repo owner/repo.'
  }
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  }
  $url = 'https://github.com/' + $Repo + '/releases/latest/download/' + $ExeName
  Write-Note $url
  $temp = Join-Path $env:TEMP ('pi-harness-' + [guid]::NewGuid().ToString('N') + '.exe')
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temp -TimeoutSec 600
  if (-not (Test-Path -LiteralPath $temp)) { throw 'The download did not produce a file.' }
  $size = (Get-Item -LiteralPath $temp).Length
  if ($size -lt 20MB) { throw ('The downloaded file looks wrong (' + $size + ' bytes).') }
  Move-Item -LiteralPath $temp -Destination $AppExe -Force
  Write-Ok ('Saved ' + $AppExe)
}

function New-Shortcut {
  Write-Step 'Creating a desktop shortcut'
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { Write-Note 'No desktop folder, skipping.'; return }
  $link = Join-Path $desktop ($AppName + '.lnk')
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $AppExe
  $shortcut.WorkingDirectory = Split-Path -Parent $AppExe
  $shortcut.IconLocation = $AppExe + ',0'
  $shortcut.Description = 'Pi Harness — desktop client for the free-pi agent'
  $shortcut.Save()
  Write-Ok $link
}

try {
  Write-Host ''
  Write-Host '  Pi Harness installer' -ForegroundColor White
  Write-Host '  --------------------' -ForegroundColor DarkGray

  Ensure-Node
  Ensure-FreePi
  Download-App
  New-Shortcut

  Write-Step 'Done'
  if ($NoLaunch) {
    Write-Ok ('Start it from ' + $AppExe)
  } else {
    Write-Ok 'Starting Pi Harness'
    Start-Process -FilePath $AppExe
    Write-Note 'The first window installs nothing else: sign in with GitHub and start working.'
  }
} catch {
  Write-Host ''
  Write-Host ('Install failed: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'You can also download the app manually from the releases page and run it.' -ForegroundColor DarkGray
  exit 1
}
