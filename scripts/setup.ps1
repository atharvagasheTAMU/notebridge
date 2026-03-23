#Requires -Version 5.1
<#
.SYNOPSIS
    Cursor Notebook Bridge - Windows setup script.

.DESCRIPTION
    Checks for and installs all prerequisites needed to develop and run the
    Cursor Notebook Bridge project:

        - Git
        - Node.js (v18+)
        - pnpm
        - Python (3.9+)
        - uv  (Python package manager used by the Colab MCP server)

    After verifying prerequisites the script:
        1. Runs pnpm install
        2. Runs pnpm build
        3. Adds Git's cmd directory to the SYSTEM PATH permanently so the
           Cursor extension host process can find git at runtime.

.NOTES
    Run this script once from the repo root in an elevated PowerShell session:

        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
        .\scripts\setup.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Header([string]$text) {
    Write-Host ""
    Write-Host "-----------------------------------------" -ForegroundColor DarkGray
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "-----------------------------------------" -ForegroundColor DarkGray
}

function Write-Ok([string]$text)   { Write-Host "  [OK]  $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "  [!!]  $text" -ForegroundColor Yellow }
function Write-Fail([string]$text) { Write-Host "  [XX]  $text" -ForegroundColor Red }
function Write-Info([string]$text) { Write-Host "  -->   $text" -ForegroundColor Gray }

function Test-Command([string]$cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Get-WingetAvailable {
    return Test-Command "winget"
}

function Install-WithWinget([string]$id, [string]$displayName) {
    Write-Info "Installing $displayName via winget..."
    try {
        winget install -e --id $id --accept-source-agreements --accept-package-agreements
        return $true
    } catch {
        Write-Fail "winget install failed for $displayName. Please install manually."
        return $false
    }
}

function Add-ToSystemPath([string]$dir) {
    if (-not (Test-Path $dir)) { return }

    $currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $entries = $currentPath -split ";"

    if ($entries -contains $dir) {
        Write-Ok "$dir is already in the system PATH"
        return
    }

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        $newPath = ($entries + $dir) -join ";"
        [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "Machine")
        $env:PATH = "$env:PATH;$dir"
        Write-Ok "Added $dir to the SYSTEM PATH (permanent)"
    } else {
        $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        $userEntries = $userPath -split ";"
        if ($userEntries -notcontains $dir) {
            $newUserPath = ($userEntries + $dir) -join ";"
            [System.Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
            $env:PATH = "$env:PATH;$dir"
            Write-Warn "Added $dir to USER PATH. Run as Administrator for a system-wide fix."
        } else {
            Write-Ok "$dir is already in the user PATH"
        }
    }
}

# ---------------------------------------------------------------------------
# Step 1: Check / install Git
# ---------------------------------------------------------------------------

Write-Header "1 / 5  Git"

$gitFound = Test-Command "git"

if ($gitFound) {
    $gitVersion = git --version 2>&1
    Write-Ok "git found: $gitVersion"
} else {
    Write-Warn "git not found in PATH"
    if (Get-WingetAvailable) {
        Install-WithWinget "Git.Git" "Git"
        $env:PATH = "$env:PATH;C:\Program Files\Git\cmd"
        $gitFound = Test-Command "git"
    }
    if (-not $gitFound) {
        Write-Fail "Please install Git from https://git-scm.com/download/win and re-run this script."
        exit 1
    }
}

# Ensure Git's cmd dir is on the SYSTEM PATH (fixes Cursor extension host issue)
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitCmdDir = Split-Path $gitCmd.Source -Parent
    Add-ToSystemPath $gitCmdDir
}

# ---------------------------------------------------------------------------
# Step 2: Check / install Node.js
# ---------------------------------------------------------------------------

Write-Header "2 / 5  Node.js (v18+)"

$nodeFound = Test-Command "node"

if ($nodeFound) {
    $nodeVersion = node --version 2>&1
    $nodeMajor = [int]($nodeVersion -replace 'v(\d+).*', '$1')
    if ($nodeMajor -ge 18) {
        Write-Ok "node found: $nodeVersion"
    } else {
        Write-Warn "node $nodeVersion is too old (need v18+). Installing latest..."
        $nodeFound = $false
    }
}

if (-not $nodeFound) {
    if (Get-WingetAvailable) {
        Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
        $env:PATH = "$env:PATH;C:\Program Files\nodejs"
    }
    if (-not (Test-Command "node")) {
        Write-Fail "Please install Node.js 18+ from https://nodejs.org and re-run this script."
        exit 1
    }
    Write-Ok "node installed: $(node --version)"
}

# ---------------------------------------------------------------------------
# Step 3: Check / install pnpm
# ---------------------------------------------------------------------------

Write-Header "3 / 5  pnpm"

if (Test-Command "pnpm") {
    Write-Ok "pnpm found: $(pnpm --version)"
} else {
    Write-Info "Installing pnpm via npm..."
    npm install -g pnpm
    if (-not (Test-Command "pnpm")) {
        Write-Fail "pnpm install failed. Try: npm install -g pnpm"
        exit 1
    }
    Write-Ok "pnpm installed: $(pnpm --version)"
}

# ---------------------------------------------------------------------------
# Step 4: Check / install Python
# ---------------------------------------------------------------------------

Write-Header "4 / 5  Python (3.9+)"

$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Test-Command $cmd) {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python (\d+)\.(\d+)") {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            if ($major -ge 3 -and $minor -ge 9) {
                $pythonCmd = $cmd
                Write-Ok "Python found: $ver (via '$cmd')"
                break
            }
        }
    }
}

