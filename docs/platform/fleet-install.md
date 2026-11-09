# Installing the agent across the fleet

How to install the cabinet agent on many cabinets at once from a remote management tool that runs PowerShell scripts as SYSTEM. The
fleet uses LogMeIn Resolve. Any tool that runs a script as SYSTEM works the same way.

## Before you start

- The agent packages are published on the platform server (Admin → Setup lists them).
- Each cabinet can reach the console address over HTTPS and the agent address on its port (both are shown on Admin → Setup).
- The site exists in the console.

## 1. Create the script for a site

1. Open **Admin → Setup**, step 2.
2. Tick **One installer for several cabinets of one site**, choose the site, and set the number of cabinets and the number of days.
3. Tick **Make a fleet install script (PowerShell)**.
4. Select **Create installer** and confirm with your authenticator code.
5. Download `Install-CabinetAgent-Fleet.ps1`.

The script is for that site only. It works until the number of cabinets you chose have enrolled, or the days have passed, whichever
comes first. You can stop it early from the site installers list.

## 2. Run it from the remote management tool

1. Add the script to your remote management tool as a PowerShell script that runs as **SYSTEM**.
2. Run it on the site's cabinets.

On each cabinet the script:
1. downloads the agent package for that cabinet's Windows architecture, 32-bit or 64-bit;
2. refuses the package unless its SHA-256 matches the value built into the script;
3. installs the agent from a folder that only SYSTEM and Administrators can change.

The script needs no parameters and asks no questions.

| Exit code | Meaning |
|---|---|
| 0 | Installed, or the agent was already installed (nothing was changed). |
| 1 | Not installed. The last two lines of output give the reason and the next step. |

A cabinet the script has already run on can safely be run again: it reports that the agent is already installed and exits with 0.

## 3. Approve the cabinets

Each cabinet appears under **Pending cabinets**, already placed at the site. Approve them one at a time or in a batch. The site's
standards apply on approval.

## If it stops

| Last line of output | What to do |
|---|---|
| The site installer this script was made from has expired, been used up or been stopped. | Create a new fleet install script for the site. |
| The downloaded package is not the one this script was made for. | The agent was updated after the script was made. Create a new script. |
| The agent package could not be downloaded. | Check that the cabinet can reach the console address over HTTPS. |
| The script is not running with administrator rights. | Run it as SYSTEM, not as the signed-in user. |

## Security

- **The token.** The script carries the site installer's token, limited to one site, a number of cabinets and a number of days. Keep it
  in the remote management tool's script library. It is never sent in a URL.
- **No authority on its own.** A cabinet that installs with it can only ask to join; an Admin approves every cabinet.
- **What is installed.** Only the package whose SHA-256 is in the script is installed, and the installer checks the programs' signatures
  before it creates any service.
