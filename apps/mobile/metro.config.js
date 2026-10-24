// Metro for the OpenBot app inside the Bun workspace (Expo's monorepo defaults: the repo root is
// watched and every node_modules is searched). React Native pins one exact React version, so every
// `react` import (the shared @openbot/client included) resolves to the app's own copy.
const { getDefaultConfig } = require("expo/metro-config")
const path = require("node:path")

const projectRoot = __dirname
const config = getDefaultConfig(projectRoot)

const fromApp = path.join(projectRoot, "package.json")
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "react" ||
    moduleName.startsWith("react/") ||
    moduleName === "react-dom" ||
    moduleName.startsWith("react-dom/")
  ) {
    return context.resolveRequest({ ...context, originModulePath: fromApp }, moduleName, platform)
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform)
}

module.exports = config
