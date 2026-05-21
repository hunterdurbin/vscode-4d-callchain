/**
 * CST visitor — walks a tree-sitter parse tree of a 4D source file and
 * produces a `ParsedFile` matching the legacy regex parser's contract.
 *
 * Scope: declarations (Class / Function / Constructor / property / var /
 * legacy C_* / #DECLARE) and call sites (call_expression, member_expression,
 * assignment to property, multi-word commands). Local-type inference from
 * assignment RHS is included for the common cs.X.new() / ds.Table.method()
 * patterns. Less-common shapes degrade to BareName or are skipped — full
 * parity is the goal of Phase 6.
 */

import * as path from "path";
import type { Node } from "web-tree-sitter";
import type { DiscoveredFile } from "../indexer/projectScanner";
import type { ParsedFile } from "../indexer/fileParser";
import {
  CallHint,
  ChainStep,
  ClassFlavor,
  FileLocation,
  RawCallSite,
  SymbolKind,
  SymbolParam,
  SymbolRecord,
  symbolIdFor,
} from "../model/symbol";

export class CstVisitor {
  private symbols: SymbolRecord[] = [];
  private rawCalls: RawCallSite[] = [];
  private localTypes = new Map<string, Map<string, string>>();
  private localStrings = new Map<string, Map<string, string>>();
  private classPropertyTypes = new Map<string, string>();
  private classMethodReturnsByName = new Map<string, string>();

  private classInfo:
    | { name: string; extends?: string; flavor: ClassFlavor }
    | undefined;
  private currentSymbolId: string | null = null;
  private currentSymbol: SymbolRecord | null = null;
  private currentLocals: Map<string, string> | null = null;
  private currentStrings: Map<string, string> | null = null;
  private fileUri: string;

