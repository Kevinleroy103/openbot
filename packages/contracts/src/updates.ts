/**
 * Updates: CI publishes a GitHub Release for every green push to main (a source tarball, its sha256
 * and release.json); the brain checks for a newer one, and installs it when the owner clicks Update
 * (or by itself, with Settings `autoUpdate`, once no work has run for a while). Installing hands off
 * to scripts/deploy.ts, so running work is finished or saved, and a release that does not start is
 * rolled back.
 */
import { Schema } from "effect"
import { Millis, NonNegativeInt } from "./base.ts"

/** A published release. */
export const UpdateRelease = Schema.Struct({
  /** "2026.10.25-fa1465b" */
  version: Schema.String,
  sha: Schema.String,
  publishedAt: Millis,
  /** The release's page on GitHub. */
  url: Schema.String,
})
export type UpdateRelease = typeof UpdateRelease.Type

export const UpdateCommit = Schema.Struct({ sha: Schema.String, message: Schema.String })
export type UpdateCommit = typeof UpdateCommit.Type

export const UpdateStatus = Schema.Struct({
  /** What runs now: a release's version, or the id of a deploy from a working tree. */
  current: Schema.Struct({
    version: Schema.String,
    sha: Schema.optionalKey(Schema.String),
    /** Deployed from a working tree with changes not in any commit. */
    dirty: Schema.optionalKey(Schema.Boolean),
  }),
  state: Schema.Literals(["unknown", "checking", "up-to-date", "available", "installing", "failed"]),
  /** The newest release, once checked. */
  latest: Schema.optionalKey(UpdateRelease),
  /** Commits from the current version to the latest, newest first (at most 50). */
  commits: Schema.optionalKey(Schema.Array(UpdateCommit)),
  /** How many commits the latest release is ahead. */
  behind: Schema.optionalKey(NonNegativeInt),
  checkedAt: Schema.optionalKey(Millis),
  /** While installing: what it is doing ("Downloading…"). */
  step: Schema.optionalKey(Schema.String),
  problem: Schema.optionalKey(Schema.String),
  /** The release before the current one, to go back to. */
  previous: Schema.optionalKey(Schema.String),
  /** Updates can only install where the brain runs from releases (scripts/deploy.ts). */
  canInstall: Schema.Boolean,
})
export type UpdateStatus = typeof UpdateStatus.Type
