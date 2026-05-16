import {
  Connection,
  FoldingRange,
  FoldingRangeKind,
  FoldingRangeParams,
  TextDocuments
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { scanBlocks, BlockKind } from "@4d/core";

const FOLD_KIND_FOR: Partial<Record<BlockKind, FoldingRangeKind>> = {
  // 4D doesn't have an import/region equivalent; leave others undefined so
  // VSCode treats them as generic structural folds.
};

void FOLD_KIND_FOR; // Currently unused; retained for future region tagging.

export function registerFoldingHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>
): void {
  connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const blocks = scanBlocks(doc.getText());
    const out: FoldingRange[] = [];
    for (const b of blocks) {
      if (b.endLine <= b.startLine) continue;
      out.push({
        startLine: b.startLine,
        endLine: b.endLine,
        kind: FOLD_KIND_FOR[b.kind]
      });
    }
    return out;
  });
}
