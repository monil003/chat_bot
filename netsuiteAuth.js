const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    // Return cached token if still valid (with 5 min buffer)
    if (cachedToken && Date.now() < tokenExpiry - 300000) {
        return cachedToken;
    }

    const accountId = process.env.NETSUITE_ACCOUNT_ID || '6518122-sb1';
    const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
    const certificateId = process.env.NETSUITE_CERTIFICATE_ID;
    
    // Handle the Private Key (might have spaces instead of newlines from JSON/env)
    let privateKey = process.env.NETSUITE_PRIVATE_KEY || '';
    if (privateKey) {
        // 1. Convert literal \n to real newlines
        privateKey = privateKey.replace(/\\n/g, '\n');
        
        // 2. If it's a flat string (no newlines) but has headers, fix it
        const header = '-----BEGIN PRIVATE KEY-----';
        const footer = '-----END PRIVATE KEY-----';
        if (privateKey.includes(header) && !privateKey.includes('\n', header.length + 1)) {
            let body = privateKey.replace(header, '').replace(footer, '').trim();
            // Replace spaces with nothing (just in case) then wrap every 64 chars
            body = body.replace(/\s+/g, '');
            const wrappedBody = body.match(/.{1,64}/g).join('\n');
            privateKey = `${header}\n${wrappedBody}\n${footer}\n`;
        }
    }

    if (!consumerKey || !privateKey || !certificateId) {
        // Fallback to manual key if available (for testing transition)
        if (process.env.NETSUITE_AUTH_KEY) {
            console.warn('[NetsuiteAuth] Missing OAuth environment variables. Using manual NETSUITE_AUTH_KEY.');
            return process.env.NETSUITE_AUTH_KEY;
        }
        throw new Error('Missing NetSuite OAuth variables: NETSUITE_CONSUMER_KEY, NETSUITE_CERTIFICATE_ID, NETSUITE_PRIVATE_KEY');
    }

    const slug = accountId.toLowerCase().replace(/_/g, '-');
    const tokenUrl = `https://${slug}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

    // 1. Create JWT (Matching the successful curl payload exactly)
    const now = Date.now() / 1000;
    const payload = {
        iss: consumerKey,
        scope: ['restlets', 'rest_webservices'],
        iat: now,
        exp: now + 3600,
        aud: tokenUrl
    };

    const clientAssertion = jwt.sign(payload, privateKey, {
        algorithm: 'PS256',
        header: {
            typ: 'JWT',
            alg: 'PS256',
            kid: certificateId
        }
    });

    // 2. Exchange JWT for Access Token (Matching curl body exactly)
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    params.append('client_assertion', clientAssertion);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`NetSuite OAuth Error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    console.log(`[NetsuiteAuth] Refreshed token. Expires in ${data.expires_in}s`);
    return cachedToken;
}

module.exports = { getAccessToken };
