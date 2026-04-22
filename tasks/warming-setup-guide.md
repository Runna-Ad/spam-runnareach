# Sending Domain + Inbox Warming Setup — Delegation Guide

> For whoever is setting up the Runna CA outbound sending infrastructure. Follow this top-to-bottom. Total clock time: ~45 min of work + 14–21 days of warming that happens in the background.

---

## Decisions already locked in

No decisions to make on these — they've been signed off. Proceed as written.

- **Public brand name:** **Runna CA** (the Canadian arm of Rünna)
- **Primary brand domain:** **`runna.agency`** — website, team email, client comms, public marketing. Rünna's Canadian face to the world.
- **Secondary outreach domain:** **`runnareach.com`** — used **only** for S.P.A.M. cold outreach. Kept isolated from the brand domain so that any deliverability hit does not affect client comms.
- **Google Workspace:** **added as a secondary domain inside Rünna's existing Google Workspace account.** No new standalone Workspace account needed — one Workspace can host multiple domains.

---

## Why this matters (read this first)

S.P.A.M. sends cold B2B outreach to Canadian SMBs. **Deliverability is the silent killer** — even a perfectly-written pitch lands in spam if the sending infrastructure has poor reputation.

We use two domains on purpose:

1. **`runna.agency`** — the primary brand domain. Client comms, website, proposals, invoices. This domain's reputation must stay clean.
2. **`runnareach.com`** — the secondary outreach domain. All cold pitches send from here. If it takes a reputation hit (spam complaints, bounces), it's isolated from `runna.agency`.

**If you skip the split and send outreach from `runna.agency`**: one bad week of deliverability can tank client-email reputation for 30–60 days. Rünna's 12-year brand moat is protected by the $12/yr secondary domain. This is not optional.

**Warming takes 14–21 days minimum.** A newly-provisioned mailbox has zero sender reputation. Google, Microsoft, and Yahoo watch new senders closely for 30–60 days. Sending automated cold mail from a cold inbox = spam folder. Warming means: real humans sending real emails to real humans, with real replies, at normal human volumes, for two weeks before any automation.

---

## Total cost

| Item | One-time | Monthly |
|---|---|---|
| `runna.agency` domain | ~$35–50 CAD/yr (.agency is a premium TLD) | — |
| `runnareach.com` domain | ~$12 CAD/yr | — |
| Google Workspace seat for sender #1 on `runnareach.com` | — | ~$9 CAD/mo |
| Mail-Tester (free tier is fine) | — | $0 |
| **Total year 1** | **~$47–62 one-time** | **~$108/yr recurring** |
| **Year 1 grand total** | | **~$155–170 CAD** |

For comparison: one junior SDR costs $60,000–80,000/yr. This is < 0.3% of that.

---

## Total time

- **Active work:** ~45 minutes of clicks (one person, one sitting)
- **Warming clock:** 14–21 days running in the background — 5 min/day of manual email sending by sender #1

---

## Before you start — 2 decisions Pedro must confirm

These need Pedro's sign-off before the delegate starts clicking. Both are quick.

### Decision 1: Who is sender #1?

The person whose name appears on every outbound email. Must be a **real human** with a **real LinkedIn profile** that matches.

- ✅ **Good:** A founder, partner, BD lead, or principal at Runna CA. Someone who actually works there and can credibly reply to "hi, are you the right person about X?"
- ❌ **Bad:** A persona with no LinkedIn. Outreach@ or info@ addresses. Someone who's not actually reachable.

**Pedro to confirm:** sender #1's name, role title, LinkedIn profile URL. The email address will be `first.last@runnareach.com`.

### Decision 2: Physical mailing address (CASL requirement)

Every commercial email to a Canadian prospect must include a valid physical mailing address. Options:

- Runna CA's actual Canadian office address (if there is one)
- Rünna's Canadian virtual office / coworking space address
- A virtual office in Calgary or Vancouver ($25–50/mo services like Regus, iPostal1, Opus Virtual)

**Pedro to confirm:** which address goes on the CASL footer. It needs to be a real address a postal carrier could deliver mail to.

---

## Step-by-step (for the delegate)

### STEP A — Buy both domains (10 min, ~$47–62)

**What to do:**