if (-not $pythonCmd) {
    Write-Warn "Python 3.9+ not found"
    if (Get-WingetAvailable) {
        Install-WithWinget "Python.Python.3.12" "Python 3.12"
        $env:PATH = "$env:PATH;$env:LOCALAPPDATA\Programs\Python\Python312;$env:LOCALAPPDATA\Programs\Python\Python312\Scripts"
    }
    if (-not (Test-Command "python")) {
        Write-Fail "Please install Python 3.9+ from https://www.python.org and re-run this script."
        exit 1
    }
    Write-Ok "Python installed: $(python --version)"
    $pythonCmd = "python"
}

# ---------------------------------------------------------------------------
# Step 5: Check / install uv
# ---------------------------------------------------------------------------

Write-Header "5 / 5  uv"

if (Test-Command "uvx") {
    Write-Ok "uv found: $(uv --version 2>&1)"
} else {
    Write-Info "Installing uv via pip..."
    & $pythonCmd -m pip install uv --quiet

    # uv installs to the Python Scripts directory; add it to PATH
    $pythonScripts = & $pythonCmd -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>&1
    if ($pythonScripts -and (Test-Path $pythonScripts)) {
        $env:PATH = "$env:PATH;$pythonScripts"
        Add-ToSystemPath $pythonScripts
    }

    if (-not (Test-Command "uvx")) {
        Write-Fail "uv install failed. Try: pip install uv"
        exit 1
    }
    Write-Ok "uv installed: $(uv --version)"
}

# ---------------------------------------------------------------------------
# Install dependencies and build
# ---------------------------------------------------------------------------

Write-Header "Installing npm dependencies"
Write-Info "Running pnpm install..."
pnpm install

Write-Header "Building all packages"
Write-Info "Running pnpm build..."
pnpm build

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Header "Setup complete"
Write-Ok "git       : $(git --version)"
Write-Ok "node      : $(node --version)"
Write-Ok "pnpm      : $(pnpm --version)"
Write-Ok "python    : $(& $pythonCmd --version)"
Write-Ok "uv        : $(uv --version 2>&1)"
Write-Host ""
Write-Host "  All prerequisites are installed and packages are built." -ForegroundColor Green
Write-Host "  IMPORTANT: Close and reopen Cursor so the updated PATH takes effect," -ForegroundColor Yellow
Write-Host "  then press F5 to launch the Extension Development Host." -ForegroundColor Yellow
Write-Host ""
