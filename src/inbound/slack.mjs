// The live Slack adapter. docs/INBOUND-SPEC.md, "Adapters".
//
// NOT RUN against a real workspace in the lane that built it: there was no Slack token. The request
// shapes follow Slack's Web API (chat.postMessage, conversations.open, conversations.history) and are
// pinned against a fake transport. Scopes a bot token needs: chat:write, im:write, im:history.
//
// THE DISTINCTION THIS FILE EXISTS TO GET RIGHT is which failures prove nothing was posted. Slack
// answers most errors with HTTP 200 and `ok: false`, and a 429 is a refusal; both prove the message was
// not posted, so posting again is safe. A dropped connection, a timeout or a 5xx after the request left
// proves nothing, so those are `ambiguous` and the engine asks `find` before it ever posts again.
//
// `transport` is REQUIRED with no default; only src/cli.mjs builds a real one. The token stays in this
// closure and every upstream text passes through `scrub`.

import { InboundAdapterError } from './errors.mjs';

export const SLACK_BASE = 'https://slack.com/api';
export const SLACK_TIMEOUT_MS = 10000;
// How far before the attempt's own instant `find` starts looking, for clock skew between us and Slack.
const SKEW_SECONDS = 60;
const MAX_DETAIL = 300;

// The chat.postMessage errors that prove nothing was posted: every error Slack documents for the
// method (https://docs.slack.dev/reference/methods/chat.postMessage, read 2026-11-17) except
// internal_error and fatal_error, documented as "It's possible some aspect of the operation succeeded
// before the error was raised", and service_unavailable, which does not say whether it ran. Those
// three, and any error not in this list, may have posted, so they go through find before a repost.
const POST_REFUSALS = new Set([
  'access_denied', 'accesslimited', 'account_inactive', 'agent_prompt_display_not_allowed', 'app_access_restricted',
  'as_user_not_supported', 'attachment_payload_limit_exceeded', 'cannot_reply_to_message', 'channel_not_found',
  'deprecated_endpoint', 'draft_already_deleted', 'draft_already_sent', 'draft_has_conflict', 'draft_not_found',
  'duplicate_channel_not_found', 'duplicate_message_not_found', 'ekm_access_denied', 'enterprise_is_restricted',
  'invalid_arg_name', 'invalid_arguments', 'invalid_array_arg', 'invalid_auth', 'invalid_blocks', 'invalid_blocks_format',
  'invalid_charset', 'invalid_form_data', 'invalid_metadata_format', 'invalid_metadata_schema', 'invalid_post_type',
  'is_archived', 'markdown_text_conflict', 'message_limit_exceeded', 'messages_tab_disabled',
  'metadata_must_be_sent_from_app', 'metadata_too_large', 'method_deprecated', 'missing_argument', 'missing_file_data',
  'missing_post_type', 'missing_scope', 'msg_blocks_too_long', 'no_permission', 'no_text', 'not_allowed_token_type',
  'not_authed', 'not_in_channel', 'org_login_required', 'posting_to_channel_denied', 'rate_limited', 'ratelimited',
  'request_timeout', 'restricted_action', 'restricted_action_non_threadable_channel', 'restricted_action_read_only_channel',
  'restricted_action_thread_locked', 'restricted_action_thread_only_channel', 'send_on_behalf_not_allowed',
  'slack_connect_canvas_sharing_blocked', 'slack_connect_file_link_sharing_blocked', 'slack_connect_lists_sharing_blocked',
  'team_access_not_granted', 'team_added_to_org', 'team_not_found', 'token_expired', 'token_revoked',
  'too_many_attachments', 'too_many_contact_cards', 'two_factor_setup_required',
]);

function short(text) {
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_DETAIL ? compact : `${compact.slice(0, MAX_DETAIL - 1)}…`;
}

