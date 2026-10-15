<#
.SYNOPSIS
  Builds RocketSim (+ Bullet) and native/wrapper.cpp to WebAssembly with Emscripten.

.DESCRIPTION
  Output: src/sim/wasm/rocketsim.js (ES module, factory `createRocketSim`) + rocketsim.wasm.
  Objects go to native/build/obj (incremental: a source is recompiled when it, one of the headers
  it includes, or the compile flags changed). Compiles in parallel (-Jobs, default = CPU count).

  Usage (from the project root):
    npm run build:wasm                      # same as: powershell -ExecutionPolicy Bypass -File native/build.ps1
    powershell -File native/build.ps1 -Clean            # wipe objects first
    powershell -File native/build.ps1 -NoLto            # faster link, slightly slower wasm
    powershell -File native/build.ps1 -DebugBuild       # -O1 -g, assertions on
    powershell -File native/build.ps1 -EmsdkDir D:/emsdk

  Emscripten is expected in tools/emsdk (installed with `python emsdk.py install latest` +
  `python emsdk.py activate latest`), or wherever $env:EMSDK / -EmsdkDir points.
#>
param(
  [switch]$Clean,
  [int]$Jobs = 0,
  [switch]$NoLto,
  [switch]$DebugBuild,
  [string]$EmsdkDir = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Norm([string]$p) { return ($p -replace '\\', '/') }

$NativeDir = Norm (Split-Path -Parent $PSCommandPath)
$ProjectRoot = Norm (Resolve-Path (Join-Path $NativeDir '..')).Path
# The RocketSim submodule (native/RocketSim) is never patched in place: patch-rocketsim.mjs mirrors it
# into native/build/rocketsim with our patches applied, and the build compiles that copy.
$RsDir = "$NativeDir/build/rocketsim"
$BulletDir = "$RsDir/libsrc/bullet3-3.24"
$ObjDir = "$NativeDir/build/obj"
$OutDir = "$ProjectRoot/src/sim/wasm"
$OutJs = "$OutDir/rocketsim.js"
$OutWasm = "$OutDir/rocketsim.wasm"

# ---- Emscripten environment ----------------------------------------------------------------
if ($EmsdkDir -eq '') {
  if ($env:EMSDK -and (Test-Path "$env:EMSDK/upstream/emscripten/emcc.bat")) { $EmsdkDir = $env:EMSDK }
  else { $EmsdkDir = "$ProjectRoot/tools/emsdk" }
}
$EmsdkDir = Norm $EmsdkDir
$Emcc = "$EmsdkDir/upstream/emscripten/em++.bat"
if (-not (Test-Path $Emcc)) {
  throw "em++ not found at $Emcc. Install it: cd tools/emsdk; python emsdk.py install latest; python emsdk.py activate latest"
}
if (-not (Test-Path "$EmsdkDir/.emscripten")) {
  Write-Host "emsdk not activated, running 'python emsdk.py activate latest'..."
  & python "$EmsdkDir/emsdk.py" activate latest | Out-Host
}
$env:EMSDK = $EmsdkDir
$env:EM_CONFIG = "$EmsdkDir/.emscripten"
$pyDir = Get-ChildItem "$EmsdkDir/python" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pyDir -and (Test-Path "$($pyDir.FullName)/python.exe")) { $env:EMSDK_PYTHON = Norm "$($pyDir.FullName)/python.exe" }
$nodeDir = Get-ChildItem "$EmsdkDir/node" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeDir) {
  if (Test-Path "$($nodeDir.FullName)/bin/node.exe") { $env:EMSDK_NODE = Norm "$($nodeDir.FullName)/bin/node.exe" }
  elseif (Test-Path "$($nodeDir.FullName)/node.exe") { $env:EMSDK_NODE = Norm "$($nodeDir.FullName)/node.exe" }
}
$env:PATH = "$EmsdkDir;$EmsdkDir/upstream/emscripten;" + $env:PATH

$ver = (& $Emcc --version | Select-Object -First 1)
Write-Host "Using $ver"

# ---- Patched RocketSim sources -------------------------------------------------------------
& node "$NativeDir/patch-rocketsim.mjs"
if ($LASTEXITCODE -ne 0) { throw "patch-rocketsim.mjs failed (is the submodule checked out? git submodule update --init)" }