1. Go to [Porkbun.com](https://porkbun.com) (or Namecheap — either works; Porkbun is cheaper and includes free WHOIS privacy)
2. Search and add to cart:
   - `runna.agency` (~$35–50/yr)
   - `runnareach.com` (~$12/yr)
3. Checkout
4. **Enable WHOIS privacy on both** (Porkbun free; Namecheap free first year, then paid)
5. **Enable auto-renew on both** — don't let a domain expire mid-operation
6. Pay (credit card)

**Why:** Owning both domains gives us full DNS control — the keys to deliverability.

**What to capture:**

- Both domains purchased ✅
- Registrar login credentials (save in 1Password / shared vault)
- Registrar DNS management URLs for both

---

### STEP B — Add `runnareach.com` to Rünna's existing Google Workspace (10 min, ~$9/mo)

Pedro confirmed we add the outreach domain to Rünna's **existing** Google Workspace account (not a new standalone account). One admin console, one billing relationship, one security config.

**What to do:**

1. Log into Rünna's Google Workspace Admin console (`admin.google.com`)
2. **Account → Domains → Manage domains → Add a domain**
3. Enter `runnareach.com` → choose "Secondary domain" (NOT "Domain alias" — those share mailboxes with the primary, which is wrong here)
4. Google provides a verification TXT record
5. Add the TXT record at Porkbun DNS for `runnareach.com` (Type=TXT, Host=`@`, Value=`google-site-verification=...`)
6. Wait ~5 minutes → click Verify in the admin console

**Why:** Google Workspace supports multi-domain tenants. Secondary-domain mailboxes are fully independent from primary-domain mailboxes — separate mail routing, separate reputation, but one unified admin experience. Saves ~$108/yr vs a second standalone Workspace.

**What to capture:**

- `runnareach.com` added as secondary domain ✅
- Screenshot of green verification checkmark

**Note:** You do NOT need to add `runna.agency` to Workspace yet — that's for the brand's public website and team email, configured separately whenever Rünna is ready to stand it up. The warming track is only about `runnareach.com`.

---

### STEP C — Configure mail DNS for `runnareach.com` (15 min, CRITICAL)

This step matters most for deliverability. Get it wrong and everything else is wasted money. Four DNS records, all applied to `runnareach.com`:

#### C1. MX records (incoming mail routing)

Google Workspace admin provides these. For the current recommended setup, it's a single record:

| Priority | Host | Value |
|---|---|---|
| 1 | @ | smtp.google.com |

(Older Workspace docs show 5 records. Follow what the current admin wizard tells you — Google updates this.)

**Why:** Routes incoming mail to Google's servers.

#### C2. SPF record (who's allowed to send as us)

Add a TXT record at Porkbun:

- Host: `@` (or blank)
- Value: `v=spf1 include:_spf.google.com ~all`

**Why:** Tells receiving mail servers "only Google's servers may send as runnareach.com." Without SPF, anyone can spoof us.

#### C3. DKIM (cryptographic email signing)

1. Google Workspace Admin → **Apps → Google Workspace → Gmail → Authenticate email**
2. Select `runnareach.com` from the domain dropdown
3. "Generate new record" → leave key length at 2048-bit
4. Google provides a long TXT record — copy it
5. At Porkbun: add TXT record for `runnareach.com` with Host=`google._domainkey` and the Value provided
6. Wait ~5 min → back in Google Admin → click "Start authentication"

**Why:** Every outgoing email is cryptographically signed. Receiving servers verify the signature to confirm the message wasn't forged. Without DKIM, Gmail and Outlook dramatically downrank your sends.

#### C4. DMARC (what to do if SPF/DKIM fail)

Add a TXT record at Porkbun:

- Host: `_dmarc`
- Value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@runnareach.com; pct=100; adkim=s; aspf=s`

**Why:** DMARC tells receiving servers what to do with mail that fails SPF or DKIM (quarantine). The `rua=` address receives aggregated reports so you can see spoofing attempts. **Start with `p=quarantine`** — after 2 weeks of clean data, upgrade to `p=reject`.

You'll also need to actually create the `dmarc@runnareach.com` mailbox (or alias) in Workspace so the reports go somewhere receivable.

**What to capture:**

- Screenshot of Porkbun DNS list showing MX, SPF, DKIM, DMARC records for `runnareach.com`
- Screenshot of Google Admin showing DKIM "Authenticating email" = green

---

### STEP D — Verify deliverability (5 min, FREE)

Before doing anything else, run a deliverability check on the freshly-configured domain.

1. Open [mail-tester.com](https://www.mail-tester.com) — free, no signup
2. It shows a unique test address like `test-abc123@mail-tester.com`
3. Log into your new Gmail at `admin@runnareach.com` (or whatever admin mailbox you set up)
4. Send a test email with a human subject like **"Test — runnareach setup"** and a one-paragraph body. Write something real — not "hi test"
5. Back on mail-tester.com → click "Then check your score"
6. **Target: 10/10.** Anything less, fix what it tells you to fix

**Why:** Mail-Tester checks SPF, DKIM, DMARC, DNS reverse-lookup, content spamminess, and about 20 other signals. A 10/10 means receiving mail servers will not automatically junk your mail. Below 9 = something wrong with DNS — fix before warming.

**What to capture:**

- Screenshot of 10/10 score

---

### STEP E — Create sender #1's mailbox (5 min)

**What to do:**

1. Google Workspace Admin → **Directory → Users → Add user**
2. First name + Last name: sender #1's real name
3. Primary email: `first.last@runnareach.com` (keep it human — not `outreach@` or `sales@`)
4. Let Google generate a secure password, force password reset on first login
5. Share credentials with sender #1 via 1Password or similar (not email)

**Why:** Sender #1 sends from their own inbox, not a shared one. Reply deliverability and LinkedIn trust depend on sender #1 being a real, reachable human.

**What to capture:**

- Sender #1's email address
- First-login completed by sender #1

---

### STEP F — Match LinkedIn identity (10 min)

This is easy to overlook and is the #1 conversion killer in outbound.

**Sender #1 does this personally:**

1. Log into LinkedIn
2. Update profile:
   - Photo: professional headshot
   - Headline: current role at Runna CA (e.g. *"Partner @ Runna CA · Creative Strategy for Canadian SMBs"*)
   - About: short paragraph about what Runna CA does and who it serves
   - Experience: make sure Runna CA is listed as current role
3. Add a link to `runna.agency` in the Contact Info section
4. **The email `first.last@runnareach.com` does NOT need to be on LinkedIn publicly** — but sender #1's full name must match exactly between email and LinkedIn

**Why:** When a prospect gets an email from "First Last at Runna CA," their first move is to Google the sender's name. If LinkedIn shows a blank profile, a different company, or nothing — reply rate drops 60%+. Real sender, real LinkedIn, matching identity. This is the single highest-leverage 10 minutes in the whole setup.

**What to capture:**

- LinkedIn profile URL for sender #1
- Screenshot of profile showing Runna CA role

---

### STEP G — Start warming (14–21 days, 5 min/day)

This is the most important part and the most boring. Sender #1 must do this personally. **No automation during warming.** Automation kills warming — the whole point is teaching Gmail / Outlook / Yahoo that this inbox is a human with human sending patterns.

#### Daily warming protocol (weekdays only, 5 min/day)

**Week 1 (days 1–7): Send 3–5 emails per day to real humans.**

- Mix of: replies to newsletters you read, emails to existing Rünna contacts, emails to Runna CA team members, LinkedIn friends you can say hi to
- Each email: 2–4 sentences. Normal human tone. **NOT a pitch, NOT a template**
- Ask questions in some of them so recipients reply (inbound replies boost reputation fast)
- Receive at least 2–3 replies per day. If you don't get replies, send to people you know will reply

**Week 2 (days 8–14): Scale to 8–12 emails per day.**

- Same kinds of recipients, more of them
- Still zero automation, still zero cold pitches
- If you have Runna CA / Rünna contacts, send them a quick "hey, launching a new outbound initiative, would love your thoughts" conversational email

**Week 3 (days 15–21, optional stretch): Scale to 15–20 emails per day.**

- Start including small amounts of content you'd send in real outreach — a link to a case study, a mention of a Rünna client — but still framed conversationally
- End of week 3: ready for Phase 4 automated warming ramp (30/day → 300/day over 5 weeks, managed by the engine)

#### Warming rules (all weeks)

- ✅ Send **only** weekdays, between 9am and 6pm local time
- ✅ Reply to incoming messages — including the stray spam that lands in your inbox. Reply rate is a signal
- ✅ Mark non-spam emails in your Spam folder as "Not spam" — trains receiving end
- ✅ Archive and label mail you read — engagement signal
- ❌ **DO NOT** send mass emails, bulk BCC, or anything that looks templated
- ❌ **DO NOT** connect this inbox to any automation tool, not even Mailchimp, not even a drip sequence
- ❌ **DO NOT** send the same message to 5 different people — receiving servers detect this instantly
- ❌ **DO NOT** skip days — inconsistent sending hurts warming

**Why:** Gmail, Outlook, Yahoo, and every other receiver watches new sending domains closely for 30–60 days. They're looking for patterns: Does this sender get replies? Does this sender send at human times? Is content varied? Are there spam complaints? Answering those questions the right way is what "warming" literally means.

**What to capture:**

- Daily log (Google Doc or Notion page): date + count of sends + count of replies received. Share with Pedro weekly so he can confirm warming is on track.

---

### STEP H — Re-verify at end of Week 2 (5 min, FREE)

Before Phase 4 engine sends start, re-verify:

1. mail-tester.com — repeat Step D process. Target: still 10/10.
2. [Google Postmaster Tools](https://postmaster.google.com) — add `runnareach.com` (add a TXT record it asks for), wait ~24 hours, then check the Sender Reputation dashboard. Should show Low volume / Green reputation.

**Why:** Warming might have introduced issues (e.g. DKIM re-keyed, domain flagged somewhere). Catch it here, not mid-campaign.

---

## What to deliver back to Pedro (and me)

When all steps are done, send this block to Pedro. He relays to me to populate `.env.local`:

```
RUNNA_FROM_EMAIL=first.last@runnareach.com
RUNNA_SENDER_NAME=First Last
RUNNA_MAILING_ADDRESS=<full physical address for CASL footer>
SENDER_1_LINKEDIN_URL=https://linkedin.com/in/first-last
DOMAIN_REGISTRAR=Porkbun
WORKSPACE_ADMIN_EMAIL=admin@runnareach.com
MAIL_TESTER_SCORE=10/10 screenshot
DMARC_REPORT_EMAIL=dmarc@runnareach.com
```

Plus:

- Confirmation screenshots: Mail-Tester 10/10, Google Admin DKIM green
- Confirmation: warming daily log started, sender #1 committed to 5 min/day for 2-3 weeks

---

## Timeline summary

| Day | Milestone |
|---|---|
| **Day 0 (today)** | Buy both domains, add runnareach to Workspace, configure DNS (SPF/DKIM/DMARC), Mail-Tester 10/10, create sender #1 mailbox, update LinkedIn |
| **Day 1–7** | Week 1 warming: 3–5 sends/day |
| **Day 8–14** | Week 2 warming: 8–12 sends/day |
| **Day 14** | Re-run Mail-Tester, check Postmaster Tools = green |
| **Day 15–21** | Week 3 warming: 15–20 sends/day (optional stretch) |
| **~Day 21** | Ready for Phase 4 engine-managed warming ramp (30 → 300/day over 5 weeks) |
| **~Day 28** | First real cold pitch goes out |

If you start today, first real pitch goes out ~4 weeks from now. If you delay a week, slide everything one week right.

---

## Red flags to escalate to Pedro immediately

- ❗ Mail-Tester score below 9/10 after DNS setup — something's configured wrong, do not proceed to warming
- ❗ DKIM status in Google Admin shows "Not authenticating email" after 24 hours
- ❗ Any bounce-back emails during warming ("your mail was rejected")
- ❗ A warming recipient tells you the email landed in their spam folder
- ❗ DMARC report emails showing hundreds of spoofing attempts (some is normal; a flood is not)
- ❗ Google Postmaster Tools showing IP reputation = "Low" or "Bad" at end of Week 1

---

## Quick-reference: what NOT to do

- ❌ Don't use `runna.agency` as the sending domain — it's the primary brand domain, not the outreach domain
- ❌ Don't use `runna.mx` (Rünna Mexico's domain) — wrong market, Canadian prospects getting `.mx` mail is confusing
- ❌ Don't use `outreach@`, `sales@`, `hello@`, `info@` — must be a real human's name
- ❌ Don't skip DKIM (most common setup mistake — it takes 15 min but is make-or-break)
- ❌ Don't set DMARC to `p=reject` on day 1 (use `p=quarantine` for first 2 weeks; upgrade after clean data)
- ❌ Don't connect to any automation during warming — not even "just for testing"
- ❌ Don't send test emails to your own other addresses and call it warming (receivers detect this)
- ❌ Don't rush warming past 7 days
- ❌ Don't skip the physical mailing address in the footer (CASL fine up to $10M for corporations)
