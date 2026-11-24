// The word scan of AT3.1b: every string literal of the .ts files under a path
// that names Firstmate, one "<file>: <text>" per line. Literals are found with
// the scanner of the TypeScript the board builds with (its dist/ast modules),
// so a comment is never one. With "check" as the third argument it instead
// prints each file the scanner did not read to its end.
//
// Usage: node word-scan.mjs <typescript-package-dir> <file-or-directory> [check]
import fs from "node:fs";
import path from "node:path";
const [typescript, target, mode] = process.argv.slice(2);
const { SyntaxKind: K } = await import(path.join(typescript, "dist/ast/index.js"));
const { createScanner } = await import(path.join(typescript, "dist/ast/scanner.js"));
const words = /first mate|firstmate|\/updatefirstmate/i;
const walk = (at) => fs.statSync(at).isDirectory()
  ? fs.readdirSync(at).flatMap((name) => walk(path.join(at, name)))
  : at.endsWith(".ts") ? [at] : [];
const literal = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.RegularExpressionLiteral]);
// After these a "/" starts a regular expression, not a division.
const beforeRegex = new Set([K.OpenParenToken, K.CommaToken, K.EqualsToken, K.ColonToken, K.OpenBracketToken,
  K.ExclamationToken, K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionToken, K.OpenBraceToken, K.CloseBraceToken,
  K.SemicolonToken, K.ReturnKeyword, K.TypeOfKeyword, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
  K.QuestionQuestionToken, K.EqualsGreaterThanToken, K.PlusToken, K.MinusToken]);
for (const file of walk(target)) {
  const text = fs.readFileSync(file, "utf8");
  const scanner = createScanner(true, 0, text);
  const braces = [];
  let previous = K.SemicolonToken;
  let end = 0;
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && beforeRegex.has(previous)) kind = scanner.reScanSlashToken();
    if (kind === K.OpenBraceToken) braces.push("brace");
    if (kind === K.TemplateHead) braces.push("template");
    if (kind === K.CloseBraceToken && braces.pop() === "template") kind = scanner.reScanTemplateToken(false);
    if (kind === K.TemplateMiddle) braces.push("template");
    if (mode !== "check" && literal.has(kind) && kind !== K.RegularExpressionLiteral && words.test(scanner.getTokenValue()))
      console.log(`${file}: ${scanner.getTokenValue()}`);
    previous = kind;
    end = scanner.getTokenEnd();
  }
  if (mode === "check" && text.trimEnd().length - end > 2) console.log(`${file}: stopped at ${end} of ${text.length}`);
}
