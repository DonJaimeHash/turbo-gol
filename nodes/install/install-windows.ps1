# Turbogol community node installer: Windows 10 / 11 home PCs, as a WebRTC host (nothing to open).
#
#   powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm <control>/nodes/releases/install-windows.ps1))) -Control <control> -Token <tgn1_...>"
#        [-Name <name>] [-UplinkMbps <n>] [-RtcPorts <from>-<to>] [-Insecure]
#   ... the same with -Stop [-StopTimeoutMinutes <n>] or -Uninstall instead of -Control / -Token
#
# -Stop asks the node to stop without cutting anyone: it writes stop.request in the node's data
# folder, the launcher sends the node { t: 'stop' } over IPC, the node finishes its running matches
# and exits, and the launcher exits 0 (so the helper and the task end and nothing restarts them).
# It waits up to -StopTimeoutMinutes (30), showing progress, then cuts what is left; 0 = stop now.
# A launcher that does not take the request within 30 s (one older than stop.request) is cut at
# once. The task starts again at the next logon. -Uninstall goes through the same stop first, and
# so does an install over a running node (re-running the installer, which updates the launcher).
# Only the node's own processes count (the helper, its cmd.exe, "launcher.mjs run" and the release
# it runs): an editor showing node.log is neither waited for nor closed.
#
# What it does (and nothing else), for the current Windows user and without admin rights:
#   1. checks the inputs, and that this file carries the release key (scripts/build-node.mjs fills it in)
#   2. Node.js >= 24: the one on PATH, or the LTS from winget (Windows may ask for permission there)
#   3. %LOCALAPPDATA%\TurbogolNode (launcher, helper) and %LOCALAPPDATA%\TurbogolNode\data (node key,
#      releases, state, node.log)
#   4. downloads the launcher and checks its Ed25519 signature with Node against the release key below
#   5. registers the PC with the one-time token (the node key is generated here and never leaves it)
#      as a host over WebRTC: no open ports, no TLS, no Caddy, nothing to forward
#   6. scheduled task "Turbogol Node": at this user's logon, limited rights, no window, no time limit,
#      also on battery, restarted when it fails; started right away
#   7. only when run as admin and -RtcPorts is given: an inbound UDP firewall rule for node.exe on
#      that range (WebRTC works without it, through outbound UDP and TURN)
#
# Written for Windows PowerShell 5.1. The file is pure ASCII on purpose: 5.1 decodes a downloaded
# script as ISO-8859-1 when the server sends no charset, which would mangle accented Spanish. The
# messages spell accents as \u00e1-style escapes and Msg() turns them into characters.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Control,
  [string]$Token,
  [string]$Name,
  [int]$UplinkMbps,
  [string]$RtcPorts,
  [switch]$Insecure,
  [switch]$Stop,
  [int]$StopTimeoutMinutes = 30,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar

# Filled in by scripts/build-node.mjs from the release key (never fetched from the network).
$ReleaseKeyB64 = '__RELEASE_PUBLIC_KEY_B64URL__'
$ReleaseKeyPem = @'
__RELEASE_PUBLIC_KEY_PEM__
'@

$TaskName = 'Turbogol Node'
$FirewallRule = 'Turbogol Node (WebRTC)'
# A launcher takes stop.request within 2 s; one that has not after this long never will.
$StopPickupSeconds = 30
$HasUplink = $PSBoundParameters.ContainsKey('UplinkMbps')
$Control = ("$Control".Trim()).TrimEnd('/')
$Token = "$Token".Trim()
$Name = "$Name".Trim()
$RtcPorts = "$RtcPorts".Trim()
$State = @{ StoppedPrevious = $false }

$AppDir = $null
if ($env:LOCALAPPDATA) { $AppDir = Join-Path $env:LOCALAPPDATA 'TurbogolNode' }
$DataDir = $null; $LogPath = $null; $LauncherPath = $null; $LauncherNew = $null; $LauncherSig = $null
$HelperExe = $null; $HelperNew = $null; $HelperSource = $null; $FallbackScript = $null; $ReleaseKeyFile = $null
if ($AppDir) {
  $DataDir = Join-Path $AppDir 'data'
  $LogPath = Join-Path $DataDir 'node.log'
  $ReleaseKeyFile = Join-Path $DataDir 'release-key.pub'
  $LauncherPath = Join-Path $AppDir 'launcher.mjs'
  $LauncherNew = Join-Path $AppDir 'launcher.mjs.download'
  $LauncherSig = Join-Path $AppDir 'launcher.mjs.sig'
  $HelperExe = Join-Path $AppDir 'TurbogolNodeHost.exe'
  $HelperNew = Join-Path $AppDir 'TurbogolNodeHost.new.exe'
  $HelperSource = Join-Path $AppDir 'TurbogolNodeHost.cs'
  $FallbackScript = Join-Path $AppDir 'run-node.ps1'
}

# ---- messages ----------------------------------------------------------------------------------

# Turns \uXXXX escapes into characters, then fills {0}, {1}... with the values (values are never
# unescaped, so a path that happens to contain "\u" stays as it is).
function Msg([string]$Text, [object[]]$Values) {
  $t = [regex]::Replace($Text, '\\u([0-9a-fA-F]{4})', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) })
  if ($null -ne $Values -and $Values.Count -gt 0) { $t = $t -f $Values }
  return $t
}
function Say([string]$Text, [object[]]$Values) { Write-Host ('==> ' + (Msg $Text $Values)) -ForegroundColor Cyan }
function Note([string]$Text, [object[]]$Values) { Write-Host ('    ' + (Msg $Text $Values)) }
function Warn([string]$Text, [object[]]$Values) { Write-Host ('  ! ' + (Msg $Text $Values)) -ForegroundColor Yellow }
function Fail([string]$Text, [object[]]$Values) {
  $e = New-Object System.Exception (Msg $Text $Values)
  $e.Data['TurbogolInstall'] = $true
  throw $e
}

