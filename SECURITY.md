# Security

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security tab, then Advisories). Please don't open a public issue.

In scope:
- Any way a key, prompt or response ends up on disk, in a log, in `/__proxy/status`, or sent to a host other than the configured upstream.
- Reaching the proxy from anything other than a local, non-browser client (web pages, DNS rebinding, other hosts).
- A call going out after a cap refused it, or a cap check that can be bypassed.
- Markup or script injection into the report page from a `calls.jsonl` file.

The proxy holds no keys of its own. It only passes through the key your agent sends, or one from its own environment.
