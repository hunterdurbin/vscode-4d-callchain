import { SymbolKind as LspSymbolKind } from "vscode-languageserver/node";
import { SymbolKind } from "@4d/core";

/**
 * Map our rich 4D SymbolKind to LSP's standard SymbolKind. Lossy by design —
 * the original kind is preserved in custom-request payloads for richer clients.
 */
export function toLspKind(kind: SymbolKind): LspSymbolKind {
  switch (kind) {
    case SymbolKind.ProjectMethod:
    case SymbolKind.CompilerMethod:
    case SymbolKind.DatabaseMethod:
    case SymbolKind.PluginCommand:
    case SymbolKind.Builtin:
      return LspSymbolKind.Function;
    case SymbolKind.Class:
      return LspSymbolKind.Class;
    case SymbolKind.ClassFunction:
    case SymbolKind.ComponentMethod:
    case SymbolKind.FormMethod:
    case SymbolKind.FormObjectMethod:
    case SymbolKind.TableFormMethod:
    case SymbolKind.TableObjectMethod:
      return LspSymbolKind.Method;
    case SymbolKind.ClassConstructor:
      return LspSymbolKind.Constructor;
    case SymbolKind.ClassGetter:
    case SymbolKind.ClassSetter:
      return LspSymbolKind.Property;
    case SymbolKind.Plugin:
    case SymbolKind.Component:
      return LspSymbolKind.Package;
    case SymbolKind.Form:
    case SymbolKind.TableForm:
      return LspSymbolKind.Module;
    case SymbolKind.Constant:
    case SymbolKind.BuiltinConstant:
      return LspSymbolKind.Constant;
    case SymbolKind.ProcessVariable:
    case SymbolKind.InterprocessVariable:
      return LspSymbolKind.Variable;
    case SymbolKind.Unresolved:
    default:
      return LspSymbolKind.Variable;
  }
}