# 'exit' ends the whole PowerShell process when this runs as a scriptblock. That is right for the
# one-liner (powershell -Command starts a process just for us, and the caller gets exit code 1) and
# for a saved .ps1 (exit leaves only the script). In an interactive window it would close the
# window, so there the error message is all.
function Test-CanExit {
  if ($PSCommandPath) { return $true }
  foreach ($a in @([Environment]::GetCommandLineArgs() | Select-Object -Skip 1)) {
    if ($a -notmatch '^[-/]([A-Za-z]+)$') { continue }
    $n = $Matches[1].ToLowerInvariant()
    if ($n.Length -ge 3 -and 'noexit'.StartsWith($n)) { return $false }
    if ($n -eq 'c' -or $n -eq 'e' -or $n -eq 'ec' -or $n -eq 'f' -or 'file'.StartsWith($n) -or
      ($n.Length -ge 3 -and ('command'.StartsWith($n) -or 'encodedcommand'.StartsWith($n)))) { return $true }
  }
  return $false
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---- inputs ------------------------------------------------------------------------------------

function Assert-Platform {
  if ([Environment]::OSVersion.Version.Major -lt 10) { Fail 'Hace falta Windows 10 u 11.' }
  if (-not $AppDir) { Fail 'No encuentro la carpeta LOCALAPPDATA de tu usuario.' }
  # The helper runs the node through cmd.exe, which would expand % even inside quotes.
  if ($AppDir -match '[%"]') { Fail 'La carpeta {0} tiene un car\u00e1cter que no soporto (% o comillas).' $AppDir }
}

function Assert-ReleaseKey {
  # A 32-byte Ed25519 key in base64url without padding is exactly 43 characters.
  if ($ReleaseKeyB64 -cnotmatch '^[A-Za-z0-9_-]{43}$' -or $ReleaseKeyPem -notmatch '-----BEGIN PUBLIC KEY-----') {
    Fail 'Este instalador no tiene la clave de las releases (se arma con scripts/build-node.mjs --sign). No instalo nada.'
  }
}

function Assert-InstallInputs($Registration) {
  if (-not $Control) { Fail 'Falta -Control <url>: copi\u00e1 el comando completo que te muestra la web.' }
  if ($Control -notmatch '^(https?)://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$') {
    Fail '-Control no parece una URL v\u00e1lida: {0}' $Control
  }
  if ($Matches[1] -ne 'https' -and -not $Insecure) {
    Fail '-Control tiene que empezar con https:// (para pruebas locales con http://, agreg\u00e1 -Insecure).'
  }
  # Already registered: the token is not needed (and not used), but a given one must still look right.
  if (-not $Registration -and -not $Token) { Fail 'Falta -Token: copi\u00e1 el comando completo de la web (el token empieza con tgn1_).' }
  if ($Token -and $Token -cnotmatch '^tgn1_[A-Za-z0-9_-]{20,64}$') {
    Fail 'El token no tiene el formato esperado (tgn1_...). Copi\u00e1 el comando completo de la web.'
  }
  if ($Name -and $Name -notmatch '^[\p{L}\p{N} ._-]{2,32}$') {
    Fail '-Name: entre 2 y 32 caracteres, solo letras, n\u00fameros, espacios, punto, guion y guion bajo.'
  }
  if ($HasUplink -and ($UplinkMbps -lt 1 -or $UplinkMbps -gt 100000)) {
    Fail '-UplinkMbps tiene que ser un n\u00famero de 1 a 100000 (tu subida en megabits por segundo).'
  }
  if ($RtcPorts) {
    $ok = $RtcPorts -match '^(\d{4,5})-(\d{4,5})$'
    if ($ok) { $from = [int]$Matches[1]; $to = [int]$Matches[2]; $ok = ($from -ge 1024 -and $to -le 65535 -and $to -gt $from) }
    if (-not $ok) { Fail '-RtcPorts va como desde-hasta, por ejemplo 50000-50199 (entre 1024 y 65535).' }
  }
  if ($Registration -and $Registration.httpBase -and ("$($Registration.httpBase)".TrimEnd('/') -ne $Control)) {
    Fail 'Esta PC ya est\u00e1 registrada con otro plano de control ({0}). Para cambiarlo, primero desinstal\u00e1 con -Uninstall.' $Registration.httpBase
  }
}

# node.json is written by `register`; when it exists this PC already has a node identity.
function Get-Registration {
  if (-not $DataDir) { return $null }
  $f = Join-Path $DataDir 'node.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try {
    return (Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    Fail 'No puedo leer {0} ({1}). Para empezar de cero, desinstal\u00e1 con -Uninstall.' $f, $_.Exception.Message
  }
}

# ---- Node.js -----------------------------------------------------------------------------------

# The node.exe this user's PATH resolves to. A version manager's shim is fine (it keeps working
# when the user switches versions); the task pins this path, so re-run the installer if it moves.
function Get-NodeExe {
  $c = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $std = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $std) { return $std }
  return $null
}

# @{ Major; Version; ExecPath } of a node.exe, or $null when it does not run.
function Get-NodeInfo([string]$Exe) {
  if (-not $Exe) { return $null }
  $ErrorActionPreference = 'Continue'
  try { $out = @(& $Exe -e 'console.log(process.versions.node);console.log(process.execPath)' 2>$null) } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or $out.Count -lt 2 -or "$($out[0])" -notmatch '^(\d+)\.') { return $null }
  return @{ Major = [int]$Matches[1]; Version = "$($out[0])"; ExecPath = "$($out[1])" }
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ';'
}

