# Mail

How the Worker sends mail: the mailer, its stub, the templates, the caps and the kill flag. It is
the groundwork for email accounts (sign-up by code, forgot password, security notices).

**Nothing sends mail yet.** No route calls the mailer. The routes that do come with the email
accounts, and each one goes through `chooseMailer`, so the rules below already hold for them.

| File | What it holds |
|---|---|
| `server/src/mail.ts` | `chooseMailer`, the live mailer and the stub, `composeMail`, `deliver`, `linkOrigin`, `emailAvailable`, the dev outbox (`isDevAuth`, `devMailResponse`) |
| `server/src/mailTemplates.ts` | Every message (M1 to M12) in Spanish and English, text and html: `renderMail`, `mailLink`, `mailLang`, `formatMailDate` |
| `server/src/mailCaps.ts` | The kinds and their lanes, the day's cap and its shares, the per-address, per-network and per-account caps, the sign-up pause, the kill flag |
| `server/test/mail.test.mjs` | The tests, one per rule on this page |

## When mail is real

`chooseMailer(request, env)` returns the live mailer only when **all** of these hold:

1. the `EMAIL` binding exists (`send_email` in `server/wrangler.jsonc`);
2. the `MAIL_LIVE` secret is exactly `1` (set only in production);
3. `MAIL_FROM` is a sender address;
4. the request's host is **not** loopback (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`).

Otherwise it returns the stub, which sends nothing:

- on a loopback host it keeps the last 20 messages of the isolate (for `GET /api/dev/mail`) and logs
  `[mail stub] <kind> to an***@x.com <link>`, so a developer can open the link;
- anywhere else (a deploy without `MAIL_LIVE`) it keeps nothing and logs only the kind.

`src/mail.ts` is the only file that may read `env.EMAIL`, and only inside `chooseMailer`; a test fails
otherwise. So no code path can send without passing those conditions.

## Local development, tests, CI and forks: no login, no real mail

`wrangler dev` never sends real mail and needs no Cloudflare account:

- **The binding has no `"remote": true`.** Wrangler then simulates `send_email` locally: a call
  writes the message to a file under `.wrangler/tmp/email/` and logs `send_email binding called
  with MessageBuilder`. With `"remote": true`, `wrangler dev` would open a remote session (which
  needs a login) and send real mail. A deploy binds the real service either way: wrangler leaves
  the flag out of what it uploads. A test fails if the flag appears in `wrangler.jsonc`.
- **`wrangler dev` is always loopback,** so even a `MAIL_LIVE=1` that slipped into `.dev.vars` or a
  `.env` file (wrangler loads both) still gives the stub.
- **Never put `MAIL_LIVE` in `.dev.vars`, `.env` or `wrangler.jsonc`.** A test checks the committed
  files.
- The node tests use a fake binding that records what it is handed; nothing in them reaches the
  network.

Checked with wrangler 4.150 and no Cloudflare credentials: `wrangler dev` starts, lists
`env.EMAIL (unrestricted) Send Email local`, and a direct `env.EMAIL.send()` writes a local file.

**Forks:** a fork without Email Service on its own domain can remove the `send_email` entry from
`wrangler.jsonc`. Without the binding every mail goes to the stub, and the flows that need mail stay
hidden (`emailAvailable` is false).

## Sender, format, headers

- **From:** `MAIL_FROM`, `Turbogol <no-reply@turbo-gol.com>`, on the verified sending domain (DKIM
  and SPF align, so DMARC `p=reject` passes). No Reply-To: help goes through Discord.
- **One recipient per message,** always. No CC, no BCC, never a batch, so nobody's address is shown to
  anyone else. `composeMail` and the live mailer refuse anything that is not exactly one address.
- **Body:** a text part and a small html part (`<html lang="es">` or `"en"`), about 2 to 3 KB:
  paragraphs, the code as text in large type, the link as an `<a>` with descriptive text and the URL
  also written out. No images, tracking pixels, click tracking, remote fonts, style sheets, scripts
  or external links; inline styles only.
