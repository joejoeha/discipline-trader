[CmdletBinding()]
param(
    [ValidateRange(1, 1440)]
    [int]$DurationMinutes = 60,
    [ValidateRange(1, 300)]
    [int]$SampleSeconds = 10,
    [ValidateRange(0, 120)]
    [int]$WarmupMinutes = 10,
    [ValidateRange(64, 8192)]
    [int]$MaxGrowthMb = 512,
    [ValidateRange(256, 16384)]
    [int]$MaxWorkingSetMb = 2500,
    [string]$ExecutablePath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $ExecutablePath = Join-Path $PSScriptRoot "..\src-tauri\target\release\discipline-trader.exe"
}
$resolvedExecutable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
    throw "Application not found: $resolvedExecutable. Run npm run tauri:build first."
}

$artifactDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\artifacts"))
[System.IO.Directory]::CreateDirectory($artifactDirectory) | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $artifactDirectory "memory-stability-$timestamp.csv"
$summaryPath = Join-Path $artifactDirectory "memory-stability-$timestamp.txt"
$launchedProcess = Start-Process -FilePath $resolvedExecutable -WindowStyle Hidden -PassThru
$rootProcessId = $launchedProcess.Id
$samples = [System.Collections.Generic.List[object]]::new()
$startedAt = Get-Date
$deadline = $startedAt.AddMinutes($DurationMinutes)

function Get-DescendantProcessIds([int]$RootId) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $all) {
            if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {
                $changed = $true
            }
        }
    }
    return @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

try {
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue)) {
            throw "The trading terminal exited during the stability test."
        }
        $tree = @(Get-DescendantProcessIds -RootId $rootProcessId)
        $processes = @($tree | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        $workingSetMb = [Math]::Round((($processes | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 2)
        $privateMb = [Math]::Round((($processes | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB), 2)
        $sample = [pscustomobject]@{
            Timestamp = (Get-Date).ToString("o")
            ElapsedMinutes = [Math]::Round(((Get-Date) - $startedAt).TotalMinutes, 2)
            ProcessCount = $processes.Count
            WorkingSetMb = $workingSetMb
            PrivateMb = $privateMb
        }
        $samples.Add($sample)
        $sample | Export-Csv -LiteralPath $reportPath -NoTypeInformation -Append -Encoding UTF8
        Write-Host ("[{0:N1}/{1} min] working set {2:N0} MB, private {3:N0} MB, processes {4}" -f $sample.ElapsedMinutes, $DurationMinutes, $workingSetMb, $privateMb, $processes.Count)
        Start-Sleep -Seconds $SampleSeconds
    }
}
finally {
    $tree = @(Get-DescendantProcessIds -RootId $rootProcessId | Sort-Object ProcessId -Descending)
    foreach ($item in $tree) {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$measured = @($samples | Where-Object { $_.ElapsedMinutes -ge $WarmupMinutes })
if ($measured.Count -lt 2) {
    throw "Not enough memory samples were collected after warmup."
}
$windowSize = [Math]::Max(1, [Math]::Floor($measured.Count * 0.1))
$baseline = ($measured | Select-Object -First $windowSize | Measure-Object PrivateMb -Average).Average
$ending = ($measured | Select-Object -Last $windowSize | Measure-Object PrivateMb -Average).Average
$growthMb = [Math]::Round($ending - $baseline, 2)
$peakWorkingSetMb = [Math]::Round(($measured | Measure-Object WorkingSetMb -Maximum).Maximum, 2)
$passed = $growthMb -le $MaxGrowthMb -and $peakWorkingSetMb -le $MaxWorkingSetMb
$summary = @(
    "Duration: $DurationMinutes minutes"
    "Warmup: $WarmupMinutes minutes"
    "Samples: $($samples.Count)"
    "Private-memory growth after warmup: $growthMb MB (limit $MaxGrowthMb MB)"
    "Peak working set: $peakWorkingSetMb MB (limit $MaxWorkingSetMb MB)"
    "Sample report: $reportPath"
    "Result: $(if ($passed) { 'PASS' } else { 'FAIL' })"
)
$summary | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ForEach-Object { Write-Host $_ }
if (-not $passed) { exit 1 }
