# Wipeout: find every process that is holding a folder (or anything inside it).
# Prints one JSON object to stdout.
param(
    [string]$Target,
    [string]$TargetFile   # one folder per line, for checking many folders at once
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$result = [ordered]@{
    ok        = $true
    error     = $null
    elevated  = $false
    scanMs    = 0
    processes = @()
}

function Write-Result {
    ConvertTo-Json -InputObject $result -Depth 6 -Compress
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $result.elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    # Compile the C# handle scanner in memory. (No on-disk cache: a cached DLL in a
    # user-writable folder could be swapped and then loaded by an elevated Wipeout.)
    $source = Join-Path $PSScriptRoot 'WipeoutLocks.cs'
    if (-not ('WipeoutLocks' -as [type])) {
        Add-Type -TypeDefinition (Get-Content -Raw -Path $source)
    }

    $targets = New-Object System.Collections.Generic.List[string]
    if ($Target) { $targets.Add($Target) }
    if ($TargetFile) {
        foreach ($line in [IO.File]::ReadAllLines($TargetFile, [Text.Encoding]::UTF8)) {
            if ($line.Trim()) { $targets.Add($line.Trim()) }
        }
    }
    if ($targets.Count -eq 0) { throw 'No folder given.' }
    $full = @($targets | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
    $canon = @($full | ForEach-Object { [WipeoutLocks]::Canonical($_) })

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $hits = [WipeoutLocks]::FindMany([string[]]$full, 4)

    $found = @{}
    foreach ($h in $hits) {
        $found[[int]$h.Pid] = [ordered]@{
            pid            = [int]$h.Pid
            handleCount    = [int]$h.Count
            holdsFolder    = [bool]$h.HoldsFolder
            runsFromFolder = $false
            moduleCount    = [int]$h.ModuleCount
            samples        = @($h.Samples)
            moduleSamples  = @($h.ModuleSamples)
            targets        = @($h.Targets)
        }
    }

    # Processes whose program file lives inside the folder lock it too,
    # even without an open handle (e.g. an electron.exe inside node_modules).
    $all = @(Get-CimInstance -ClassName Win32_Process)
    $byPid = @{}
    $children = @{}
    foreach ($p in $all) {
        $id = [int]$p.ProcessId
        $byPid[$id] = $p
        $parent = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.Generic.List[int] }
        $children[$parent].Add($id)

        $exe = [string]$p.ExecutablePath
        if (-not $exe) { continue }
        # Either side may use 8.3 short names (C:\Users\RUNNER~1), so compare long forms too.
        $exeForms = @($exe)
        if ($exe.Contains('~')) { $exeForms += [WipeoutLocks]::Canonical($exe) }
        for ($t = 0; $t -lt $full.Count; $t++) {
            $under = $false
            foreach ($e in $exeForms) {
                foreach ($root in @($full[$t], $canon[$t])) {
                    if ($e.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { $under = $true }
                }
            }
            if (-not $under) { continue }
            if (-not $found.ContainsKey($id)) {
                $found[$id] = [ordered]@{
                    pid            = $id
                    handleCount    = 0
                    holdsFolder    = $false
                    runsFromFolder = $true
                    moduleCount    = 0
                    samples        = @($exe)
                    moduleSamples  = @()
                    targets        = @()
                }
            }
            $found[$id].runsFromFolder = $true
            if (@($found[$id].targets) -notcontains $t) { $found[$id].targets = @($found[$id].targets) + $t }
            break
        }
    }

    # Listening ports, so dev servers can be named by their localhost URL.
    $ports = @{}
    try {
        foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
            $owner = [int]$c.OwningProcess
            if (-not $ports.ContainsKey($owner)) { $ports[$owner] = New-Object System.Collections.Generic.List[int] }
            $port = [int]$c.LocalPort
            if (-not $ports[$owner].Contains($port)) { $ports[$owner].Add($port) }
        }
    }
    catch { }

    $out = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $found.Values) {
        $id = $entry.pid
        $p = $byPid[$id]
        if ($null -eq $p) { continue } # exited during the scan

        # Ports owned by this process or anything it started.
        $treePorts = New-Object System.Collections.Generic.List[int]
        $stack = New-Object System.Collections.Generic.Stack[int]
        $stack.Push($id)
        $seen = @{}
        while ($stack.Count -gt 0) {
            $cur = $stack.Pop()
            if ($seen.ContainsKey($cur)) { continue }
            $seen[$cur] = $true
            if ($ports.ContainsKey($cur)) {
                foreach ($port in $ports[$cur]) { if (-not $treePorts.Contains($port)) { $treePorts.Add($port) } }
            }
            if ($children.ContainsKey($cur)) { foreach ($k in $children[$cur]) { $stack.Push($k) } }
        }

        $parentId = [int]$p.ParentProcessId
        $parentName = $null
        if ($byPid.ContainsKey($parentId)) { $parentName = [string]$byPid[$parentId].Name }

        $started = $null
        if ($p.CreationDate) { $started = ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }

        $entry['name'] = [string]$p.Name
        $entry['exe'] = [string]$p.ExecutablePath
        $entry['commandLine'] = [string]$p.CommandLine
        $entry['parentPid'] = $parentId
        $entry['parentName'] = $parentName
        $entry['ports'] = @($treePorts.ToArray())
        $entry['startedAt'] = $started
        $out.Add($entry)
    }

    $result.processes = @($out.ToArray())
    $result.scanMs = [int]$sw.ElapsedMilliseconds
}
catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
}

Write-Result
