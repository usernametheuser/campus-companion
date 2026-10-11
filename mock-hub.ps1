<#
.SYNOPSIS
  Mock Campus Companion hub - run the web app and sync API on your PC, no ESP32 needed.

.DESCRIPTION
  Serves firmware/CampusCompanion/data/www and implements /api/info and /api/sync with
  the same protocol as the firmware (revisions, tombstones, owner keys, admin PIN, paging).
  Data is kept in tools/mock-db.json. Not implemented: per-field length limits and
  cap trimming (the hub drops the oldest records when a collection is full).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/mock-hub.ps1
  # then open http://localhost:8080
#>
param(
  [int]$Port = 8080,
  [string]$Pin = '4321',
  [switch]$Fresh  # start with a new, seeded database
)
$ErrorActionPreference = 'Stop'

$www    = (Resolve-Path (Join-Path $PSScriptRoot '..\firmware\CampusCompanion\data\www')).Path
$dbFile = Join-Path $PSScriptRoot 'mock-db.json'
$PageSize = 40

# Keep in sync with kSpecs in store.cpp. The first field is required.
$specs = @{
  announcements = @{ admin = $true;  fields = @('title', 'body', 'priority', 'author') }
  events        = @{ admin = $true;  fields = @('title', 'start', 'end', 'location', 'body') }
  timetable     = @{ admin = $true;  fields = @('course', 'day', 'start', 'end', 'room', 'group', 'teacher') }
  lostfound     = @{ admin = $false; fields = @('item', 'kind', 'location', 'contact', 'body', 'resolved') }
  board         = @{ admin = $false; fields = @('body', 'author') }
}

