# Sending Domain + Inbox Warming Setup — Delegation Guide

> For whoever is setting up the SAGA outbound sending infrastructure. Follow this top-to-bottom. Total clock time: ~45 min of work + 14–21 days of warming that happens in the background.

---

## Why this matters (read this first)

S.P.A.M. sends cold B2B outreach to Canadian SMBs. **Deliverability is the silent killer** — even a perfectly-written pitch lands in spam if the sending infrastructure has poor reputation.

We're building a **secondary** sending domain (not `runna.ca` or SAGA's primary) so that:
1. **If warming goes badly or we get a spam complaint, Rünna's main domain is untouched.** Protecting the mothership.
2. **New domains have zero sender reputation** — they need 2–3 weeks of "warming" (real human emails to real humans) before any automated sending. Starting the clock *today* means we can send real pitches ~3 weeks from now. Starting next week means 4 weeks. Starting in a month means 2 months.
3. **CASL requires** a valid physical mailing address on every commercial email and a working unsubscribe. This is baked in at the domain level.

**If you skip or shortcut this step: 100% of pitches land in spam, bounce rate skyrockets, Google throttles the account, and the engine is dead on arrival.** This is not optional.

---

## Total cost

| Item | One-time | Monthly |
|---|---|---|
| Domain registration | ~$12 CAD/yr | — |
| Google Workspace Business Starter | — | ~$9 CAD/user/mo |
| Mail-Tester (optional paid checks) | — | free first 3, then $17/mo if you want unlimited |
| **Total year 1** | **~$12** | **~$108** | 
| **Year 1 grand total** | **~$120 CAD** | |

For comparison: one junior SDR costs $60–80k/yr. This is < 0.2% of that.

---

## Total time

- **Active work:** ~45 minutes of clicks (one person, one sitting)
- **Warming:** 14–21 days running in the background — 5 minutes/day of manual email sending by sender #1

---

## Before you start — decisions Pedro must make

These need Pedro's sign-off *before* the delegate starts clicking. Lock them in first.

### Decision 1: Who is sender #1?

The person whose name appears on every email. Must be a **real human** with a **real LinkedIn profile** that matches.

- ✅ Good: Founder, partner, BD lead, or principal at SAGA. Someone who actually works there and can credibly reply to "hi, are you the right person about X?"
- ❌ Bad: A persona ("James from SAGA" with no LinkedIn). Outreach@ or info@ addresses. Someone who's not actually reachable.

**Pedro to confirm:** Name, title, LinkedIn profile URL.

### Decision 2: Domain name

Must be a secondary domain (not `runna.ca`). Should be brandable, short, and believable. Recommended options:

| Domain | $/yr | Vibe | Notes |
|---|---|---|---|
| `sagareach.com` | $12 | Functional, clear | Readable, outbound-feel |
| `saga.run` | $40 | Short, clever | `.run` is $40/yr on Porkbun |
| `sagareachout.com` | $12 | Explicit | A bit wordy |
| `sagamarketing.ca` | $15 | Canadian + topical | `.ca` gives geo trust to CA prospects |
| `sagastudio.ca` | $15 | Neutral | Less "outbound-y" feel |

**Pedro's call:** pick one. I recommend **`sagareach.com`** — cheap, clear, and the `-reach` suffix is common for B2B outbound without being spammy.

### Decision 3: Physical mailing address (CASL requirement)

Every commercial email sent to a Canadian prospect must include a valid physical mailing address. Options:

- SAGA's actual Canadian office address (if one exists)
- Rünna's Canadian virtual office / coworking space address
- A virtual office in Calgary or Vancouver ($25–50/mo services like Regus, iPostal1)

**Pedro's call:** which address goes on the footer? Needs to be a real address a postal carrier could deliver mail to.

---

## Step-by-step (for the delegate)

### STEP A — Buy the domain (5 min, ~$12)

