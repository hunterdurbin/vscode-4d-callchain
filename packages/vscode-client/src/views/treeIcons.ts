import * as vscode from "vscode";
import { SymbolKind } from "@4d/core";
import type { SymbolRecord } from "@4d/core";

export function iconFor(s: SymbolRecord): vscode.ThemeIcon {
  switch (s.kind) {
    case SymbolKind.ProjectMethod:    return new vscode.ThemeIcon("symbol-method");
    case SymbolKind.CompilerMethod:   return new vscode.ThemeIcon("symbol-ruler");
    case SymbolKind.Class:            return new vscode.ThemeIcon("symbol-class");
    case SymbolKind.ClassFunction:    return new vscode.ThemeIcon("symbol-function");
    case SymbolKind.ClassConstructor: return new vscode.ThemeIcon("symbol-constructor");
    case SymbolKind.ClassGetter:      return new vscode.ThemeIcon("arrow-small-right");
    case SymbolKind.ClassSetter:      return new vscode.ThemeIcon("arrow-small-left");
    case SymbolKind.ClassProperty:    return new vscode.ThemeIcon("symbol-property");
    case SymbolKind.Form:
    case SymbolKind.TableForm:        return new vscode.ThemeIcon("window");
    case SymbolKind.FormMethod:
    case SymbolKind.TableFormMethod:  return new vscode.ThemeIcon("preview");
    case SymbolKind.FormObjectMethod:
    case SymbolKind.TableObjectMethod:return new vscode.ThemeIcon("symbol-property");
    case SymbolKind.DatabaseMethod:   return new vscode.ThemeIcon("database");
    case SymbolKind.Plugin:           return new vscode.ThemeIcon("plug");
    case SymbolKind.PluginCommand:    return new vscode.ThemeIcon("symbol-method");
    case SymbolKind.Component:        return new vscode.ThemeIcon("package");
    case SymbolKind.ComponentMethod:  return new vscode.ThemeIcon("symbol-method");
    case SymbolKind.Builtin:          return new vscode.ThemeIcon("symbol-keyword");
    case SymbolKind.TableBuiltin:     return new vscode.ThemeIcon("database");
    case SymbolKind.Constant:         return new vscode.ThemeIcon("symbol-constant");
    case SymbolKind.BuiltinConstant:  return new vscode.ThemeIcon("symbol-numeric");
    case SymbolKind.ProcessVariable:  return new vscode.ThemeIcon("symbol-variable");
    case SymbolKind.InterprocessVariable: return new vscode.ThemeIcon("symbol-variable");
    case SymbolKind.Unresolved:       return new vscode.ThemeIcon("question");
    default:                          return new vscode.ThemeIcon("symbol-misc");
  }
}

export function descriptionFor(s: SymbolRecord): string {
  if (s.kind === SymbolKind.Constant) {
    const valueStr = formatConstantValue(s.constantValue, s.constantType);
    const typeStr = s.constantType ?? "";
    if (valueStr && typeStr) return `= ${valueStr} · ${typeStr}`;
    if (valueStr) return `= ${valueStr}`;
    if (typeStr) return typeStr;
    return "Constant";
  }
  if (s.kind === SymbolKind.BuiltinConstant) {
    const valueStr = formatConstantValue(s.constantValue, undefined);
    const theme = s.constantTheme ?? "";
    if (valueStr && theme) return `= ${valueStr} · ${theme}`;
    if (valueStr) return `= ${valueStr}`;
    if (theme) return theme;
    return "Builtin constant";
  }
  if (s.kind === SymbolKind.PluginCommand) {
    return s.ownerPlugin ? `${s.ownerPlugin}` : "Plugin command";
  }
  if (s.kind === SymbolKind.ComponentMethod) {
    return s.ownerComponent ? `${s.ownerComponent}` : "Component method";
  }
  if (s.kind === SymbolKind.TableForm || s.kind === SymbolKind.TableFormMethod || s.kind === SymbolKind.TableObjectMethod) {
    if (s.ownerTable) return `[${s.ownerTable}]`;
  }
  if (s.kind === SymbolKind.TableBuiltin) {
    return s.ownerTable ? `[${s.ownerTable}]` : "Table builtin";
  }
  if (s.kind === SymbolKind.ProcessVariable || s.kind === SymbolKind.InterprocessVariable) {
    const prefix = s.kind === SymbolKind.InterprocessVariable ? "<> · " : "";
    if (s.variableType) return `${prefix}${s.variableType}`;
    return s.kind === SymbolKind.InterprocessVariable ? "Interprocess" : "Process";
  }
  const suffix =
    s.kind === SymbolKind.ClassGetter ? " · get" :
    s.kind === SymbolKind.ClassSetter ? " · set" : "";
  if (s.ownerClass) return `${s.ownerClass}${suffix}`;
  return `${s.kind}${suffix}`;
}

function formatConstantValue(value: string | undefined, type: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (type === "Text" || type === "Alpha") return `"${value}"`;
  if (type === "Boolean") return value;
  // Long values: truncate so the tree row stays readable.
  if (value.length > 40) return value.slice(0, 39) + "…";
  return value;
}