  constructor(
    private file: DiscoveredFile,
    private source: string,
    _constants?: Set<string>,
  ) {
    this.fileUri = `file://${file.absolutePath}`;
    if (file.category === "class") {
      const className = path.basename(file.absolutePath, ".4dm");
      this.classInfo = { name: className, flavor: ClassFlavor.Generic };
      // Synthesize the class symbol immediately — the constructor / functions
      // attach to it as ownerClass.
      this.symbols.push({
        id: symbolIdFor(SymbolKind.Class, className),
        name: className,
        kind: SymbolKind.Class,
        location: { uri: this.fileUri, line: 0 },
        classFlavor: ClassFlavor.Generic,
      });
    } else if (
      file.category === "method" ||
      file.category === "compilerMethod"
    ) {
      // Project method: one top-level symbol whose name is the filename.
      const name = path.basename(file.absolutePath, ".4dm");
      const sym: SymbolRecord = {
        id: symbolIdFor(
          file.category === "compilerMethod"
            ? SymbolKind.CompilerMethod
            : SymbolKind.ProjectMethod,
          name,
        ),
        name,
        kind:
          file.category === "compilerMethod"
            ? SymbolKind.CompilerMethod
            : SymbolKind.ProjectMethod,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.currentSymbol = sym;
      this.currentSymbolId = sym.id;
      this.currentLocals = new Map();
      this.currentStrings = new Map();
      this.localTypes.set(sym.id, this.currentLocals);
      this.localStrings.set(sym.id, this.currentStrings);
    }
  }

  visit(root: Node): ParsedFile {
    for (let i = 0; i < root.childCount; i++) {
      this.visitTopLevel(root.child(i)!);
    }
    return {
      file: this.file,
      symbols: this.symbols,
      rawCalls: this.rawCalls,
      localTypes: this.localTypes,
      localStrings: this.localStrings,
      classInfo: this.classInfo,
      classPropertyTypes:
        this.classPropertyTypes.size > 0 ? this.classPropertyTypes : undefined,
      classMethodReturnsByName:
        this.classMethodReturnsByName.size > 0
          ? this.classMethodReturnsByName
          : undefined,
    };
  }

  // ---- Top-level dispatch ----

  private visitTopLevel(node: Node): void {
    switch (node.type) {
      case "class_extends_header":
        this.visitClassExtends(node);
        break;
      case "constructor_declaration":
        this.visitConstructor(node);
        break;
      case "function_declaration":
        this.visitFunctionDecl(node);
        break;
      case "property_declaration":
        this.visitPropertyDecl(node);
        break;
      case "declare_directive":
        this.visitDeclare(node);
        break;
      case "var_declaration":
        this.visitVarDecl(node);
        break;
      case "legacy_var_declaration":
      case "legacy_array_declaration":
        this.visitLegacyDecl(node);
        break;
      case "assignment_statement":
        this.visitAssignment(node);
        break;
      case "expression_statement":
        this.visitExpression(node.childForFieldName("expression"));
        break;
      case "return_statement": {
        const value = node.childForFieldName("value");
        if (value) this.visitExpression(value);
        break;
      }
      // Control flow — recurse into bodies so calls inside if/for/etc. land
      // on the enclosing symbol.
      case "if_statement":
      case "else_if_clause":
      case "else_clause":
      case "case_of_statement":
      case "case_label_arm":
      case "case_else_clause":
      case "for_statement":
      case "for_each_statement":
      case "while_statement":
      case "repeat_statement":
      case "use_statement":
      case "try_statement":
      case "catch_clause":
        for (let i = 0; i < node.childCount; i++) {
          this.visitTopLevel(node.child(i)!);
        }
        break;
      default:
        // Unknown / unhandled node types are ignored.
        break;
    }
  }

  // ---- Declaration handlers ----

  private visitClassExtends(node: Node): void {
    if (!this.classInfo) return;
    const base = node.childForFieldName("base");
    if (base) {
      this.classInfo.extends = base.text;
      // Crude flavor inference: a class extending `Entity` is an Entity class,
      // extending `EntitySelection` is a selection class. Anything else stays
      // Generic.
      const baseName = base.text;
      if (baseName === "Entity") this.classInfo.flavor = ClassFlavor.Entity;
      else if (baseName === "EntitySelection")
        this.classInfo.flavor = ClassFlavor.EntitySelection;
      else if (baseName === "DataStore")
        this.classInfo.flavor = ClassFlavor.DataStore;
      // Reflect the flavor on the synthetic Class symbol.
      const classSym = this.symbols.find(
        (s) => s.kind === SymbolKind.Class && s.name === this.classInfo!.name,
      );
      if (classSym) {
        classSym.classFlavor = this.classInfo.flavor;
        classSym.extendsClass = this.classInfo.extends;
      }
    }
  }

  private visitConstructor(node: Node): void {
    if (!this.classInfo) return;
    const className = this.classInfo.name;
    const sym: SymbolRecord = {
      id: symbolIdFor(SymbolKind.ClassConstructor, "constructor", className),
      name: "constructor",
      kind: SymbolKind.ClassConstructor,
      ownerClass: className,
      accessor: "function",
      scope: "public",
      location: this.locationOf(node, node),
    };
    const params = this.collectParams(node.childForFieldName("parameters"));
    if (params.length) sym.params = params;
    this.symbols.push(sym);
    this.beginSymbol(sym, params);
  }

  private visitFunctionDecl(node: Node): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const name = nameNode.text;

    const accessor = node.childForFieldName("accessor");
    const scope = node.childForFieldName("scope");

    let kind: SymbolKind = this.classInfo
      ? SymbolKind.ClassFunction
      : SymbolKind.ProjectMethod;
    let accessorTag: "get" | "set" | "function" = "function";
    if (accessor?.type === "keyword_get") {
      kind = SymbolKind.ClassGetter;
      accessorTag = "get";
    } else if (accessor?.type === "keyword_set") {
      kind = SymbolKind.ClassSetter;
      accessorTag = "set";
    }

    let scopeTag: "local" | "shared" | "public" = "public";
    if (scope?.type === "keyword_local") scopeTag = "local";
    else if (scope?.type === "keyword_shared") scopeTag = "shared";

    const sym: SymbolRecord = {
      id: this.classInfo
        ? symbolIdFor(kind, name, this.classInfo.name)
        : symbolIdFor(kind, name),
      name,
      kind,
      ownerClass: this.classInfo?.name,
      accessor: accessorTag,
      scope: scopeTag,
      location: this.locationOf(nameNode, nameNode),
    };

    const params = this.collectParams(node.childForFieldName("parameters"));
    if (params.length) sym.params = params;

    // Capture return type for chain resolution.
    const ret = node.childForFieldName("return_type");
    if (ret) {
      const typeNode = ret.childForFieldName("type");
      if (typeNode) {
        sym.returnType = typeNode.text;
        if (this.classInfo) {
          if (accessorTag === "get") {
            this.classPropertyTypes.set(name, typeNode.text);
          } else if (accessorTag === "function") {
            this.classMethodReturnsByName.set(name, typeNode.text);
          }
        }
      }
    }

    this.symbols.push(sym);
    this.beginSymbol(sym, params);
  }

