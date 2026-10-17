/**
 * @openbot/harness-opencode: the OpenCode v2 harness adapter (architecture §4.5, D2.3).
 *
 * Server mode: the user's `opencode serve` + `@opencode/client` 2.0.29 over HTTP+SSE. The public
 * surface is SDK-type-free: the injectable client is the structural {@link OpenCodeApi}.
 */
export { makeOpenCodeClient, type OpenCodeApi, type OpenCodeEvent, type PermissionRule } from "./client.ts"
export {
  instructionEntries,
  mcpServerName,
  parseModel,
  serverArgs,
  serverConfigContent,
  serverEnv,
  sessionRules,
} from "./config.ts"
export {
  makeOpenCodeDriver,
  makeOpenCodeDriverLive,
  OPENCODE_CAPABILITIES,
  type OpenCodeHarnessConfig,
  OpenCodeHarnessLive,
  openCodePaths,
} from "./Driver.ts"
export { type HostOptions, makeHost, type OpenCodeHost } from "./hub.ts"
export { classifyTool, makeNormalizer, type OpenCodeNormalizer } from "./normalize.ts"
export { listOpenCodeModels, probeOpenCode } from "./probe.ts"
export { formAnswer, formToRequest, permissionReply, permissionToRequest } from "./requests.ts"
export { type OpenCodeTransport, resolveOpenCodeBinary, spawnServer, verifyServer } from "./server.ts"
export { openOpenCodeSession, type SessionOptions } from "./Session.ts"
