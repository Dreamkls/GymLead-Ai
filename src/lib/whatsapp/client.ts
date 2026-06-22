// src/lib/whatsapp/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Business Cloud API client
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

const WA_API_VERSION = 'v20.0';
const WA_BASE = `https://graph.facebook.com/${WA_API_VERSION}`;

export interface WASendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── Send a free-form text message ───────────────────────────────────────────
// NOTE: Meta only allows free-form messages within the 24-hour customer
// service window. For follow-ups outside that window use sendWhatsAppTemplate.
export async function sendWhatsAppMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<WASendResult> {
  try {
    const res = await fetch(`${WA_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: sanitizePhone(to),
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error('[WhatsApp] Send failed:', err);
      return { success: false, error: err?.error?.message ?? 'Unknown error' };
    }

    const data = await res.json();
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Network error:', err);
    return { success: false, error: String(err) };
  }
}

// ─── Send a pre-approved template message ────────────────────────────────────
// Required for follow-ups sent after the 24-hour customer service window.
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components: unknown[]
): Promise<WASendResult> {
  try {
    const res = await fetch(`${WA_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      return { success: false, error: err?.error?.message };
    }

    const data = await res.json();
    return { success: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Mark message as read ─────────────────────────────────────────────────────
export async function markMessageAsRead(
  phoneNumberId: string,
  accessToken: string,
  messageId: string
): Promise<void> {
  try {
    await fetch(`${WA_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    // Non-critical — log and continue
    console.warn('[WhatsApp] markMessageAsRead failed:', err);
  }
}

// ─── Verify webhook HMAC-SHA256 signature ────────────────────────────────────
// Called on every incoming webhook POST. Returns false if the signature is
// missing or invalid — the caller MUST reject the request in that case.
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  appSecret: string
): boolean {
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  return `sha256=${expected}` === signature;
}

// ─── Extract the first text message from a webhook payload ───────────────────
export function extractIncomingMessage(body: unknown): {
  phoneNumberId: string;
  from: string;
  messageId: string;
  text: string;
  senderName: string;
  timestamp: string;
} | null {
  try {
    const b = body as Record<string, unknown>;
    const entry = (b.entry as unknown[])?.[0] as Record<string, unknown>;
    const change = (entry?.changes as unknown[])?.[0] as Record<string, unknown>;
    const value = change?.value as Record<string, unknown>;

    const messages = value?.messages as unknown[];
    if (!messages?.length) return null;

    const msg = messages[0] as Record<string, unknown>;
    if (msg.type !== 'text') return null; // Only handle text messages for now

    const contacts = value?.contacts as unknown[];
    const contact = contacts?.[0] as Record<string, unknown>;
    const profile = contact?.profile as Record<string, unknown>;
    const meta = value?.metadata as Record<string, unknown>;

    return {
      phoneNumberId: meta?.phone_number_id as string,
      from: msg.from as string,
      messageId: msg.id as string,
      text: ((msg.text as Record<string, unknown>)?.body as string) ?? '',
      senderName: (profile?.name as string) ?? '',
      timestamp: msg.timestamp as string,
    };
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip non-digits for WA API (must not include leading +) */
function sanitizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

/** Format a phone number for human-readable display */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return `+${digits}`;
}
