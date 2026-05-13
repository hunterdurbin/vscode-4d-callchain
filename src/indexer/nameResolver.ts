import { CallEdge, CallKind, RawCallSite, SymbolIndex, SymbolKind, SymbolRecord, symbolIdFor } from "../model/symbol";
import { ParsedFile } from "./fileParser";
import builtinsData from "../model/builtins.json";

const BUILTIN_SET = new Set<string>((builtinsData as any).commands);
const PLUGIN_PREFIXES: string[] = (builtinsData as any).pluginCommandPrefixes ?? [];

export interface ResolverInput {
  files: ParsedFile[];
  plugins: { name: string; symbolId: string }[];
}

export interface ResolverOutput {
  edges: CallEdge[];
  unresolvedSymbols: SymbolRecord[];
}

export function resolve(input: ResolverInput, projectSymbols: SymbolRecord[]): ResolverOutput {
  const edges: CallEdge[] = [];
  const unresolved: SymbolRecord[] = [];
  const unresolvedSeen = new Set<string>();

  // Build indexes for fast lookup.
  const byName = new Map<string, SymbolRecord[]>();
  const classByName = new Map<string, SymbolRecord>();
  for (const s of projectSymbols) {
    const key = s.name.toLowerCase();
    const arr = byName.get(key) ?? [];
    arr.push(s);
    byName.set(key, arr);
    if (s.kind === SymbolKind.Class) {
      classByName.set(s.name.toLowerCase(), s);
    }
  }
  const classFunctions = new Map<string, SymbolRecord>(); // key: className.fnName (lowercase)
  for (const s of projectSymbols) {
    if ((s.kind === SymbolKind.ClassFunction || s.kind === SymbolKind.ClassConstructor) && s.ownerClass) {
      classFunctions.set(`${s.ownerClass}.${s.name}`.toLowerCase(), s);
    }
  }
  const pluginByName = new Map<string, string>();
  for (const p of input.plugins) pluginByName.set(p.name.toLowerCase(), p.symbolId);

  const findOrCreateBuiltin = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Builtin, name);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      unresolved.push({
        id,
        name,
        kind: SymbolKind.Builtin,
        location: { uri: "", line: 0 }
      });
    }
    return id;
  };

  const findOrCreateUnresolved = (name: string): string => {
    const id = symbolIdFor(SymbolKind.Unresolved, name);
    if (!unresolvedSeen.has(id)) {
      unresolvedSeen.add(id);
      unresolved.push({
        id,
        name,
        kind: SymbolKind.Unresolved,
        location: { uri: "", line: 0 }
      });
    }
    return id;
  };

  // Walks the inheritance chain (extends) for a class and looks up a function name.
  const resolveOnClassChain = (className: string, method: string): SymbolRecord | undefined => {
    let cur: string | undefined = className;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.toLowerCase())) {
      visited.add(cur.toLowerCase());
      const key = `${cur}.${method}`.toLowerCase();
      const f = classFunctions.get(key);
      if (f) return f;
      const cls = classByName.get(cur.toLowerCase());
      cur = cls?.extendsClass;
    }
    return undefined;
  };

  for (const parsed of input.files) {
    const localTypes = parsed.localTypes;
    const className = parsed.classInfo?.name;

    for (const call of parsed.rawCalls) {
      const hint = call.hint;
      if (!hint) continue;
      const pushEdge = (toId: string, kind: CallKind, resolved: boolean) => {
        edges.push({
          fromId: call.fromSymbolId,
          toId,
          callKind: kind,
          line: call.line,
          raw: call.expression,
          resolved
        });
      };

      switch (hint.kind) {
        case "BareName": {
          // Order: project method by name → builtin → unresolved
          const matches = byName.get(hint.name.toLowerCase()) ?? [];
          const method = matches.find(
            (s) =>
              s.kind === SymbolKind.ProjectMethod ||
              s.kind === SymbolKind.DatabaseMethod
          );
          if (method) {
            pushEdge(method.id, CallKind.Static, true);
          } else if (BUILTIN_SET.has(hint.name)) {
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else if (PLUGIN_PREFIXES.some((p) => hint.name.startsWith(p))) {
            // Plugin-like (e.g. HTTP_Get) — classify as builtin/plugin
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(hint.name), CallKind.Dynamic, false);
          }
          break;
        }
        case "BuiltinChain": {
          if (BUILTIN_SET.has(hint.name)) {
            pushEdge(findOrCreateBuiltin(hint.name), CallKind.Static, true);
          }
          break;
        }
        case "CsNew": {
          const cls = classByName.get(hint.className.toLowerCase());
          if (cls) {
            const ctor = classFunctions.get(`${cls.name}.constructor`.toLowerCase());
            pushEdge(ctor?.id ?? cls.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(`cs.${hint.className}.new`), CallKind.Dynamic, false);
          }
          break;
        }
        case "CsCall": {
          const fn = resolveOnClassChain(hint.className, hint.method);
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            pushEdge(findOrCreateUnresolved(`cs.${hint.className}.${hint.method}`), CallKind.Dynamic, false);
          }
          break;
        }
        case "DsCall": {
          // ds.<DataClassName>.<fn>(...) — try classes named both DataClassName and singular Entity variants.
          const fn =
            resolveOnClassChain(hint.className, hint.method) ??
            classFunctions.get(`${hint.className}.${hint.method}`.toLowerCase());
          if (fn) {
            pushEdge(fn.id, CallKind.Static, true);
          } else {
            // Might be a built-in DataClass method like .query, .create, .all etc.
            pushEdge(findOrCreateBuiltin(`ds.${hint.className}.${hint.method}`), CallKind.Static, true);
          }
          break;
        }
        case "ThisCall": {
          if (className) {
            const fn = resolveOnClassChain(className, hint.method);
            if (fn) {
              pushEdge(fn.id, fn.ownerClass === className ? CallKind.Static : CallKind.Inherited, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(`This.${hint.method}`), CallKind.Dynamic, false);
          break;
        }
        case "SuperCall": {
          if (className && parsed.classInfo?.extends) {
            const m = hint.method ?? "constructor";
            const fn = resolveOnClassChain(parsed.classInfo.extends, m);
            if (fn) {
              pushEdge(fn.id, CallKind.Inherited, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved("Super"), CallKind.Dynamic, false);
          break;
        }
        case "VarCall": {
          const fromId = call.fromSymbolId;
          const locals = localTypes.get(fromId);
          const type = locals?.get(hint.variable);
          if (type) {
            // cs.Foo style
            const csMatch = type.match(/^cs\.([\w_]+)$/);
            const esMatch = type.match(/^entitySelectionOf:([\w_]+)$/);
            const targetClass = csMatch?.[1] ?? esMatch?.[1];
            if (targetClass) {
              const fn = resolveOnClassChain(targetClass, hint.method);
              if (fn) {
                pushEdge(fn.id, CallKind.Static, true);
                break;
              }
              pushEdge(findOrCreateBuiltin(`${targetClass}.${hint.method}`), CallKind.Static, true);
              break;
            }
          }
          pushEdge(findOrCreateUnresolved(`$${hint.variable}.${hint.method}`), CallKind.Dynamic, false);
          break;
        }
        case "CallWorker":
        case "NewProcess":
        case "ExecuteMethodLiteral": {
          const matches = byName.get(hint.methodName.toLowerCase()) ?? [];
          const method = matches.find((s) => s.kind === SymbolKind.ProjectMethod || s.kind === SymbolKind.DatabaseMethod);
          if (method) pushEdge(method.id, CallKind.Dynamic, true);
          else pushEdge(findOrCreateUnresolved(hint.methodName), CallKind.Dynamic, false);
          break;
        }
        case "ExecuteMethodDynamic": {
          pushEdge(findOrCreateUnresolved(`EXECUTE_METHOD($${hint.variable})`), CallKind.Dynamic, false);
          break;
        }
        case "ExecuteMethodInSubform": {
          const matches = byName.get(`${hint.formName}.${hint.methodName}`.toLowerCase()) ?? [];
          const method = matches[0];
          if (method) pushEdge(method.id, CallKind.Dynamic, true);
          else pushEdge(findOrCreateUnresolved(`${hint.formName}.${hint.methodName}`), CallKind.Dynamic, false);
          break;
        }
        case "Formula": {
          // The body's calls were already extracted by callExtractor.
          break;
        }
      }
    }
  }

  // Deduplicate identical edges (same from/to/line)
  const seen = new Set<string>();
  const uniq: CallEdge[] = [];
  for (const e of edges) {
    const key = `${e.fromId}|${e.toId}|${e.line}|${e.callKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  return { edges: uniq, unresolvedSymbols: unresolved };
}

export function buildSymbolIndex(
  projectRoot: string,
  parsedFiles: ParsedFile[],
  plugins: { name: string; absolutePath: string }[]
): SymbolIndex {
  const allSymbols: SymbolRecord[] = [];
  for (const f of parsedFiles) {
    for (const s of f.symbols) allSymbols.push(s);
  }
  const pluginSyms = plugins.map((p) => ({
    id: symbolIdFor(SymbolKind.Plugin, p.name),
    name: p.name,
    kind: SymbolKind.Plugin,
    location: { uri: "file://" + p.absolutePath, line: 0 }
  }));
  for (const s of pluginSyms) allSymbols.push(s);

  const { edges, unresolvedSymbols } = resolve(
    { files: parsedFiles, plugins: pluginSyms.map((s) => ({ name: s.name, symbolId: s.id })) },
    allSymbols
  );

  for (const u of unresolvedSymbols) allSymbols.push(u);

  return {
    version: 2,
    builtAt: Date.now(),
    projectRoot,
    symbols: allSymbols,
    edges,
    fileMtimes: {}
  };
}