  private visitPropertyDecl(node: Node): void {
    if (!this.classInfo) return;
    const nameNode = node.childForFieldName("name");
    const typeAnn = node.childForFieldName("type");
    if (!nameNode) return;
    if (typeAnn) {
      const typeNode = typeAnn.childForFieldName("type");
      if (typeNode) this.classPropertyTypes.set(nameNode.text, typeNode.text);
    }
  }

  private visitDeclare(node: Node): void {
    const params = this.collectParams(node.childForFieldName("parameters"));
    if (this.currentSymbol) {
      if (!this.currentSymbol.params || this.currentSymbol.params.length === 0) {
        if (params.length) this.currentSymbol.params = params;
      }
      // Park param types in the current symbol's local table so $-completion
      // can find them.
      if (this.currentLocals) {
        for (const p of params) {
          if (p.type) this.currentLocals.set(p.name, p.type);
        }
      }
    }
    const ret = node.childForFieldName("return");
    if (ret) {
      const retType = ret.childForFieldName("type");
      const retName = ret.childForFieldName("name");
      if (retType && this.currentSymbol) {
        this.currentSymbol.returnType = retType.text;
      }
      if (retName && retType && this.currentLocals) {
        // `$result : Type` — register the local too.
        const localName = retName.text.replace(/^\$/, "");
        this.currentLocals.set(localName, retType.text);
      }
    }
  }

