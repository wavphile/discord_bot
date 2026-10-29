[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int] $PullRequestNumber
)

$ErrorActionPreference = "Stop"

$gitCandidates = @(
    Get-Command git.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and $_.Source -notmatch "(?i)\\(msys|devkitpro)\\" }
)
if ($gitCandidates.Count -eq 0) {
    throw "Git for Windows was not found. Install Git, then reopen PowerShell."
}
$script:GitExecutable = $gitCandidates[0].Source
$script:RepoRoot = [IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "..")).Path)

function Invoke-Git {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    & $script:GitExecutable -C $script:RepoRoot @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git failed with exit code ${LASTEXITCODE}: git $($Arguments -join ' ')"
    }
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $output = & $script:GitExecutable -C $script:RepoRoot @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git failed with exit code ${LASTEXITCODE}: git $($Arguments -join ' ')"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string] $Text,
        [Parameter(Mandatory = $true)][string] $Name
    )

    $pattern = "(?m)^\s*(?:export\s+)?$([regex]::Escape($Name))\s*=\s*(?<value>[^\r\n]*)"
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) {
        return $null
    }

    $value = $match.Groups["value"].Value.Trim()
    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    return $value
}

function Get-SnowflakeList {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value,
        [Parameter(Mandatory = $true)][string] $Name
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return @()
    }

    $ids = @($Value.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($id in $ids) {
        if ($id -notmatch '^\d{17,20}$') {
            throw "Every entry in $Name must be a Discord user or role ID."
        }
    }
    return $ids
}

$actualRoot = Get-GitValue @("rev-parse", "--show-toplevel")
$actualRoot = [IO.Path]::GetFullPath($actualRoot.Replace('/', [IO.Path]::DirectorySeparatorChar))
if (-not [string]::Equals($actualRoot, $script:RepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The script must be inside the repository checkout."
}

$originUrl = Get-GitValue @("remote", "get-url", "origin")
$expectedOrigin = '^(https://github\.com/wavphile/discord_bot(?:\.git)?/?|git@github\.com:wavphile/discord_bot(?:\.git)?|ssh://git@github\.com/wavphile/discord_bot(?:\.git)?)$'
if ($originUrl -notmatch $expectedOrigin) {
    throw "Expected origin to be wavphile/discord_bot; found a different repository."
}

$workingChanges = Get-GitValue @("status", "--porcelain", "--untracked-files=normal")
if (-not [string]::IsNullOrWhiteSpace($workingChanges)) {
    throw "The checkout has uncommitted or untracked files. Commit or move them before switching PRs. Ignored .env and data files are preserved."
}

$nodeVersionOutput = (& node --version).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Node.js was not found. Install Node.js 24.15 or newer in the 24.x line."
}
$nodeVersionMatch = [regex]::Match($nodeVersionOutput, "^v?(?<major>\d+)\.(?<minor>\d+)")
if (-not $nodeVersionMatch.Success -or [int]$nodeVersionMatch.Groups["major"].Value -ne 24 -or [int]$nodeVersionMatch.Groups["minor"].Value -lt 15) {
    throw "This PR requires Node.js 24.15 or newer in the 24.x line; found $nodeVersionOutput."
}

$envPath = Join-Path $script:RepoRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath (Join-Path $script:RepoRoot ".env.example") -Destination $envPath
    throw "Created .env from .env.example. Fill in your development bot token, application ID, and private test server ID, then rerun this script."
}