# Returns @{ Exe; Major; Version; ExecPath } for a Node.js >= 24, installing the LTS when needed.
function Install-NodeIfNeeded {
  $exe = Get-NodeExe
  $info = Get-NodeInfo $exe
  if ($info -and $info.Major -ge 24) {
    Say 'Node.js {0} ({1})' $info.Version, $exe
    $info.Exe = $exe
    return $info
  }
  if ($info) { Say 'Tu Node.js es el {0} y hace falta el 24 o m\u00e1s nuevo: instalo la versi\u00f3n LTS con winget.' $info.Version }
  else { Say 'No encontr\u00e9 Node.js: instalo la versi\u00f3n LTS con winget.' }
  $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $winget) {
    Fail 'No encuentro winget para instalar Node.js. Instal\u00e1 Node.js 24 LTS o m\u00e1s nuevo desde https://nodejs.org, abr\u00ed una terminal nueva y volv\u00e9 a correr este comando.'
  }
  Note 'Windows te puede pedir permiso para instalarlo: aceptalo.'
  $ErrorActionPreference = 'Continue'
  # --source winget: skips the Microsoft Store source, which fails on some machines and is not needed.
  & $winget.Source install -e --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Update-SessionPath
  $exe = Get-NodeExe
  $info = Get-NodeInfo $exe
  if (-not $info -or $info.Major -lt 24) {
    # An older node.exe earlier on PATH (another install method) can hide the new one.
    $std = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    $stdInfo = Get-NodeInfo $std
    if ($stdInfo -and $stdInfo.Major -ge 24) { $exe = $std; $info = $stdInfo }
  }
  if (-not $info -or $info.Major -lt 24) {
    Fail 'winget no dej\u00f3 instalado Node.js 24 o m\u00e1s nuevo (c\u00f3digo {0}). Instal\u00e1 la versi\u00f3n LTS desde https://nodejs.org, abr\u00ed una terminal nueva y volv\u00e9 a correr este comando.' $code
  }
  Say 'Node.js {0} instalado ({1})' $info.Version, $exe
  $info.Exe = $exe
  return $info
}

# ---- launcher ----------------------------------------------------------------------------------

function Save-Url([string]$Url, [string]$Path) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -TimeoutSec 120
  } catch {
    Fail 'No pude bajar {0}: {1}' $Url, $_.Exception.Message
  }
}

# Ed25519 check of the exact launcher bytes, done by Node itself. It also checks that the PEM and
# the raw key baked into this file are the same key (the launcher only gets the raw one).
# Exit codes: 0 valid, 1 bad signature, 3 key mismatch, 4 could not check.
function Test-LauncherSignature([string]$NodeExe) {
  $js = "try{const c=process.getBuiltinModule('node:crypto'),f=process.getBuiltinModule('node:fs'),e=process.env;" +
    "const k=c.createPublicKey(e.TURBOGOL_VERIFY_PEM);" +
    "if(k.export({format:'der',type:'spki'}).subarray(-32).toString('base64url')!==e.TURBOGOL_VERIFY_RAW)process.exit(3);" +
    "const s=Buffer.from(f.readFileSync(e.TURBOGOL_VERIFY_SIG,'utf8').trim(),'base64url');" +
    "process.exit(c.verify(null,f.readFileSync(e.TURBOGOL_VERIFY_FILE),k,s)?0:1)" +
    "}catch(x){console.error(x.message);process.exit(4)}"
  # Inputs go through the environment: Windows PowerShell 5.1 mangles quotes in native arguments.
  $env:TURBOGOL_VERIFY_PEM = $ReleaseKeyPem
  $env:TURBOGOL_VERIFY_RAW = $ReleaseKeyB64
  $env:TURBOGOL_VERIFY_SIG = $LauncherSig
  $env:TURBOGOL_VERIFY_FILE = $LauncherNew
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $NodeExe -e $js 2>&1)
    $code = $LASTEXITCODE
  } finally {
    foreach ($v in 'TURBOGOL_VERIFY_PEM', 'TURBOGOL_VERIFY_RAW', 'TURBOGOL_VERIFY_SIG', 'TURBOGOL_VERIFY_FILE') {
      Remove-Item -Path "Env:$v" -ErrorAction SilentlyContinue
    }
  }
  if ($code -eq 0) { return }
  Remove-Item -LiteralPath $LauncherNew, $LauncherSig -Force -ErrorAction SilentlyContinue
  if ($code -eq 1) { Fail 'La firma del lanzador NO verifica contra la clave de releases de Turbogol: no instalo nada.' }
  if ($code -eq 3) { Fail 'Las dos copias de la clave de releases de este instalador no coinciden: no instalo nada.' }
  Fail 'No pude verificar la firma del lanzador ({0}): no instalo nada.' ((@($out | ForEach-Object { "$_" }) -join ' ').Trim())
}