# ---- Sources -------------------------------------------------------------------------------
$sources = @("$NativeDir/wrapper.cpp")
$sources += Get-ChildItem "$RsDir/src" -Recurse -Filter *.cpp | ForEach-Object { Norm $_.FullName }
$sources += Get-ChildItem $BulletDir -Recurse -Filter *.cpp | ForEach-Object { Norm $_.FullName }
Write-Host "$($sources.Count) source files"

if ($Clean -and (Test-Path $ObjDir)) { Remove-Item -Recurse -Force $ObjDir }
New-Item -ItemType Directory -Force $ObjDir | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null

# ---- Flags ---------------------------------------------------------------------------------
$opt = if ($DebugBuild) { @('-O1', '-g') } else { @('-O3') }
$lto = if ($NoLto -or $DebugBuild) { @() } else { @('-flto') }
$compileFlags = @('-std=c++20', '-c', '-msimd128') + $opt + $lto + @(
  '-DRS_DONT_LOG', '-DRS_MAX_SPEED', '-DNDEBUG', '-DBT_NO_PROFILE=1',
  '-fno-strict-aliasing',         # RocketSim type-puns Vec <-> btVector3
  '-Wno-deprecated-declarations', '-Wno-unused-value', '-Wno-switch', '-Wno-reorder-ctor',
  '-Wno-unused-but-set-variable', '-Wno-deprecated-enum-enum-conversion',
  "-I$NativeDir", "-I$RsDir/src"
)

# Exported C functions: every rs_* declared in rs_api.h, plus malloc/free.
$apiText = Get-Content "$NativeDir/rs_api.h" -Raw
$exports = @([regex]::Matches($apiText, '\b(rs_\w+)\s*\(') | ForEach-Object { '_' + $_.Groups[1].Value } | Select-Object -Unique)
$exports += '_malloc', '_free'
$exportedFunctions = ($exports -join ',')

$linkFlags = @('-msimd128') + $opt + $lto + @(
  '--no-entry',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createRocketSim',
  '-sENVIRONMENT=web,worker,node',
  # 16 MB initial (Emscripten's default): measured peak use is ~4 MB (mesh BVH + two arenas + 1 MB
  # stack); growth stays enabled and the bridge re-creates its views when the buffer is replaced.
  '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16MB', '-sSTACK_SIZE=1MB',
  '-sFILESYSTEM=0', '-sDISABLE_EXCEPTION_CATCHING=1',
  '-sINCOMING_MODULE_JS_API=locateFile,instantiateWasm,wasmBinary,print,printErr',
  "-sEXPORTED_FUNCTIONS=$exportedFunctions",
  '-sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAP32,HEAPU8,wasmMemory'
)
if ($DebugBuild) { $linkFlags += '-sASSERTIONS=1' } else { $linkFlags += '-sASSERTIONS=0' }

# Flag changes invalidate every object.
$flagStamp = "$ObjDir/flags.txt"
$flagText = ($compileFlags -join ' ') + "`n" + $ver
if ((Test-Path $flagStamp) -and ((Get-Content $flagStamp -Raw) -ne $flagText)) {
  Write-Host 'Compile flags changed, rebuilding everything'
  Get-ChildItem $ObjDir -Filter *.o | Remove-Item -Force
  Get-ChildItem $ObjDir -Filter *.d | Remove-Item -Force
}
Set-Content -Path $flagStamp -Value $flagText -NoNewline -Encoding ascii

# ---- Incremental check ---------------------------------------------------------------------
function ObjName([string]$src) {
  $rel = $src.Substring($NativeDir.Length + 1)
  return ($rel -replace '[/\\]', '__') -replace '\.cpp$', '.o'
}

function NeedsBuild([string]$src, [string]$obj) {
  if (-not (Test-Path $obj)) { return $true }
  $objTime = (Get-Item $obj).LastWriteTimeUtc
  if ((Get-Item $src).LastWriteTimeUtc -gt $objTime) { return $true }
  $dep = $obj -replace '\.o$', '.d'
  if (-not (Test-Path $dep)) { return $true }
  # .d format: "target.o: dep1 dep2 \<newline> dep3 ..." (no spaces in our paths). The target and
  # the deps contain drive-letter colons, so split at the ".o:" that ends the target.
  $text = (Get-Content $dep -Raw) -replace '\\\r?\n', ' '
  $colon = $text.IndexOf('.o:')
  if ($colon -lt 0) { return $true }
  $deps = $text.Substring($colon + 3) -split '\s+' | Where-Object { $_ -ne '' }
  foreach ($d in $deps) {
    if (-not (Test-Path $d)) { return $true }
    if ((Get-Item $d).LastWriteTimeUtc -gt $objTime) { return $true }
  }
  return $false
}

