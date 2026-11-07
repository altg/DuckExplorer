/**
 * In GitHub Actions, a failure as an error annotation (an `::error` workflow command printed to the log). It
 * shows on the run's summary and in pull requests, and anyone can read annotations through the API, while
 * reading a job's log takes signing in.
 */
export function annotateFailure(title: string, err: unknown): void {
  if (!process.env.GITHUB_ACTIONS) {
    return;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.log(`::error title=${escapeProperty(title)}::${escapeData(message.slice(0, 4000))}`);
}

// As the Actions runner reads workflow commands: one line, with %, CR and LF escaped (and : and , in properties).
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
