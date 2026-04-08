/**
 * AskTrusscoreBot
 * Handles incoming Teams messages, maintains per-conversation history,
 * and calls Claude API with NetSuite MCP to answer questions.
 */
require('dotenv').config();
const { ActivityHandler, MessageFactory, CardFactory } = require('botbuilder');
const fetch = require('node-fetch');
// const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
// const NETSUITE_ACCOUNT_ID = process.env.NETSUITE_ACCOUNT_ID;

// ── System prompt (same logic as Suitelet) ────────────────────────────────────
const SYSTEM_PROMPT = `You are "Ask Trusscore" — an AI assistant for Trusscore, a building products company, embedded in Microsoft Teams.

You answer questions about NetSuite data by querying it via MCP tools.

## TOOL PRIORITY ORDER
1. ns_listAllReports → ns_runReport
2. ns_listSavedSearches → ns_runSavedSearch
3. ns_getRecordTypeMetadata → ns_getRecord
4. ns_getSuiteQLMetadata → ns_runCustomSuiteQL (ALWAYS ROWNUM <= 1000)

## TRUSSCORE DOMAIN KNOWLEDGE
- Fiscal year starts March 1st
- Primary transaction type: Sales Order
- Custom item fields: custitem_tc_lengh_ft (note typo), custitem_tc_item_weight (lbs/ft),
  custitem_tc_skid_qty, custitem_tc_item_bundle_size, custitem_tc_skid_weight,
  custitem_tc_item_colour, custitem_tc_product_group
- Weight per piece = custitem_tc_lengh_ft × custitem_tc_item_weight
- Gross skid weight = (length × weight_per_ft × skid_qty) + custitem_tc_skid_weight
- If bundle_size equals skid_qty → ships loose (no inner bundles)
- custitem_ds_30_days_avg_sales = nightly calc: 180-day sales ÷ 6

## OUTPUT FORMAT — IMPORTANT
You are responding inside Microsoft Teams. Use Adaptive Cards JSON for rich responses.
For every response, return a JSON object in this exact shape:

  Plain answer:
  {"type":"text","text":"Your answer here"}

  Table (5+ rows):
  {"type":"table","title":"Table title","columns":["Col1","Col2"],"rows":[["val1","val2"]]}

  KPI / metric:
  {"type":"kpi","value":"$2.3M","label":"Total Open AR","subtitle":"As of today"}

  Multiple KPIs:
  {"type":"kpis","items":[{"value":"$2.3M","label":"Open AR"},{"value":"14","label":"Overdue Invoices"}]}

Rules:
- Numbers: millions → $X.XM, thousands → $X.XK, percentages → X.X%
- Full numbers with commas in table cells
- Never expose raw internal NetSuite numeric IDs
- Be concise — no preamble, no filler
- Return ONLY the JSON object, no markdown fences`;

function getNetsuiteMcpUrl() {
    // If PUBLIC_URL is set (e.g. ngrok or Azure URL), use our local /mcp-proxy
    // Otherwise fall back to direct NetSuite (which might fail if auth is required)
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl) {
        return `${publicUrl.replace(/\/$/, '')}/mcp-proxy`;
    }

    const accountId = process.env.NETSUITE_ACCOUNT_ID || '6518122-sb1';
    const slug = accountId.toLowerCase().replace(/_/g, '-');
    return `https://${slug}.suitetalk.api.netsuite.com/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools`;
}

// ── In-memory conversation history (keyed by Teams conversation ID) ───────────
// For production, swap this for Redis or Azure Table Storage
const conversationHistories = new Map();
const MAX_HISTORY_TURNS = 6; // 6 pairs = 12 messages