**What to do:**
1. Go to [Porkbun.com](https://porkbun.com) (or Namecheap — either works; Porkbun is cheaper and has free WHOIS privacy)
2. Search the domain Pedro picked
3. Add to cart → checkout
4. **Enable WHOIS privacy** (Porkbun includes this free; some registrars charge extra — it's worth it)
5. **Enable auto-renew** (don't let the domain expire mid-warming)
6. Pay (credit card)

**Why:** Owning the domain lets us configure DNS (the keys to deliverability).

**What to capture:**
- Domain purchased ✅
- Login credentials for the registrar (save in 1Password / shared vault)
- Registrar-side DNS management URL

---

### STEP B — Sign up for Google Workspace (10 min, ~$9/mo)

**What to do:**
1. Go to [workspace.google.com](https://workspace.google.com)
2. Click "Get started"
3. Pick **Business Starter** ($9 CAD/user/mo — 30 GB mail + shared drives + Meet + Calendar)
4. Enter business details (use Rünna's Canadian entity or SAGA as the business name)
5. **When asked "Do you already have a domain?"** → YES → enter the domain you just bought
6. Create the admin account with a temporary username (e.g. `admin@sagareach.com`)
7. Pay (credit card — note this is in addition to the domain purchase)

**Why:** Google Workspace gives you proper G-suite infrastructure. It handles the mail server, spam filtering on receive, and most importantly — Gmail API access we need in Phase 4.5. Alternative ESPs exist but Gmail API has the best B2B reply-rate baseline.

**What to capture:**
- Google Workspace admin email
- Admin login password (save securely)
- Workspace domain confirmation ✅

---

### STEP C — Verify domain ownership (5 min)

**What to do:**
1. In Google Workspace setup, Google will ask to verify domain ownership
2. It gives you a **TXT record** starting with `google-site-verification=...`
3. Log into the registrar (Porkbun / Namecheap)
4. Go to DNS settings for your domain
5. Add a TXT record: Type=`TXT`, Host=`@` (or blank), Value=`google-site-verification=XXXX...`
6. Save → wait ~5 minutes
7. Return to Google Workspace → click "Verify"

**Why:** Google needs to confirm you actually own the domain before routing mail for it.

**What to capture:**
- Verification complete ✅ (screenshot of green checkmark)

---

### STEP D — Configure mail DNS (15 min, CRITICAL)

This is the step that matters most for deliverability. Mess it up and everything else is wasted money.

You need to add **four** DNS records. Google Workspace provides the values; you paste them into the registrar.

#### D1. MX records (incoming mail)

Google's setup wizard provides these. Typically:

| Priority | Host | Value |
|---|---|---|
| 1 | @ | smtp.google.com |

(Older Google Workspace docs show 5 records — the current recommended setup is a single one. Follow whatever the admin wizard tells you.)

**Why:** Routes incoming mail to Google's servers.

#### D2. SPF record (who's allowed to send as us)

Add a TXT record:
- Host: `@` (or blank)
- Value: `v=spf1 include:_spf.google.com ~all`

**Why:** Tells receiving mail servers "only Google's servers are authorized to send as us." Without this, anyone can spoof your domain.

#### D3. DKIM (cryptographic email signing)

1. In Google Workspace Admin: **Apps → Google Workspace → Gmail → Authenticate email**
2. Click "Generate new record" → leave key at 2048-bit
3. Google gives you a long TXT record — copy it
4. At the registrar: add TXT record with Host=`google._domainkey` and the Value provided
5. Wait 5 min → back in Google Admin → click "Start authentication"

**Why:** Every outgoing email is cryptographically signed. Receiving servers verify the signature to confirm the message wasn't forged. Without DKIM, Gmail and Outlook dramatically downrank your sends.

#### D4. DMARC (what to do if SPF/DKIM fail)

Add a TXT record:
- Host: `_dmarc`
- Value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@sagareach.com; pct=100; adkim=s; aspf=s`

(Replace `sagareach.com` with your actual domain.)

**Why:** DMARC tells receiving servers what to do with mail that fails SPF or DKIM (quarantine it). The `rua=` email receives aggregated reports so you can see who's trying to spoof your domain. **Start with `p=quarantine`** — after 2 weeks of clean data, upgrade to `p=reject`.

**What to capture:**
- Screenshot of DNS records list at registrar showing MX, SPF, DKIM, DMARC all in place
- Screenshot of Google Admin showing DKIM "Authenticating email" = green

---

### STEP E — Verify everything is set up correctly (5 min, FREE)

Before doing anything else, run a deliverability check:

1. Open [mail-tester.com](https://www.mail-tester.com) — free, no signup
2. It shows you a unique email address like `test-abc123@mail-tester.com`
3. Log into your new Gmail (at `admin@sagareach.com` or whatever you created)
4. Send a test email to that address with **Subject: "Test"** and a one-paragraph body (write something human — not "hi test")
5. Go back to mail-tester.com → click "Then check your score"
6. **Target: 10/10.** Anything less, fix what it tells you to fix.

**Why:** Mail-Tester checks SPF, DKIM, DMARC, DNS reverse-lookup, content spamminess, and about 20 other things. A 10/10 score means receiving mail servers will not automatically junk your mail. A score below 9 means something's wrong with DNS — fix it before warming.

**What to capture:**
- Screenshot of 10/10 score (or note what's wrong and fix)

---

### STEP F — Create sender #1's mailbox (5 min)

**What to do:**
1. Google Workspace Admin → Directory → Users → Add user
2. First name + Last name: sender #1's real name
3. Primary email: `first.last@sagareach.com` (keep it human — not `outreach@` or `sales@`)
4. Let Google generate a secure password, force password reset on first login
5. Send the login credentials to sender #1 securely (1Password share, not email)

**Why:** Sender #1 sends from their own inbox, not a shared one. Reply deliverability and LinkedIn trust depend on sender #1 being a real reachable human.

**What to capture:**
- Sender #1 email address
- First-login completed confirmation from sender #1

---

### STEP G — Match LinkedIn identity (10 min)

This is easy to overlook and is the #1 conversion killer we've seen in outbound.

**Sender #1 does this personally:**
1. Log into LinkedIn
2. Update profile:
   - Photo: professional headshot
   - Headline: current role at SAGA (e.g. "Partner @ SAGA · Creative Strategy for Canadian SMBs")
   - About: short paragraph about what SAGA does
   - Experience: make sure SAGA is listed as current role
3. Add a link to the SAGA website (or Rünna's site) in the Contact Info section
4. **The email `first.last@sagareach.com` does not need to be on LinkedIn publicly** — but sender #1's full name must match between email and LinkedIn

**Why:** When a prospect gets an email from "Pedro Torres at SAGA," their first move is to Google the sender. If LinkedIn shows a blank profile, a different company, or nothing — reply rate drops 60%+ . Real sender, real LinkedIn, matching identity.

**What to capture:**
- LinkedIn profile URL for sender #1
- Screenshot of profile showing SAGA role

---

### STEP H — Start warming (14–21 days, 5 min/day)

This is the most important part and the most boring. Sender #1 must do this personally. **No automation during warming.** Automation kills warming — the whole point is teaching Gmail / Outlook / receiving servers that this inbox is a human with human sending patterns.

#### Daily warming protocol (weekdays only, 5 min/day)

**Week 1 (days 1–7): Send 3–5 emails per day to real humans.**
- Mix of: replies to newsletters you read, emails to existing Rünna contacts, emails to SAGA team members, LinkedIn friends you can say hi to.
- Each email: 2–4 sentences. Normal human tone. NOT a pitch, NOT a template.
- Ask questions in some of them so recipients reply (inbound replies boost reputation fast).
- Receive at least 2–3 replies per day. If you don't get replies, send to people you know will reply.

**Week 2 (days 8–14): Scale to 8–12 emails per day.**
- Same kinds of recipients, more of them.
- Still zero automation. Still zero cold pitches.
- If you have SAGA/Rünna contacts, send them a quick "hey, launching a new outbound initiative, would love a quick call" kind of email. Conversational, no template.

**Week 3 (days 15–21, if needed): Scale to 15–20 emails per day.**
- Start including small amounts of content you'd send in real outreach — a link to a case study, a mention of a Rünna client — but still framed conversationally.
- End of week 3: ready for Phase 4 automated warming ramp (30/day → 300/day over 5 weeks, managed by the engine).

#### Warming rules (all weeks)

- ✅ Send **only** weekdays, between 9am and 6pm local time
- ✅ Reply to incoming messages (even spam that landed in your inbox) — reply rate is a signal
- ✅ Mark non-spam emails in your Spam folder as "Not spam" — trains the receiving end
- ✅ Archive and label mail you read — shows engagement
- ❌ **DO NOT** send mass emails, bulk BCC, or anything that looks templated
- ❌ **DO NOT** connect this inbox to any automation tool, not even Mailchimp, not even a drip sequence
- ❌ **DO NOT** send the same message to 5 different people — receiving servers detect this
- ❌ **DO NOT** skip days (inconsistent sending hurts)

**Why:** Gmail, Outlook, Yahoo, and every other receiving server watches new sending domains closely for 30–60 days. They're looking for patterns: Does this sender get replies? Does this sender send at human times? Is the content varied? Are there any spam complaints? Answering those questions the right way is what "warming" literally means.

**What to capture:**
- Daily log (just a shared Google Doc or Notion page): date + count of sends + count of replies received. Share with Pedro weekly so he can confirm warming is on track.

---

### STEP I — Re-verify deliverability at end of Week 2 (5 min, FREE)

Before Phase 4 sends start, run Mail-Tester again:

1. mail-tester.com
2. Same process as Step E
3. Target: **still 10/10**
4. Also check [Google Postmaster Tools](https://postmaster.google.com) — add your domain, wait a day, then review Sender Reputation dashboard

**Why:** Warming might have introduced issues. Re-verify before we automate sends.

---

## What to deliver back to Pedro / me

When all steps are done, send this to Pedro (and he relays to me to put in `.env.local`):

```
SAGA_FROM_EMAIL=first.last@sagareach.com
SAGA_SENDER_NAME=First Last
SAGA_MAILING_ADDRESS=<full physical address for CASL footer>
SENDER_1_LINKEDIN_URL=https://linkedin.com/in/first-last
DOMAIN_REGISTRAR=<e.g. Porkbun>
WORKSPACE_ADMIN_EMAIL=admin@sagareach.com
MAIL_TESTER_SCORE=<10/10 screenshot>
DMARC_REPORT_EMAIL=dmarc@sagareach.com
```

Plus:
- Confirmation screenshot: Mail-Tester score 10/10
- Confirmation screenshot: Google Admin DKIM status = "Authenticating email"
- Confirmation: warming daily log started

---

## Timeline summary

| Day | Milestone |
|---|---|
| **Day 0 (today)** | Buy domain, set up Workspace, configure DNS, create sender #1 mailbox, Mail-Tester 10/10, update LinkedIn |
| **Day 1–7** | Week 1 warming: 3–5 sends/day |
| **Day 8–14** | Week 2 warming: 8–12 sends/day |
| **Day 14** | Re-run Mail-Tester, confirm Postmaster Tools = green |
| **Day 15–21** | Week 3 warming: 15–20 sends/day (optional, stretch) |
| **~Day 21** | Ready for Phase 4 engine-managed warming ramp |
| **~Day 28** | First real cold pitch goes out |

If you start today (2026-04-22), first real pitch goes out ~2026-05-20. If you delay a week, slide everything a week right.

---

## Red flags to escalate to Pedro immediately

- ❗ Mail-Tester score below 9/10 after DNS setup — something's configured wrong
- ❗ DKIM status in Google Admin shows "Not authenticating email" after 24 hours
- ❗ Any bounce-back emails during warming ("your mail was rejected")
- ❗ Sender #1 lands any warming email in someone's spam folder and they tell you about it
- ❗ DMARC report emails showing hundreds of spoofing attempts (some is normal; floods are not)
- ❗ Google Postmaster Tools shows IP reputation = "Low" at end of Week 1

---

## Quick-reference: what NOT to do

- ❌ Don't use runna.ca as the sending domain
- ❌ Don't use `outreach@`, `sales@`, `hello@`, `info@` — must be a real human's name
- ❌ Don't skip DKIM (most common mistake — it takes 15 min but is make-or-break)
- ❌ Don't set DMARC to `p=reject` on day 1 (use `p=quarantine` for first 2 weeks; upgrade after)
- ❌ Don't connect to any automation during warming
- ❌ Don't send test emails to your own other addresses and call it warming (receiving servers know)
- ❌ Don't rush warming past 7 days
- ❌ Don't skip the physical mailing address (CASL fine up to $10M for corporations)