function ConvertTo-Hashtable($obj) {
  $h = [ordered]@{}
  foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  $h
}
function Now { [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Save-Db { $script:db | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $dbFile }

function Invoke-Op($op, [bool]$admin, [int]$now) {
  $col = [string]$op.col
  $spec = $specs[$col]
  if (-not $spec) { return 'unknown collection' }
  if ($spec.admin -and -not $admin) { return 'not allowed (admin PIN or owner required)' }
  $id = [string]$op.id
  if ($id -notmatch '^[A-Za-z0-9_-]{4,40}$') { return 'malformed request' }

  $idx = -1
  for ($i = 0; $i -lt $script:db.items.Count; $i++) {
    if ($script:db.items[$i].col -eq $col -and $script:db.items[$i].id -eq $id) { $idx = $i; break }
  }
  $existing = if ($idx -ge 0) { $script:db.items[$idx] } else { $null }
  $tomb = $existing -and $existing.deleted
  $isDel = $op.op -eq 'del'

  if ($isDel -and (-not $existing -or $tomb)) { return $null }
  if ($existing -and -not $admin -and ($tomb -or -not $existing._k -or $existing._k -ne $op.key)) {
    return 'not allowed (admin PIN or owner required)'
  }
  if ($isDel) {
    $script:db.rev++
    $script:db.items[$idx] = [ordered]@{ col = $col; id = $id; rev = $script:db.rev; deleted = $true }
    return $null
  }

  $data = $op.data
  if (-not $data -or -not ([string]$data.($spec.fields[0])).Trim()) { return 'required field is empty' }

  $script:db.rev++
  $item = [ordered]@{ col = $col; id = $id; rev = $script:db.rev; ts = if ($existing) { $existing.ts } else { $now } }
  if (-not $spec.admin) { $item._k = if ($existing) { $existing._k } else { [string]$op.key } }
  foreach ($f in $spec.fields) {
    $v = $data.$f
    if ($v -is [bool]) { $item[$f] = $v }
    elseif ($null -ne $v -and ([string]$v).Trim()) { $item[$f] = ([string]$v).Trim() }
  }
  if ($idx -ge 0) { $script:db.items[$idx] = $item } else { [void]$script:db.items.Add($item) }
  return $null
}

function Invoke-Sync($in) {
  $admin = [bool]($in.pin) -and $in.pin -eq $Pin
  $results = New-Object System.Collections.ArrayList
  $changed = $false
  foreach ($op in @($in.ops)) {
    if ($null -eq $op) { continue }
    $err = Invoke-Op $op $admin (Now)
    $r = [ordered]@{ id = $op.id; ok = -not $err }
    if ($err) { $r.err = $err } else { $changed = $true }
    [void]$results.Add($r)
  }
  if ($changed) { Save-Db }

  $since = [int]$in.since
  $after = if ($null -ne $in.after) { [int]$in.after } else { $since }
  $out = [ordered]@{ results = @($results) }
  if ($since -gt 0 -and ($in.epoch -ne $script:db.epoch -or $since -gt $script:db.rev)) {
    $out.reset = $true
  } else {
    $all = @($script:db.items | Where-Object { $_.rev -gt $after } | Sort-Object { $_.rev })
    $page = @($all | Select-Object -First $PageSize | ForEach-Object {
      $c = [ordered]@{}; foreach ($k in $_.Keys) { if ($k -ne '_k') { $c[$k] = $_[$k] } }; $c
    })
    $out.items = $page
    $out.more = $all.Count -gt $PageSize
    $out.cursor = if ($out.more) { $page[-1].rev } else { $script:db.rev }
  }
  $out.rev = $script:db.rev
  $out.epoch = $script:db.epoch
  $out.admin = $admin
  $out.time = Now
  $out
}

# ---------------------------------------------------------------- database
if ($Fresh -and (Test-Path $dbFile)) { Remove-Item $dbFile }
if (Test-Path $dbFile) {
  $j = Get-Content -Raw $dbFile | ConvertFrom-Json
  $script:db = [ordered]@{ epoch = $j.epoch; rev = [int]$j.rev; items = New-Object System.Collections.ArrayList }
  foreach ($it in @($j.items)) { if ($it) { [void]$script:db.items.Add((ConvertTo-Hashtable $it)) } }
} else {
  $script:db = [ordered]@{ epoch = '{0:x8}' -f (Get-Random -Maximum ([int]::MaxValue)); rev = 0; items = New-Object System.Collections.ArrayList }
  $seed = @(
    '{"col":"announcements","id":"seed-ann-1","data":{"title":"Welcome to Campus Companion (mock hub)","body":"This is the PC mock hub. Admin PIN is 4321.","priority":"high","author":"Admin"}}',
    '{"col":"events","id":"seed-evt-1","data":{"title":"Tech Fest 2026","start":"2026-11-14T10:00","end":"2026-11-14T17:00","location":"Main Auditorium","body":"Project expo and hackathon."}}',
    '{"col":"timetable","id":"seed-tt-1","data":{"course":"Digital Electronics","day":"Mon","start":"09:00","end":"10:00","room":"B-201","group":"CSE-A","teacher":"Dr. Rao"}}',
    '{"col":"timetable","id":"seed-tt-2","data":{"course":"Microcontrollers Lab","day":"Tue","start":"11:30","end":"13:30","room":"Lab-3","group":"CSE-A","teacher":"Dr. Khan"}}',
    '{"col":"lostfound","id":"seed-lf-1","data":{"item":"Blue water bottle","kind":"found","location":"Canteen","contact":"Front desk"}}',
    '{"col":"board","id":"seed-brd-1","data":{"body":"Study group for the lab exam? Library, Thursday 5 PM.","author":"Asha"}}'
  )
  foreach ($s in $seed) { [void](Invoke-Op ($s | ConvertFrom-Json) $true (Now)) }
  Save-Db
}

# ------------------------------------------------------------------ server
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
            '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon' }

function Send($ctx, [int]$code, [string]$type, [byte[]]$bytes) {
  $res = $ctx.Response
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-cache'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.Close()
}
function SendJson($ctx, $obj, [int]$code = 200) {
  Send $ctx $code 'application/json' ([Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 8 -Compress)))
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Mock hub running at http://localhost:$Port  (admin PIN $Pin, Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.Wait(300)) { }
    $ctx = $task.Result
    $path = $ctx.Request.Url.AbsolutePath
    $method = $ctx.Request.HttpMethod
    try {
      if ($path -eq '/api/info') {
        SendJson $ctx ([ordered]@{ name = 'Mock Hub (PC)'; version = 'mock'; rev = $script:db.rev; epoch = $script:db.epoch
          records = $script:db.items.Count; uptime = [int]([Environment]::TickCount / 1000); heap = 0; psram = 0; stations = 1; time = (Now); staIp = ''; fsUsed = 0 })
      } elseif ($path -eq '/api/sync' -and $method -eq 'POST') {
        $body = (New-Object IO.StreamReader($ctx.Request.InputStream, [Text.Encoding]::UTF8)).ReadToEnd()
        SendJson $ctx (Invoke-Sync ($body | ConvertFrom-Json))
      } elseif ($path.StartsWith('/api/')) {
        SendJson $ctx @{ error = 'not found' } 404
      } else {
        $rel = [Uri]::UnescapeDataString($path.TrimStart('/'))
        if (-not $rel) { $rel = 'index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $www $rel))
        if (-not $file.StartsWith($www) -or -not (Test-Path $file -PathType Leaf)) { $file = Join-Path $www 'index.html' }
        $type = $types[[IO.Path]::GetExtension($file)]
        if (-not $type) { $type = 'application/octet-stream' }
        Send $ctx 200 $type ([IO.File]::ReadAllBytes($file))
      }
      Write-Host ("{0} {1} {2}" -f (Get-Date -Format 'HH:mm:ss'), $method, $path)
    } catch {
      Write-Warning "$method $path failed: $_"
      try { SendJson $ctx @{ error = "$_" } 500 } catch { }
    }
  }
} finally {
  $listener.Stop()
}