- **Headers:** `Auto-Submitted: auto-generated` (RFC 3834), `X-Auto-Response-Suppress: All` and a
  random `X-Entity-Ref-ID` per message, so Gmail never threads separate codes together. Email Service
  accepts `Auto-Submitted` and any `X-` header. No `List-Unsubscribe`: this mail is transactional.
- **Footer:** `— Turbogol · turbo-gol.com` and "Este correo es automático: no lo respondas." / "This
  is an automatic email: please don't reply." The host is `LINK_ORIGIN`'s.
- **Values** (names, the masked address) are cleaned of control characters and bidi overrides,
  and escaped in the html. They also never become links: "tg-verify.com" and "www.x.gg" are valid
  usernames, and mail clients link bare domains, so an attacker's account name would be a live link
  in a signed mail from turbo-gol.com. A WORD JOINER (U+2060, invisible) goes on both sides of every
  `.`, `:`, `/`, `\`, `@` and full-width full stop of a value, and the html puts each of those in its
  own `<span>`. The name reads the same; no client finds a domain or a `www.` or `http://` start in
  it. The tests check every template with such names for any domain but `LINK_ORIGIN`'s host.
- **M7's move code** is typed "en el juego, en esa cuenta" / "in the game, on that account", never
  "there", and the mail says never to share it, as every other code mail does.

## Language and dates

| Mail | Language |
|---|---|
| Codes, links and resets to the person who asked | The account's `lang`, else the request's, else English |
| A mail to an address whose account did not ask | That account's `lang`, else the request's |
| Security notices (M4, M6, M8, M9, M12) | Both languages, the account's first. The subject reads "first · second", and a line `— English —` or `— Español —` opens the second version |

