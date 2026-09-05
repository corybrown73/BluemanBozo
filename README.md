# 🤡 Blue Man Bozo

A private website for the Blue Man Group's **Bozo of the Week** game.

Everybody picks one NFL player prop. The picks get stacked into a parlay. When the
games end, the real stat lines go in, the group votes on whose pick was the most
embarrassing, and that person — the **Bozo** — pays for next week's ticket. The site
tracks who's been the bozo, how often, and how badly, forever.

Replaces the Google Sheet. Keeps the receipts.

---

## What it does

| | |
|---|---|
| 🔒 **Private** | Every page is behind a login. One account per member. |
| 🏈 **Live NFL props** | Pulls player prop lines from [The Odds API](https://the-odds-api.com). Load one game, or the whole slate at once and search any player by name. |
| 🙈 **Blind picks** | Nobody sees anyone else's pick until the week locks, so you can't fade the group. |
| 🎫 **The ticket** | Every pick becomes a parlay leg. Real combined odds, real payout math. |
| 📋 **Grading** | Enter the actual stat line; win/loss/push is computed. No arguing about it. |
| 🧮 **Bozo Index** | Ranks every losing pick 0–100 by how badly it missed and how safe it was supposed to be. |
| 🗳️ **The vote** | The group votes. The Index is only a suggestion — you're the jury. |
| 🔥 **Roasts** | Auto-generated, and they read the actual pick. Missing by 92% gets mocked differently than missing by 3%. |
| 📣 **The summons** | Email and/or text the bozo their bad news. Or copy it for the group chat. |
| 🏆 **Hall of Shame** | Season and all-time bozo counts, streaks, records, worst picks ever, earned titles. |
| 💸 **The ledger** | Tracks who owes the ticket and whether they paid. |

---

## Quick start (5 minutes, on your laptop)

```bash
git clone https://github.com/corybrown73/BluemanBozo.git
cd BluemanBozo
npm install

cp .env.example .env
# open .env and set SESSION_SECRET and ODDS_API_KEY

npm run seed          # creates the crew, prints their passwords
npm start             # http://localhost:3000
```

Add `--demo` to the seed for three fake finished weeks so you can click around
with real-looking data:

```bash
npm run seed -- --demo
```

**Save the passwords the seed prints.** They are shown once. Everyone can change
their own after signing in, and you can reset anyone's in **Commissioner → Members**.

Edit the member list at the top of `scripts/seed.js` before seeding to use real
names, or add people one at a time:

```bash
node scripts/add-user.js dave "Dave" --email dave@example.com --phone +15551234567
```

---

## Check your Odds API key

Run this before anything else. It verifies the key, lists this week's games, and
tells you exactly what a prop pull will cost:

```bash
node scripts/check-odds.js            # free — spends 0 credits
node scripts/check-odds.js --props    # also pulls one real board (spends credits)
```

---

## Credits and what they buy

The Odds API bills per market, not per call:

| Call | Cost |
|---|---|
| List the week's games | **0 credits** — free, refresh all you want |
| Load one game's props | **1 credit per market, per region** |
| Load the whole slate | that, times the number of games |
| Final scores | 1–2 credits |

**Defaults are sized for the free 500-credit plan.** Five markets are enabled —
passing yards, rushing yards, receiving yards, receptions, anytime TD — covering
QB, RB and WR/TE. That makes:

- **one game = 5 credits**
- **the entire 16-game slate = 80 credits**
- **a full-slate load every week = 320/month**, inside the free 500

**Two ways to pick:**

- **Load all games** — one button, pulls every game, then you type a player's
  name. No hunting through matchups. The app prices the job before spending
  anything.
- **Click one game** — 5 credits, when you already know the matchup.

Either way, **every response is cached for 6 hours and shared by the whole
group.** Five people browsing after one person loads the slate is still 80
credits, not 400. Games already cached cost nothing, so a repeat click is free.

### The app knows your real plan

Every API response carries your remaining and used credits, so the app infers
your actual plan size and **warns if your local cap is set higher than your plan
allows** — a cap of 16,000 on a 500-credit plan protects nothing. It also refuses
any single call that would need more credits than your plan has left, regardless
of the cap.

### If you upgrade

On the 20,000 tier, go to **Commissioner → Odds API** and raise
`monthly_credit_cap` to ~18,000, turn on whatever extra markets you want, and
optionally drop the cache to 180 minutes for fresher lines. At 10 markets a full
slate is ~160 credits, which is roughly 110 slate loads a month.

## How a week runs

```
   OPEN  ──────▶  LOCKED  ──────▶  GRADED  ──────▶  FINAL
picks in       picks revealed    stat lines in    bozo crowned
picks hidden   parlay priced     voting open      bill assigned
```

1. **Commissioner → Open the next week.** Last week's bozo is automatically put on
   the hook for this week's ticket. Optionally set an auto-lock time (kickoff) —
   the week locks itself.
2. **Everyone makes a pick.** *Make a Pick* → either **Load all games** and search
   for your guy by name, or click a single matchup. Or type it in by hand if your
   book has a number the API doesn't.
3. **Lock it** (or let auto-lock do it). All picks are revealed and the parlay
   gets priced.
4. **Games play.** Whoever is on the hook places the bet.
5. **Commissioner → Enter the stat lines.** Type each player's actual number.
   Results compute themselves. When all are in, voting opens.
6. **Everybody votes** on the Vote tab, with the Bozo Index there for reference.
7. **Commissioner → Crown the bozo.** Roast generated, counts updated, next week's
   bill assigned.
8. **Send the summons** — email, text, or copy for the group chat.

---

## The Bozo Index

Every losing pick gets scored 0–100. Higher is worse.

```
Bozo Index  =  65% × how badly you missed the number
            +  35% × how safe the bet was supposed to be
```

- **The miss** is measured against the line. Needing 74.5 receiving yards and
  getting 11 is an 85% miss. Missing a full line — a goose egg — is the maximum.
- **The chalk** is the implied probability of your price. Blowing a −350 lock is
  more embarrassing than losing a +250 dart throw.
- **Anytime TD** props have no distance to miss, so they're scored purely on how
  likely the book thought they were. Missing a longshot TD is Tuesday; missing a
  −300 TD is a war crime.

Wins and pushes are never eligible. **If nobody loses, nobody is the bozo** — it's
a Perfect Week, and everyone is quietly furious about it.

The vote outranks the Index. The Index only breaks ties and fills in if nobody votes.

---

## Bringing over the Google Sheet

Export it (`File → Download → .csv`), then:

```bash
# One row per week — keeps the actual picks
node scripts/import-csv.js history.csv --season 2024 --dry-run
node scripts/import-csv.js history.csv --season 2024
```

```csv
week,date,bozo,player,market,side,line,odds,actual,stake
1,2024-09-08,Dave,Josh Allen,Passing Yards,Over,249.5,-115,180,20
2,2024-09-15,Mike,Puka Nacua,Receiving Yards,Over,74.5,-110,11,20
```

Only `week` and `bozo` are required. Column names are matched loosely — `Week #`,
`Bozo of the Week`, `Prop`, `O/U`, `Result` all work. Members not in the database
are created automatically (give them passwords in Commissioner → Members).

If your sheet is only a running tally, use `--tally`:

```csv
name,bozos
Dave,4
Mike,2
```

```bash
node scripts/import-csv.js tally.csv --tally --season 2024
```

**Always `--dry-run` first.**

---

## Deploying to www.bluemanbozo.com

The database is a SQLite file, so **you need a host with a persistent disk.** On
platforms without one, every deploy wipes your history. Render's free tier and
Vercel/Netlify will not work for this.

### Render (easiest)

1. Push this repo to GitHub.
2. Render → **New → Blueprint**, point at the repo. `render.yaml` sets up the web
   service, the 1 GB disk mounted at `/data`, and a generated `SESSION_SECRET`.
3. In the dashboard, set **`ODDS_API_KEY`**. It is deliberately not in git.
4. Deploy, then in a Render Shell run `npm run seed` once to create the members.

### Fly.io

```bash
fly launch --no-deploy
fly volumes create bozo_data --size 1
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) ODDS_API_KEY=your_key_here
fly deploy
fly ssh console -C "npm run seed"
```

### Any Docker host

```bash
docker build -t bluemanbozo .
docker run -d -p 3000:3000 \
  -v /srv/bozo-data:/data \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e ODDS_API_KEY=your_key_here \
  -e SITE_URL=https://www.bluemanbozo.com \
  --name bluemanbozo bluemanbozo
```

### Pointing the Namecheap domain at it

Your host will give you either a hostname (`bluemanbozo.onrender.com`) or an IP.

In Namecheap → **Domain List → Manage → Advanced DNS**, delete the default
parking records, then add:

| Type | Host | Value | TTL |
|---|---|---|---|
| `CNAME` | `www` | `your-app.onrender.com` | Automatic |
| `ALIAS` (or `URL Redirect` to `https://www.bluemanbozo.com`) | `@` | `your-app.onrender.com` | Automatic |

If your host gives an IP instead, use `A` records pointing at it for both `@` and `www`.

Then add `bluemanbozo.com` and `www.bluemanbozo.com` as custom domains in your
host's dashboard so it provisions the HTTPS certificate. DNS takes 10 minutes to
a few hours. Finally set `SITE_URL=https://www.bluemanbozo.com` so the links in
the bozo's email and text point to the right place.

---

## Email and text notifications

Both are optional — the app works fine without them, and you can always copy the
summons for the group chat instead.

**Email** — any SMTP server. For Gmail you need an
[App Password](https://myaccount.google.com/apppasswords), not your login:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-char-app-password
SMTP_FROM="Blue Man Bozo <you@gmail.com>"
```

**Text** — a [Twilio](https://twilio.com) account (a few dollars covers a season):

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+15551234567
```

Phone numbers must be in E.164 format (`+15551234567`). Test both from
**Commissioner → Notifications** before you rely on them.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the site |
| `npm run dev` | Run with auto-restart on file changes |
| `npm test` | Run the test suite (48 tests) |
| `npm run seed` | Create the season and members |
| `npm run seed -- --demo` | …plus three fake finished weeks |
| `node scripts/check-odds.js` | Verify the Odds API key and see credit costs |
| `node scripts/add-user.js <username>` | Add or update one member |
| `node scripts/import-csv.js <file>` | Import the Google Sheet |

---

## Layout

```
server/
  index.js      express app, static hosting, security headers
  db.js         SQLite schema and settings
  auth.js       bcrypt hashing, signed-cookie sessions, login throttle
  odds.js       The Odds API client — caching, credit accounting, budget cap
  scoring.js    parlay math, grading, the Bozo Index
  roast.js      roast generation and shame titles
  notify.js     email (SMTP) and SMS (Twilio)
  game.js       week assembly, pick visibility, leaderboards
  routes/       auth · game · odds · admin
public/         the front end — no build step, no framework
scripts/        seed · add-user · import-csv · check-odds
test/           scoring unit tests and API integration tests
```

Data lives in `data/bluemanbozo.db` (or `$DATA_DIR`). Back it up by copying that
file — that's your entire history.

---

## Security notes

- Passwords are bcrypt-hashed. Sessions are HMAC-signed cookies — `httpOnly`,
  `sameSite=lax`, and `secure` in production.
- Failed logins are throttled to 8 per 10 minutes per username+IP.
- `SESSION_SECRET` is required in production and signs every session. Changing it
  logs everyone out.
- The Odds API key is never sent to the browser — only whether one is configured.
- `.env` is gitignored. **Never commit real credentials.** If a key ends up
  somewhere public, regenerate it.
- The app is not hardened for the open internet — it's built for six people who
  know each other. Don't put anything sensitive in it.
