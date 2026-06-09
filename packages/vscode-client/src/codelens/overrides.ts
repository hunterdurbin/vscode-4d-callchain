// These override/inheritance helpers are pure CallGraph walks with no editor
// dependencies, so they live in `@4d/core` where the MCP server and LSP servers
// can reuse them too. This shim preserves the original import paths used by
// `callChainLens.ts` and `extension.ts`.
export {
  FUNCTION_KINDS,
  descendantClassNames,
  directSubclasses,
  descendantClasses,
  overridesForClass,
  findOverridesOfFunction,
  inheritedFunctions,
  findOverriddenFunction
} from "@4d/core";