- With the account's time zone, a date carries the time and the zone's short name ("29 de octubre de
  2026 a las 22:04 GMT-3"). Without one it is the date alone, in UTC, so a player at UTC-3 never
  reads a time three hours ahead. A deletion date and the cutoff are always the date alone.
- The Spanish is neutral (tú, never voseo). The test applies `tests/i18n-es.test.mjs`'s check and
  `tests/i18n-copy.test.mjs`'s rules to every rendered message, and fails if those files change their
  rules without the mirror in `mail.test.mjs`.

## Links

- `${LINK_ORIGIN}/account#<kind>=<token>`, where `<kind>` is `verify`, `email`, `reset`, `undo`,
  `keep` (cancel a deletion) or `unsub`. `${LINK_ORIGIN}/account#forgot` carries no token.
- **The token sits in the fragment.** Browsers never send it to a server or in a `Referer`, so it
  never reaches Workers Logs or analytics. A GET consumes nothing: links open the game, and a POST
  after a button press uses them, so mail scanners that prefetch links use nothing.
- **`LINK_ORIGIN`** (`linkOrigin`): in production the `MAIL_LINK_ORIGIN` var (`https://turbo-gol.com`);
  on a loopback host the request's own loopback `Origin`, else `http://localhost:5173`. Never the
  `Host` or any other header: a test renders every message under a hostile `Host` and `Origin` and
  checks every URL. A production request without the var gets no origin, and its route answers 503
  `email_unconfigured`.
- Templates never take a URL from the caller: they build each one from the origin and a token, which
  must be base64url.

## The messages

| # | Kind | Lane | Link | Sent when |
|---|---|---|---|---|
| M1 | `verify_signup` (variant: a provider hint) | signup | `verify` | A sign-up starts: the 6-digit code and the link |
| M2 | `signup_exists` (variants `reset`, `held`) | signup | `reset` | A sign-up with an address that already has an account |
| M3 | `reset` (variants `reset`, `create`) | account | `reset` | Forgot password, or create a first password |
| M4 | `password_changed` | notice | `#forgot` | The password changed |
| M5 | `verify_email` | account | `email` | An email is added or changed: the code to the new address |
| M6 | `email_changed` | notice | `undo` | The email changed: to the old address, with the 7-day undo |
| M7 | `email_in_use` (variants `move`, `only`, `held`) | account | none | An add or change aimed at another account's address |
| M8 | `provider_linked` (variants `linked`, `unlinked`) | notice | none | Google or Discord linked or unlinked |
| M9 | `deletion_scheduled` | notice | `keep` | A deletion was asked for |
| M10 | `legacy_reminder` | account | `reset` | 7 days before the username cutoff (optional) |
| M11 | `reauth_code` | account | none | "Confirm it's you" by a mailed code |
| M12 | `email_moved` | notice | none | An address moved to another account |

The copy is the sign-in design's, word for word. The codes lead the subject of M1, M5 and M11, so a
phone shows them on its lock screen.

## Caps, lanes and failures

All counters will live in AccountsDO's SQLite (exact, global, they survive deploys). `mailCaps.ts`
holds the numbers and the rules:

- **The day's cap, split into lanes.** A lane may send while the day's total across all lanes is
  below its share of `EMAIL_DAILY_CAP` (default 100; set it to 80 % of the account's quota once the
  Email Service dashboard shows it):

  | Lane | Mail | Sends while the day's total is below |
  |---|---|---|
  | signup | M1, M2 | 60 % |
  | account | M3, M5, M7, M10, M11 | 90 % |
  | notice | M4, M6, M8, M9, M12 | 100 % |

  A flood of sign-ups can only use up sign-up mail: resets, codes and notices still go.
- **Per address, network and account:** mail to one address, 5 an hour and 10 a day (notices apart:
  5 a day per account); mail started by anonymous routes, per IPv6 /64 10 an hour and 30 a day, per
  IPv4 address 200 and 600 (schools, LAN parties and carriers' CGNAT put many players behind one
  address); mail started by an account, 10 a day; resends, one a minute and three per attempt, each
  with the same code and link.
- **Failures.** A route sends after it has answered (`ctx.waitUntil`). A failed send logs
  `mail_failed kind=<kind> lane=<lane> err=<code>`, with no address, link or code, and is not
  retried (a retry would mail a second code). Ten failures in ten minutes pause the sign-up lane for
  30 minutes; the account and notice lanes never pause by themselves and raise one ALERT per 30
  minutes instead.
- **The kill flag:** KV `email_off` (`1`, `true` or `on`) stops every lane within a minute, with no
  deploy: `npx wrangler kv key put email_off 1 --binding FLAGS --remote`, and `kv key delete` undoes
  it. `emailAvailable` is then false, so the game stops offering the flows that mail.

## Deploying

1. The `send_email` binding and the vars `MAIL_FROM`, `MAIL_LINK_ORIGIN` and `EMAIL_DAILY_CAP` ship in
   `wrangler.jsonc`. Email Service must be onboarded for the sending domain (it is for
   turbo-gol.com).
2. Nothing sends until a route calls the mailer **and** the `MAIL_LIVE` secret is `1`:
   `npx wrangler versions secret put MAIL_LIVE` (it ships with the next deploy), when the first mail
   route ships.
3. Read the account's daily quota in the Email Service dashboard, set `EMAIL_DAILY_CAP` to 80 % of
   it, and ask Cloudflare for a higher quota before announcing the game.

## A future newsletter

Email Service is meant for transactional mail. News would go from another provider, on a subdomain
such as `news.turbo-gol.com` signed with that provider's DKIM key at `d=news.turbo-gol.com` (relaxed
alignment passes the inherited `p=reject`), so the reputation of transactional mail stays apart.
The audience is the accounts that opted in; unsubscribing goes through the Worker, with a
`List-Unsubscribe` one-click URL that carries an opaque id and can only unsubscribe.
