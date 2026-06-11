import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

/**
 * Bootstrap the @4d/language-server LSP client. One process serving the
 * standard navigation methods (definition / references / workspaceSymbol /
 * documentSymbol / callHierarchy / semantic tokens / diagnostics) plus the
 * IDE features (hover, completion, signature help).
 */
export function startLanguageServer(
  output: vscode.OutputChannel,
  exclusions: string[],
  builtinConstantsPaths: string[]
): LanguageClient {
  const serverModule = require.resolve("@4d/language-server/dist/bin.js");
  output.appendLine(`[LSP] Spawning language-server at ${serverModule}`);
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6011"] }
    }
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "4d" }, { pattern: "**/*.4dm" }],
    initializationOptions: { exclusions, builtinConstantsPaths },
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.4dm"),
        vscode.workspace.createFileSystemWatcher("**/Project/Sources/catalog.4DCatalog"),
        vscode.workspace.createFileSystemWatcher("**/Resources/Constants_*.xlf"),
        vscode.workspace.createFileSystemWatcher("**/Components/**/*.{4DZ,4dz}")
      ]
    },
    outputChannel: output
  };
  const client = new LanguageClient(
    "4dLanguageServer",
    "4D Language Server",
    serverOptions,
    clientOptions
  );
  void client.start();
  return client;
}
