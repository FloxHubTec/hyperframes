// Parsing of the `--pr` argument: a full pull-request url, `owner/repo#N`, or
// a bare pull-request number.
//
// `gh pr view <ref>` resolves BOTH the repository and the argument against the
// local git context, so it fails outright outside a git repository and reads
// "owner/repo#N" as a branch name. Parsing the ref here and pinning the repo
// with --repo makes the documented forms work in any directory.

/** @returns {{ owner: string | null, repo: string | null, number: number | null }} */
export function parsePrRef(value) {
  const raw = String(value ?? "").trim();

  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(raw);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };

  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(raw);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };

  if (/^\d+$/.test(raw)) return { owner: null, repo: null, number: Number(raw) };

  return { owner: null, repo: null, number: null };
}
