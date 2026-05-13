import * as vscode from "vscode";
import { SymbolKind, SymbolRecord } from "../model/symbol";

export function iconFor(s: SymbolRecord): vscode.ThemeIcon {
  switch (s.kind) {
    case SymbolKind.ProjectMethod:    return new vscode.ThemeIcon("symbol-method");
    case SymbolKind.CompilerMethod:   return new vscode.ThemeIcon("symbol-ruler");
    case SymbolKind.Class:            return new vscode.ThemeIcon("symbol-class");
    case SymbolKind.ClassFunction:    return new vscode.ThemeIcon("symbol-function");
    case SymbolKind.ClassConstructor: return new vscode.ThemeIcon("symbol-constructor");
    case SymbolKind.ClassGetter:      return new vscode.ThemeIcon("arrow-small-right");
    case SymbolKind.ClassSetter:      return new vscode.ThemeIcon("arrow-small-left");
    case SymbolKind.FormMethod:
    case SymbolKind.TableFormMethod:  return new vscode.ThemeIcon("preview");
    case SymbolKind.FormObjectMethod:
    case SymbolKind.TableObjectMethod:return new vscode.ThemeIcon("symbol-property");
    case SymbolKind.DatabaseMethod:   return new vscode.ThemeIcon("database");
    case SymbolKind.Plugin:           return new vscode.ThemeIcon("plug");
    case SymbolKind.Builtin:          return new vscode.ThemeIcon("symbol-keyword");
    case SymbolKind.Constant:         return new vscode.ThemeIcon("symbol-constant");
    case SymbolKind.Unresolved:       return new vscode.ThemeIcon("question");
    default:                          return new vscode.ThemeIcon("symbol-misc");
  }
}

export function descriptionFor(s: SymbolRecord): string {
  const suffix =
    s.kind === SymbolKind.ClassGetter ? " · get" :
    s.kind === SymbolKind.ClassSetter ? " · set" : "";
  if (s.ownerClass) return `${s.ownerClass}${suffix}`;
  return `${s.kind}${suffix}`;
}
