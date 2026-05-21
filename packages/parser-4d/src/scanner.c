/*
 * External scanner for tree-sitter-fourd.
 *
 * Sole job: decide whether a `\n` is a statement terminator or whitespace.
 *
 * 4D code uses `\n` as the statement separator at the top level, but lets
 * argument lists, parameter lists, and parenthesized expressions span
 * multiple physical lines without a continuation marker. Whether a given
 * `\n` is "significant" depends on parser context — exactly what an
 * external scanner is for.
 *
 * Approach: check `valid_symbols[STATEMENT_NEWLINE]`.
 *   - If true (parser is at a statement boundary): consume one `\n` and
 *     emit STATEMENT_NEWLINE. Each blank line becomes its own emission.
 *   - If false (mid-expression / inside parens): skip the `\n` as
 *     whitespace (advance with skip=true so it counts as `extras`) and
 *     return false so the regular lexer can take over.
 */

#include "tree_sitter/parser.h"

enum TokenType {
    STATEMENT_NEWLINE,
};

void *tree_sitter_fourd_external_scanner_create(void) { return NULL; }
void tree_sitter_fourd_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_fourd_external_scanner_serialize(void *payload, char *buffer) {
    (void)payload; (void)buffer;
    return 0;
}
void tree_sitter_fourd_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    (void)payload; (void)buffer; (void)length;
}

bool tree_sitter_fourd_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    (void)payload;

    if (lexer->lookahead != '\n') return false;

    if (valid_symbols[STATEMENT_NEWLINE]) {
        /* At a statement boundary — consume exactly one newline and emit. */
        lexer->advance(lexer, false);
        lexer->mark_end(lexer);
        lexer->result_symbol = STATEMENT_NEWLINE;
        return true;
    }

    /* Mid-expression (inside parens, after an operator, etc.) — skip the
     * `\n` as whitespace. `advance(lexer, true)` treats it as part of
     * `extras`. Returning false hands control back to the regular lexer
     * so the next non-whitespace character gets tokenized normally. */
    lexer->advance(lexer, true);
    return false;
}
