# Native "pick a media file" dialog for the dsh-splash-animation settings page.
#
# Spawned by the plugin's Host half, which cannot open a native dialog itself
# when DSH runs as a plain Node process (the CLI `dsh web` case). Windows ships
# WinForms with the .NET runtime that PowerShell already loads, so this needs no
# dependency and no install step.
#
# Contract with the caller:
#   - STA is required: the common file dialog is a COM object and throws on an
#     MTA thread, which is why the caller must pass -STA (Windows PowerShell 5.1
#     defaults to STA, but `pwsh` 7 defaults to MTA).
#   - The selected path is written to -OutFile as UTF-8, NOT to stdout. A console
#     writes text through the system ANSI code page (GBK on a Chinese Windows), so
#     a path with non-ASCII characters comes back as mojibake when the caller
#     decodes it as UTF-8 — which is exactly how the first version turned
#     `开屏动画.mp4` into `????.mp4`. A file carries its own encoding and cannot be
#     corrupted by a code page.
#   - Nothing is written when the user cancels, so "no file" means cancel.
#   - Diagnostics go to stderr, never into the result.
#   - Exit code 0 covers both "picked" and "cancelled"; a non-zero code means the
#     dialog itself failed, which the caller reports as an environment problem
#     rather than as a user cancellation.

param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$InitialDirectory = '',
  [string]$InitialFile = ''
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select a video or animated image for the DSH splash'
  $dialog.CheckFileExists = $true
  $dialog.CheckPathExists = $true
  $dialog.Multiselect = $false
  $dialog.RestoreDirectory = $true

  # Filter order matters: the first entry is what the dialog opens on. The
  # "All supported" entry repeats the same set so a user who does not care about
  # the distinction still sees every acceptable file.
  $video = 'Video (*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts)|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts'
  $image = 'Animated / still image (*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico)|*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'
  $all = 'All supported media|*.webm;*.mp4;*.m4v;*.mov;*.mkv;*.ogv;*.ogm;*.mpg;*.mpeg;*.ts;*.gif;*.apng;*.webp;*.avif;*.png;*.jpg;*.jpeg;*.svg;*.bmp;*.ico'
  $dialog.Filter = "$all|$video|$image|All files (*.*)|*.*"

  if ($InitialDirectory -ne '' -and (Test-Path -LiteralPath $InitialDirectory)) {
    $dialog.InitialDirectory = $InitialDirectory
  }
  if ($InitialFile -ne '') {
    $dialog.FileName = $InitialFile
  }

  # A dialog owned by a hidden form is centred on the screen and reliably comes
  # to the front; without an owner it can appear behind the browser window.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.WindowState = 'Minimized'
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0

  $result = $dialog.ShowDialog($owner)
  $owner.Dispose()

  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.FileName -ne '') {
    # No BOM: the caller reads this as plain UTF-8 and would otherwise get a
    # U+FEFF glued to the front of a Windows path.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, $dialog.FileName, $utf8NoBom)
  }
  $dialog.Dispose()
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