export function createSlackAdapter({ transport, token, scrub = (text) => text, timeoutMs = SLACK_TIMEOUT_MS } = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('createSlackAdapter requires a transport. There is deliberately no default, so nothing reaches Slack by omission');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('createSlackAdapter requires a token');
  }

  // Every await after the request left sits inside the try: a body that cannot be read after a 200
  // says nothing about whether the post landed, so it is ambiguous exactly like a dropped connection.
  async function call(method, url, body) {
    let response;
    let text;
    try {
      response = await transport(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const stage = response === undefined ? 'could not be reached' : `answered ${response.status} but the answer could not be read`;
      throw new InboundAdapterError('SLACK_UNREACHABLE', `Slack ${stage}: ${short(scrub(String(error?.message ?? error)))}`, { ambiguous: true });
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const scopes = typeof response.headers?.get === 'function' ? response.headers.get('x-oauth-scopes') : null;
    return { status: response.status, text, json, scopes };
  }

  return {
    // The scopes the token holds. Slack returns them on every Web API response in the x-oauth-scopes
    // header (https://docs.slack.dev/legacy/legacy-authentication/, read 2026-11-17); auth.test needs
    // no scope and writes nothing. null when Slack did not send the header.
    async scopes() {
      const answer = await call('POST', `${SLACK_BASE}/auth.test`);
      if (answer.json?.ok !== true) {
        throw new InboundAdapterError('SLACK_REJECTED', `Slack refused the token at auth.test (${short(scrub(String(answer.json?.error ?? answer.status)))})`);
      }
      if (answer.scopes === null || answer.scopes === undefined) return null;
      return String(answer.scopes).split(',').map((scope) => scope.trim()).filter(Boolean);
    },

    async post({ channel, text, blocks }) {
      const answer = await call('POST', `${SLACK_BASE}/chat.postMessage`, { channel, text, blocks, unfurl_links: false, unfurl_media: false });
      if (answer.status === 429) {
        throw new InboundAdapterError('SLACK_RATE_LIMITED', 'Slack answered 429, so nothing was posted');
      }
      if (answer.status >= 500 || answer.json === null) {
        throw new InboundAdapterError('SLACK_UNREACHABLE', `Slack answered ${answer.status} with ${short(scrub(answer.text))}, which does not say whether the post landed`, { ambiguous: true });
      }
      if (answer.json.ok !== true) {
        const error = String(answer.json.error);
        if (!POST_REFUSALS.has(error)) {
          throw new InboundAdapterError('SLACK_REJECTED', `Slack answered ok: false, ${short(scrub(error))}, which Slack does not document as a refusal, so the post may have landed`, { ambiguous: true });
        }
        throw new InboundAdapterError('SLACK_REJECTED', `Slack answered ok: false, ${short(scrub(error))}, so nothing was posted`);
      }
      return { ts: String(answer.json.ts) };
    },

    async find({ channel, marker, oldest }) {
      const unsearchable = (detail) =>
        new InboundAdapterError('SLACK_UNSEARCHABLE', `Slack would not show the message history (${short(scrub(detail))}), so whether the post landed is unknown`);

      // A lookup that fails in any way, including a body that cannot be read, is "cannot tell", never
      // "not found": only a history Slack actually showed may say the post is absent.
      const ask = async (...args) => {
        try {
          return await call(...args);
        } catch (error) {
          throw unsearchable(String(error?.message ?? error));
        }
      };
      const opened = await ask('POST', `${SLACK_BASE}/conversations.open`, { users: channel });
      if (opened.json?.ok !== true) throw unsearchable(String(opened.json?.error ?? opened.status));

      // oldest null: after a recovery nothing says when the post may have been made, so the newest 200
      // messages of the DM are searched.
      const query = new URLSearchParams({ channel: opened.json.channel.id });
      if (oldest !== null && oldest !== undefined) query.set('oldest', String(Math.floor(Date.parse(oldest) / 1000) - SKEW_SECONDS));
      query.set('limit', '200');
      const history = await ask('GET', `${SLACK_BASE}/conversations.history?${query}`);
      if (history.json?.ok !== true) throw unsearchable(String(history.json?.error ?? history.status));

      const hit = (history.json.messages ?? []).find((m) => typeof m?.text === 'string' && m.text.includes(marker));
      return hit === undefined ? null : { ts: String(hit.ts) };
    },
  };
}
