// Slack connector (D3.4): the owner's own Slack app (user token, Socket Mode), what Connect apps shows
// about it, and the app manifest the owner creates it from.
import { Schema } from "effect"

/** What Connect apps › Slack shows. Tokens never leave the brain. */
export const SlackStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** Workspace name, e.g. "Seen". */
  team: Schema.optionalKey(Schema.String),
  /** e.g. `https://seen.slack.com/` */
  teamUrl: Schema.optionalKey(Schema.String),
  /** The owner's Slack user id (`U…`) and display name. */
  userId: Schema.optionalKey(Schema.String),
  userName: Schema.optionalKey(Schema.String),
  /**
   * Live Slack events (Socket Mode, needs the app-level token): `off` without one, `connecting`,
   * `live`, or `failed` with `problem`.
   */
  events: Schema.Literals(["off", "connecting", "live", "failed"]),
  problem: Schema.optionalKey(Schema.String),
})
export type SlackStatus = typeof SlackStatus.Type

export const SLACK_DISCONNECTED: SlackStatus = { connected: false, events: "off" }

/** What the owner pastes from the Slack app's pages. */
export const SlackConnectInput = Schema.Struct({
  /** "User OAuth Token" (`xoxp-…`), OAuth & Permissions. Absent while connected: keep the current one (adding an app-level token). */
  userToken: Schema.optionalKey(Schema.String),
  /** "App-Level Token" (`xapp-…`) with `connections:write`, Basic Information. Optional: no live events without it. */
  appToken: Schema.optionalKey(Schema.String),
})
export type SlackConnectInput = typeof SlackConnectInput.Type

/**
 * User scopes: read and search what the owner can see, send as the owner (only after they press
 * Send on a draft), and open a DM with someone.
 */
export const SLACK_USER_SCOPES: ReadonlyArray<string> = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "search:read",
  "users:read",
  "chat:write",
]

/** Messages Slack sends over Socket Mode (user events: what the owner can see). */
export const SLACK_USER_EVENTS: ReadonlyArray<string> = ["message.im", "message.mpim", "message.channels", "message.groups"]

/** The app manifest (JSON) the owner creates their Slack app from. */
export const slackAppManifest = (name = "OpenBot") => ({
  display_information: {
    name,
    description: "Lets your OpenBot Bots read your Slack and draft messages you send.",
    background_color: "#1d1d1f",
  },
  oauth_config: { scopes: { user: [...SLACK_USER_SCOPES] } },
  settings: {
    event_subscriptions: { user_events: [...SLACK_USER_EVENTS] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
})

/** Opens Slack's "Create an app" with the manifest filled in. */
export const slackCreateAppUrl = (name = "OpenBot"): string =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest(name)))}`