$envText = Get-Content -LiteralPath $envPath -Raw
$botToken = Get-DotEnvValue -Text $envText -Name "DISCORD_BOT_TOKEN"
$applicationId = Get-DotEnvValue -Text $envText -Name "DISCORD_APPLICATION_ID"
$testGuildId = Get-DotEnvValue -Text $envText -Name "DISCORD_DEV_GUILD_ID"
$allowedUserValue = Get-DotEnvValue -Text $envText -Name "DISCORD_ALLOWED_USER_IDS"
$allowedRoleValue = Get-DotEnvValue -Text $envText -Name "DISCORD_ALLOWED_ROLE_IDS"
$databasePath = Get-DotEnvValue -Text $envText -Name "DATABASE_PATH"
if ([string]::IsNullOrWhiteSpace($botToken) -or $botToken -like "replace-with-*") {
    throw "Set DISCORD_BOT_TOKEN in .env to your development bot token. The token will not be printed."
}
if ($applicationId -notmatch '^\d{17,20}$') {
    throw "Set DISCORD_APPLICATION_ID in .env to the development application's ID."
}
if ($testGuildId -notmatch '^\d{17,20}$') {
    throw "Set DISCORD_DEV_GUILD_ID in .env to your private test server's ID."
}
if ($null -eq $allowedUserValue) { $allowedUserValue = "" }
if ($null -eq $allowedRoleValue) { $allowedRoleValue = "" }
$allowedUserIds = @(Get-SnowflakeList -Value $allowedUserValue -Name "DISCORD_ALLOWED_USER_IDS")
$allowedRoleIds = @(Get-SnowflakeList -Value $allowedRoleValue -Name "DISCORD_ALLOWED_ROLE_IDS")
if ($allowedUserIds.Count -eq 0 -and $allowedRoleIds.Count -eq 0) {
    throw "Set at least one test user ID or role ID in DISCORD_ALLOWED_USER_IDS or DISCORD_ALLOWED_ROLE_IDS in .env."
}
if ([string]::IsNullOrWhiteSpace($databasePath)) {
    $databasePath = "./data/discord-bot.sqlite"
}

$remoteRef = "refs/remotes/origin/codex-try/$PullRequestNumber"
$localBranch = "try/pr-$PullRequestNumber"
Write-Host "Fetching the current head of PR #$PullRequestNumber..."
Invoke-Git @("fetch", "origin", "+pull/$PullRequestNumber/head:$remoteRef")

$currentBranch = Get-GitValue @("branch", "--show-current")
$existingBranch = Get-GitValue @("branch", "--list", $localBranch)
if ($existingBranch) {
    if ($currentBranch -ne $localBranch) {
        throw "Local branch $localBranch already exists. Switch to it or remove it yourself; the script will not overwrite it."
    }
    Invoke-Git @("merge", "--ff-only", $remoteRef)
} else {
    Invoke-Git @("switch", "--create", $localBranch, $remoteRef)
}

Write-Host "Checked out PR #$PullRequestNumber on local branch $localBranch."
Write-Host "Development application ID: $applicationId"
Write-Host "Private test server ID:     $testGuildId"
Write-Host "Allowed test users:         $($allowedUserIds.Count)"
Write-Host "Allowed test roles:         $($allowedRoleIds.Count)"
Write-Host "Database path:              $databasePath"
Write-Host "Confirm these are your development app, private test server, and test database."

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    throw "npm.cmd was not found. Install Node.js 24.15 or newer, then reopen PowerShell."
}

$environmentNames = @(
    "DISCORD_BOT_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_DEV_GUILD_ID",
    "DISCORD_ALLOWED_USER_IDS",
    "DISCORD_ALLOWED_ROLE_IDS",
    "DATABASE_PATH",
    "NODE_ENV"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

Push-Location $script:RepoRoot
try {
    [Environment]::SetEnvironmentVariable("DISCORD_BOT_TOKEN", $botToken, "Process")
    [Environment]::SetEnvironmentVariable("DISCORD_APPLICATION_ID", $applicationId, "Process")
    [Environment]::SetEnvironmentVariable("DISCORD_DEV_GUILD_ID", $testGuildId, "Process")
    [Environment]::SetEnvironmentVariable("DISCORD_ALLOWED_USER_IDS", ($allowedUserIds -join ","), "Process")
    [Environment]::SetEnvironmentVariable("DISCORD_ALLOWED_ROLE_IDS", ($allowedRoleIds -join ","), "Process")
    [Environment]::SetEnvironmentVariable("DATABASE_PATH", $databasePath, "Process")
    [Environment]::SetEnvironmentVariable("NODE_ENV", "development", "Process")

    Write-Host "Installing the dependencies from package-lock.json..."
    & $npmCommand.Source ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE."
    }

    $confirmation = Read-Host "Type DEPLOY to register guild-scoped commands in the test server above"
    if ($confirmation -cne "DEPLOY") {
        throw "Stopped before command registration. The PR branch remains checked out."
    }

    & $npmCommand.Source run deploy:commands
    if ($LASTEXITCODE -ne 0) {
        throw "Command registration failed with exit code $LASTEXITCODE."
    }

    Write-Host "Starting the bot. Try /health in the private test server; press Ctrl+C to stop."
    & $npmCommand.Source run dev
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 130) {
        throw "The bot process exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
}
