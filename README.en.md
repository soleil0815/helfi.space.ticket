<p align="center"><img src="public/logo.svg" width="72" alt=""></p>

# Helfi.Space

[Deutsch](README.md) · **English** · [helfi.space](https://helfi.space)

A lightweight ticket system for IT departments and institutes, in German and English. Helfi.Space runs as a single Docker container with SQLite.

![Board with tickets in four columns](docs/images/board-en.png)

- **Active Directory** (Windows Server or Samba AD): sign in with Windows accounts, roles from AD groups (nested groups too), **fetch the LDAPS certificate with one click**
- **Single sign-on** via OpenID Connect: Microsoft Entra ID, ADFS, Keycloak, Authentik …
- **Email → ticket:** a mailbox is polled via IMAP, new mails become tickets and replies land in the matching ticket. Reporters get answers by email.
- **Clear and simple:** sidebar with queues (open, assigned to me, unassigned, waiting, recently resolved, all) with live counts, per-project summary, board with drag & drop, ticket list with filters, ticket view with details, comments, internal notes, attachments and history
- **Easy migration:** import from **Zammad**, **Znuny/OTRS**, **GLPI**, **Zendesk**, **Freshdesk**, **Jira** (cloud, Server/Data Center) or a **CSV file** – with comments, internal notes and attachments; ticket numbers are kept, a second run only adds what is new.
- **Paste screenshots:** images from the clipboard with Ctrl+V right into a comment, the description or "Create ticket". In internal notes they stay internal.
- **IT service management following ITIL** (all optional): links and subtasks, impact/urgency and major incidents, service levels, problems and known errors, change management with approval and calendar, knowledge base, service catalog with forms and approval, devices & services, satisfaction survey and key figures
- **Search with results while typing** – with where it matched, keyboard control and recently opened tickets, on desktop and phone
- **Saved filters and custom queues:** save the ticket list filters under a name – personal or shared by an admin with all agents, in the sidebar with a count, on phones as a chip
- **Components with ownership:** split projects into areas such as “VPN & remote access” or “Printers & scanners”, each with a responsible person and a deputy. New tickets are matched by keywords or the sender and go to the right person automatically – with ready-made examples for IT, facilities and administration
- **Formatted replies:** one toolbar above the comment field (ticket, knowledge articles, phone) with AI, bold/italic, lists, quote, code, link, image, emoji, @-mention and canned responses – formatted while writing, formatted in the mail
- **Teamwork:** **@-mentions** in replies and internal notes (with email and a "Mentions me" view), request participants, reply templates, **multi-select** (status, assignment, comment or link for many tickets at once), **linking with search and suggestions** (possible causes, similar tickets)
- **AI assistance (optional, every function can be switched on its own):** summary, reply suggestion, rewriting, help writing knowledge articles and detecting the component (with hit rate) with your own model (Ollama, LM Studio, vLLM …) or any OpenAI-compatible service – suggestions only, nothing is sent automatically
- **Phone app:** its own app-like interface under `/m`, installable as an app, with photos, templates, mentions and 2FA setup
- **Self-registration and "forgot password"** for local accounts (off by default), optionally only for certain domains and with approval
- **Automatic sign-out when idle,** stricter for admins and access from outside if desired, with a "Still there?" prompt
- **Knowledge articles with 👍/👎 rating** and feedback on what was missing – articles that need rework at a glance
- **Roles:** administrator, agent, user. Users only see their own requests.
- **Two-factor sign-in (TOTP):** on the internal network a password is enough, from outside a code from an authenticator app is required – configurable per role.
- **Local emergency admin:** created during first setup, works even when the AD is unreachable.
- **What's new:** after an update Helfi.Space shows everyone once what changed for them; all versions are listed in the user menu under *What's new*.
- Automatic backups daily and before every update

![Ticket view with comments, internal note and details](docs/images/ticket-en.png)

**Manual (PDF):** [English](docs/Manual.en.pdf) · [Deutsch](docs/Handbuch.pdf) – for users, agents and administrators.

---

## Installation

Requirement: Docker with Compose (Linux server, Synology, …).

```sh
mkdir helfi && cd helfi
# download docker-compose.yml, env.example and update.sh from the latest release
cp env.example .env
nano .env            # at least set HELFI_BASE_URL
docker compose up -d
docker compose logs helfi   # shows the setup code
```

Then open `HELFI_BASE_URL` in the browser. The setup wizard asks for the **setup code** from the log and creates the **local administrator** and the first project. After that it takes you straight to the AD setup.

The host only holds a few things:

| | |
|---|---|
| `docker-compose.yml` | usually stays the same across updates |
| `update.sh` | manual update (optional, not needed with a container manager) |
| `.env` | your settings (address, port, version, PUID/PGID) |
| `data/` | database, attachments, backups, key file |

**Synology:** set `PUID`/`PGID` in `.env` to your user (e.g. `1026`/`100`, see `id` via SSH) so the files in `data/` belong to you.

### HTTPS (recommended)

Helfi.Space itself speaks HTTP on port 8080. In production, put a reverse proxy with HTTPS in front of it (Synology reverse proxy, Nginx Proxy Manager, Caddy, Traefik …). Then set `HELFI_BASE_URL=https://helfi.firma.local`. Cookies are then marked `Secure` automatically.

So that the brake against password guessing sees the real client address, enter the proxy's address in `.env`, e.g. `HELFI_TRUST_PROXY=10.0.10.5`. Separate several entries with commas, e.g. `loopback, 10.0.10.5`. Without it, Helfi.Space only trusts `X-Forwarded-For` from its own host (`loopback`), because the header could otherwise be forged. Values such as `true` or a number (count of proxies) are ignored with a warning in the log; `loopback` then applies as well.

Example Caddy:

```
helfi.firma.local {
    reverse_proxy 10.0.10.20:8080
}
```

---

## Appearance (corporate design)

*Administration → General → Appearance*:

- **Logo** as PNG or SVG (512 KB at most). It replaces the logo in the header, on the sign-in page and in the browser tab. SVGs with scripts or references to external content are rejected. The logo is stored in the data folder under `brand/` and is included in backups.
- **Title next to the logo** can be hidden if the logo already contains the name.
- **Main colour** for buttons, links and highlights. The page shows the contrast to white and warns below 4.5:1, because text on buttons is then hard to read.
- **Header** light or in the main colour. With very light colours the text there automatically turns dark.
- A preview shows the effect before saving; *Reset to default* restores everything.

## Customizing the sign-in page

*Administration → General → Sign-in page*: your own heading (e.g. "Help center"), welcome text in German and optionally English, e.g. how to get help, and your own label for the user name field ("Windows user name"). Text only: `**bold**`, links and email addresses become clickable, HTML is never executed. A preview shows the result right away.

## AI assistance (optional)

*Administration → AI* (off by default)

Agents can have tickets summarized and replies suggested, polished, shortened or translated. Everything is only a **suggestion**: nothing is sent or saved automatically, and requesters see none of it. The only exception, if explicitly set: *detect component* in *assign automatically* mode.

- **Any OpenAI-compatible API:** Ollama, LM Studio, vLLM, but also cloud providers. Enter the address (Ollama: `http://<host>:11434/v1`) and optionally an API key (stored encrypted, only sent to this address). **The installed models are fetched automatically** and offered in a list – for Ollama with parameter count, quantisation and size, cloud models in a group of their own; embedding models (they cannot answer) are hidden. If a server provides no list, enter the name via *Other model …*. *Test* checks the connection.
- **Recommended for production: self-host.** With a model in your own network, ticket content does not leave the house. Models from about 8–14 billion parameters (e.g. Qwen3, Mistral, gpt-oss:20b) give usable results; with a GPU, answers come in seconds. Cloud models (including Ollama's `…-cloud` models) send names, descriptions and replies to the provider – the settings page points this out; whether that is permitted is a data protection question.
- **What the AI gets:** title, description and public comments (newest first, shortened to a configurable length). Internal notes only if switched on; attachments never. The log only contains ticket key, task, model and duration – no content.
- **Reasoning models** (e.g. gpt-oss): reasoning is set to *low* (faster) and removed from the answer.
- Only the server talks to the model; the browser still loads nothing from outside. Calls are limited per agent.
- **Knowledge articles** (function on by default): in the article editor *AI* is the first button. It works on the selection or the whole article and keeps the formatting – polish, shorten, step-by-step guide from notes, translate, suggest title and category. For an article from a ticket the AI writes a draft on request (problem – cause – solution) without personal data. *Undo* brings back the previous text.
- **Switch functions one by one:** *summary*, *reply suggestion* and *rewrite* (on by default) and *detect component* (off by default). Functions that are off do not appear anywhere.
- **Detect component:** for new tickets that no [component](#components) rule matches, the AI picks from the list of components (with description and keywords) in the background – or reports “none fits”. Two modes:
  - *Suggest* (default): the ticket shows “AI suggests: VPN & remote access – Accept / Dismiss” (phone: under *All details*). Accepting sets the component and gives the ticket to the responsible person like the rules do.
  - *Assign automatically*: the component is set directly; the history says “by AI” with the model.
  - The **hit rate** is shown on the AI page, e.g. “87 % (52 of 60 accepted)”: accepted ones and automatic ones nobody changed, against corrected and dismissed ones.
  - With a cloud model, the title and description of every new ticket without a rule match go to the provider for this – the page points it out.

## Self-registration and forgotten passwords

*Administration → Security → Registration and forgotten passwords* (registration is off by default)

Without AD or SSO, external people simply send an email and are kept as an email contact; they cannot sign in with it. With **self-registration** they create a local account themselves via "Create account" on the sign-in page (role "User") and then also see their requests in the browser.

- **Confirmation link:** enter name, email address and password, then a link arrives (valid for 24 hours). Only then is the account created. If there already is an email contact for the address, it becomes the account, with all previous requests. Unconfirmed registrations expire on their own.
- **Sign-in** with the email address as user name. Afterwards only an admin can change the address.
- **Allowed mail domains** (optional, subdomains included) and **approval by an admin** (optional: admins get an email and approve the account under *Users*; the person is notified).
- **Forgot password:** link by email, valid for 60 minutes and usable once; afterwards all sessions are ended. By default for local accounts with the role "User", optionally for all local accounts or off. The link only appears if such accounts exist. Accounts from AD or SSO change their password there; two-factor sign-in stays in place.
- **Requires** outgoing mail. The page never says whether an address is already known (the person learns it by email). Requests per IP and address are limited, an invisible field keeps simple bots away; there is no captcha because it would have to load something from the internet.
- **Two-factor:** if 2FA is required for everyone from outside but enrollment is only allowed inside the company network, external people could never sign in. The settings page points this out.

## Setting up Active Directory

*Administration → Active Directory*

1. Enter the **domain controller** using the name in its certificate (e.g. `dc01.firma.local`). Encryption: **LDAPS (636)** or **StartTLS (389)**.
2. **Fetch certificate** retrieves the certificate directly from the DC and shows the SHA-256 fingerprint. Compare it with the one on the server, then click **Accept certificate**.
   - Windows: `certlm.msc` → Personal → Certificates → the DC's certificate → Details → Thumbprint (SHA-256 via PowerShell: `Get-ChildItem Cert:\LocalMachine\My | Format-List Subject, @{n='SHA256';e={$_.GetCertHashString('SHA256')}}`)
   - Samba: `openssl x509 -in /var/lib/samba/private/tls/cert.pem -noout -fingerprint -sha256`
3. Enter a **service account**, e.g. `svc-helfi@firma.local` (a normal domain account, no special rights needed). Without a service account, Helfi.Space searches with the account that is signing in and then checks the password once more against the found account (so another account's UPN never leads to the wrong sign-in).
4. Enter the **groups** for administrators and agents, e.g. `Helfi-Admins` and `Helfi-Agents` (name or full DN). Nested groups are taken into account. Optionally, an "allowed users" group restricts who may sign in at all (admins and agents always may). If a group name is ambiguous (same name in several OUs), no role is assigned and the log says so – enter the full DN in that case.
5. **Test connection**, ideally with a test sign-in. If the base DN is empty, it is taken from the AD. If there is a Microsoft certification authority (AD CS), the test finds it and offers to accept it too. Renewed DC certificates then stay valid automatically.
6. **Enable AD sign-in** and save.

Users sign in with `m.muster`, `FIRMA\m.muster` or `m.muster@firma.local`. Users are created on their first sign-in. Their role follows from their groups at every sign-in, unless an admin has locked it under *Users* with "fixed role". If an admin changes a role by hand, it is locked automatically.

**Good to know**

- A Windows DC only offers LDAPS if it has a certificate (AD CS or installed manually). Samba AD creates one itself during provisioning.
- Every day Helfi.Space checks whether the stored certificate still matches and whether it expires soon. Problems appear as a notice for admins. After a renewal on the DC, simply **fetch the certificate** again.
- **Suggest participants from AD** (default: on, requires the service account): see [Request participants](#request-participants).
- Local accounts take precedence: if a local account has the same name as an AD account, the local one wins.
- If the AD is unreachable, local accounts (the emergency admin) can still sign in.

## Two-factor sign-in (2FA)

*Administration → Security*

Default: **on the internal network a password is enough, from outside a second factor is required.** That is a 6-digit code from an authenticator app such as Microsoft Authenticator, Google Authenticator, Aegis or 2FAS. The requirement can be set separately per role:

| Setting | Options |
|---|---|
| Required when signing in from outside | all users (default) · agents and administrators · administrators only · nobody |
| Inside the internal network | no two-factor prompt (default) · administrators only · agents and administrators · all users |

Example: reporters without a code, agents with a code from outside, administrators always with a code. Installations that had "always" or "never" set keep that behaviour.

- **Requests from the server itself** (127.0.0.1) do not count as internal automatically. A reverse proxy on the same host must set X-Forwarded-For, otherwise every request would look like it came from the server itself. For testing, `127.0.0.1` can be added to the list.
- **Internal networks** are listed in the settings, one entry per line (default: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). The default covers all private ranges, including Docker networks and a guest Wi-Fi. Best narrow it down to the real company networks, e.g. `10.0.10.0/24`. The page shows how your current address is classified.
- **Own internet connection:** when a computer inside the company opens Helfi.Space via its public address, it often arrives with the public IP of your own connection (hairpin NAT). Enter that IP or a DynDNS name (e.g. `203.0.113.10` or `helfi.dyndns.example`) and such requests count as internal. Names are resolved again every 5 minutes; if DNS is briefly unreachable, the last known address keeps counting. Caution: if a guest Wi-Fi uses the same connection, guests count as internal too.
- **Behind a reverse proxy** its address must be in `HELFI_TRUST_PROXY`. Otherwise Helfi.Space only sees the proxy and, to be safe, treats every request as external. Admins then get a notice.
- **Setup:** everyone sets up 2FA under *Profile → Two-factor sign-in*: scan the QR code, enter a code, save 10 recovery codes. For security, first-time setup only works on the internal network, in every mode. Exception: after an SSO sign-in whose second factor was checked by the identity provider ("SSO sign-ins count as second factor"). Once 2FA is set up, it can only be turned off with a valid code and then set up again (e.g. new phone). This way nobody with a stolen password can register their own second factor from outside. For people who only work remotely, *Security* can allow "first-time setup from outside too".
- **Sessions:** if you signed in at the office without a code and later use the same browser from home, you have to sign in again with a code there. Every session ends at the latest 30 days after sign-in, even with constant use.
- **Automatic sign-out** (*Administration → Security*): whoever does nothing for a while (no clicks, no typing) is signed out – everyone after `HELFI_SESSION_HOURS` (default 12 hours) or the value set there, admins after 60 minutes by default, optionally shorter for access from outside the company network; the shortest applicable period counts. Two minutes before, Helfi asks "Still there?". As long as someone works, including typing a long reply, the session continues. Optionally the sign-in ends when the browser is closed.
- **Lost phone:** sign in with a recovery code. Alternatively, an admin resets 2FA under *Users → Reset 2FA*, and the person sets it up again at the office.
- **Applies to** local accounts and Active Directory sign-ins. For **SSO**, *Security → SSO sign-in as second factor* decides whether the sign-in at the identity provider is enough:
  - **Only if the provider reports MFA** (default): the token must show a multi-factor sign-in, i.e. `amr` with e.g. `mfa`, `otp` or `hwk` (Entra ID: `mfa`), or one of the `acr` values entered under *Single sign-on → acr values for MFA* (e.g. Keycloak level `2`). Otherwise Helfi.Space asks for its own code.
  - **Always** or **Never** (then always its own code as well).
  - Installations with SSO enabled keep their previous behaviour (“Always”) on update; *Security* then shows a notice with the recommendation.
- Docker note: with some Docker setups all requests seem to come from the Docker gateway, e.g. with rootless Docker or IPv6. That address therefore only counts as internal if it is listed on its own.

![Two-factor sign-in settings](docs/images/2fa-en.png)

## Single sign-on (OpenID Connect)

*Administration → Single sign-on*

1. Create an app or client at your provider and enter the displayed address as redirect URI: `https://helfi.firma.local/auth/oidc/callback`.
2. Enter issuer URL, client ID and client secret, then **Test**.
   - **Microsoft Entra ID:** `https://login.microsoftonline.com/<tenant ID>/v2.0`. Add the groups claim under *Token configuration*. The token then contains group IDs, and you enter those IDs as admin/agent group.
   - **ADFS (Windows Server):** `https://adfs.firma.local/adfs`, application group "Server application accessing a web API". Issue the `groups` claim via a claim rule.
   - **Keycloak:** `https://keycloak.firma.local/realms/<realm>`, mapper "Group Membership" with claim `groups`.
3. Optionally enable "redirect straight to SSO". The normal sign-in page stays reachable at `/login?local=1`, e.g. for the emergency admin.

**SSO and AD together:** if you enter your domain under "Merge with AD accounts for domain" (e.g. `firma.local`), `m.muster@firma.local` from SSO is the same account as the AD user `m.muster`. Only enter the domain if the provider really controls it, i.e. does not allow guest accounts from other organizations. Without it, SSO accounts stay separate, and a guest `m.muster@fremd.example` can never take over the account `m.muster`. If the token contains no user name (`preferred_username`/UPN) but only the email address, accounts are only merged if the provider reports it as verified (`email_verified`). Email addresses from SSO are only taken over and merged with email contacts if the provider reports them as verified or if they equal the user name of the allowed domain (e.g. Entra ID: UPN = email address).

**Stable merge via the AD identifier (recommended):** with some providers (e.g. Keycloak, Authentik) the user name can be chosen freely. So enter under *Claim with AD identifier* the claim that holds the `objectSid` or `objectGUID` of the AD account: the optional claim `onprem_sid` for Entra ID, a custom mapping to `objectGUID` for Keycloak or Authentik (as text with dashes, hex or Base64). Then accounts are merged **only** this way, no longer by name and domain. With a service account, Helfi.Space checks the AD account on every SSO sign-in like a password sign-in: disabled or no longer in the “Allowed users” group means no access, the role follows the AD groups, and an AD account not known yet is created (unless “only existing accounts” is set). If the AD is unreachable at that moment, the SSO sign-in is cancelled instead of creating a separate account. A previously separate SSO account of the same person stays, from then on the AD account is signed in. If the claim is missing in the token or the person does not exist in AD, the SSO account stays separate.

## Email

*Administration → Email*

- **Polling a mailbox (IMAP):** enter server, user and password of the help desk mailbox. New mails become tickets (including attachments up to 20 MB each and up to 30 attachments; anything not taken over is noted in the ticket; mails over 80 MB are skipped and flagged in the mailbox). Replies to mails from Helfi.Space and replies from participants with `[IT-123]` in the subject become comments, quoted history is cut off. If the reporter replies to a waiting or resolved ticket, it is reopened. Out-of-office notes and automatic mails are ignored. Processed mails are marked as read or moved to a folder. Skipped mails (automatically generated, hourly limit, account disabled, no valid sender, own address, rule "Ignore") and delivery failure reports stay in the inbox, marked as read; they are not moved to the processed-mail folder and therefore not deleted automatically either.
- **Sending (SMTP):** ideally use the same address as the mailbox as sender, so replies land back in the ticket.
- **Internal notes** never go out by email.
- Only people involved may reply by ticket number in the subject: the reporter, request participants and everyone who has already written in the ticket. The assignee does not automatically count. Anyone who merely guesses the number gets a new ticket of their own. Replies to mails from Helfi.Space are always matched correctly via the Message-ID.
- If a reply is matched only by the number in the subject, its To/CC recipients do not become participants. That only happens for new tickets and for replies to mails from Helfi.Space (matched via the Message-ID).
- Sender addresses can be forged. That is why a mail never counts as an agent reply, even if it comes from an agent's address: it appears with the sender address, not under the account, and is not forwarded to the reporter. Agents reply through the web interface.
- Email replies to assignment, SLA or approval mails sent to agents become internal notes and do not reopen the ticket.
- Helfi.Space marks processed mails with its own IMAP flag (`$HelfiDone`). If someone reads the mailbox in parallel in Outlook or on a phone, the mails are still processed. If the mail server cannot store custom flags, Helfi.Space fetches only unread mails as before – then do not read the mailbox in parallel. A folder for processed mails is recommended.
- Confirmations of receipt go out at most 60 times per hour (protection against abuse with forged senders).
- Loop protection: more than 20 new tickets per hour from the same sender are ignored.
- **Mail loop protection** (e.g. with monitoring systems, printers, backup software):
  - Delivery failure reports (Exchange, Postfix, …) and read receipts never become tickets or comments and are never answered.
  - If a report belongs to a mail from Helfi.Space, the ticket gets an internal note "delivery failed".
  - The affected address gets no mail for 7 days. Only addresses from real header lines of the report (`X-Failed-Recipients`) or from its `message/delivery-status` part are blocked, never addresses from the mail text. The list is under *Administration → Email → Blocked recipients*, where an address can also be released early.
  - **Sender rules** (address or pattern like `*@zabbix.firma.local`): "Create ticket, never reply", optionally into a separate project, or "Ignore". Automatically generated emails (header `Auto-Submitted`, `Precedence: bulk`, sender `noreply@…`), as sent by Proxmox, NAS systems or monitoring, are only accepted with the rule "Create ticket, never reply". Without a rule they are skipped. *Administration → Email* lists the recently skipped emails with sender and reason.
- Senders without an account are kept as *email contacts*. If they later sign in via AD or SSO with the same address, their tickets are taken over.
- **Look up senders in AD** (default: on, requires AD sign-in with a service account): Helfi.Space searches unknown senders in AD. It checks `mail`, `userPrincipalName` and the alias addresses in `proxyAddresses`, and skips disabled accounts. With exactly one match, the person is created as an AD user right away, with the role from their groups, as if they had signed in. An existing email contact is taken over. Not found, ambiguous or AD unreachable: they become an email contact as before. Unknown addresses are not looked up again for one hour. A mail still never grants agent rights.
- **Retention:** "Delete processed mail after … days" (default 0 = never, otherwise at least 7). Once a day, older mails in the processed-mail folder are permanently deleted, at most 500 per run. Nothing is ever deleted in the inbox. If no separate folder is set, Helfi.Space deletes nothing. The content stays in the tickets.

### HTML emails

Helfi.Space shows HTML emails **formatted** in descriptions and replies, with tables, bold text, colours, signature and embedded images. A **"Formatted | Text"** switch changes to the text version; the browser remembers the choice. Editing always uses the text version. After a description has been edited, only the text applies.

- **Security:** the HTML is cleaned when the mail arrives. Scripts, forms, embedded pages, event attributes and `javascript:` links are removed. It is also shown in an isolated frame with its own security policy in which no script can run.
- **Images:** embedded images such as logos, signatures or pasted screenshots are shown. Small logos do not appear in the attachment list. **Images from the internet** (often tracking pixels) are never loaded; a notice states how many there were.
- **Replies:** the quoted history (Outlook, Gmail, Apple Mail, Thunderbird) is collapsed: "Show quoted text".
- Applies to mails received after the update.

## Search

The search box at the top searches all tickets in full text: title, description, replies, labels and attachment names. Agents also find internal notes and the people involved (reporter, assignee, people who replied, also by email address and logon name). Users without the agent role find tickets by title, description, public replies, attachment names, labels and the names they also see in the ticket (reporter, assignee, people who replied) – never by internal notes, email addresses or logon names.

- **Results while typing:** from two characters a list below the search box shows up to eight tickets with key, title, status and where they matched (e.g. "Reply from Eva Berger: …"). ↑/↓ choose, Enter or click opens the ticket, Enter without a choice or *Show all results* leads to the ticket list with all results and filters as before; Esc closes. A ticket key appears as "Open IT-42" at the top. In the empty field the recently opened tickets appear (stored in the browser only, removed at sign-out). The same on phones in the *Tickets* tab.
- **Parts of words** are found: `printer` also finds "networkprinter". Upper and lower case do not matter.
- **Several words** in any order must all occur, `"exact phrase"` in quotes, `-word` excludes.
- **Best matches first:** title matches count most. Clicking a column sorts as usual, "Best matches first" switches back.
- **Where it was found:** below each hit is an excerpt with highlighted words and where it comes from (description, reply from …, attachment).
- A ticket key such as `HELP-123` jumps straight to the ticket. The search index is built once at the first start after the update (under a second for 7000 tickets) and kept up to date afterwards.

## Request participants

Besides the reporter, other people can be involved in a ticket, e.g. colleagues with the same problem or a manager.

- **Add:** in the ticket view under *Request participants → Add*.
  - Agents search by name or enter any email address. Suggestions appear while typing and the cursor stays in the field; pick with a click or ↑/↓ and Enter, Esc cancels.
  - **From AD:** from 3 characters on, agents also see people from AD (marked “AD”), searched by name, logon name and email addresses including aliases. The chosen person is created or updated as an AD user, with email address and role from AD; an existing email contact is taken over. A typed email address is looked up in AD as well. People whose groups do not allow them to use Helfi.Space are added as an email contact. If AD is unreachable, only existing people are shown. Can be turned off under *Administration → Active Directory → Suggest participants from AD*; requires the service account.
  - Reporters and participants can add colleagues who have an account, but no arbitrary addresses.
  - At most 20 per ticket.
- **By email:** anyone in *To* or *CC* of a new mail or of a reply to a mail from Helfi.Space automatically becomes a participant (not when a reply is matched only by the number in the subject). This applies to at most 10 addresses per mail; the helpdesk address and agents are not counted. Can be turned off under *Administration → Email*.
- **What participants can do:**
  - see the ticket, also under *My requests* with the filter "I am a participant"
  - comment and attach files on the web or by replying to a mail
- **What participants cannot do:** see internal notes, change status, assignee or title. Of the reporter they only see the name, not the email address and logon name (the same applies to approvers without the agent role).
- **The sender is always the ticket system** (no agent addresses or signatures). Reply and resolved mails end with “Kind regards”, the agent’s name and the system name; if the ticket is assigned to someone else, “Your contact person: …” is added.
- **Notifications:** participants get the same mails as the reporter (replies, resolved), each one separately in their language, without the other addresses. People added on the web get a short mail.
- **Remove:** agents, the reporter or the person themselves.

## Formatting replies

Above the comment field there is a toolbar – in tickets, in comments on knowledge articles and on phones (there it appears while writing and can be swiped sideways):

- **AI** (if set up): suggest a reply, polish, shorten, translate.
- **Formatting:** bold (Ctrl+B), italic (Ctrl+I), underline, strikethrough, code; bullets, numbered list, quote, code block. The formatting is visible while writing; “- ”, “1. ” or “> ” at the start of a line work too.
- **Link** (Ctrl+K, also ticket numbers such as IT-42), **image** (or Ctrl+V), **emoji** (also “:)”) and **@** to mention someone.
- **Canned responses** on the right of the bar, *Save as canned response* in the same menu. Ctrl+Enter saves.

The text is stored in the format of knowledge articles. Reporters and participants get the reply formatted by email (HTML) with a readable text part without asterisks. Older comments and mails are shown as before.

## @-mentions

Agents bring colleagues into a ticket directly: in the reply field (desktop and phone) type **@** and a few letters, then pick a person (click/tap or ↑/↓ and Enter or Tab; Esc closes the list). The name is highlighted in the comment, your own mentions in colour.

- **Who can be mentioned:** in an **internal note** only agents; in a **reply** also the ticket's reporter, participants and approvers. People who cannot see the ticket are not offered – and a reference typed by hand becomes plain text when saving. Reporters do not mention anyone; neither do comments from emails (senders can be forged).
- **Notification:** people mentioned get an email from the ticket system ("Anna mentioned you on IT-12") with the comment and the link. Reporters and participants who get the reply by email anyway do not get a second one. Mentioning yourself sends nothing. Replies to an agent's email become internal notes as usual. Can be switched off under *Channels: email → Notifications*.
- **Finding them again:** *Mentions me* in the sidebar (phone: *Mentions* chip under *Tickets*) lists all tickets with a mention; the number next to it counts those not opened yet. New mentions are marked with **@** in lists, and so is the comment in the ticket. Opening the ticket marks the mention as seen.
- Mentions do not add people as participants or watchers – that is what *Request participants* is for.

## Saved filters and queues

Set filters, search and sorting in the ticket list and choose **Save filter**. The filter appears on the left under *Saved filters* with its current count (phone: as a chip under *Tickets*); the list then carries its name.

- **Personal:** every agent has their own filters (up to 50). Others do not see them.
- **For all agents:** admins can share a filter when saving it. It appears as a queue for all agents (with a people icon). “Assigned to me” then refers to each person.
- **Managing:** the icon next to *Saved filters* opens the list to rename, sort (↑/↓) and delete. Only admins change shared queues.
- Only ticket list filters are saved (project, status, type, priority, assignee, component, label, search, sorting …).

## Components

*Administration → Components* (or *Projects → Components*)

Components split a project into areas of responsibility. Each has a name, a short description, a **responsible person**, optionally a **deputy**, **keywords** and optionally **sender patterns**.

- **Matching:** when a ticket is created (web, phone, email, service catalog), a matching sender (e.g. `*@zabbix.firma.local`) decides first, otherwise the keywords: a hit in the title counts 3, in the description 1. On a tie the component further up wins. From 4 letters a keyword also counts inside a word (“print” finds “printer”), shorter ones only as a whole word (“pc” does not find “PCIe”).
- **Assigning:** if nobody is assigned yet, the responsible person gets the ticket; if they are deactivated, the deputy. An agent who picks someone when creating the ticket takes precedence.
- **Traceable:** the history shows “component VPN & remote access (keywords: vpn, forticlient)” and “assigned to Anna (responsible for VPN & remote access)”. Agents change the component in the ticket (phone: under *All details*); that is recorded too.
- **Testing:** below the list you try out with title, description and sender which component a ticket would get and why.
- **Take over examples:** ready-made components with description and German and English keywords for IT support (workplace & PC, printers & scanners, email & calendar, network & Wi-Fi, VPN & remote access, user account & password, telephony & mobile devices, software & licences, servers & storage, website & intranet), facilities and administration/service.
- **List and reports:** filter and column *Component* in the ticket list (with a project selected); under *Reports* tickets, open ones and average resolution time per component.
- Components are only visible to agents. Deleting leaves the tickets untouched (the field becomes empty); archived components stay visible on old tickets but are no longer assigned. Moving a ticket to another project clears its component.
- The **Jira import** brings the (first) Jira component along and creates it in the target project if it does not exist yet.

**Tip – cutting components sensibly:** by responsibility, not by technology; 6–12 components rather than 40; each needs a responsible person; take keywords from real ticket titles and check them with the test field.

## Editing several tickets at once

In *All tickets* (agents):
- **Select:** checkbox in front of each row, "all" in the header, Shift+click for a range, `x` for the ticket highlighted with `j`/`k`.
- **Action bar:**
  - **Resolve** and **Status:** each with an optional comment – either a reply to reporters and participants or an internal note, with templates and per-ticket placeholders. With a reply there is no extra "resolved" mail.
  - **Comment:** reply or internal note for all selected tickets without changing the status.
  - **Link …:** link all selected tickets with one ticket, e.g. "is caused by IT-42"; optionally with status and comment right away. Existing links stay as they are.
  - **Assign**, **Priority**
  - **Move to another project**
- Every change goes into the ticket history. If one ticket fails, the others still go through and the message names it.

**Tickets are never deleted**, not even by admins, so that their history remains traceable. Finished work is set to “Done”. Against spam, use a sender rule “Ignore”. A project can only be deleted if its tickets are moved to another project; to keep it together with its tickets, archive it instead.

## Links and subtasks

In the ticket view (agents) under *Links* – or faster via **Link** at the top next to the status; on phones under *Details*. Many tickets at once are linked from the multi-select. The ticket field searches by number or keyword (title, description, comments); while it is empty there are suggestions: **possible cause** (open problems and major incidents) and **similar tickets** (the same striking words in title and description, without those already linked).

- **Link:** “relates to”, “duplicates”, “blocks” / “is blocked by”, “causes” / “is caused by”, “is subtask of” / “has subtask”. The other ticket shows the link automatically, both get a history entry. With “duplicates” the ticket can be set to “Done” right away.
- **Subtasks:** create them directly (a task in the same project) or put existing tickets underneath. A progress bar shows “x of y done”. A ticket has at most one parent, circles are rejected.
- Links are only visible to agents; at most 50 per ticket.

## Impact, urgency and major incidents

- **ITIL priority:** in the details, agents set *impact* and *urgency* (high/medium/low). Once both are set, the priority follows the matrix (e.g. high × high = Highest, medium × medium = Medium). It can still be changed manually.
- **Major incident:** mark an incident with many affected people using the *Major incident* button. All agents see it as a red notice at the top. Attach affected tickets via *Link → causes*. **Inform everyone affected** posts the same reply in the major incident and all open affected tickets, so every reporter and participant receives it by email. Optionally all of them are set to “Done” afterwards.

## Service level (SLA)

*Administration → Service level* (off by default):

- **Targets per priority** for the **first response** (first public reply by an agent) and the **resolution**, in business hours. Default: Highest 0.5 / 4 h, High 2 / 16, Medium 8 / 40, Low 16 / 80.
- **Business hours** (weekdays, start, end) and **public holidays** (one line per day, `2026-12-24 Christmas Eve`). No SLA time runs outside them; the container’s `TZ` applies.
- **“Waiting” pauses the resolution time** (can be turned off).
- Applies to incidents, requests and questions from users, not to tasks and agents’ own tickets and not to imported tickets.
- **Display:** the ticket view shows both clocks with time left, green, yellow from 80 % (configurable) and red when breached. The ticket list has an SLA column, the sidebar a **SLA at risk** view with a count.
- **Warning:** when the warning threshold is reached and when the target is breached, the assignee gets an email (without assignee the project lead), once each. The history records it.

## Problem management

- **Create a problem** from an incident via *Create problem*. It is linked to the incident right away. Only agents create problems; the sidebar shows open **problems** with a count.
- **Fields:** *root cause*, *workaround* and **known error** (root cause and workaround are known, the permanent fix is still pending).
- **Affected incidents** are attached via *Link → causes*. There agents see “Root cause known” with the workaround at the top and can use it as a reply with one click.
- **Inform incidents:** posts the same reply in all open affected incidents, e.g. once the fix is deployed.

## Change management

Ticket type **Change** (agents only), with its own section in the ticket:

- **Kinds:**
  - **Normal:** needs approval.
  - **Standard:** pre-approved routine from a template, no approval.
  - **Emergency:** implement immediately, approval afterwards.
- **Fields:** reason, risk, affected services and devices, planned start and end, implementation, backout and test plan.
- **Flow:** Draft → Awaiting approval → Approved/Rejected → Scheduled → Implementing → Review → Closed. The ticket status follows automatically. Missing required information is named at each step.
- **Approval (CAB):** approvers and rule (“one approval is enough” or “everyone must approve”) under *Administration → Change*. Approvers get an email and decide in the ticket (with a comment) or via the **My approvals** view. Every decision is in the history. After a rejection the change can be reworked and submitted again.
- **Standard change templates** (e.g. firmware update) under *Administration → Change*, applied in the change with one click.
- **Closing:** outcome “Successful”, “With issues” or “Rolled back”. For the latter two a post-implementation review is required.
- **Change calendar** in the sidebar: monthly view of all planned changes, overlapping time windows are marked red.

## Knowledge base

*Knowledge* in the sidebar; for users it is called *Help & knowledge*.

- **Articles** with title, category and formatted content. Visibility **internal** (agents only) or **public** (everyone signed in).
- **Editor:** edit in the final look with a toolbar: headings, bold/italic/underline/strikethrough, bulleted list, numbered list, checklist, quote, code block, info panel (note, tip, warning), table, divider, link (also to tickets like `IT-42` or articles `KB-3`), emoji and images. Images go in via Ctrl+V, drag & drop or button, with size and caption. Markdown shortcuts while typing (`# `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`), keyboard shortcuts (Ctrl+B/I/U/K/E/S). Pasting from Word or web pages keeps headings, lists, tables and links; images from external addresses are not taken over. The browser keeps unsaved changes as a draft. Stored as plain Markdown-style text, never HTML.
- **Table of contents** in the article view from three headings on.
- **Versions:** every save is a version (with an optional change note). *Version n · History* on the article lists all versions; two of them can be compared word by word (removed red, added green), older ones viewed and restored – this creates a new version, the history stays complete.
- **Templates:** “New article” starts with a choice: blank page, how-to, troubleshooting (FAQ), checklist, known error or a template of your own. Create your own templates in the editor with *Save as template* and manage them under *Knowledge → Templates*.
- **Page tree:** articles can sit below other articles (*Located under* in the editor, *Subpage* on the article, on a PC by dragging in the page tree; *New folder* creates a collection page without text of its own), at any depth. The start page shows the tree and recently changed articles; each article shows its path, the tree on the left (on phones behind *Pages*) and its subpages. Users only see public pages; a public page below an internal one moves up a level for them. Deleting moves subpages up one level. Moving creates no new version.
- **Print / PDF:** own print layout (title, path, date and content only; no breaks inside images, tables or info panels). With subpages you get one document with a table of contents, each page starting on a new sheet. Choose “Save as PDF” in the print dialog.
- **"Was this article helpful?"** 👍/👎 below every article, on desktop and phone: one vote per account, clicking again withdraws it. After 👎 people can briefly say what was missing – only agents see that (*Feedback* on the article). Agents see the rating in the article list; the *Needs rework* filter shows articles with 👎 votes, most first. After reworking, *Reset rating* sets the votes back to zero; the notes are kept as earlier feedback.
- **Comments:** anyone who can see an article can comment on it (including users on public articles). The author and last editor get an email, agents mark comments as done, your own can be deleted. The article list shows open comments.
- **Search** in title and content, title matches first; filter by category. Read count per article for agents.
- **Suggestions when reporting:** as a user types the summary in the “Create ticket” dialog, matching public articles appear (“Maybe this already helps”). They open without losing the report.
- **From a ticket:** *Knowledge article* in a ticket creates a draft with description, last reply and, for problems, root cause and workaround. Remove personal details before publishing. The ticket history links to the article.
- **Known errors:** tab with all problems marked as known error, including the workaround.

## Service catalog

Standard requests with their own form, e.g. “New employee”, “Software request” or “Access to a network drive”. Create them under *Administration → Service catalog*.

- **Form:** fields of type text, multi-line, choice, check box or date, each optionally required. The answers appear neatly in the ticket description (type *Request*).
- **Request a service** in the sidebar shows all offers as tiles to users and agents.
- **Approval (optional):** per offer you decide who has to agree and whether one approval is enough or everybody has to agree. Approvers can be people without the agent role, such as managers; they then only see the requests they decide on. They get an email and find open decisions under **My approvals**.
- **Result:** the decision is added to the ticket as a reply, so the reporter also gets it by email. A rejection closes the request.

## Devices & services

A lean register of IT equipment and services (CI register), for agents only: *Devices & services* in the sidebar.

- **Entries** with name (e.g. `PC-0001`), kind (workstation, server, network, printer, phone/mobile, service, application, other), status (in operation, in maintenance, retired), location, user or owner, IP address, serial number, vendor, model and description. Search covers all details; retired entries are hidden by default.
- **In a ticket** you link affected devices and services in the *Devices & services* section. This works for all ticket types, including changes (affected services) and problems. A number on the entry shows that more open tickets exist for it.
- **History per entry:** all tickets for a device or service at a glance, e.g. to spot recurring faults.
- **CSV import** (administrators) from your inventory tool: first line = column names (including name/hostname, type, location, IP address, serial number, vendor, model, user, status). Separator `;`, `,` or tab. Existing entries with the same name are updated.
- **Deleting** is for administrators only, and only possible while no tickets are linked. After that, set the entry to “retired”; the history is kept.

## Satisfaction survey

Switch it on under *Administration → Email → Satisfaction survey* (default: off).

- **In the “Resolved” email** the reporter gets five links from “very satisfied” to “very dissatisfied”. One click is enough, no sign-in needed. On the page they can still change the stars and optionally write a comment. Request participants get no links.
- **In the ticket** signed-in reporters can rate as well. Agents see the rating and comment at the top of the ticket; changes of the stars appear in the history.
- **Security:** each link contains a random token; only its hash is stored. The link is valid for a configurable number of days (default 14) and only shows the ticket key and title. If the ticket is reopened and resolved again, there is a new survey and the old link expires.
- **Results** under *Reports → Satisfaction*: average, response rate, distribution of stars, values per agent and the latest comments. Problems and changes are not surveyed.

## On a smartphone

On phones Helfi.Space opens automatically in its own app-like interface (under `/m`). Tablets and computers keep the familiar view.

- **Tab bar at the bottom:** *My work* or *Requests*, *Tickets* (agents), the round **＋** button, *Knowledge* and *Me*. Pages slide in like in an app; go back with the button, a swipe from the left edge or the back key. Pull lists down to refresh.
- **Report (＋):** report a problem with title, description, **Take photo** or **File**; agents also choose project, type and priority (as on the PC). While you type the title, Helfi.Space suggests matching knowledge articles. If there is a service catalog, its offerings appear as large tiles next to it – with all field types, required fields and approval. An unsent draft is kept until the tab is closed.
- **Ticket:** comments like a chat, reply bar at the bottom with photos and files; agents add the history (status, assignments …) via *All* – the phone remembers the choice. Agents also write internal notes, use templates, change status, assignee, priority, type and participants, link tickets and approve requests. Title and description can be changed by agents and by the reporter.
- **Knowledge:** search, categories, *Recently viewed*, *Most read* and the page tree to browse. Articles with a table of contents, sideways-scrolling tables and comments. Articles are edited on the PC (*Edit on desktop*). Users only see public articles.
- **Me:** name, email and password (local accounts), language, **two-factor authentication** right on the phone (secret key to copy and an *Open in authenticator app* button instead of a QR code, the QR code stays available for a second device; then the recovery codes to copy or share), what's new and *Desktop view*.
- **Install as an app:** iPhone/iPad: in Safari *Share* → *Add to Home Screen*. Android: in Chrome ⋮ → *Install app* (or the button under *Me → Install app*). Helfi.Space then starts full screen with its own icon; a small service worker keeps only the program files ready and shows a notice page without a connection. New versions arrive automatically ("New version – Reload").
- **Switching:** *Me → Desktop view* switches to the familiar view for good, *Phone view* in the user menu switches back. Pages that only exist on the PC (administration, reports, board …) open in the desktop view.
- **Privacy:** photos are uploaded without location data: camera photos (JPEG) are always re-encoded on the phone, which drops metadata such as the location (EXIF/GPS); large pictures (over 2560 px) are also downscaled. Pictures the browser cannot read (e.g. HEIC) are uploaded unchanged. Ticket data, attachments and server responses are **not** cached on the device (`Cache-Control: no-store`) – only the program files. Unsent drafts belong to the account and are deleted on sign-out, when the session expires and when another account signs in; the server deletes unsent uploads after a day. Nothing is loaded from the internet.

The desktop view stays usable on narrow screens too (menu as a drawer, lists as cards, full-screen dialogs).

## Emojis

In comments, descriptions and reply templates:

- **🙂 button** in the toolbar of the comment field (in other text fields at the bottom right): picker with search (English and German, e.g. "thumbs" or "printer"), groups and "Recently used".
- **While typing:** `:thu` suggests 👍 (arrow keys, Enter or Tab to accept, Esc to close). A complete short name such as `:tada:` turns into 🎉 right away. Times like `12:30` and addresses are left alone.
- **Classic smileys** are converted while typing as soon as a space follows (or when sending): `:)` → 🙂, `;)` → 😉, `:D` → 😄, `:(` → 🙁, `:P` → 😛, `:O` → 😮, `<3` → ❤️, `(y)` → 👍. Only when they stand alone, so `C:)` stays as it is. **Ctrl+Z** undoes the conversion right away.
- Emojis are shown with the operating system's emoji font; nothing is loaded from the internet. They arrive in emails as usual.

## Reply templates

For replies that are always the same (e.g. "Please restart your computer"):

- **Insert:** click **Template** in the comment box, type to search, press Enter or click to insert. The text goes to the cursor position and can still be edited before saving. Works for replies and internal notes. Only agents see templates.
- **Placeholders:** `{reporter}`, `{ticket}`, `{title}`, `{agent}` (German `{melder}`, `{titel}`, `{bearbeiter}`) are replaced when inserting.
- **Create:**
  - Write a text in the comment box and choose **Save as template**.
  - Admins manage templates for everyone under *Administration → Reply templates*.
  - Every agent manages personal templates in their *profile*; only they can see them.

## Reports

*Reports* (visible to all agents) shows who worked on and resolved how many tickets:

- **Period:** last 7, 30 or 90 days, this year or a custom range; optionally one project.
- **Key figures:** created, resolved, currently open.
- **Charts:**
  - "Resolved per agent"
  - "Created and resolved" per day, per week from 93 days; hover to see the values
- **Table per agent**, sortable by every column and downloadable as CSV:
  - **Resolved:** set to "Resolved" by that person (according to history)
  - **Open assigned:** current state
  - **Worked on:** tickets with an own change or comment
  - **Replies and internal notes**
  - **Avg. resolution time:** from "created" to "resolved"
- **By component** (once components are used): tickets created in the period, how many are open, and average resolution time; a click opens the filtered list
- **ITIL key figures** for the same period:
  - **Service quality:** resolved requests and incidents, resolved at first contact (at most one reply from IT, no follow-up question, never reopened), reopen rate, major incidents. IT's own tickets are not counted.
  - **SLA compliance** for response and resolution, overall and per priority (when SLAs are switched on)
  - **Changes per month:** kinds, rejected, outcomes, success rate and share of emergency changes
  - **Problems:** new, resolved, open, known errors
  - **Satisfaction** (when the survey is switched on)

## Keyboard shortcuts

`?` shows all shortcuts in the UI. They never fire while typing in a field.

| Where | Key | Action |
|---|---|---|
| everywhere | `c` | create ticket |
| | `/` | search |
| | `g` then `b` / `i` / `m` | board / all tickets / my work |
| ticket | `i` | assign to me |
| | `a` | choose assignee |
| | `m` | comment |
| | `e` | edit title |
| | `l` | edit labels |
| | `.` | actions with search (status, priority, type, template …) |
| | `Ctrl` + `Enter` | save comment |
| lists | `j` / `k` | next / previous ticket |
| | `o` / `Enter` | open selected ticket |
| | `x` | select the highlighted ticket (multi-select) |

`Enter` on a focused link or button activates it. `Enter` only opens the row highlighted with `j`/`k` when the focus is not on a control.

## Import from another ticket system

*Administration → Import*

Helfi.Space takes over tickets with comments and attachments from

- **Zammad** (REST API, access token),
- **Znuny / OTRS** (web service via the Generic Interface),
- **GLPI** (REST API `apirest.php`, GLPI 9.5 to 11),
- **Zendesk** (email and API token),
- **Freshdesk** (API key),
- **Jira** (cloud via REST API v3, Server/Data Center via v2), service management projects included,
- a **CSV file** – an export from any other system (e.g. osTicket, ServiceNow, Excel lists).

Credentials are not stored; they are only used for the running import. A CSV file stays in memory for at most two hours.

1. **Choose the source and connect:**
   - **Zammad:** address and access token (in Zammad under *Profile → Token Access*, permission `ticket.agent`), alternatively user name and password. The account needs read access to the groups.
   - **Znuny / OTRS:** once in Znuny, import the bundled example `GenericTicketConnectorREST` under *Admin → Web Services → Add web service*. In Helfi.Space enter the full web service URL, e.g. `https://tickets.example.local/otrs/nph-genericinterface.pl/Webservice/GenericTicketConnectorREST` (Znuny 7: `/znuny/` instead of `/otrs/`), plus login and password of an agent with read access to the queues. Newer (`POST /Ticket/Search`) and older web services (`GET /Ticket`) both work.
   - **GLPI:** enable the REST API in GLPI under *Setup → General → API*. Address up to and including `apirest.php` (e.g. `https://glpi.example.local/apirest.php`) and the account's personal token (*Settings → remote access key*), alternatively user name and password; an application token only if an API client with one is set up in GLPI. Entities become projects; followups and tasks become comments (private ones stay internal), solutions public comments, the category a label. Deleted tickets (trash) are left out.
   - **Zendesk:** address (`https://example.zendesk.com`), email and API token (*Admin Center → Apps and integrations → APIs → Zendesk API*). With an administrator account the incremental export also brings archived tickets, otherwise only the normal ticket list. Groups become projects, tags labels; private comments stay internal.
   - **Freshdesk:** address (`https://example.freshdesk.com`) and API key from the profile. Groups become projects, private notes stay internal. Freshdesk's list returns at most 30,000 tickets; for more, add a CSV export. Custom statuses (number 6 and up) appear as "Status 6" … and are mapped by hand.
   - **Jira:** cloud with address, email and API token; Server/Data Center with address and personal access token, alternatively user name and password.
   - **CSV file:** upload it (separator `;`, `,` or tab, UTF-8 or Excel encoding, at most 50 MB) and map the columns. Recognised columns (e.g. "Subject", "Status", "Email", "Created") are prefilled; only the title is required. A *project / queue* column spreads the tickets over several projects. Dates like `02.01.2026 09:05` or `2026-01-02 09:05` are recognised.
   - With an internal certificate, enter your own certification authority (PEM).
2. **Select projects** (groups in Zammad, Zendesk and Freshdesk, queues in Znuny, entities in GLPI, projects or values of the project column) and choose which Helfi.Space project they go into. If the project does not exist, it is created.
3. **Map:** distribute the source system's statuses and types over the four statuses and types of Helfi.Space. Suggestions are prefilled, e.g. "pending reminder" / "Waiting for customer" → Waiting, "closed successful" → Done, "Incident" / "Bug" → Incident.
4. **Import:** progress is shown. The import can be cancelled.

What is taken over:

- Title, description (as text, HTML mails are converted), type, status, priority, labels (Zammad tags), due date, created and resolved date
- **Comments:** in Zammad, Znuny and Zendesk the first article or comment visible to the customer is the description, all further ones become comments. Internal notes (Zammad "internal", Znuny "not visible for customer", internal comments from service desk projects and comments with restricted visibility) stay internal. From CSV: a *comments* column becomes one internal note.
- **Attachments** up to the chosen size. Files of an internal note are attached to that note and stay internal. Small embedded images (logos in signatures) and the HTML part of mails are skipped.

How numbers and people are handled:

- **Numbers:** `SUP-123` stays `SUP-123`, Zammad `#31011` becomes e.g. `SD-31011`. Very long numbers (date based, e.g. `2025030110000071` from Znuny) and numbers already taken get the next free one; so do numbers that belonged to a ticket moved elsewhere since. The old number appears in the history ("imported"). New tickets continue after the highest number.
- **People** are matched by email address. Reporters without an account become email contacts, and if the person later signs in via AD or SSO, the tickets belong to them. Assignees are only assigned if they are already agents in Helfi.Space (by email, login or a unique name), otherwise their name appears in the history. Cloud systems may withhold email addresses depending on privacy settings; then only the name is taken over.

Also:

- **No emails** are sent.
- **Protection against misuse (SSRF):** the import never connects to local addresses (`127.x`, `::1`), link-local addresses (`169.254.x.x`, e.g. metadata services of cloud servers) or multicast – not even via a name or a redirect pointing there. Systems in your own network (`10.x`, `172.16–31.x`, `192.168.x`) are reachable. If the source system really runs on the same machine and is only reachable via `127.0.0.1`, `HELFI_IMPORT_ALLOW_LOCAL=1` in the `.env` lifts the block.
- Before every import starts, Helfi.Space creates a backup (`helfi-vor-import-….sqlite`).
- **Repeatable:** a second run updates tickets that have changed in the source system since (the state from there wins; the changed fields appear in the history). Unchanged ones stay as they were edited in Helfi.Space. New comments and attachments are added, nothing is duplicated. So you can do a trial import before the switch and import once more on the cut-over day. For CSV files use the same *name of the source*; without a number column a row is recognised by title, creation date and reporter.

---

## Updates

### With a container manager (recommended)

**Dockhand**, **Watchtower** or **Tugtainer** detect new images of `ghcr.io/soleil0815/helfi.space.ticket:latest` and update the container. Recommendation: schedule updates **at night**. Helfi.Space backs up the database itself when a new version starts (`data/backups/helfi-vor-<version>-….sqlite`) and migrates it afterwards.

### Manually

```sh
./update.sh            # latest version
./update.sh 1.2.0      # specific version (recorded in .env)
./update.sh -y         # no prompts
./update.sh --cleanup  # list leftovers from earlier updates and delete them after confirmation
```

`update.sh` remembers the running version and pulls the new one. If the bundled `docker-compose.yml` is newer, it replaces the old one and keeps it as `docker-compose.yml.alt-<date>-<time>`. Then it starts the container and waits for the health check. If the new version does not start, it asks and restarts the previous version with the matching database backup (automatically with `-y`). It does not unpack or build anything. It runs with `/bin/sh`, on a Synology too. Messages are in German if the locale is German (e.g. `LANG=de_DE.UTF-8`), otherwise in English.

- **`docker compose up` fails** (e.g. invalid `docker-compose.yml`): `update.sh` reports an error, restores `.env` and `docker-compose.yml` and exits with code 1. If there is a previous version, it first asks whether to start it again (automatically with `-y`).
- **Still starting:** if the new version is still "starting" after `HELFI_UPDATE_WAIT` (e.g. database migration on large databases), `update.sh` asks whether to wait once more (automatically once with `-y`).
- **Going back:** afterwards `.env` holds the previous version again. If `update.sh` does not restore the database, it says so explicitly, e.g. if the backups are not readable for this user (then `sudo ./update.sh -y`) or if there is no backup or only an incomplete one (then the database has not been migrated yet).

### Cleaning up

Over time, older backup copies of `docker-compose.yml` and loaded image files from the release pile up in the folder. `./update.sh --cleanup` lists these files and only deletes them after confirmation (no prompt with `-y`). The newest `docker-compose.yml.alt-…` is kept.

Only files on this fixed list are deleted:

- older `docker-compose.yml.alt-…`
- `helfi-<version>[-amd64|-arm64].tar[.gz]`
- temporary files of aborted runs older than one hour
- a `docker-compose.yml.neu` that has already been taken over

Never touched: `data/`, backups, `.env`, `docker-compose.yml`, folders, links and files mounted into a container.

### Pinning a version and going back

1. Set `HELFI_VERSION=1.1.0` in `.env` (instead of `latest`).
2. If the newer version has already migrated the database, the older one will not start. It then tells you in the log which backup fits. In that case:
   ```sh
   docker compose down
   cp data/helfi.sqlite data/helfi.sqlite.neu
   cp data/backups/helfi-vor-1.2.0-<date>.sqlite data/helfi.sqlite
   rm -f data/helfi.sqlite-wal data/helfi.sqlite-shm
   docker compose up -d
   ```

### Without internet

Every release contains the image file (`helfi-<version>-amd64.tar.gz` or `-arm64`). Copy it to the server and run:

```sh
./update.sh --offline helfi-1.2.0-amd64.tar.gz 1.2.0
```

A relative path to the image file is taken from the current folder. Without a version, `update.sh` takes the version from the image and records it in `.env`; if it cannot be determined, it aborts without changing anything.

### Verify the origin (optional)

Every release is signed with build provenance: the image and the image files provably come from the CI run of this repository. Check with the GitHub CLI:

```sh
gh attestation verify oci://ghcr.io/soleil0815/helfi.space.ticket:1.2.0 --owner soleil0815
gh attestation verify helfi-1.2.0-amd64.tar.gz --owner soleil0815
```

The image files can also be checked against the release checksums with `sha256sum -c SHA256SUMS`.

### Your own changes to docker-compose.yml

`update.sh` only replaces `docker-compose.yml` if it is unchanged. If you have customized it (e.g. a different data path), it stays as it is. The new version is then placed next to it as `docker-compose.yml.neu`. After a failed update, `update.sh` restores the previous version, its database backup and the old `docker-compose.yml`. It also records the old version in `.env`, so Watchtower or Dockhand do not immediately pull the broken one again.

More variables for `update.sh`: `HELFI_UPDATE_WAIT` (time to wait for startup, default 120 seconds) and `HELFI_IMAGE_REPO` (your own registry). They are set on the command line, not in `.env`, e.g. `HELFI_UPDATE_WAIT=300 ./update.sh`. For your own registry, `image:` in `docker-compose.yml` must be changed too; the file then counts as customized and is no longer replaced automatically.

### Notice "docker-compose.yml is outdated"

The file has a version number (`HELFI_COMPOSE_VERSION`). If a new program version needs a newer file, Helfi.Space shows admins a notice. `./update.sh` takes over the new file automatically, or you download it from the release.

---

## Backup

- Automatic: daily, before every version change, before deleting a project and before every import starts, in `data/backups/`. If deleting a project is refused (e.g. last project), no backup is created.
- Each backup is first written as `….sqlite.part` and only renamed once complete. A `.part` file left behind after a crash is never used and is removed by the next clean-up after one hour.
- Manual: *Administration → System → Back up now*. That page also lists all backups with kind, date, size and the total space used; single backups can be deleted.
- **Back up as well:** the whole `data/` folder, including `secret.key`. Without this file, stored passwords (service account, mailbox, SSO) and 2FA keys can no longer be decrypted. Helfi.Space then does not start and says so in the log. Alternatively set `HELFI_SECRET` (at least 16 characters) in `.env`, but right at setup: switching between `secret.key` and `HELFI_SECRET` later makes stored data unreadable.
- The backups in `data/backups/` only contain the database. Attachments (`data/attachments/`) and `secret.key` live next to it. So always back up the whole `data/` folder to another drive.
- **Retention:** *Administration → System → Backups to keep* (default 10, 1–100). The number applies per kind: daily, manual, before version change, before project deletion and before import. Older ones are deleted, at least the newest of each kind always stays. Cleanup runs when saving, at startup and after every backup. `HELFI_BACKUP_KEEP_DAYS` is no longer used.

## Security

- Two-factor sign-in per RFC 6238. Each code is valid only once; after 5 failed attempts sign-in starts over. The key is stored encrypted, recovery codes only as a scrypt hash with its own salt per code.
- Passwords of local accounts are stored with scrypt. Stored credentials (service account, mailbox, SSO) are encrypted with AES-256-GCM and never sent to the browser.
- First-time setup is only possible with the setup code from the container log.
- After several wrong passwords, sign-in is slowed down. Session cookies are `HttpOnly` and `SameSite`, plus CSRF protection and a strict Content Security Policy.
- Empty passwords are never passed to the AD, because an anonymous bind would otherwise count as a sign-in. Input in LDAP filters is escaped.
- The container runs without root rights (`PUID`/`PGID`, 0 is not allowed), with a read-only program part, without extra Linux capabilities and with `no-new-privileges` (see `docker-compose.yml`). Files in `data/` are readable only by this user.
- Attachments are served as downloads (only images are shown directly), so uploaded files never run in the context of Helfi.Space.
- Stored passwords stay bound to their connection: anyone who changes server, port, encryption, service account or user, issuer or client ID for AD, IMAP, SMTP or SSO, weakens the certificate check (including “Fetched certificate” → “System certificate authorities”) or stores a different AD certificate, must enter the password or secret again in the same step, otherwise nothing is saved. This way a stored secret never goes to a different server. Connection tests with a changed server or a weakened check do not send the stored password either.
- Disabled accounts get the same message at sign-in as for a wrong password.
- The image contains only what runs: no Node package tools (npm, yarn, corepack), and only the database driver binary for its own platform. Every release is checked with Trivy before publishing; in addition, the CI checks the published image every Monday and opens an issue as soon as fixable vulnerabilities (high/critical) appear – then a new release helps.
- **Found a vulnerability?** Please do not open a public issue, report it confidentially – see [SECURITY.md](SECURITY.md).

## Development

```sh
npm install
npm run dev                  # http://localhost:8080, data in ./data
npm test                     # unit, API and update.sh tests
sudo scripts/test-samba-ad.sh && HELFI_TEST_LDAP_HOST=dc01.firma.local npm run test:integration
```

Rebuild the manual (after changes in `docs/manual/`): `npm install --no-save playwright && npx playwright install chromium && node scripts/build-manual.mjs`.

Structure: `src/` server (Express, better-sqlite3), `public/` UI (plain JavaScript without a build step), `src/i18n.js` and `public/js/i18n.js` for the texts (de/en).

What's new: `src/news.json`, per version items for `all`, `agent` or `admin` (de/en). New items go into an entry with `"version": ""` (create it at the top if there is none) – a number is never filled in by hand: at release, `scripts/news-versions.mjs` assigns each item, based on the release tags, to the version it was first shipped with; new items get the version being built. So nothing needs to be done after a release. Users see the items once after the update, all versions are listed under *What's new*.

Releases: *Actions → CI → Run workflow*, branch `main`, choose `patch`, `minor` or `major` under "Release". The version counts up by itself (highest tag + 1), no need to edit `package.json`. CI tests, builds the images for amd64 and arm64 natively, scans for vulnerabilities and only then creates the tag, images and GitHub release. This is the only way to a release: a manually pushed tag starts nothing. Only one release runs at a time; exactly the scanned image (same digest) is published. The base image is pinned by digest; Dependabot proposes new digests weekly.

Economical CI: pull requests always run the tests; the AD integration test only when sign-in/AD code, dependencies or the workflows changed, image build and vulnerability scan only when not only documentation changed (`.github/scripts/changes.sh`). A new push to the same PR cancels the older run. After a merge to `main` only the image is built (keeps the build cache warm) – a release runs all checks again anyway. Every job has a time limit; Dependabot bundles minor updates into one PR per week.

## License

MIT – see [LICENSE](LICENSE).
