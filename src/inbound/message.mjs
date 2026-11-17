// The Slack message a rep receives. docs/INBOUND-SPEC.md, "Escaping and secrets".
//
// Pure. The payload is a stranger's text, and Slack mrkdwn turns `<!channel>` into a ping for a whole
// channel and `<https://x|y>` into a link that reads as y. So payload text only ever appears:
//
//   1. inside plain_text objects, which Slack renders with no formatting, no links and no mentions;
//   2. in the notification fallback `text`, with &, < and > escaped as Slack documents.
//
// In both, control characters are made visible the way the terminal does it (src/terminal.mjs), so an
// escape sequence or a right-to-left override cannot rearrange what the rep reads. Line breaks inside
// the draft body are kept, because a draft is paragraphs.
//
// The mrkdwn parts carry only text this file writes plus values from the operator's own rotation file.

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;
const NAMED = { '\r': '\\r', '\t': '\\t' };

import { createHash } from 'node:crypto';

// Slack's documented limits, read 2026-11-16. A section block's text: "maximum length is 3000
// characters" (https://docs.slack.dev/reference/block-kit/blocks/section-block). chat.postMessage's
// `text`: "limit the `text` field to 4,000 characters" (https://docs.slack.dev/reference/methods/chat.postMessage).
// Every block field is capped at the first and the fallback below the second, with room to spare.
export const SLACK_PLAIN_MAX = 3000;
export const SLACK_TEXT_MAX = 3900;

function visible(value, { keepNewlines = true } = {}) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const escaped = text.replace(CONTROL, (ch) => {
    if (NAMED[ch]) return NAMED[ch];
    const code = ch.codePointAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
  return keepNewlines ? escaped : escaped.replace(/\n/g, '\\n');
}

function slackEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function capped(text, max = SLACK_PLAIN_MAX) {
  const limit = max - 60;
  if (text.length <= max) return text;
  return `${text.slice(0, limit)}… (${text.length} characters, first ${limit} shown)`;
}

const plain = (text) => ({ type: 'plain_text', text: capped(text), emoji: false });

// A digest of the idempotency key and the attempt, in [a-z0-9-] only. It is sent, escaped, stored and
// searched as the same bytes whatever the signal id holds: Slack's escaping of &, < and > cannot touch
// it, so a post that may have landed is always findable.
export function markerFor(key, attempt) {
  const digest = createHash('sha256').update(`${key}\u0000${attempt}`).digest('hex').slice(0, 24);
  return `signal-desk-${digest}`;
}

/**
 * The message for one assignment attempt.
 *
 *   lead        the handoff artifact's facts (company, to, subject, body, band, play, score, citations)
 *   rep         the rep from the rotation file
 *   reassigned  { from, minutes } when this attempt is a reassignment
 *
 * Returns { channel, text, blocks, marker }.
 */
export function buildSlackMessage({ lead, rep, key, attempt, reassigned, contactId }) {
  const marker = markerFor(key, attempt);
  const company = visible(lead.company, { keepNewlines: false });
  const mention = `<@${slackEscape(visible(rep.slack_user_id, { keepNewlines: false }))}>`;

  const headline = reassigned
    ? `Reassigned to you from ${reassigned.from}: the lead was untouched for ${reassigned.minutes} minutes`
    : 'New inbound lead';

  const brief = [
    `Company: ${company}`,
    `Contact: ${visible(lead.to, { keepNewlines: false })}`,
    `Band: ${visible(lead.band, { keepNewlines: false })} (score ${visible(String(lead.score), { keepNewlines: false })}), play ${visible(lead.play, { keepNewlines: false })}`,
    `Draft approved by: ${visible(lead.approved_by, { keepNewlines: false })}`,
    ...(contactId === undefined ? [] : [`HubSpot contact: ${visible(String(contactId), { keepNewlines: false })}`]),
  ].join('\n');

  const draft = `Subject: ${visible(lead.subject, { keepNewlines: false })}\n\n${visible(lead.body)}`;
  const citations = Array.isArray(lead.citations) ? lead.citations : [];
  const evidence = citations.length === 0
    ? 'Evidence: none recorded'
    : `Evidence:\n${citations.map((url) => `- ${visible(url, { keepNewlines: false })}`).join('\n')}`;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: capped(`*${slackEscape(headline)}* for ${mention}`) } },
    { type: 'section', text: plain(brief) },
    { type: 'section', text: plain(draft) },
    { type: 'section', text: plain(evidence) },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'This draft has not been sent. Read it, then send it yourself or log why not in HubSpot.' },
        plain(marker),
      ],
    },
  ];

  // The fallback is what a notification shows, and what `find` searches. One line, escaped for mrkdwn,
  // with the marker FIRST, so cutting it to Slack's limit can never drop the marker.
  const text = capped(`${marker} ${slackEscape(`${headline}: ${company}.`)}`, SLACK_TEXT_MAX);

  return { channel: rep.slack_user_id, text, blocks, marker };
}
