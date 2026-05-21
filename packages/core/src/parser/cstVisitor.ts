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
      const kind =
        file.category === "compilerMethod"
          ? SymbolKind.CompilerMethod
          : SymbolKind.ProjectMethod;
      const sym: SymbolRecord = {
        id: symbolIdFor(kind, name),
        name,
        kind,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.beginFileSymbol(sym);
    } else if (file.category === "formMethod") {
      // Forms/<formName>/method.4dm → FormMethod symbol named `<form>.method`.
      const formName = file.containerName ?? "Form";
      const name = `${formName}.method`;
      const sym: SymbolRecord = {
        id: symbolIdFor(SymbolKind.FormMethod, name),
        name,
        kind: SymbolKind.FormMethod,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.beginFileSymbol(sym);
    } else if (
      file.category === "formObjectMethod" ||
      file.category === "tableObjectMethod"
    ) {
      const objName = path.basename(file.absolutePath, ".4dm");
      const containerName = file.containerName ?? "Form";
      const name = `${containerName}.${objName}`;
      const kind =
        file.category === "formObjectMethod"
          ? SymbolKind.FormObjectMethod
          : SymbolKind.TableObjectMethod;
      const ownerTable =
        file.category === "tableObjectMethod" ? file.ownerTableId : undefined;
      const sym: SymbolRecord = {
        id: ownerTable
          ? `${kind}:${ownerTable}.${name}`
          : symbolIdFor(kind, name),
        name,
        kind,
        ownerTable,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.beginFileSymbol(sym);
    } else if (file.category === "tableFormMethod") {
      const formName = file.containerName ?? "Form";
      const name = `${formName}.method`;
      const sym: SymbolRecord = {
        id: file.ownerTableId
          ? `${SymbolKind.TableFormMethod}:${file.ownerTableId}.${name}`
          : symbolIdFor(SymbolKind.TableFormMethod, name),
        name,
        kind: SymbolKind.TableFormMethod,
        ownerTable: file.ownerTableId,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.beginFileSymbol(sym);
    } else if (file.category === "databaseMethod") {
      const name = path.basename(file.absolutePath, ".4dm");
      const sym: SymbolRecord = {
        id: symbolIdFor(SymbolKind.DatabaseMethod, name),
        name,
        kind: SymbolKind.DatabaseMethod,
        location: { uri: this.fileUri, line: 0 },
      };
      this.symbols.push(sym);
      this.beginFileSymbol(sym);
    }
    // formDefinition / tableFormDefinition are JSON form files — the regex
    // parser handles them separately (extractFormDataSourceCalls). They're
    // not .4dm files, so the visitor never sees them via this code path.
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
        this.visitExpressionStatement(node);
        break;
      case "return_statement": {
        const value = node.childForFieldName("value");
        if (value) this.visitExpression(value);
        break;
      }
      // Control flow — recurse into bodies AND walk condition expressions
      // so calls and refs inside `If (...)` / `For ($i; ...)` etc. land on
      // the enclosing symbol.
      case "if_statement":
      case "else_if_clause":
      case "case_label_arm":
      case "while_statement":
      case "repeat_statement":
      case "use_statement":
        this.visitExpression(node.childForFieldName("condition"));
        this.visitExpression(node.childForFieldName("semaphore"));
        for (let i = 0; i < node.childCount; i++) {
          this.visitTopLevel(node.child(i)!);
        }
        break;
      case "for_statement":
        this.visitExpression(node.childForFieldName("counter"));
        this.visitExpression(node.childForFieldName("start"));
        this.visitExpression(node.childForFieldName("end"));
        this.visitExpression(node.childForFieldName("step"));
        for (let i = 0; i < node.childCount; i++) {
          this.visitTopLevel(node.child(i)!);
        }
        break;
      case "for_each_statement":
        this.visitExpression(node.childForFieldName("element"));
        this.visitExpression(node.childForFieldName("collection"));
        for (let i = 0; i < node.childCount; i++) {
          this.visitTopLevel(node.child(i)!);
        }
        break;
      case "else_clause":
      case "case_of_statement":
      case "case_else_clause":
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
    const typeKw = node.child(0);
    if (!typeKw) return;
    const isArray = node.type === "legacy_array_declaration";
    const canon = this.canonicalLegacyType(typeKw.text);
    // Emit a BareName/BuiltinChain call for the C_*/ARRAY * keyword itself
    // — matches the legacy regex parser's behavior so the indexer sees this
    // as a builtin invocation. ARRAY * is multi-word → BuiltinChain.
    if (this.currentSymbolId) {
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line: typeKw.startPosition.row,
        raw: this.lineText(typeKw.startPosition.row),
        expression: `${typeKw.text}(`,
        hint: isArray
          ? { kind: "BuiltinChain", name: typeKw.text }
          : { kind: "BareName", name: typeKw.text },
        column: typeKw.startPosition.column,
        endColumn: typeKw.endPosition.column,
      });
    }
    // Walk children: record local-type aliases AND emit InterprocessRef for
    // any `<>name` references inside the body.
    for (let i = 1; i < node.childCount; i++) {
      const c = node.child(i)!;
      if (c.type === "local_var" && canon && this.currentLocals) {
        this.currentLocals.set(c.text.replace(/^\$/, ""), canon);
      } else if (c.type === "interprocess_var") {
        this.emitInterprocessRef(c);
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

    // Interprocess var write: `<>aGlobal := value`.
    if (target.type === "interprocess_var") {
      this.emitInterprocessRef(target);
    }

    // Visit the RHS for any nested calls. The target is handled above —
    // we deliberately skip recursing into it so we don't double-emit a
    // ThisGet/VarGet for `This.prop:=…`.
    this.visitExpression(value);
    // The target may contain nested expressions worth walking. For a
    // subscript assignment like `This.entries[$key] := val`:
    //   * walk the index for any nested calls
    //   * emit a property-read on the inner member-expression (the legacy
    //     parser emits a ThisGet for `This.entries` here)
    if (target.type === "subscript_expression") {
      const index = target.childForFieldName("index");
      if (index) this.visitExpression(index);
      const inner = target.childForFieldName("object");
      if (inner && inner.type === "member_expression") {
        this.emitMemberRead(inner);
      }
    }
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
        // Property read — emit ThisGet / VarGet hints. Tree-sitter walks
        // member expressions left-to-right; we treat any member that isn't
        // the LHS of an assignment as a read.
        this.emitMemberRead(node);
        for (let i = 0; i < node.childCount; i++) {
          this.visitExpression(node.child(i)!);
        }
        break;
      case "subscript_expression":
        for (let i = 0; i < node.childCount; i++) {
          this.visitExpression(node.child(i)!);
        }
        break;
      case "interprocess_var":
        this.emitInterprocessRef(node);
        break;
      default:
        // primary expressions, multi_word_identifier alone, etc. — no
        // recursion needed.
        break;
    }
  }

  /**
   * Statement-level dispatch for an `expression_statement`. Whereas
   * `visitExpression` walks an embedded expression looking for nested calls,
   * this entry-point treats the WHOLE statement as a potential call —
   * specifically the paren-less bare-name form `MyMethod` and standalone
   * multi-word commands like `DispatchedMethod` or `New object`.
   */
  private visitExpressionStatement(stmt: Node): void {
    const expr = stmt.childForFieldName("expression");
    if (!expr) return;

    // Bare identifier as a complete statement: paren-less project-method
    // call. Emit a BareName hint.
    if (expr.type === "identifier" && this.currentSymbolId) {
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line: expr.startPosition.row,
        raw: this.lineText(expr.startPosition.row),
        expression: expr.text,
        hint: { kind: "BareName", name: expr.text },
        column: expr.startPosition.column,
        endColumn: expr.endPosition.column,
      });
      return;
    }

    // Multi-word identifier alone (no `(...)`): treat as a builtin/command
    // reference — same shape the regex parser emits for `New object` etc.
    if (expr.type === "multi_word_identifier" && this.currentSymbolId) {
      const parts: string[] = [];
      for (let i = 0; i < expr.childCount; i++) {
        const c = expr.child(i);
        if (c && c.type === "identifier") parts.push(c.text);
      }
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line: expr.startPosition.row,
        raw: this.lineText(expr.startPosition.row),
        expression: expr.text,
        hint: { kind: "BareName", name: parts.join(" ") },
        column: expr.startPosition.column,
        endColumn: expr.endPosition.column,
      });
      return;
    }

    this.visitExpression(expr);
  }

  /**
   * Emit a ThisGet / VarGet hint for a member access used as a read.
   * Tree-sitter doesn't tell us whether a member is the LHS of an
   * assignment from the node alone; we already handle the LHS path in
   * `visitAssignment` and skip emission there.
   */
  private emitMemberRead(node: Node): void {
    if (!this.currentSymbolId) return;
    if (!this.isReadContext(node)) return;
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (!object || !property) return;
    const propName = property.text;
    let hint: CallHint | undefined;
    if (object.type === "keyword_this") {
      hint = { kind: "ThisGet", property: propName };
    } else if (object.type === "local_var") {
      hint = {
        kind: "VarGet",
        variable: object.text.replace(/^\$/, ""),
        property: propName,
      };
    }
    if (!hint) return;
    this.rawCalls.push({
      fromSymbolId: this.currentSymbolId,
      line: node.startPosition.row,
      raw: this.lineText(node.startPosition.row),
      expression: node.text,
      hint,
      column: property.startPosition.column,
      endColumn: property.endPosition.column,
    });
  }

  /** True when `member` is read, not written or called. */
  private isReadContext(member: Node): boolean {
    const parent = member.parent;
    if (!parent) return true;
    // If we're the function of a call, the call path will emit the hint —
    // skip the property read. Web-tree-sitter doesn't guarantee node `===`
    // identity, so compare by id.
    if (parent.type === "call_expression") {
      const fn = parent.childForFieldName("function");
      if (fn && fn.id === member.id) return false;
    }
    // If we're the LHS of an assignment, visitAssignment already emits
    // the set hint.
    if (parent.type === "assignment_statement") {
      const target = parent.childForFieldName("target");
      if (target && target.id === member.id) return false;
    }
    // Intermediate members in a longer chain (`This.cache.get(...)` → the
    // `This.cache` part) ARE read contexts — the legacy regex parser emits
    // a ThisGet/VarGet on each intermediate step alongside the terminal
    // ThisChainCall. Keep parity by treating them as reads.
    return true;
  }

  private emitInterprocessRef(node: Node): void {
    if (!this.currentSymbolId) return;
    const text = node.text;
    // text starts with `<>` — strip the prefix.
    const name = text.replace(/^<>/, "");
    this.rawCalls.push({
      fromSymbolId: this.currentSymbolId,
      line: node.startPosition.row,
      raw: this.lineText(node.startPosition.row),
      expression: text,
      hint: { kind: "InterprocessRef", name },
      column: node.startPosition.column,
      endColumn: node.endPosition.column,
    });
  }

  // ---- Call-site emission ----

  private emitCall(node: Node): void {
    if (!this.currentSymbolId) return;
    const fn = node.childForFieldName("function");
    if (!fn) return;

    const line = node.startPosition.row;
    const raw = this.lineText(line);
    const expression = node.text;

    // Multi-word commands: emit BOTH the specific hint (NewProcess /
    // ExecuteMethodLiteral / ExecuteMethodDynamic / Formula / etc.) AND a
    // BuiltinChain for the command-name token itself, matching the legacy
    // regex parser's double-emit shape.
    if (fn.type === "multi_word_identifier") {
      const specific = this.classifySpecialMultiWord(fn, node);
      if (specific) {
        this.rawCalls.push({
          fromSymbolId: this.currentSymbolId,
          line,
          raw,
          expression,
          hint: specific,
          column: fn.startPosition.column,
          endColumn: fn.endPosition.column,
        });
      }
      const cmdName = this.multiWordName(fn);
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line,
        raw,
        expression: `${cmdName}(`,
        hint: { kind: "BuiltinChain", name: cmdName },
        column: fn.startPosition.column,
        endColumn: fn.endPosition.column,
      });
      return;
    }

    const hint = this.classifyCallee(fn, node);
    // Skip emission when we have no hint — the regex parser doesn't track
    // intermediate chained calls like `.new().foo().bar()`, so emitting
    // them inflates the raw-call count without producing resolvable edges.
    // Bare-name calls and member-call shapes always have hints.
    if (!hint) return;

    const callSite: RawCallSite = {
      fromSymbolId: this.currentSymbolId,
      line,
      raw,
      expression,
      hint,
      column: fn.startPosition.column,
      endColumn: fn.endPosition.column,
    };

    this.rawCalls.push(callSite);
  }

  private multiWordName(fn: Node): string {
    const parts: string[] = [];
    for (let i = 0; i < fn.childCount; i++) {
      const c = fn.child(i);
      if (c && c.type === "identifier") parts.push(c.text);
    }
    return parts.join(" ");
  }

  /**
   * Map well-known multi-word commands to their specific CallHint shapes.
   * Matches the legacy regex parser's handling of CALL WORKER, New process,
   * EXECUTE METHOD, EXECUTE METHOD IN SUBFORM, Formula from string, and
   * the form-opener family (DIALOG, Open form window, etc.).
   */
  private classifySpecialMultiWord(
    fn: Node,
    callNode: Node,
  ): CallHint | undefined {
    const name = this.multiWordName(fn).toUpperCase();
    const args = callNode.childForFieldName("arguments");
    if (!args) return undefined;
    const argList = this.argChildren(args);

    // CALL WORKER(target; "MethodName"; ...) — second arg is the method.
    if (name === "CALL WORKER" && argList.length >= 2) {
      const second = argList[1];
      if (second.type === "string") {
        return {
          kind: "CallWorker",
          methodName: stripQuotes(second.text),
        };
      }
    }
    // New process("MethodName"; ...).
    if (name === "NEW PROCESS" && argList.length >= 1) {
      const first = argList[0];
      if (first.type === "string") {
        return {
          kind: "NewProcess",
          methodName: stripQuotes(first.text),
        };
      }
    }
    // EXECUTE METHOD("MethodName"; ...) — literal form.
    // EXECUTE METHOD($var; ...) — dynamic form.
    if (name === "EXECUTE METHOD" && argList.length >= 1) {
      const first = argList[0];
      if (first.type === "string") {
        return {
          kind: "ExecuteMethodLiteral",
          methodName: stripQuotes(first.text),
        };
      }
      if (first.type === "local_var") {
        return {
          kind: "ExecuteMethodDynamic",
          variable: first.text.replace(/^\$/, ""),
        };
      }
    }
    // EXECUTE METHOD IN SUBFORM("Form"; "Method"; ...).
    if (name === "EXECUTE METHOD IN SUBFORM" && argList.length >= 2) {
      const a = argList[0];
      const b = argList[1];
      if (a.type === "string" && b.type === "string") {
        return {
          kind: "ExecuteMethodInSubform",
          formName: stripQuotes(a.text),
          methodName: stripQuotes(b.text),
        };
      }
    }
    // Formula from string("body").
    if (name === "FORMULA FROM STRING" && argList.length >= 1) {
      const first = argList[0];
      if (first.type === "string") {
        return { kind: "Formula", body: stripQuotes(first.text) };
      }
    }
    // Form openers — DIALOG, FORM LOAD, MODIFY SELECTION, etc. The form
    // name is either the 1st arg (no table) or 2nd arg (with table). We
    // detect by checking for a leading table_ref / field_ref.
    if (this.isFormOpener(name)) {
      let nameArgIdx = 0;
      if (argList.length > 0 && argList[0].type === "table_ref") nameArgIdx = 1;
      if (argList.length > nameArgIdx) {
        const a = argList[nameArgIdx];
        if (a.type === "string") {
          return { kind: "FormRef", formName: stripQuotes(a.text) };
        }
        // Variable form-name — recover from intra-method string assignments
        // if we've seen one.
        if (a.type === "local_var" && this.currentStrings) {
          const varName = a.text.replace(/^\$/, "");
          const recovered = this.currentStrings.get(varName);
          if (recovered) {
            return { kind: "FormRef", formName: recovered };
          }
        }
      }
    }
    return undefined;
  }

  private isFormOpener(upperName: string): boolean {
    return (
      upperName === "DIALOG" ||
      upperName === "OPEN FORM WINDOW" ||
      upperName === "FORM LOAD" ||
      upperName === "PRINT FORM" ||
      upperName === "MODIFY SELECTION" ||
      upperName === "DISPLAY SELECTION"
    );
  }

  /**
   * Return the direct argument-list children of an `argument_list` node,
   * skipping the `(`, `;`, `,`, `)` tokens.
   */
  private argChildren(args: Node): Node[] {
    const out: Node[] = [];
    for (let i = 0; i < args.childCount; i++) {
      const c = args.child(i);
      if (!c) continue;
      if (c.type === "(" || c.type === ")" || c.type === ";" || c.type === ",")
        continue;
      out.push(c);
    }
    return out;
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
    // Two-or-more-segment chain. Walk back to the head to classify.
    //
    // Cs/Ds heads (`cs.X.method()`, `ds.T.query()`) require a PURE property
    // chain — no intermediate calls — because the resolver can't know what
    // the intermediate call returned. `cs.X.new().foo()` would fall back
    // to no hint (and be skipped, like the regex parser does).
    //
    // This/Var heads can have intermediate calls (the chain resolver in
    // nameResolver walks return-types via `isCall` flags on each step).
    if (
      object.type === "member_expression" ||
      object.type === "call_expression"
    ) {
      const flat = this.flattenChain(member);
      if (!flat) return undefined;
      const { head, steps } = flat;
      const path = steps.slice(0, -1);
      const finalMethod = steps[steps.length - 1].name;
      const pureChain = path.every((s) => !s.isCall);

      // cs.Class.method — only for pure chains.
      if (head.type === "cs" && path.length === 1 && pureChain) {
        const className = path[0].name;
        if (finalMethod === "new") return { kind: "CsNew", className };
        return { kind: "CsCall", className, method: finalMethod };
      }
      if (head.type === "cs" && path.length === 2 && pureChain) {
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
      if (head.type === "ds" && path.length === 1 && pureChain) {
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
   * property name. Each segment carries an `isCall` flag so the resolver
   * knows whether to walk a return-type vs a property-type.
   *
   * Handles two cases for intermediate nodes:
   *  - `member_expression` (pure property/method chain): `$x.foo.bar`
   *  - `call_expression` (a call's result feeding into the next member):
   *    `$x.foo().bar()` — the inner call's function is itself a chain.
   */
  private flattenChain(
    member: Node,
  ):
    | { head: ChainHead; steps: ChainStep[] }
    | undefined {
    const steps: ChainStep[] = [];
    let cursor: Node | null = member;
    while (cursor) {
      if (cursor.type === "member_expression") {
        const prop = cursor.childForFieldName("property");
        if (prop) steps.unshift({ name: prop.text, isCall: false });
        cursor = cursor.childForFieldName("object");
        continue;
      }
      if (cursor.type === "call_expression") {
        // Mark the most-recently-pushed segment as a call (it's the call's
        // property/method) and step into the function for further walking.
        if (steps.length > 0) steps[0].isCall = true;
        cursor = cursor.childForFieldName("function");
        continue;
      }
      break;
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

  private emitPropertyAssign(target: Node, stmt: Node): void {
    if (!this.currentSymbolId) return;
    const object = target.childForFieldName("object");
    const property = target.childForFieldName("property");
    if (!object || !property) return;
    const propName = property.text;
    const line = target.startPosition.row;
    const raw = this.lineText(line);

    // Compound-assignment forms (`+=`, `-=`, etc.) are "read + write" —
    // emit BOTH a get and a set hint, matching the regex parser's
    // post-processing of RE_THIS_ASSIGN compound forms.
    const op = stmt.childForFieldName("operator");
    const isCompound = op?.type === "compound_assign_op";

    let setHint: CallHint | undefined;
    let getHint: CallHint | undefined;
    if (object.type === "keyword_this") {
      setHint = { kind: "ThisSet", property: propName };
      if (isCompound) getHint = { kind: "ThisGet", property: propName };
    } else if (object.type === "local_var") {
      const variable = object.text.replace(/^\$/, "");
      setHint = { kind: "VarSet", variable, property: propName };
      if (isCompound) getHint = { kind: "VarGet", variable, property: propName };
    }
    if (getHint) {
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line,
        raw,
        expression: target.text,
        hint: getHint,
        column: property.startPosition.column,
        endColumn: property.endPosition.column,
      });
    }
    if (setHint) {
      this.rawCalls.push({
        fromSymbolId: this.currentSymbolId,
        line,
        raw,
        expression: target.text,
        hint: setHint,
        column: property.startPosition.column,
        endColumn: property.endPosition.column,
      });
    }
  }

  // ---- Helpers ----

  /**
   * Sets up an enclosing file-level symbol — project method, form method,
   * database method, etc. Used in the constructor for categories that
   * implicitly synthesize one top-level symbol per file.
   */
  private beginFileSymbol(sym: SymbolRecord): void {
    this.currentSymbol = sym;
    this.currentSymbolId = sym.id;
    this.currentLocals = new Map();
    this.currentStrings = new Map();
    this.localTypes.set(sym.id, this.currentLocals);
    this.localStrings.set(sym.id, this.currentStrings);
  }

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
