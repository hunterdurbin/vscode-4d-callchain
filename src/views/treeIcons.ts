import * as vscode from "vscode";
import { SymbolKind, SymbolRecord } from "../model/symbol";

export function iconFor(s: SymbolRecord): vscode.ThemeIcon {
  switch (s.kind) {
    case SymbolKind.ProjectMethod:    return new vscode.ThemeIcon("symbol-method");
    case SymbolKind.CompilerMethod:   return new vscode.ThemeIcon("symbol-ruler");
    case SymbolKind.Class:            return new vscode.ThemeIcon("symbol-class");
    case SymbolKind.ClassFunction:    return new vscode.ThemeIcon("symbol-function");
    case SymbolKind.ClassConstructor: return new vscode.ThemeIcon("symbol-constructor");
    case SymbolKind.FormMethod:
    case SymbolKind.TableFormMethod:  return new vscode.ThemeIcon("preview");
    case SymbolKind.FormObjectMethod:
    case SymbolKind.TableObjectMethod:return new vscode.ThemeIcon("symbol-property");
    case SymbolKind.DatabaseMethod:   return new vscode.ThemeIcon("database");
    case SymbolKind.Plugin:           return new vscode.ThemeIcon("plug");
    case SymbolKind.Builtin:          return new vscode.ThemeIcon("symbol-keyword");
    case SymbolKind.Unresolved:       return new vscode.ThemeIcon("question");
    default:                          return new vscode.ThemeIcon("symbol-misc");
  }
}

export function descriptionFor(s: SymbolRecord): string {
  if (s.ownerClass) return s.ownerClass;
  return s.kind;
}