# ---- running hidden ----------------------------------------------------------------------------
#
# How the node runs with no window: Task Scheduler starts TurbogolNodeHost.exe, a tiny C# program
# compiled right here with the csc.exe of the .NET Framework 4.x that every Windows 10/11 has (its
# source stays next to it, TurbogolNodeHost.cs). It is a Windows-subsystem program, so no console
# is ever created for it, and it runs the launcher through cmd.exe with CREATE_NO_WINDOW.
# Alternatives considered:
#   - powershell.exe -WindowStyle Hidden: the console window is created first and hidden a moment
#     later, so it flashes at every logon, and when Windows Terminal is the default terminal
#     (Windows 11) the window may not hide at all. Kept only as the fallback when csc.exe is
#     missing or blocked.
#   - VBScript (wscript): Windows is retiring it. conhost.exe --headless: undocumented, and a
#     pattern security tools flag.
#   - "Run whether the user is logged on or not": needs the user's password or admin rights.
# The helper also: appends stdout and stderr to node.log through a plain file handle (Node writes
# files synchronously, so the last lines before an exit are kept); rotates node.log to node.log.1
# when it is over 5 MB each time it starts the launcher; starts the launcher again when it fails
# (10 s, doubling up to 5 min); and puts itself in a kill-on-close job object, so stopping the task
# never leaves an orphan node running.
$HelperCode = @'
// TurbogolNodeHost: windowless supervisor for the Turbogol community node, compiled on this PC by
// install-windows.ps1. Usage: TurbogolNodeHost.exe <log file> <program> [args...]
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class TurbogolNodeHost
{
    const long MaxLogBytes = 5L * 1024 * 1024;
    const uint KillOnJobClose = 0x2000;          // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    const int ExtendedLimitInformationClass = 9; // JobObjectExtendedLimitInformation

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    static int Main(string[] args)
    {
        if (args.Length < 2) return 2;
        string log = Path.GetFullPath(args[0]);
        string dir = Path.GetDirectoryName(log);
        try { Directory.CreateDirectory(dir); } catch (Exception) { }
        bool first;
        using (Mutex single = new Mutex(true, @"Local\TurbogolNodeHost", out first))
        {
            if (!first)
            {
                Note(log, "another TurbogolNodeHost is running in this session; exiting");
                return 0;
            }
            string cmdArgs;
            try { cmdArgs = CmdArguments(args, log); }
            catch (ArgumentException e) { Note(log, e.Message); return 2; }
            JoinKillOnCloseJob();
            int delay = 10;
            for (;;)
            {
                Rotate(log);
                Note(log, "starting the launcher");
                DateTime started = DateTime.UtcNow;
                int code = Run(cmdArgs, dir, log);
                if (code == 0)
                {
                    Note(log, "the launcher stopped (exit code 0)");
                    return 0;
                }
                if (DateTime.UtcNow - started >= TimeSpan.FromMinutes(10)) delay = 10;
                Note(log, "the launcher exited with code " + code + "; starting it again in " + delay + " s");
                Thread.Sleep(TimeSpan.FromSeconds(delay));
                delay = Math.Min(delay * 2, 300);
            }
        }
    }

    // A new job that kills every process in it when its last handle closes. The handle stays open
    // until this process ends (normally, killed by the task's End, or at sign-out); cmd, the
    // launcher and the node inherit the job, so none of them outlives this process. If Windows
    // refuses (an outer job that forbids nesting), it just goes on without it.
    static void JoinKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return;
        ExtendedLimitInformation info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = KillOnJobClose;
        uint size = (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation));
        if (SetInformationJobObject(job, ExtendedLimitInformationClass, ref info, size))
            AssignProcessToJobObject(job, GetCurrentProcess());
    }

    // cmd.exe /s /c ""<program>" "<arg>"... >> "<log>" 2>&1": with /s, cmd drops the first and the
    // last quote and runs what is between, so every piece can be quoted. cmd would expand %VAR% even
    // inside quotes, and a quote would end the quoting, so both characters are refused.
    static string CmdArguments(string[] args, string log)
    {
        StringBuilder sb = new StringBuilder("/d /v:off /s /c \"");
        for (int i = 1; i < args.Length; i++) sb.Append(Quote(args[i])).Append(' ');
        sb.Append(">> ").Append(Quote(log)).Append(" 2>&1\"");
        return sb.ToString();
    }

    static string Quote(string s)
    {
        if (s.IndexOfAny(new char[] { '"', '%', '\r', '\n' }) >= 0)
            throw new ArgumentException("unsupported character (quote, % or line break) in argument: " + s);
        int slashes = 0;
        while (slashes < s.Length && s[s.Length - 1 - slashes] == '\\') slashes++;
        return "\"" + s + new string('\\', slashes) + "\"";
    }

    static int Run(string cmdArgs, string dir, string log)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), cmdArgs);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = dir;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Note(log, "could not start cmd.exe: " + e.Message);
            return -1;
        }
    }

    static void Rotate(string log)
    {
        try
        {
            FileInfo f = new FileInfo(log);
            if (!f.Exists || f.Length <= MaxLogBytes) return;
            string old = log + ".1";
            if (File.Exists(old)) File.Delete(old);
            File.Move(log, old);
        }
        catch (Exception) { }
    }

    static void Note(string log, string message)
    {
        try { File.AppendAllText(log, "[host] " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine); }
        catch (Exception) { }
    }
}
'@

# The fallback supervisor (same loop, started by a hidden powershell.exe). @@LOG@@ and @@ARGS@@ are
# replaced with quoted literals.
$FallbackTemplate = @'
# Turbogol node supervisor, written by install-windows.ps1 because the windowless helper could not
# be built on this PC. The "Turbogol Node" scheduled task starts it with a hidden window.
$ErrorActionPreference = 'Continue'
$log = @@LOG@@
$cmdArgs = @@ARGS@@
$delay = 10
while ($true) {
  try {
    $f = Get-Item -LiteralPath $log -ErrorAction Stop
    if ($f.Length -gt 5MB) {
      Remove-Item -LiteralPath ($log + '.1') -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $log -Destination ($log + '.1') -ErrorAction Stop
    }
  } catch { }
  $started = Get-Date
  $code = -1
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = [IO.Path]::Combine([Environment]::SystemDirectory, 'cmd.exe')
    $psi.Arguments = $cmdArgs
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
    $code = $p.ExitCode
  } catch { }
  if ($code -eq 0) { break }
  if (((Get-Date) - $started).TotalMinutes -ge 10) { $delay = 10 }
  Start-Sleep -Seconds $delay
  $delay = [Math]::Min($delay * 2, 300)
}
'@

# One command-line argument for CreateProcess-style parsing (the helper, node.exe).
function ConvertTo-ArgString([string[]]$Items) {
  $parts = foreach ($a in $Items) {
    if ($a -match '["\r\n]') { Fail 'Un argumento tiene comillas o un salto de l\u00ednea, que no soporto: {0}' $a }
    if ($a -eq '' -or $a -match '\s') { '"' + ($a -replace '(\\+)$', '$1$1') + '"' } else { $a }
  }
  return (@($parts) -join ' ')
}

# The cmd.exe arguments the fallback uses (the same as CmdArguments in the helper).
function ConvertTo-CmdArguments([string[]]$Command, [string]$Log) {
  $parts = foreach ($a in (@($Command) + $Log)) {
    if ($a -match '["%\r\n]') { Fail 'Un argumento tiene un car\u00e1cter que no soporto (comillas, % o salto de l\u00ednea): {0}' $a }
    '"' + ($a -replace '(\\+)$', '$1$1') + '"'
  }
  $parts = @($parts)
  $n = $parts.Count
  return '/d /v:off /s /c "' + (($parts[0..($n - 2)]) -join ' ') + ' >> ' + $parts[$n - 1] + ' 2>&1"'
}

function ConvertTo-PSLiteral([string]$s) { return "'" + ($s -replace "'", "''") + "'" }

