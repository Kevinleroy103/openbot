/** Join class names, skipping falsy values. (No tailwind-merge: callers append overrides last.) */
export const cn = (...parts: ReadonlyArray<string | false | null | undefined | 0>): string => parts.filter(Boolean).join(" ")