$work = @()
$objects = @()
foreach ($src in $sources) {
  $obj = "$ObjDir/" + (ObjName $src)
  $objects += $obj
  if (NeedsBuild $src $obj) { $work += , @($src, $obj) }
}
Write-Host "$($work.Count) file(s) to compile, $($objects.Count - $work.Count) up to date"

# ---- Parallel compile ----------------------------------------------------------------------
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$running = @()
$failed = @()
$queue = [System.Collections.Queue]::new()
foreach ($w in $work) { $queue.Enqueue($w) }

function Start-Compile($src, $obj) {
  $dep = $obj -replace '\.o$', '.d'
  $log = $obj -replace '\.o$', '.log'
  $args = $compileFlags + @('-MMD', '-MF', $dep, '-o', $obj, $src)
  # Quote every argument for cmd.exe (emcc.bat).
  $argLine = ($args | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $p = Start-Process -FilePath $Emcc -ArgumentList $argLine -NoNewWindow -PassThru `
    -RedirectStandardOutput "$log.out" -RedirectStandardError $log
  $null = $p.Handle  # cache the handle, otherwise ExitCode is $null once the process has exited
  return @{ Proc = $p; Src = $src; Obj = $obj; Log = $log }
}

while ($queue.Count -gt 0 -or $running.Count -gt 0) {
  while ($queue.Count -gt 0 -and $running.Count -lt $Jobs) {
    $w = $queue.Dequeue()
    $running += Start-Compile $w[0] $w[1]
  }
  Start-Sleep -Milliseconds 120
  $still = @()
  foreach ($r in $running) {
    if ($r.Proc.HasExited) {
      $name = $r.Src.Substring($NativeDir.Length + 1)
      $err = ''
      if (Test-Path $r.Log) { $err = (Get-Content $r.Log -Raw) }
      if (Test-Path "$($r.Log).out") { $err += (Get-Content "$($r.Log).out" -Raw) }
      $code = $r.Proc.ExitCode
      if ($null -eq $code) { $code = 999 }
      if ($code -ne 0) {
        $failed += $r.Src
        Write-Host "FAILED $name" -ForegroundColor Red
        if ($err) { Write-Host $err }
        if (Test-Path $r.Obj) { Remove-Item $r.Obj -Force }
      } else {
        Write-Host ("  [{0,5:N1}s] {1}" -f $sw.Elapsed.TotalSeconds, $name)
        if ($err -and $err.Trim() -ne '') { Write-Host $err -ForegroundColor DarkYellow }
        Remove-Item $r.Log -Force -ErrorAction SilentlyContinue
      }
      Remove-Item "$($r.Log).out" -Force -ErrorAction SilentlyContinue
    } else { $still += $r }
  }
  $running = $still
}
if ($failed.Count -gt 0) {
  throw "$($failed.Count) file(s) failed to compile: $($failed -join ', ')"
}
Write-Host ("Compiled in {0:N1}s" -f $sw.Elapsed.TotalSeconds)

# ---- Link ----------------------------------------------------------------------------------
$needLink = $work.Count -gt 0 -or -not (Test-Path $OutJs) -or -not (Test-Path $OutWasm)
$linkStamp = "$ObjDir/linkflags.txt"
$linkText = ($linkFlags -join ' ')
if (-not (Test-Path $linkStamp) -or ((Get-Content $linkStamp -Raw) -ne $linkText)) { $needLink = $true }
if (-not $needLink) {
  Write-Host 'Link up to date'
} else {
  $sw.Restart()
  Write-Host "Linking $OutJs ..."
  $args = $linkFlags + @('-o', $OutJs) + $objects
  $rsp = "$ObjDir/link.rsp"
  Set-Content -Path $rsp -Value (($args | ForEach-Object { '"' + $_ + '"' }) -join "`n") -Encoding ascii
  & $Emcc "@$rsp"
  if ($LASTEXITCODE -ne 0) { throw "link failed (exit $LASTEXITCODE)" }
  Set-Content -Path $linkStamp -Value $linkText -NoNewline -Encoding ascii
  Write-Host ("Linked in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
}

$wasmSize = (Get-Item $OutWasm).Length
$jsSize = (Get-Item $OutJs).Length
Write-Host ("rocketsim.wasm: {0:N0} bytes ({1:N1} KB)   rocketsim.js: {2:N0} bytes" -f $wasmSize, ($wasmSize / 1KB), $jsSize)
