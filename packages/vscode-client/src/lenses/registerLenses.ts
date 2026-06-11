import * as vscode from "vscode";
import { Indexer } from "@4d/core";
import { CallChainLensProvider } from "../codelens/callChainLens";
import { DirtyLineTracker } from "../codelens/dirtyLineTracker";
import { TestStatusDecorator } from "../decorations/testStatusDecorator";
import { CoverageService } from "../coverage/coverageService";
import { debounce } from "../util/debounce";

/**
 * Register the call-chain code lenses plus the dirty-line tracker that keeps
 * them glued to their functions while a document is dirty: the index only
 * re-parses on save, so between edits and save each lens shifts by the net
 * newlines added/removed above it. Re-renders coalesce across keystrokes.
 */
export function registerLenses(
  context: vscode.ExtensionContext,
  indexer: Indexer,
  coverage: CoverageService,
  testStatusGetter: () => TestStatusDecorator | undefined
): CallChainLensProvider {
  const dirtyLines = new DirtyLineTracker(
    () => indexer.getGraph(),
    debounce(() => lensProvider.refresh(), 80)
  );
  context.subscriptions.push(dirtyLines);

  const lensProvider = new CallChainLensProvider(
    () => indexer.getGraph(),
    testStatusGetter,
    () => coverage.get(),
    () => coverage.getPatterns(),
    (uri, savedLine) => dirtyLines.displayLine(uri, savedLine)
  );
  context.subscriptions.push(
    lensProvider, // owns its emitter + the codeLens-config listener
    vscode.languages.registerCodeLensProvider({ pattern: "**/*.{4dm,4DForm}" }, lensProvider)
  );

  return lensProvider;
}
