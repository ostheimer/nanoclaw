/**
 * Gmail Channel for NanoClaw
 * Polls Gmail for emails matching the configured trigger and runs the agent.
 * Uses Gmail REST API directly with stored OAuth2 credentials.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { EMAIL_CHANNEL } from './config.js';
import { logger } from './logger.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');
const OAUTH_KEYS_PATH = path.join(os.homedir(), '.gmail-mcp', 'gcp-oauth.keys.json');
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

interface OAuthCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
    token_uri: string;
  };
}

async function loadCredentials(): Promise<OAuthCredentials> {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(raw) as OAuthCredentials;
}

async function refreshAccessToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
  const keysRaw = fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8');
  const keys = JSON.parse(keysRaw) as OAuthKeys;
  const { client_id, client_secret, token_uri } = keys.installed;

  const body = new URLSearchParams({
    client_id,
    client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });

  const res = await fetch(token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const refreshed = await res.json() as { access_token: string; expires_in: number };
  const updated: OAuthCredentials = {
    ...creds,
    access_token: refreshed.access_token,
    expiry_date: Date.now() + refreshed.expires_in * 1000,
  };

  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

async function getAccessToken(): Promise<string> {
  let creds = await loadCredentials();

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= creds.expiry_date - 60_000) {
    logger.debug('Gmail access token expired, refreshing');
    creds = await refreshAccessToken(creds);
  }

  return creds.access_token;
}

async function gmailGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function gmailPost(path: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function decodeBase64Url(data: string): string {
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractBody(payload: Record<string, unknown>): string {
  // Try direct body first
  const body = payload.body as { data?: string; size?: number } | undefined;
  if (body?.data) return decodeBase64Url(body.data);

  // Try parts recursively
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (parts) {
    for (const part of parts) {
      const mimeType = part.mimeType as string;
      if (mimeType === 'text/plain') {
        const partBody = part.body as { data?: string } | undefined;
        if (partBody?.data) return decodeBase64Url(partBody.data);
      }
    }
    // Fallback: first part with body data
    for (const part of parts) {
      const partBody = part.body as { data?: string } | undefined;
      if (partBody?.data) return decodeBase64Url(partBody.data);
    }
  }

  return '';
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

export async function checkForNewEmails(): Promise<EmailMessage[]> {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.warn('Gmail credentials not found, skipping email check');
    return [];
  }

  let query: string;
  switch (EMAIL_CHANNEL.triggerMode) {
    case 'label':
      query = `label:${EMAIL_CHANNEL.triggerValue} is:unread`;
      break;
    case 'address':
      query = `to:${EMAIL_CHANNEL.triggerValue} is:unread`;
      break;
    case 'subject':
      query = `subject:"${EMAIL_CHANNEL.triggerValue}" is:unread`;
      break;
  }

  const token = await getAccessToken();
  const searchResult = await gmailGet(
    `/messages?q=${encodeURIComponent(query)}&maxResults=20`,
    token,
  ) as { messages?: Array<{ id: string; threadId: string }> };

  if (!searchResult.messages?.length) return [];

  const emails: EmailMessage[] = [];

  for (const msg of searchResult.messages) {
    const detail = await gmailGet(
      `/messages/${msg.id}?format=full`,
      token,
    ) as {
      id: string;
      threadId: string;
      payload: {
        headers: Array<{ name: string; value: string }>;
        body?: { data?: string };
        parts?: Array<Record<string, unknown>>;
        mimeType?: string;
      };
    };

    const headers = detail.payload.headers;
    emails.push({
      id: detail.id,
      threadId: detail.threadId,
      from: extractHeader(headers, 'From'),
      subject: extractHeader(headers, 'Subject'),
      body: extractBody(detail.payload as Record<string, unknown>),
      date: extractHeader(headers, 'Date'),
    });
  }

  return emails;
}

export async function sendEmailReply(
  threadId: string,
  to: string,
  subject: string,
  body: string,
  inReplyToMessageId?: string,
): Promise<void> {
  const token = await getAccessToken();

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  // Build RFC 2822 message
  const headers = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    `Content-Type: text/plain; charset=utf-8`,
  ];

  if (inReplyToMessageId) {
    headers.push(`In-Reply-To: ${inReplyToMessageId}`);
    headers.push(`References: ${inReplyToMessageId}`);
  }

  const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
  const encoded = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  await gmailPost('/messages/send', token, {
    raw: encoded,
    threadId,
  });
}

export async function markEmailAsRead(messageId: string): Promise<void> {
  const token = await getAccessToken();
  await gmailPost(`/messages/${messageId}/modify`, token, {
    removeLabelIds: ['UNREAD'],
  });
}

export function getContextKey(email: EmailMessage): string {
  switch (EMAIL_CHANNEL.contextMode) {
    case 'thread':
      return `email-thread-${email.threadId}`;
    case 'sender': {
      const addr = email.from.match(/<(.+)>/)?.[1] || email.from;
      return `email-sender-${addr.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    }
    case 'single':
      return 'email-main';
  }
}
