/**
 * @openbot/harness-fake: a deterministic scripted harness for tests and the offline demo
 * (architecture §4.5 Fake, D2.4). See `script.ts` for the directive language.
 */
export {
  FAKE_CAPABILITIES,
  FAKE_HARNESS_VERSION,
  FAKE_MODELS,
  type FakeDriverOptions,
  FakeHarnessLayer,
  FakeHarnessLive,
  makeFakeDriver,
} from "./Driver.ts"
export { FAKE_HARNESS_KIND, type FakeSessionConfig, openFakeSession, toolKindOf } from "./Session.ts"
export { chunksOf, DIRECTIVE_NAMES, type Directive, type DirectiveName, parseScript } from "./script.ts"
export { McpCallError } from "./mcp.ts"
