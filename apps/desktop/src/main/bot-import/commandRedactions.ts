import { importedContentRedactions, isImportedCredentialField } from './connectionCatalog.js';

/** Shared by readable import copies and execution output; originals stay intact. */
export function commandLiteralRedactions(literals: string[], environmentValues: string[] = [], maskLiterals = true): Record<string, string> {
  const candidates = literals.flatMap(value => [value, /^--?[\w-]+=(.+)$/s.exec(value)?.[1]])
    .filter((value): value is string => !!value);
  const literalSet = new Set(candidates);
  const values = maskLiterals ? [...candidates] : [];
  const structured: { id: string; format: string; value: unknown }[] = [];
  for (const value of new Set([...candidates, ...environmentValues])) {
    // curl accepts a separate -H/--header value, --header=value or -Hvalue.
    // Strip the authorization scheme as with MCP headers: commands may echo
    // only its credential payload. Public headers/scheme names are not masks.
    const header = /^(?:-H)?[\t ]*(?:proxy-)?authorization[\t ]*:[\t ]*(\S+[\t ]+(.+?))[\t ]*$/i.exec(value);
    if (header) values.push(header[1]!, header[2]!);
    // command-env applies both the credential-field rules and URL component
    // traversal, including URLs beneath ordinary structured keys like endpoint.
    structured.push({ id: `command_${structured.length}`, format: 'command-env', value });
    try {
      const parsed: unknown = JSON.parse(value);
      if (maskLiterals && typeof parsed === 'string' && literalSet.has(value)) values.push(parsed);
      if ((parsed && typeof parsed === 'object') || typeof parsed === 'string') {
        structured.push({ id: `command_${structured.length}`, format: 'command-env', value: parsed });
      }
    } catch { /* Requested exact literal masks need no JSON parser. */ }
  }
  values.push(...Object.values(importedContentRedactions({ env: {}, mcp: [], credentials: structured })));
  const secrets: Record<string, string> = {};
  for (const [index, value] of [...new Set(values)].entries()) {
    secrets[`command_literal_${index}`] = value;
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) secrets[`command_literal_${index}_json`] = escaped;
  }
  return secrets;
}

/** Public copies retain ordinary CLI syntax/settings, not a blanket argv mask. */
export function commandArgumentRedactions(argv: string[]): Record<string, string> {
  const values: string[] = [];
  let credentialArgument = false;
  for (const arg of argv.slice(1)) {
    const option = /^--?([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    const privateValue = option ? isImportedCredentialField(option[1]) && option[2] !== undefined : credentialArgument;
    values.push(...Object.values(commandLiteralRedactions([arg], [], privateValue)));
    credentialArgument = !!option && option[2] === undefined && isImportedCredentialField(option[1]);
  }
  return Object.fromEntries([...new Set(values)].map((value, index) => [`command_argument_${index}`, value]));
}
