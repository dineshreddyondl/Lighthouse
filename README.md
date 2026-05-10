# Lighthouse v1

Customer escalation tracker for ONDL. Watches WhatsApp customer groups, classifies messages, surfaces escalations on a dashboard, lets the team respond from the dashboard.

## What v1 does

- **Today's escalations**: 4 counters (groups, total, responded, open) + drillable list
- **History**: searchable audit trail of closed escalations
- **Drilled-in group view**: WhatsApp-style conversation thread + reply box (sends from support number)
- **Auto-onboarding**: bot picks up groups it's added to; type detected from `ONDL-` prefix
- **Group search**: sidebar filter

## Setup

```bash
git clone <repo>
cd lighthouse
npm install
cp .env.example .env   # then edit with your keys
```

## Run

```bash
# Start the bot + dashboard
npm run dev

# In another terminal, after the bot is connected:

# 1. Bulk-import all groups the bot is currently in (one-shot)
npm run discover

# 2. Seed team members (recognize their replies as 'ours')
npm run seed:team

# Open the dashboard
open http://localhost:3000
```

## Configuration

`.env`:

```
LLM_PROVIDER=together
TOGETHER_API_KEY=<your_key>
TOGETHER_CLASSIFIER_MODEL=moonshotai/Kimi-K2.5
TOGETHER_JUDGE_MODEL=moonshotai/Kimi-K2.5
DB_PATH=./data/lighthouse.db
WA_AUTH_DIR=./src/whatsapp/auth
LOG_LEVEL=info
ENABLE_OUTBOUND_DMS=false   # set to true to allow dashboard replies to send
WEB_PORT=3000
```

## Group naming convention

Type auto-detected from group name:

| Pattern | Type |
|---|---|
| `ONDL-EnterpriseName` | customer |
| `ONDL-OperatorName-City` | operator |
| `ONDL-Internal*` | internal |
| anything else | unclassified |

Only `customer` groups feed today's escalation counters. Other groups are still tracked + classified, but don't pollute the dashboard.

## Adding new groups

The bot auto-tracks any group it's added to. No manual JID copying.

To onboard:
1. Ops adds the bot's WhatsApp number to a new group on their phone
2. Bot detects the join and creates the group with auto-detected type
3. Group appears in the dashboard sidebar

## Adding team members

Edit `data/team_members.csv`:

```csv
phone,name,role
+918019461100,Dinesh,ops_lead
+22750576042214,Dinesh LID,ops_lead
+919876543210,Priya,support
```

Then `npm run seed:team`.

**WhatsApp LID note**: WhatsApp may use pseudonymous IDs (starting with `+227...`) instead of real phone numbers in groups. If a team member's replies aren't being recognized, check `messages.sender_phone` in the DB and add their LID as a separate row.

## Architecture

```
WhatsApp → Baileys → Pipeline → Classifier (Kimi) → Escalation
                                Ack judge ─────────→ Status update
                                Manual close ──────→ Dashboard
```

Tables: `groups`, `messages`, `open_loops` (escalations), `team_members`, `outbound_replies`.

## What's NOT in v1

- Auth/Cognito (deferred — runs as 'dinesh' user for now)
- AI-suggested replies in the reply box
- Auto-resolution detection (manual close only)
- Supply-side (operator) tracking
- Mobile responsiveness
- "Stop tracking" button (remove bot from group instead)

These are noted for v2 in the brief.
