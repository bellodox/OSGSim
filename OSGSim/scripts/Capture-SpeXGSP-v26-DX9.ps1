# SPDX-License-Identifier: MIT
# Capture real interactive DX9 window by PID; never generate synthetic proof images.
param([Parameter(Mandatory=$true)][int]$SimulatorPid,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT r);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
$p=Get-Process -Id $SimulatorPid -ErrorAction Stop
if($p.ProcessName -ne 'SpaceXpanse'){throw 'NOT_METAVERSE_PROCESS'}
$p.Refresh()
$hwnd=$p.MainWindowHandle
if($hwnd -eq [IntPtr]::Zero){throw 'METAVERSE_WINDOW_UNAVAILABLE'}
[void][WinCapture]::ShowWindow($hwnd,9)
[void][WinCapture]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 600
$r=New-Object WinCapture+RECT
if(-not [WinCapture]::GetWindowRect($hwnd,[ref]$r)){throw 'WINDOW_BOUNDS_UNAVAILABLE'}
$w=$r.Right-$r.Left;$h=$r.Bottom-$r.Top
if($w -lt 320 -or $h -lt 240 -or $w -gt 7680 -or $h -gt 4320){throw 'WINDOW_DIMENSIONS_INVALID'}
$bitmap=New-Object System.Drawing.Bitmap($w,$h)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try{
 $graphics.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$h)))
 $distinct=New-Object 'System.Collections.Generic.HashSet[int]'
 for($y=0;$y -lt $h;$y += [Math]::Max(1,[int]($h/16))){for($x=0;$x -lt $w;$x += [Math]::Max(1,[int]($w/16))){[void]$distinct.Add($bitmap.GetPixel($x,$y).ToArgb())}}
 if($distinct.Count -lt 15){throw 'DX9_IMAGE_IS_BLANK_OR_UNIFORM'}
 $parent=Split-Path -Parent $OutputFile
 if(-not (Test-Path -LiteralPath $parent)){New-Item -Path $parent -ItemType Directory -Force | Out-Null}
 $bitmap.Save($OutputFile,[System.Drawing.Imaging.ImageFormat]::Png)
 $hash=(Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
 Write-Output ('SPEXGSP_DX9_CAPTURE '+(@{sha256=$hash;pid=$SimulatorPid;width=$w;height=$h;colors=$distinct.Count;file=$OutputFile}|ConvertTo-Json -Compress))
}finally{$graphics.Dispose();$bitmap.Dispose()}
