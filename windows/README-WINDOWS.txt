IN/OUT Board for Windows
========================

After installing, open  https://<this-PC's-IP>:8443/   (admin: /admin)
Run "InOutBoard.ps1 -Action Status" in an elevated PowerShell to list every URL.

Where things are
  Program         C:\Program Files\IN-OUT Board\
  Settings        C:\ProgramData\InOutBoard\inout-board.env
  Data + photos   C:\ProgramData\InOutBoard\data\
  Backups         C:\ProgramData\InOutBoard\backups\   (nightly 02:15, keeps 14)
  Logs            C:\ProgramData\InOutBoard\logs\
  Client CA cert  C:\ProgramData\InOutBoard\InOutBoard-Local-CA.crt

First sign-in
  The first admin is "admin". Unless you set ADMIN_PASSWORD in inout-board.env
  before the first start, a random password is printed ONCE in
  C:\ProgramData\InOutBoard\logs\app.log  (search for "password").

Browser certificate warnings
  HTTPS on an IP address uses a private certificate authority created on this PC.
  Each device that opens the board must trust InOutBoard-Local-CA.crt (copy it to
  the device and install it into "Trusted Root Certification Authorities"), or
  the browser will warn. Public-IP certificates can be used instead: put the
  files in the paths named under TLS_CERT_FILE / TLS_KEY_FILE in the settings file.

Changing settings
  Edit inout-board.env, then run (as Administrator):
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\IN-OUT Board\InOutBoard.ps1" -Action Restart

Silent install (IT)
  msiexec /i InOutBoard-<version>-x64.msi /qn TLSPORT=443 EXTRAADDRESSES=203.0.113.7
  msiexec /x InOutBoard-<version>-x64.msi /qn          (data is kept)

Network
  - Give this PC a fixed address (DHCP reservation) so router forwarding stays valid.
  - The app itself only listens on 127.0.0.1. Only the HTTPS port is opened in the
    Windows firewall. To reach it from the internet, forward that one port on the
    router to this PC and test from a device outside the office network.
  - Anyone who can open the board can still clock anyone in or out. Do not rely on
    internet exposure until per-person PINs are added.