# Compiles the helper to TurbogolNodeHost.new.exe. Returns $null when it worked, else the reason.
function New-HostHelper {
  $csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $csc) { return 'no est\u00e1 csc.exe de .NET Framework 4' }
  try {
    [IO.File]::WriteAllText($HelperSource, $HelperCode, (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $HelperNew -Force -ErrorAction SilentlyContinue
  } catch { return $_.Exception.Message }
  $ErrorActionPreference = 'Continue'
  $out = @(& $csc /nologo /target:winexe /optimize+ "/out:$HelperNew" $HelperSource 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $HelperNew)) {
    return ((@($out | ForEach-Object { "$_" }) -join ' ').Trim())
  }
  return $null
}

# ---- processes, files, task --------------------------------------------------------------------

# The processes of this installation, told apart by name and command line: the helper
# (TurbogolNodeHost.exe), the fallback supervisor (powershell.exe running run-node.ps1), the cmd.exe
# and node.exe of the launcher (<app>\launcher.mjs run ...) and the node.exe of the node it runs
# (<data>\releases\<version>\<entry> run ...). Anything else that merely names the folder, such as
# Notepad showing node.log, is not the node: it is neither waited for nor stopped.
function Get-NodeProcessList {
  if (-not $AppDir -or -not $DataDir -or -not $LauncherPath) { return @() }
  $needle = $AppDir.TrimEnd('\') + '\'
  $runArg = '"?\s+"?run(?=["\s]|$)'
  $launcherRe = [regex]::Escape($LauncherPath) + $runArg
  $releaseRe = [regex]::Escape((Join-Path $DataDir 'releases') + '\') + '[^"\\]+\\[^"\\]+' + $runArg
  return @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $cl = [string]$_.CommandLine
      if ($_.ProcessId -eq $PID -or -not $cl -or $cl.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
      switch (([string]$_.Name).ToLowerInvariant()) {
        'turbogolnodehost.exe' { return $true }
        'powershell.exe' { return ($cl.IndexOf($FallbackScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
        'cmd.exe' { return [regex]::IsMatch($cl, $launcherRe, 'IgnoreCase') }
        'node.exe' { return ([regex]::IsMatch($cl, $launcherRe, 'IgnoreCase') -or [regex]::IsMatch($cl, $releaseRe, 'IgnoreCase')) }
      }
      return $false
    })
}

# Stops the processes of this installation (Get-NodeProcessList; the helper first: its job takes
# cmd, the launcher and the node with it), at once: matches still running are cut. Returns how
# many it found.
function Stop-NodeProcesses {
  if (-not $AppDir) { return 0 }
  $seen = @{}
  for ($round = 0; $round -lt 4; $round++) {
    $procs = @(Get-NodeProcessList)
    if ($procs.Count -eq 0) { break }
    foreach ($p in @($procs | Sort-Object { if ($_.Name -eq 'TurbogolNodeHost.exe') { 0 } else { 1 } })) {
      $seen[[string]$p.ProcessId] = $true
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800
  }
  return $seen.Count
}

function Get-NodeTask { return (Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue) }

# Waits up to $Seconds for every process of this installation to exit. Meanwhile it prints the
# launcher's and the node's stop / drain lines from node.log and, every 30 s, the time waited.
# Returns $true when none is left.
function Wait-NodeExit([int]$Seconds, [long]$LogOffset) {
  $started = Get-Date
  $nextNote = 30
  while ($true) {
    if ($LogPath) {
      $text = Read-LogFrom $LogOffset
      if ($text) {
        $LogOffset += [Text.Encoding]::UTF8.GetByteCount($text)
        foreach ($line in ($text -split "`r?`n")) {
          if ($line -match '^\[(launcher|node)\] .*(stop|drain)') { Write-Host ('      ' + $line.Trim()) }
        }
      }
    }
    if (@(Get-NodeProcessList).Count -eq 0) { return $true }
    $elapsed = ((Get-Date) - $started).TotalSeconds
    if ($elapsed -ge $Seconds) { return $false }
    if ($elapsed -ge $nextNote) {
      Note 'Esperando a que terminen las partidas en curso: {0} min {1:00} s (m\u00e1ximo {2} min).' ([int][Math]::Floor($elapsed / 60)), ([int][Math]::Floor($elapsed) % 60), ([int][Math]::Ceiling($Seconds / 60))
      $nextNote += 30
    }
    Start-Sleep -Seconds 2
  }
}

# Waits up to $Seconds for the launcher to take <data>\stop.request (it deletes the file and logs
# "stop requested (stop.request)"; it looks every 2 s). $true when it did, or when no process of
# the node is left; $false means nothing is listening (a launcher older than the file, or a hung
# one): waiting for it to drain would only waste the whole timeout.
function Wait-StopPickedUp([string]$StopFile, [int]$Seconds, [long]$LogOffset) {
  $started = Get-Date
  while ($true) {
    if (-not (Test-Path -LiteralPath $StopFile)) { return $true }
    if ($LogPath -and ((Read-LogFrom $LogOffset) -match '\[launcher\] stop (now )?requested \(stop\.request\)')) { return $true }
    if (@(Get-NodeProcessList).Count -eq 0) { return $true }
    if (((Get-Date) - $started).TotalSeconds -ge $Seconds) { return $false }
    Start-Sleep -Milliseconds 500
  }
}

# Stops a running node without cutting its matches. Windows has no SIGTERM for a process with no
# console (Stop-Process and the task's End are TerminateProcess), so the launcher watches
# <data>\stop.request: it deletes the file and asks the node over IPC to drain (no new matches,
# exit when the running ones end), then exits 0, and the helper and the task end with it. After
# -StopTimeoutMinutes it asks for a stop now ('now' in the file: the node closes its matches
# itself) and gives it 20 s more; what still runs after that is for Stop-NodeProcesses, and so is
# a launcher that does not take the request within $StopPickupSeconds. $ForUpdate: the installer
# stops the node to replace it (other messages). Returns how many processes of the node were running.
function Stop-NodeGracefully([bool]$ForUpdate) {
  $procs = @(Get-NodeProcessList)
  if ($procs.Count -eq 0 -or -not $DataDir -or -not (Test-Path -LiteralPath $DataDir)) { return $procs.Count }
  $stopFile = Join-Path $DataDir 'stop.request'
  $offset = 0
  if ($LogPath -and (Test-Path -LiteralPath $LogPath)) { $offset = (Get-Item -LiteralPath $LogPath).Length }
  $now = ($StopTimeoutMinutes -le 0)
  try {
    if ($now) { Write-TextFile $stopFile 'now' $false } else { Write-TextFile $stopFile 'stop' $false }
  } catch {
    Warn 'No pude pedirle al nodo que se detenga ({0}): lo detengo de golpe.' $_.Exception.Message
    return $procs.Count
  }
  try {
    if ($now) {
      Say 'Deteniendo el nodo ya (-StopTimeoutMinutes 0): se cortan las partidas en curso.'
    } elseif ($ForUpdate) {
      Say 'El nodo est\u00e1 corriendo: antes de actualizarlo le ped\u00ed que se detenga. No toma partidas nuevas y se cierra cuando terminan las que est\u00e1n en curso, as\u00ed no se corta a nadie.'
      Note 'Espero hasta {0} minutos (con -StopTimeoutMinutes 0 no espera y corta las partidas). Si cerr\u00e1s esta ventana, el nodo igual se detiene cuando termina, sin actualizarse, y vuelve a arrancar al iniciar sesi\u00f3n.' $StopTimeoutMinutes
    } else {
      Say 'Le ped\u00ed al nodo que se detenga: no toma partidas nuevas y se cierra cuando terminan las que est\u00e1n en curso, as\u00ed no se corta a nadie.'
      Note 'Espero hasta {0} minutos. Si cerr\u00e1s esta ventana, el nodo igual se detiene solo cuando termina.' $StopTimeoutMinutes
    }
    if (-not (Wait-StopPickedUp $stopFile $StopPickupSeconds $offset)) {
      Warn 'El lanzador no tom\u00f3 el pedido en {0} s (es una versi\u00f3n vieja que no lo conoce, o est\u00e1 trabado): lo detengo de golpe, as\u00ed que se cortan las partidas en curso.' $StopPickupSeconds
      return $procs.Count
    }
    if (-not $now) {
      if (Wait-NodeExit ($StopTimeoutMinutes * 60) $offset) { Say 'El nodo se detuvo.'; return $procs.Count }
      Warn 'Pasaron {0} minutos y el nodo sigue con partidas: lo detengo igual (se cortan las que queden).' $StopTimeoutMinutes
      if ($LogPath -and (Test-Path -LiteralPath $LogPath)) { $offset = (Get-Item -LiteralPath $LogPath).Length }
      Write-TextFile $stopFile 'now' $false
    }
    if (Wait-NodeExit 20 $offset) { Say 'El nodo se detuvo.' }
    return $procs.Count
  } finally {
    # The launcher deletes the file when it reads it. Left behind (an old launcher that does not
    # know it, or one that never got to it), a later start must not find it.
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  }
}

# Replace $Destination with $Source; retried because a scanner may still hold a fresh file.
function Move-FileReplacing([string]$Source, [string]$Destination) {
  for ($i = 0; ; $i++) {
    try {
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force -ErrorAction Stop }
      Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
      return
    } catch {
      if ($i -ge 9) { Fail 'No pude reemplazar {0}: {1}' $Destination, $_.Exception.Message }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Write-TextFile([string]$Path, [string]$Text, [bool]$Bom) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($Bom)))
}

function Invoke-Register([string]$NodeExe) {
  $a = @($LauncherPath, 'register', '--control', $Control, '--data', $DataDir, '--token', $Token, '--roles', 'host', '--transport', 'rtc')
  if ($Name) { $a += @('--name', $Name) }
  if ($HasUplink) { $a += @('--uplink-mbps', [string]$UplinkMbps) }
  # Start-Process -NoNewWindow lets Node write straight to this console (accents included).
  $p = Start-Process -FilePath $NodeExe -ArgumentList (ConvertTo-ArgString $a) -WorkingDirectory $DataDir -NoNewWindow -Wait -PassThru
  $reg = Get-Registration
  if (-not $reg -or ($null -ne $p.ExitCode -and $p.ExitCode -ne 0)) {
    Fail 'El registro fall\u00f3 (c\u00f3digo {0}). Los tokens son de un solo uso y vencen a la hora: gener\u00e1 uno nuevo en la web y volv\u00e9 a correr el comando.' $p.ExitCode
  }
  return $reg
}

function Register-NodeTask([string]$Execute, [string]$Arguments) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments -WorkingDirectory $DataDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = 'PT30S'   # let the desktop settle first
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # No time limit (PT0S), runs and keeps running on battery, restarted every minute if it fails,
  # one instance. Priority 5 is a normal process priority: the default (7) is below normal, and a
  # match server that loses the CPU whenever the PC is busy makes the match stutter.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Priority 5 -Compatibility Win8
  $description = Msg 'Nodo comunitario de Turbogol: hostea partidas por WebRTC en segundo plano. Lo cre\u00f3 install-windows.ps1 (para sacarlo, correlo con -Uninstall).'
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
  try {
    Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -InputObject $task -Force -ErrorAction Stop | Out-Null
  } catch {
    Fail 'No pude crear la tarea programada "{0}": {1}' $TaskName, $_.Exception.Message
  }
}

# Text appended to node.log after byte $Offset ('' if none; from the start if it was rotated).
function Read-LogFrom([long]$Offset) {
  try {
    $fs = New-Object System.IO.FileStream($LogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      if ($Offset -gt $fs.Length) { $Offset = 0 }
      [void]$fs.Seek($Offset, [IO.SeekOrigin]::Begin)
      return (New-Object System.IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $fs.Dispose() }
  } catch { return '' }
}

function Start-NodeTask {
  $offset = 0
  if (Test-Path -LiteralPath $LogPath) { $offset = (Get-Item -LiteralPath $LogPath).Length }
  Start-ScheduledTask -TaskPath '\' -TaskName $TaskName | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ((Read-LogFrom $offset) -match '\[launcher\] starting') { Say 'El nodo arranc\u00f3.'; return }
    $t = Get-NodeTask
    if ($i -ge 3 -and $t -and "$($t.State)" -ne 'Running') {
      Warn 'El nodo se detuvo apenas arranc\u00f3. \u00daltimas l\u00edneas de {0}:' $LogPath
      Get-Content -LiteralPath $LogPath -Tail 15 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('      ' + $_) }
      return
    }
  }
  Warn 'El nodo sigue arrancando. Si en un par de minutos no aparece en la web, mir\u00e1 {0}' $LogPath
}

function Set-FirewallRuleIfAdmin([string]$Program) {
  if (-not $RtcPorts -or -not (Test-IsAdmin)) { return }
  # Inbound UDP only, only node.exe, only the given range. Profile Any: Windows puts many home
  # networks in the Public profile. WebRTC works without this rule anyway.
  try {
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Protocol UDP -LocalPort $RtcPorts `
      -Program $Program -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Say 'Regla de firewall "{0}": UDP entrante {1} para {2}' $FirewallRule, $RtcPorts, $Program
  } catch {
    Warn 'No pude crear la regla de firewall ({0}). No es imprescindible: WebRTC funciona igual.' $_.Exception.Message
  }
}

# ---- install -----------------------------------------------------------------------------------

function Invoke-Install {
  Say 'Turbogol: instalando el nodo comunitario en esta PC'
  Assert-Platform
  Assert-ReleaseKey
  $reg = Get-Registration
  Assert-InstallInputs $reg
  Assert-StopTimeout
  $user =[Security.Principal.WindowsIdentity]::GetCurrent().Name
  if (Test-IsAdmin) { Note 'Lo est\u00e1s corriendo como administrador; no hace falta. Queda instalado para el usuario {0}.' $user }
  if ([Net.ServicePointManager]::SecurityProtocol -ne 0 -and -not ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $node = Install-NodeIfNeeded
  $nodeExe = $node.Exe
  if ($nodeExe -match '[%"]') { Fail 'La ruta de Node.js tiene un car\u00e1cter que no soporto (% o comillas): {0}' $nodeExe }

  New-Item -ItemType Directory -Force -Path $AppDir, $DataDir | Out-Null

  # Everything new is prepared under temporary names first: a running node is not touched until
  # the launcher verified and the helper built.
  Say 'Bajando el lanzador y verificando su firma'
  Save-Url "$Control/nodes/releases/launcher.mjs" $LauncherNew
  Save-Url "$Control/nodes/releases/launcher.mjs.sig" $LauncherSig
  Test-LauncherSignature $nodeExe
  Note 'Firma v\u00e1lida (clave de releases de Turbogol).'

  Say 'Preparando el arranque en segundo plano, sin ventanas'
  $helperError = New-HostHelper
  if ($helperError) {
    Warn 'No pude compilar el ayudante sin ventana ({0}). Uso PowerShell oculto: al iniciar sesi\u00f3n puede verse una ventana un instante.' $helperError
  }

  # A node already running is stopped the same way as with -Stop: its matches end first.
  $previousTask = Get-NodeTask
  $running = Stop-NodeAll $true
  if ($previousTask -or $running -gt 0) { $State.StoppedPrevious = $true }
  if ($running -gt 0) { Note 'Detuve la instalaci\u00f3n anterior para actualizarla.' }
  Move-FileReplacing $LauncherNew $LauncherPath
  Remove-Item -LiteralPath $LauncherSig -Force -ErrorAction SilentlyContinue
  Write-TextFile $ReleaseKeyFile $ReleaseKeyB64 $false

  $command = @($nodeExe, $LauncherPath, 'run', '--control', $Control, '--data', $DataDir, '--')
  if ($HasUplink) { $command += @('--uplink-mbps', [string]$UplinkMbps) }
  if ($RtcPorts) { $command += @('--rtc-ports', $RtcPorts) }
  if (-not $helperError) {
    Move-FileReplacing $HelperNew $HelperExe
    Remove-Item -LiteralPath $FallbackScript -Force -ErrorAction SilentlyContinue
    $execute = $HelperExe
    $arguments = ConvertTo-ArgString (@($LogPath) + $command)
  } else {
    Remove-Item -LiteralPath $HelperExe, $HelperNew -Force -ErrorAction SilentlyContinue
    $fallbackText = $FallbackTemplate.Replace('@@LOG@@', (ConvertTo-PSLiteral $LogPath)).Replace('@@ARGS@@', (ConvertTo-PSLiteral (ConvertTo-CmdArguments $command $LogPath)))
    Write-TextFile $FallbackScript $fallbackText $true   # BOM: 5.1 reads a .ps1 without one as ANSI
    $execute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (ConvertTo-ArgString @($FallbackScript))
  }

  if ($reg) {
    Say 'Esta PC ya estaba registrada como "{0}": conservo esa identidad y no uso el token.' $reg.name
  } else {
    Say 'Registrando esta PC (mide la capacidad durante unos segundos)'
    $reg = Invoke-Register $nodeExe
  }

  Say 'Creando la tarea programada "{0}" (arranca sola cuando inici\u00e1s sesi\u00f3n)' $TaskName
  Register-NodeTask $execute $arguments
  Set-FirewallRuleIfAdmin $node.ExecPath
  Say 'Arrancando el nodo'
  Start-NodeTask

  $uninstallCmd = 'powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ' + $Control + '/nodes/releases/install-windows.ps1))) -Uninstall"'
  $stopCmd = $uninstallCmd.Replace(' -Uninstall"', ' -Stop"')
  Write-Host ''
  Say 'Listo: esta PC es un nodo comunitario de Turbogol ("{0}", regi\u00f3n {1}).' $reg.name, $reg.region
  Note '- Arranca solo al iniciar sesi\u00f3n en Windows, en segundo plano y sin ventanas (tarea "{0}").' $TaskName
  Note '- Se actualiza solo, con releases firmadas. Lo ves en la web, en "Mis servidores".'
  Note '- Log: {0}' $LogPath
  Note '- Hostea por WebRTC: usa UDP saliente y, si hace falta, un relay TURN. No hay que abrir ni redirigir puertos.'
  Note '- Si Windows pregunta si Node.js puede usar la red, permitilo en redes privadas; si cancel\u00e1s, igual funciona.'
  if ($RtcPorts -and -not (Test-IsAdmin)) {
    Note '- Opcional, para conexiones directas entrantes en {0}: en una PowerShell como administrador,' $RtcPorts
    Note "    New-NetFirewallRule -DisplayName '{0}' -Direction Inbound -Protocol UDP -LocalPort {1} -Program '{2}' -Action Allow" $FirewallRule, $RtcPorts, $node.ExecPath
  }
  Note '- Con la PC suspendida, apagada o sin tu sesi\u00f3n iniciada, no hostea partidas.'
  Note '- Para detenerlo sin cortar partidas (espera a que terminen; vuelve a arrancar al iniciar sesi\u00f3n): {0}' $stopCmd
  Note '- Para desinstalar: {0}' $uninstallCmd
}

# ---- stop --------------------------------------------------------------------------------------

function Assert-StopTimeout {
  if ($StopTimeoutMinutes -lt 0 -or $StopTimeoutMinutes -gt 1440) {
    Fail '-StopTimeoutMinutes va de 0 (cortar ya) a 1440. Sin ese par\u00e1metro espera 30 minutos.'
  }
}

# Graceful stop (Stop-NodeGracefully), then the task's End and a sweep for anything left over.
# Used by -Stop, -Uninstall and by an install over a running node ($ForUpdate). Returns how many
# node processes it found running.
function Stop-NodeAll([bool]$ForUpdate) {
  $task = Get-NodeTask
  $n = Stop-NodeGracefully $ForUpdate
  if ($task) {
    try { Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop | Out-Null } catch { }
  }
  $left = Stop-NodeProcesses
  return [Math]::Max([int]$n, [int]$left)
}

function Invoke-Stop {
  Say 'Deteniendo el nodo de Turbogol de este usuario'
  if (-not $AppDir) { Fail 'No encuentro la carpeta LOCALAPPDATA de tu usuario.' }
  Assert-StopTimeout
  $n = Stop-NodeAll
  if ($n -eq 0) { Say 'El nodo no estaba corriendo.' } else { Say 'Listo: el nodo est\u00e1 detenido.' }
  if (Get-NodeTask) {
    Note 'Vuelve a arrancar solo la pr\u00f3xima vez que inicies sesi\u00f3n. Para arrancarlo ahora: Start-ScheduledTask -TaskName ''{0}''' $TaskName
    Note 'Para que no arranque solo: Disable-ScheduledTask -TaskName ''{0}''  (y Enable-ScheduledTask para volver)' $TaskName
  }
}

# ---- uninstall ---------------------------------------------------------------------------------

function Invoke-Uninstall {
  Say 'Desinstalando el nodo de Turbogol de este usuario'
  Assert-StopTimeout
  $done = 0
  $task = Get-NodeTask
  # The same stop as -Stop first: running matches end normally instead of being cut.
  $n = Stop-NodeAll
  if ($n -gt 0) { Note 'Detuve {0} proceso(s) del nodo.' $n; $done++ }
  if ($task) {
    try {
      Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    } catch {
      Fail 'No pude borrar la tarea programada "{0}": {1}' $TaskName, $_.Exception.Message
    }
    Note 'Borr\u00e9 la tarea programada "{0}".' $TaskName
    $done++
  }
  $rule = $null
  try { $rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue } catch { }
  if ($rule) {
    $removedRule = $false
    if (Test-IsAdmin) {
      try { $rule | Remove-NetFirewallRule -ErrorAction Stop; $removedRule = $true } catch { }
    }
    if ($removedRule) { Note 'Borr\u00e9 la regla de firewall "{0}".' $FirewallRule; $done++ }
    else { Warn "Qued\u00f3 la regla de firewall ""{0}"". Para borrarla, en una PowerShell como administrador: Remove-NetFirewallRule -DisplayName '{0}'" $FirewallRule }
  }
  if ($AppDir -and (Test-Path -LiteralPath $AppDir)) {
    for ($i = 0; ; $i++) {
      try { Remove-Item -LiteralPath $AppDir -Recurse -Force -ErrorAction Stop; break }
      catch {
        if ($i -ge 4) { Fail 'No pude borrar {0} ({1}). Cerr\u00e1 lo que lo est\u00e9 usando y volv\u00e9 a correr con -Uninstall.' $AppDir, $_.Exception.Message }
        Start-Sleep -Seconds 1
      }
    }
    Note 'Borr\u00e9 {0} (lanzador, versiones, identidad del nodo y logs).' $AppDir
    $done++
  }
  if ($done -eq 0) {
    Say 'No hab\u00eda nada del nodo de Turbogol instalado para este usuario.'
    return
  }
  Say 'Listo, desinstalado.'
  Note 'Node.js queda instalado: si no lo us\u00e1s para otra cosa, lo pod\u00e9s sacar desde Configuraci\u00f3n > Aplicaciones.'
  Note 'En la web, este servidor va a figurar desconectado.'
}

# ---- main --------------------------------------------------------------------------------------

try {
  if ($Uninstall) { Invoke-Uninstall } elseif ($Stop) { Invoke-Stop } else { Invoke-Install }
} catch {
  $ex = $_.Exception
  Write-Host ''
  if ($ex.Data.Contains('TurbogolInstall')) {
    Write-Host ('turbogol-node: ' + $ex.Message) -ForegroundColor Red
  } else {
    Write-Host (Msg 'turbogol-node: error inesperado en la l\u00ednea {0} del instalador: {1}' $_.InvocationInfo.ScriptLineNumber, $ex.Message) -ForegroundColor Red
  }
  if (-not $Uninstall -and -not $Stop -and $State.StoppedPrevious -and (Get-NodeTask)) {
    try {
      Start-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop | Out-Null
      Write-Host (Msg 'Volv\u00ed a arrancar la instalaci\u00f3n que ya estaba.') -ForegroundColor Yellow
    } catch { }
  }
  if (Test-CanExit) { exit 1 }
}
