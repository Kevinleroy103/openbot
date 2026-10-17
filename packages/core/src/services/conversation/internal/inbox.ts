/**
 * Files a bot RECEIVES (owner uploads, `send_file` from another bot, files in group catch-up) are
 * copied into its workspace on its host node before the turn starts — `inbox/<attachmentId>/<name>`
 * — through `NodeFiles.upload` (a streamed `transfer`, the node's own path policy), so every harness
 * and every placement can open them with its normal tools. The turn text lists them:
 * `[Attachments: inbox/att_…/diagram.png (image/png, 120 KB), …]`. A file that cannot be copied is
 * listed with the reason (and still handed to the harness by its brain path).
 */
import type { BotId, ConversationId, InvalidInput } from "@openbot/contracts"
import { describeNodeError } from "@openbot/node-protocol"
import { Effect } from "effect"
import type { RepoError } from "../../../ports/errors.ts"
import { sessionKeyOf } from "../../../ports/Harness.ts"
import { CoreIdPrefix, type IdGenShape } from "../../../ports/IdGen.ts"
import type { NodeDownloadError, NodeFiles } from "../../../ports/NodeFiles.ts"
import type { ResolvedPlacement } from "../../../ports/Placement.ts"
import type { AttachmentRecord, AttachmentStore } from "../../../ports/stores.ts"
import { formatBytes } from "../files.ts"

/** The inbox directory, relative to the bot's workspace. */
export const INBOX_DIR = "inbox"

/** A file name usable as one path segment on any node (no separators, controls, `.`/`..`). */
export const safeFileName = (name: string): string => {
  const cleaned = [...name].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("").trim().replace(/^\.+$/, "")
  return cleaned === "" ? "file" : cleaned.length > 180 ? cleaned.slice(cleaned.length - 180) : cleaned
}

/** `inbox/<attachmentId>/<name>`: where a received file lands in the workspace. */
export const inboxPath = (record: Pick<AttachmentRecord, "id" | "name">): string => `${INBOX_DIR}/${record.id}/${safeFileName(record.name)}`

/** Model-readable reason a file transfer failed (node, transfer, store or validation failure). */
export const describeFileFailure = (error: NodeDownloadError | InvalidInput | RepoError): string => {
  switch (error._tag) {
    case "InvalidInput":
    case "NodeUnavailable":
      return error.message
    case "RepoError":
      return "the file is missing on the brain"
    case "RpcClientError":
      return `the node did not answer (${error.message})`
    case "FsError":
      return error.code === "ENOENT" ? `${error.path} does not exist` : describeNodeError(error)
    default:
      return describeNodeError(error)
  }
}

export interface ReceivedFile {
  readonly record: AttachmentRecord
  /** Path relative to the workspace when the copy succeeded. */
  readonly relativePath?: string | undefined
  readonly error?: string | undefined
}

export interface InboxDeps {
  readonly nodeFiles: NodeFiles["Service"]
  readonly attachments: AttachmentStore["Service"]
  readonly ids: IdGenShape
  readonly maxFileBytes: number
}

const joinWorkspace = (workspace: string, relative: string): string => `${workspace.replace(/[\\/]+$/, "")}/${relative}`

/** Copies the files into the bot's workspace on its host node (already-present copies are kept). */
export const receiveFiles = (
  deps: InboxDeps,
  input: {
    readonly botId: BotId
    readonly conversationId: ConversationId
    readonly placement: Pick<ResolvedPlacement, "hostNodeId" | "workspacePath">
    readonly records: ReadonlyArray<AttachmentRecord>
  },
): Effect.Effect<ReadonlyArray<ReceivedFile>> =>
  Effect.forEach(
    input.records,
    (record): Effect.Effect<ReceivedFile> =>
      Effect.gen(function*() {
        if (record.byteSize > deps.maxFileBytes) {
          return { record, error: `it is larger than the ${formatBytes(deps.maxFileBytes)} limit` }
        }
        const relativePath = inboxPath(record)
        const inv = {
          invocationId: yield* deps.ids.next(CoreIdPrefix.invocation),
          botId: input.botId,
          runId: sessionKeyOf(input.botId, input.conversationId),
        }
        const copied = yield* Effect.result(deps.nodeFiles.upload({
          nodeId: input.placement.hostNodeId,
          inv,
          path: joinWorkspace(input.placement.workspacePath, relativePath),
          size: record.byteSize,
          chunks: deps.attachments.stream(record.id),
        }))
        if (copied._tag === "Success") return { record, relativePath }
        yield* Effect.logWarning(`Inbox: ${record.id} not copied for ${input.botId}`, copied.failure)
        return { record, error: describeFileFailure(copied.failure) }
      }),
    { concurrency: 2 },
  )

/** The turn-text line listing received files (empty when there are none). */
export const attachmentsLine = (files: ReadonlyArray<ReceivedFile>): string => {
  if (files.length === 0) return ""
  const items = files.map(({ record, relativePath, error }) => {
    const meta = `${record.mime}, ${formatBytes(record.byteSize)}`
    return relativePath !== undefined
      ? `${relativePath} (${meta})`
      : `${record.name} (${meta}; not copied to your computer: ${error ?? "unknown error"})`
  })
  return `[Attachments: ${items.join(", ")}]`
}
