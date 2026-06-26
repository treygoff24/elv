/** POSIX single-quote escaping so a value is safe to paste as one shell argument. */
export function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