class AskTrusscoreBot extends ActivityHandler {
    constructor() {
        super();
        this.onMessage(async (context, next) => {
            await this.handleMessage(context);
            await next();
        });

        this.onMembersAdded(async (context, next) => {
            for (const member of context.activity.membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(
                        MessageFactory.attachment(this.buildWelcomeCard())
                    );
                }
            }
            await next();
        });
    }

    async handleMessage(context) {
        const conversationId = context.activity.conversation.id;
        const userText = (context.activity.text || '').replace(/<at>[^<]+<\/at>/g, '').trim();

        if (!userText) return;

        // Handle special commands
        if (userText.toLowerCase() === '/reset' || userText.toLowerCase() === 'reset') {
            conversationHistories.delete(conversationId);
            await context.sendActivity('Conversation history cleared. Ask me anything!');
            return;
        }
        if (userText.toLowerCase() === '/help' || userText.toLowerCase() === 'help') {
            await context.sendActivity(MessageFactory.attachment(this.buildHelpCard()));
            return;
        }

        // Show typing indicator
        await context.sendActivity({ type: 'typing' });

        // Get or initialise history for this conversation
        const history = conversationHistories.get(conversationId) || [];

        try {
            const answer = await this.callClaude(userText, history);

            // Update history
            history.push({ role: 'user', content: userText });
            history.push({ role: 'assistant', content: answer.raw });
            // Trim to max turns
            while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
            conversationHistories.set(conversationId, history);

            // Send response as Adaptive Card or plain text
            const card = this.buildResponseCard(answer);
            if (card) {
                await context.sendActivity(MessageFactory.attachment(card));
            } else {
                await context.sendActivity(answer.text || 'No response received.');
            }
        } catch (err) {
            console.error('[handleMessage]', err);
            await context.sendActivity(
                '⚠️ Error connecting to the AI service. Please try again or contact your administrator.'
            );
        }
    }

    // ── Claude API call ───────────────────────────────────────────────────────
    async callClaude(question, history) {
        const messages = [
            ...history,
            { role: 'user', content: question }
        ];

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'mcp-client-2025-11-20'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 1500,
                system: SYSTEM_PROMPT,
                messages,
                mcp_servers: [
                    {
                        name: 'netsuite',
                        type: 'url',
                        url: getNetsuiteMcpUrl()
                    }
                ],
                tools: [
                    {
                        type: 'mcp_toolset',
                        mcp_server_name: 'netsuite'
                    }
                ]
            })
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Claude API error ${response.status}: ${body}`);
        }

        const data = await response.json();
        const raw = (data.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();

        // Try to parse structured response
        let parsed = null;
        try {
            const clean = raw.replace(/```json|```/g, '').trim();
            parsed = JSON.parse(clean);
        } catch (_) { /* plain text fallback */ }

        return { raw, parsed, text: raw };
    }

    // ── Adaptive Card builders ────────────────────────────────────────────────

    buildResponseCard(answer) {
        const { parsed } = answer;
        if (!parsed) return null; // fall back to plain text

        if (parsed.type === 'text') {
            // Plain text — still wrap in a card for consistent styling
            return CardFactory.adaptiveCard({
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                    {
                        type: 'TextBlock',
                        text: parsed.text,
                        wrap: true,
                        color: 'Default'
                    }
                ]
            });
        }

        if (parsed.type === 'kpi') {
            return CardFactory.adaptiveCard({
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                    {
                        type: 'ColumnSet',
                        columns: [
                            {
                                type: 'Column',
                                width: 'auto',
                                items: [
                                    {
                                        type: 'TextBlock',
                                        text: parsed.value,
                                        size: 'ExtraLarge',
                                        weight: 'Bolder',
                                        color: 'Accent'
                                    },
                                    {
                                        type: 'TextBlock',
                                        text: parsed.label,
                                        isSubtle: true,
                                        spacing: 'None'
                                    },
                                    ...(parsed.subtitle ? [{
                                        type: 'TextBlock',
                                        text: parsed.subtitle,
                                        isSubtle: true,
                                        size: 'Small',
                                        spacing: 'None'
                                    }] : [])
                                ]
                            }
                        ]
                    }
                ]
            });
        }

        if (parsed.type === 'kpis') {
            return CardFactory.adaptiveCard({
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                    {
                        type: 'ColumnSet',
                        columns: parsed.items.map(item => ({
                            type: 'Column',
                            width: 'stretch',
                            style: 'emphasis',
                            items: [
                                {
                                    type: 'TextBlock',
                                    text: item.value,
                                    size: 'Large',
                                    weight: 'Bolder',
                                    color: 'Accent',
                                    horizontalAlignment: 'Center'
                                },
                                {
                                    type: 'TextBlock',
                                    text: item.label,
                                    isSubtle: true,
                                    size: 'Small',
                                    horizontalAlignment: 'Center',
                                    spacing: 'None',
                                    wrap: true
                                }
                            ]
                        }))
                    }
                ]
            });
        }

        if (parsed.type === 'table') {
            const columns = (parsed.columns || []).map(col => ({
                type: 'TableColumnDefinition',
                width: 1
            }));

            const headerRow = {
                type: 'TableRow',
                style: 'accent',
                cells: (parsed.columns || []).map(col => ({
                    type: 'TableCell',
                    items: [{
                        type: 'TextBlock',
                        text: col,
                        weight: 'Bolder',
                        wrap: true,
                        color: 'Light'
                    }]
                }))
            };

            const dataRows = (parsed.rows || []).map((row, i) => ({
                type: 'TableRow',
                style: i % 2 === 0 ? 'default' : 'emphasis',
                cells: row.map(cell => ({
                    type: 'TableCell',
                    items: [{
                        type: 'TextBlock',
                        text: String(cell),
                        wrap: true,
                        size: 'Small'
                    }]
                }))
            }));

            const body = [];
            if (parsed.title) {
                body.push({
                    type: 'TextBlock',
                    text: parsed.title,
                    weight: 'Bolder',
                    size: 'Medium',
                    spacing: 'None'
                });
            }
            body.push({
                type: 'Table',
                columns,
                rows: [headerRow, ...dataRows],
                showGridLines: true,
                firstRowAsHeaders: false
            });

            return CardFactory.adaptiveCard({
                type: 'AdaptiveCard',
                version: '1.5',
                body
            });
        }

        return null;
    }

    buildWelcomeCard() {
        return CardFactory.adaptiveCard({
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
                {
                    type: 'TextBlock',
                    text: '👋 Ask Trusscore',
                    size: 'Large',
                    weight: 'Bolder'
                },
                {
                    type: 'TextBlock',
                    text: "I'm your AI assistant for NetSuite data. Ask me anything about customers, inventory, orders, financials, and more — in plain English.",
                    wrap: true,
                    isSubtle: true
                },
                {
                    type: 'TextBlock',
                    text: '**Try asking:**',
                    wrap: true,
                    spacing: 'Medium'
                },
                {
                    type: 'TextBlock',
                    text: '• AR aging over 90 days\n• Top 5 customers this month\n• Open purchase orders\n• Skid weight for Wall&Ceiling Panel 8ft White\n• Revenue vs last quarter',
                    wrap: true,
                    spacing: 'None'
                },
                {
                    type: 'TextBlock',
                    text: 'Type **/reset** to clear conversation history  •  **/help** for more examples',
                    wrap: true,
                    isSubtle: true,
                    size: 'Small',
                    spacing: 'Medium'
                }
            ]
        });
    }

    buildHelpCard() {
        return CardFactory.adaptiveCard({
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
                { type: 'TextBlock', text: 'Ask Trusscore — Help', weight: 'Bolder', size: 'Medium' },
                { type: 'TextBlock', text: '**Financials**', weight: 'Bolder', spacing: 'Medium' },
                { type: 'TextBlock', text: '• AR aging over 90 days\n• Revenue vs last quarter\n• Budget vs actual this period\n• Open vendor bills', wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: '**Sales & Customers**', weight: 'Bolder', spacing: 'Medium' },
                { type: 'TextBlock', text: '• Top 5 customers by revenue this month\n• Open sales orders this week\n• Orders for customer Acme Corp', wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: '**Inventory & Products**', weight: 'Bolder', spacing: 'Medium' },
                { type: 'TextBlock', text: '• Inventory below reorder point\n• Skid weight for Wall&Ceiling Panel 8ft White\n• 30-day avg sales for item TC-WC-8-W', wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: '**Commands**', weight: 'Bolder', spacing: 'Medium' },
                { type: 'TextBlock', text: '• **/reset** — clear conversation history\n• **/help** — show this card', wrap: true, spacing: 'None' }
            ]
        });
    }
}

module.exports = { AskTrusscoreBot };
