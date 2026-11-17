IN/OUT Board for Windows
========================

After installing, open  https://<this-PC's-IP>:8443/   (admin: /admin)
Run "InOutBoard.ps1 -Action Status" in an elevated PowerShell to list every URL
and to check that other devices can reach the board.

First sign-in
  User "admin", password "admin". The board makes you choose a new password
  (10 or more characters) before anything else works. Do this straight after
  installing and before exposing the board beyond your office network.
  This applies to a brand-new data folder only. If this PC already had the board,
  its existing admin account and password are kept. Reset them any time with:
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\IN-OUT Board\InOutBoard.ps1" -Action ResetAdmin
  (run as Administrator; it signs in as admin / admin and asks for a new password).

Where things are
  Program         C:\Program Files\IN-OUT Board\
  Settings        C:\ProgramData\InOutBoard\inout-board.env
  Data + photos   C:\ProgramData\InOutBoard\data\
  Backups         C:\ProgramData\InOutBoard\backups\   (nightly 02:15, keeps 14)
  Logs            C:\ProgramData\InOutBoard\logs\

HTTPS and the certificate
  HTTPS on an IP address uses a private certificate authority created on this PC.
  - This PC trusts it automatically (normal padlock in Chrome and Edge).
  - Other devices: open https://<this-PC-IP>:8443/ca.crt (the browser warns once),
    download the file and install it as a trusted root:
      Windows  double-click, Install Certificate, Local Machine, Trusted Root
               Certification Authorities
      macOS    open it, add to Keychain Access, set to Always Trust
      iPhone   open in Safari, install the profile in Settings, then enable it in
               Settings > General > About > Certificate Trust Settings
      Android  Settings > Security > Encryption & credentials > Install a
               certificate > CA certificate
      Firefox  about:config, security.enterprise_roots.enabled = true
  Without installing it the connection is still encrypted, but browsers warn.
  A publicly trusted certificate for a public IP can be used instead: set
  TLS_CERT_FILE and TLS_KEY_FILE in the settings file.

Changing settings
  Edit inout-board.env, then run (as Administrator):
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\IN-OUT Board\InOutBoard.ps1" -Action Restart
  If the PC's IP address changes, HTTPS follows it within about 30 seconds.

Silent install (IT)
  msiexec /i InOutBoard-<version>-x64.msi /qn TLSPORT=443 EXTRAADDRESSES=203.0.113.7
  msiexec /x InOutBoard-<version>-x64.msi /qn          (data is kept)

Other devices cannot connect, but this PC can?
  Run Status from an ELEVATED PowerShell (right-click, Run as administrator). It
  checks the listening port, the firewall rule on every network profile, and HTTPS
  on each address. Reaching this PC's own IP from this PC never passes through the
  firewall, so it proves nothing about other devices. If Status is all OK, the
  cause is outside the PC: router "AP / client isolation" or a guest network, a
  different subnet or VPN, or a third-party antivirus firewall. From the other
  device try  https://<this-PC-IP>:8443/api/health  (certificate warning expected).

Network
  - Give this PC a fixed address (DHCP reservation) so router forwarding stays valid.
  - The app itself only listens on 127.0.0.1. Only the HTTPS port (TCP) is opened in
    the Windows firewall, on every network profile. To reach it from the internet,
    forward that one port on the router to this PC and test from outside.
  - Anyone who can open the board can still clock anyone in or out. Do not rely on
    internet exposure until per-person PINs are added.
