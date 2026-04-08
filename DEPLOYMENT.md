# Ask Trusscore — Teams Bot Deployment Guide

## Architecture Overview

```
Teams User
    │  (message)
    ▼
Azure Bot Service  ──────────────────────────────►  Your Node.js Bot Server
(handles auth,                                        (AskTrusscore bot)
 routing)                                                   │
                                                            │  POST /v1/messages
                                                            ▼
                                                     Anthropic Claude API
                                                     + NetSuite MCP Server
                                                            │
                                                            ▼
                                                     Adaptive Card response
                                                      back to Teams
```

---

## Prerequisites

- Node.js 18+
- An Azure account (free tier works)
- Microsoft 365 / Teams Admin access (or ask your IT admin)
- Your Anthropic API key
- Your NetSuite Account ID

---

## Step 1 — Register an Azure Bot

1. Go to [portal.azure.com](https://portal.azure.com) → **Create a resource** → search **Azure Bot**
2. Fill in:
   - **Bot handle:** `AskTrusscore`
   - **Subscription:** your Azure subscription
   - **Resource group:** create new or use existing
   - **Pricing tier:** F0 (free) is fine to start
   - **Microsoft App ID:** choose **Create new Microsoft App ID**
3. Click **Review + Create → Create**
4. Once deployed, go to the bot resource → **Configuration**
5. Note down your **Microsoft App ID**
6. Click **Manage Password** → **New client secret** → copy the secret value immediately

---

## Step 2 — Set Up the Bot Server

```bash
# Clone or copy the ask-trusscore-bot folder to your server
cd ask-trusscore-bot

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your values:
#   MICROSOFT_APP_ID       → from Azure Step 1
#   MICROSOFT_APP_PASSWORD → client secret from Azure Step 1
#   ANTHROPIC_API_KEY      → your Anthropic API key
#   NETSUITE_ACCOUNT_ID    → your NetSuite account ID (e.g. 1234567)
```

---

## Step 3 — Deploy the Server

### Option A — Azure App Service (recommended, stays in Microsoft ecosystem)

```bash
# Install Azure CLI if needed
az login
az webapp up \
  --name ask-trusscore-bot \
  --resource-group your-resource-group \
  --runtime "NODE:18-lts" \
  --plan ask-trusscore-plan \
  --sku B1

# Set environment variables on the App Service
az webapp config appsettings set \
  --name ask-trusscore-bot \
  --resource-group your-resource-group \
  --settings \
    MICROSOFT_APP_ID="your-app-id" \
    MICROSOFT_APP_PASSWORD="your-app-secret" \
    ANTHROPIC_API_KEY="sk-ant-..." \
    NETSUITE_ACCOUNT_ID="your-account-id"
```

Your bot URL will be: `https://ask-trusscore-bot.azurewebsites.net`

### Option B — Local development with ngrok (for testing)

```bash
# Start the bot
npm start

# In another terminal, expose it publicly
npx ngrok http 3978
# Note the https URL (e.g. https://abc123.ngrok.io)
```

---

## Step 4 — Connect Azure Bot to Your Server

1. In Azure Portal → your Bot resource → **Configuration**
2. Set **Messaging endpoint** to:
   `https://your-server-url/api/messages`
   (e.g. `https://ask-trusscore-bot.azurewebsites.net/api/messages`)
3. Click **Apply**

---

## Step 5 — Enable the Teams Channel

1. In Azure Portal → your Bot resource → **Channels**
2. Click **Microsoft Teams**
3. Accept the Terms of Service → **Save**
4. The Teams channel is now active

---

## Step 6 — Package & Upload the Teams App

1. Edit `manifest/manifest.json`:
   - Replace both instances of `REPLACE-WITH-YOUR-MICROSOFT-APP-ID` with your actual App ID
2. Add two icon files to the `manifest/` folder:
   - `icon-color.png` — 192×192px, full colour (your Trusscore logo works great)
   - `icon-outline.png` — 32×32px, white/transparent outline version
3. Zip the manifest folder contents (not the folder itself):
   ```bash
   cd manifest
   zip ../AskTrusscore.zip manifest.json icon-color.png icon-outline.png
   ```
4. Upload to Teams:
   - **For personal testing:** Teams → Apps → Manage your apps → Upload an app → Upload a custom app → select `AskTrusscore.zip`
   - **For your whole org:** Teams Admin Center → Teams apps → Manage apps → Upload → select `AskTrusscore.zip`, then create an App Setup Policy to pin it for your team

---

## Step 7 — Test It

1. In Teams, search for **Ask Trusscore** in Apps
2. Click **Add** → **Open**
3. Try: *"AR aging over 90 days"*
4. You should see a formatted Adaptive Card with your live NetSuite data

---

## Conversation Commands

| Command | Description |
|---------|-------------|
| `/reset` | Clears the conversation history for a fresh start |
| `/help` | Shows example questions and available commands |

---

## Production Checklist

- [ ] Bot server running on HTTPS (Azure App Service handles this automatically)
- [ ] Environment variables set (never hardcoded in source)
- [ ] Azure Bot messaging endpoint updated to production URL
- [ ] Teams app manifest App IDs match your Azure registration
- [ ] Icons added to manifest zip
- [ ] App uploaded via Teams Admin Center for org-wide rollout
- [ ] NetSuite MCP server URL resolves correctly (verify NETSUITE_ACCOUNT_ID)
- [ ] Test with `/help` and a known NetSuite query before announcing to the team

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot doesn't respond | Check messaging endpoint URL in Azure Bot config |
| `401 Unauthorized` from Claude | Verify `ANTHROPIC_API_KEY` in environment variables |
| NetSuite returns no data | Check `NETSUITE_ACCOUNT_ID` format — no dashes, exact account ID |
| Teams shows "Something went wrong" | Check bot server logs; confirm App ID & Password match Azure |
| Table cards not rendering | Adaptive Card tables require Teams client v1.5+ — check Teams version |