  private visitVarDecl(node: Node): void {
    if (!this.currentLocals) return;
    const typeAnn = node.childForFieldName("type");
    const typeStr = typeAnn?.text;
    // Collect every var-decl-name child as a target.
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === "local_var") {
        const name = c.text.replace(/^\$/, "");
        if (typeStr) this.currentLocals.set(name, typeStr);
      }
    }
  }

  private visitLegacyDecl(node: Node): void {
    if (!this.currentLocals) return;
    const typeKw = node.child(0);
    if (!typeKw) return;
    // c_type_keyword text is `C_<TYPE>`; array_type_keyword is `ARRAY <TYPE>`.
    const canon = this.canonicalLegacyType(typeKw.text);
    if (!canon) return;
    for (let i = 1; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === "local_var") {
        this.currentLocals.set(c.text.replace(/^\$/, ""), canon);
      }
    }
  }

  // ---- Statement handlers ----

  private visitAssignment(node: Node): void {
    const target = node.childForFieldName("target");
    const value = node.childForFieldName("value");
    if (!target || !value) return;

    // Local-type inference: `$x := cs.Y.new()` etc.
    if (target.type === "local_var" && this.currentLocals) {
      const localName = target.text.replace(/^\$/, "");
      const inferred = this.inferRhsType(value);
      if (inferred) this.currentLocals.set(localName, inferred);
      // Also track string-literal assignments so form-name recovery works.
      if (value.type === "string" && this.currentStrings) {
        const literal = stripQuotes(value.text);
        this.currentStrings.set(localName, literal);
      }
    }

    // Property write: `This.prop := value` or `$x.prop := value`.
    if (target.type === "member_expression") {
      this.emitPropertyAssign(target, node);
    }

    // Visit both sides for any nested calls (RHS commonly has the call).
    this.visitExpression(target);
    this.visitExpression(value);
  }

  private visitExpression(node: Node | null | undefined): void {
    if (!node) return;
    switch (node.type) {
      case "call_expression":
        this.emitCall(node);
        // Recurse into the function and arguments for nested calls.
        this.visitExpression(node.childForFieldName("function"));
        this.visitExpression(node.childForFieldName("arguments"));
        break;
      case "argument_list":
      case "parenthesized_expression":
      case "binary_expression":
      case "unary_expression":
      case "object_literal":
      case "collection_literal":
      case "object_entry":
        for (let i = 0; i < node.childCount; i++) {
          this.visitExpression(node.child(i)!);
        }
        break;
      case "member_expression":
      case "subscript_expression":
        for (let i = 0; i < node.childCount; i++) {
          this.visitExpression(node.child(i)!);
        }
        break;
      default:
        // primary expressions, multi_word_identifier alone, etc. — no
        // recursion needed.
        break;
    }
  }

  // ---- Call-site emission ----

  private emitCall(node: Node): void {
    if (!this.currentSymbolId) return;
    const fn = node.childForFieldName("function");
    if (!fn) return;

    const line = node.startPosition.row;
    const raw = this.lineText(line);
    const expression = node.text;
    const callSite: RawCallSite = {
      fromSymbolId: this.currentSymbolId,
      line,
      raw,
      expression,
    };

    const hint = this.classifyCallee(fn, node);
    if (hint) callSite.hint = hint;
    // Column position of the callee identifier.
    callSite.column = fn.startPosition.column;
    callSite.endColumn = fn.endPosition.column;

    this.rawCalls.push(callSite);
  }

  private classifyCallee(fn: Node, callNode: Node): CallHint | undefined {
    // Bare identifier: a project-method call (`Foo(...)` or `Foo` w/o parens).
    if (fn.type === "identifier") {
      const name = fn.text;
      return { kind: "BareName", name };
    }

    // Multi-word builtin / command: `CALL WORKER(...)`, `New process(...)`,
    // etc. We classify the well-known forms; everything else degrades to a
    // multi-word BareName.
    if (fn.type === "multi_word_identifier") {
      return this.classifyMultiWord(fn, callNode);
    }

    // Member expression — could be This.x, $var.x, cs.X.method, ds.X.method,
    // or a longer chain.
    if (fn.type === "member_expression") {
      return this.classifyMember(fn);
    }

    if (fn.type === "keyword_super") {
      return { kind: "SuperCall" };
    }
    return undefined;
  }

  private classifyMember(member: Node): CallHint | undefined {
    const object = member.childForFieldName("object");
    const property = member.childForFieldName("property");
    if (!object || !property) return undefined;
    const method = property.text;

    // This.method() → ThisCall (single segment) or ThisChainCall (multi-step).
    if (object.type === "keyword_this") {
      return { kind: "ThisCall", method };
    }
    if (object.type === "keyword_super") {
      return { kind: "SuperCall", method };
    }
    if (object.type === "local_var") {
      const variable = object.text.replace(/^\$/, "");
      return { kind: "VarCall", variable, method };
    }
    if (object.type === "identifier") {
      // Bare-identifier head — could be cs.X / ds.X or a generic chain.
      // We don't have enough context to classify; emit a generic BareName.
      return undefined;
    }
    if (object.type === "member_expression") {
      // Two-or-more-segment chain. Walk back to head to figure out the shape.
      const flat = this.flattenChain(member);
      if (!flat) return undefined;
      const { head, steps } = flat;
      // The last step IS the call's method; preceding steps are intermediate.
      const path = steps.slice(0, -1);
      const finalMethod = steps[steps.length - 1].name;
      // cs.Class.method / cs.NS.Class.method
      if (head.type === "cs" && path.length === 1) {
        const className = path[0].name;
        if (finalMethod === "new") return { kind: "CsNew", className };
        return { kind: "CsCall", className, method: finalMethod };
      }
      if (head.type === "cs" && path.length === 2) {
        const namespace = path[0].name;
        const className = path[1].name;
        if (finalMethod === "new")
          return { kind: "CsNewNs", namespace, className };
        return {
          kind: "CsCallNs",
          namespace,
          className,
          method: finalMethod,
        };
      }
      if (head.type === "ds" && path.length === 1) {
        const className = path[0].name;
        return { kind: "DsCall", className, method: finalMethod };
      }
      if (head.type === "this") {
        return {
          kind: "ThisChainCall",
          path,
          method: finalMethod,
        };
      }
      if (head.type === "var" && head.name) {
        return {
          kind: "VarChainCall",
          variable: head.name,
          path,
          method: finalMethod,
        };
      }
    }
    return undefined;
  }

  /**
   * Walks a member_expression back to its head. Returns the head shape and
   * an ordered list of segments. The terminal segment is the call's
   * property name.
   */
  private flattenChain(
    member: Node,
  ):
    | { head: ChainHead; steps: ChainStep[] }
    | undefined {
    const steps: ChainStep[] = [];
    let cursor: Node | null = member;
    while (cursor && cursor.type === "member_expression") {
      const prop = cursor.childForFieldName("property");
      if (prop) steps.unshift({ name: prop.text, isCall: false });
      cursor = cursor.childForFieldName("object");
    }
    if (!cursor) return undefined;
    if (cursor.type === "keyword_this") return { head: { type: "this" }, steps };
    if (cursor.type === "local_var") {
      return {
        head: { type: "var", name: cursor.text.replace(/^\$/, "") },
        steps,
      };
    }
    if (cursor.type === "identifier") {
      const t = cursor.text;
      if (t === "cs") return { head: { type: "cs" }, steps };
      if (t === "ds") return { head: { type: "ds" }, steps };
      return { head: { type: "ident", name: t }, steps };
    }
    return undefined;
  }

  private classifyMultiWord(fn: Node, _callNode: Node): CallHint | undefined {
    // Reconstruct the multi-word name.
    const parts: string[] = [];
    for (let i = 0; i < fn.childCount; i++) {
      const c = fn.child(i);
      if (c && c.type === "identifier") parts.push(c.text);
    }
    const name = parts.join(" ");
    return { kind: "BareName", name };
  }

  private emitPropertyAssign(target: Node, _stmt: Node): void {
    if (!this.currentSymbolId) return;
    const object = target.childForFieldName("object");
    const property = target.childForFieldName("property");
    if (!object || !property) return;
    const propName = property.text;
    const line = target.startPosition.row;
    const raw = this.lineText(line);

    let hint: CallHint | undefined;
    if (object.type === "keyword_this") {
      hint = { kind: "ThisSet", property: propName };
    } else if (object.type === "local_var") {
      hint = {
        kind: "VarSet",
        variable: object.text.replace(/^\$/, ""),
        property: propName,
      };
    }
    if (hint) {
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line,
        raw,
        expression: target.text,
        hint,
        column: property.startPosition.column,
        endColumn: property.endPosition.column,
      });
    }
  }

  // ---- Helpers ----

  private beginSymbol(sym: SymbolRecord, params: SymbolParam[]): void {
    this.currentSymbol = sym;
    this.currentSymbolId = sym.id;
    this.currentLocals = new Map();
    this.currentStrings = new Map();
    this.localTypes.set(sym.id, this.currentLocals);
    this.localStrings.set(sym.id, this.currentStrings);
    // Pre-populate param types into the local table.
    for (const p of params) {
      if (p.type) this.currentLocals.set(p.name, p.type);
    }
  }

  private collectParams(paramList: Node | null | undefined): SymbolParam[] {
    if (!paramList) return [];
    const out: SymbolParam[] = [];
    for (let i = 0; i < paramList.childCount; i++) {
      const c = paramList.child(i)!;
      if (c.type !== "parameter_decl") continue;
      const nameNode = c.childForFieldName("name");
      const typeNode = c.childForFieldName("type");
      if (!nameNode) continue;
      const rawName = nameNode.text;
      const name = rawName.startsWith("$") ? rawName.slice(1) : rawName;
      out.push(typeNode ? { name, type: typeNode.text } : { name });
    }
    return out;
  }

  private inferRhsType(value: Node): string | undefined {
    // `cs.X.new(...)` → `cs.X`
    // `ds.Table.new()` → `dsTable:Table`
    // `ds.Table.query(...)` → `entitySelectionOf:Table`
    if (value.type === "call_expression") {
      const fn = value.childForFieldName("function");
      if (!fn) return undefined;
      if (fn.type === "member_expression") {
        const flat = this.flattenChain(fn);
        if (!flat) return undefined;
        const { head, steps } = flat;
        const terminal = steps[steps.length - 1]?.name;
        if (head.type === "cs" && terminal === "new") {
          // cs.X.new or cs.NS.X.new — assemble dotted path of pre-terminal
          // identifiers.
          const path = steps.slice(0, -1).map((s) => s.name);
          return path.length === 1
            ? `cs.${path[0]}`
            : `cs.${path.join(".")}`;
        }
        if (head.type === "ds" && terminal === "new") {
          // ds.Table.new() → dsTable:Table (single-entity convention).
          if (steps.length === 2) return `dsTable:${steps[0].name}`;
        }
        if (
          head.type === "ds" &&
          (terminal === "query" ||
            terminal === "all" ||
            terminal === "fromCollection" ||
            terminal === "orderBy" ||
            terminal === "newSelection")
        ) {
          if (steps.length === 2)
            return `entitySelectionOf:${steps[0].name}`;
        }
      }
    }
    return undefined;
  }

  private canonicalLegacyType(rawKw: string): string | undefined {
    // `C_LONGINT` → `LONGINT`; `ARRAY TEXT` → `TEXT`.
    const m =
      /^c_([a-z]+)$/i.exec(rawKw) ||
      /^array[ \t]+([a-z]+)$/i.exec(rawKw);
    if (!m) return undefined;
    const t = m[1].toUpperCase();
    switch (t) {
      case "LONGINT":
      case "INTEGER":
      case "REAL":
      case "NUMERIC":
        return "Number";
      case "TEXT":
      case "STRING":
      case "ALPHA":
        return "Text";
      case "BOOLEAN":
        return "Boolean";
      case "DATE":
        return "Date";
      case "TIME":
        return "Time";
      case "BLOB":
        return "Blob";
      case "PICTURE":
        return "Picture";
      case "OBJECT":
        return "Object";
      case "COLLECTION":
        return "Collection";
      default:
        return undefined;
    }
  }

  private locationOf(start: Node, end: Node): FileLocation {
    return {
      uri: this.fileUri,
      line: start.startPosition.row,
      column: start.startPosition.column,
      endColumn: end.endPosition.column,
    };
  }

  private lineText(line: number): string {
    const lines = this.source.split(/\r?\n/);
    return lines[line] ?? "";
  }
}

interface ChainHead {
  type: "this" | "cs" | "ds" | "var" | "ident";
  name?: string;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}
