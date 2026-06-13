# glyphcast station host bootstrap (Windows, run ONCE as Administrator).
# Opens a dedicated SSH door for the Mac (port 2222, key-only, Tailscale-only -
# deliberately NOT port 22, which belongs to the FiveM workflow) and installs
# the station runtime deps. After this runs, everything else is driven over
# SSH from the Mac: relay + caster + cloudflared services and the tunnel route.
# NOT responsible for: the tunnel config or services themselves (done over SSH).

$ErrorActionPreference = 'Stop'

# ---- 0. the Mac's public key (REPLACE BEFORE RUNNING) ----
$MacPubKey = '__MAC_PUBKEY__'
if ($MacPubKey -like '*__MAC*') { Write-Error 'Replace __MAC_PUBKEY__ with the Mac public key first.' }

# ---- 1. Tailscale must be up ----
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) { winget install --accept-package-agreements --accept-source-agreements Tailscale.Tailscale }
& tailscale up
$tsIp = (& tailscale ip -4) | Select-Object -First 1
Write-Host "Tailscale IP: $tsIp"

# ---- 2. OpenSSH Server on port 2222 (our own door; port 22 untouched) ----
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
$cfg = 'C:\ProgramData\ssh\sshd_config'
if (-not (Test-Path $cfg)) { Start-Service sshd; Stop-Service sshd }  # generate defaults
$conf = Get-Content $cfg | Where-Object { $_ -notmatch '^\s*(Port|PasswordAuthentication|PubkeyAuthentication)\b' }
$conf = @('Port 2222', 'PasswordAuthentication no', 'PubkeyAuthentication yes') + $conf
Set-Content $cfg $conf -Encoding ascii

# admin users authenticate against this file (Windows OpenSSH quirk), strict ACL required
$ak = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content $ak $MacPubKey -Encoding ascii
icacls $ak /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

Set-Service sshd -StartupType Automatic
Restart-Service sshd

# ---- 3. Firewall: 2222 reachable ONLY from the Tailscale range ----
Remove-NetFirewallRule -DisplayName 'glyphcast-ssh-door' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'glyphcast-ssh-door' -Direction Inbound -Protocol TCP `
  -LocalPort 2222 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null

# ---- 4. Station runtime deps ----
foreach ($pkg in 'Oven-sh.Bun', 'Gyan.FFmpeg', 'Cloudflare.cloudflared', 'Git.Git') {
  winget list --id $pkg 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { winget install --accept-package-agreements --accept-source-agreements $pkg }
}

Write-Host ''
Write-Host "Door open: ssh -p 2222 $env:USERNAME@$tsIp (key-only, Tailscale-only)."
Write-Host 'Tell Claude the IP above; everything else happens from the Mac.'
