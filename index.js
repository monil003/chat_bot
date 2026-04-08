/**
 * Ask Trusscore — Teams Bot
 * Entry point: Express server + Bot Framework adapter
 */

const { BotFrameworkAdapter } = require('botbuilder');
const express = require('express');
const { AskTrusscoreBot } = require('./bot');

const proxy = require('express-http-proxy');
const app = express();
app.use(express.json());

// ── NetSuite MCP Auth Proxy ──────────────────────────────────────────────────
// Claude managed MCP doesn't support headers, so we proxy through this route
// which injects the Authorization: Bearer token.
app.use('/mcp-proxy', proxy((req) => {
    const accountId = process.env.NETSUITE_ACCOUNT_ID || '6518122-sb1';
    const slug = accountId.toLowerCase().replace(/_/g, '-');
    return `${slug}.suitetalk.api.netsuite.com`;
}, {
    proxyReqPathResolver: (req) => {
        const base = '/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools';
        return `${base}${req.url === '/' ? '' : req.url}`;
    },
    proxyReqOptDecorator: (proxyReqOpts) => {
        proxyReqOpts.headers['Authorization'] = `Bearer ${process.env.NETSUITE_AUTH_KEY}`;
        return proxyReqOpts;
    },
    https: true,
    proxyTimeout: 60000,
    timeout: 60000
}));

// ── Bot Framework Adapter ─────────────────────────────────────────────────────
const adapter = new BotFrameworkAdapter({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

adapter.onTurnError = async (context, error) => {
    console.error('[onTurnError]', error);
    await context.sendActivity('Sorry, something went wrong. Please try again.');
};

// ── Bot instance ──────────────────────────────────────────────────────────────
const bot = new AskTrusscoreBot();

// ── Webhook endpoint (Teams posts here) ──────────────────────────────────────
app.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async (context) => {
        await bot.run(context);
    });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', bot: 'Ask Trusscore' }));

const PORT = process.env.PORT || 3978;
app.listen(PORT, () => {
    console.log(`Ask Trusscore bot running on port ${PORT}`);
    console.log(`Messaging endpoint: http://localhost:${PORT}/api/messages`);
});
