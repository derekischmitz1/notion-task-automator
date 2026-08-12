import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: Missing CLIENT_ID or CLIENT_SECRET in environment variables.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: scopes,
});

console.log('\n--- GOOGLE AUTHORIZATION STEP ---');
console.log('1. Open this link in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in, accept all permissions (Gmail + Calendar).');
console.log('3. After approving, you will be redirected to a blank page or error page on localhost.');
console.log('4. Copy the full URL from your browser address bar and paste it below.\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Paste the redirect URL here: ', async (redirectUrl) => {
  try {
    const urlParams = new URL(redirectUrl).searchParams;
    const code = urlParams.get('code');

    if (!code) {
      console.error('Could not find authorization code in the provided URL.');
      process.exit(1);
    }

    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n=== SUCCESS! YOUR NEW REFRESH TOKEN ===');
    console.log(tokens.refresh_token);
    console.log('=======================================\n');
  } catch (err) {
    console.error('Error retrieving access token:', err);
  } finally {
    rl.close();
  }
});