# Research companies with Parallel Search MCP

Use [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
in terminal Claude Code to research companies, keep the supporting source URLs
and quotes, then import the results into GTM Grid as a CSV. This is useful for
building an account list with product and customer context before adding other
enrichment columns.

Parallel provides free anonymous web search and page fetching without a Parallel
account or API key. Anonymous search uses Fast mode and has lower rate limits
than authenticated usage. You still need your own signed-in Claude Code and a
GTM Grid account on your hosted or self-hosted instance.

## Connect Parallel in a terminal workspace

Install and sign in to [Claude Code](https://code.claude.com/docs/en/setup) first.
Run the following in a directory where you want to keep your research files:

```bash
mkdir -p company-research
cd company-research
claude mcp add --transport http --scope local parallel-search https://search.parallel.ai/mcp
claude mcp get parallel-search
claude
```

In Claude Code, run `/mcp` and confirm `parallel-search` is connected. It exposes
`web_search` for finding pages and `web_fetch` for reading specific URLs. Local
scope keeps this server configuration specific to the current directory; see
[Claude Code's MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes).

This guide uses a separate terminal session and imports a file into the grid.
The app's agent panel and connector configuration are separate from this setup.

## Gather a small, sourced account list

Start with a few companies and review the output before expanding the list.
For example, give Claude Code this prompt and approve the tool calls and file
write when asked:

```text
Use parallel-search's web_search and web_fetch to research these companies:
Ramp (ramp.com), Vanta (vanta.com), and Linear (linear.app).

For each company, find a first-party page describing its product and intended
customers. Fetch that page to verify the facts. Do not guess: leave a field
blank if you cannot verify it, including when a page cannot be fetched.

Save companies.csv as UTF-8 CSV with exactly this header:
Company,Website,Product,Customer,Source URL,Source Quote,Checked At

Write one row per company. Keep Product and Customer short and factual.
Include the full source URL and a short verbatim quote supporting the facts.
Use today's UTC date in YYYY-MM-DD format for Checked At. Quote fields that
contain commas, quotes, or newlines, and escape embedded quotes as doubled quotes.
```

Open the source URLs and compare each row with its quote. A search snippet alone
may omit context; leave unsupported fields blank instead of treating the agent's
summary as a verified fact. `Checked At` records when you checked the page, not
when it was published. Keep the CSV header even when some fields are empty.

## Import into GTM Grid

1. Open GTM Grid, sign in, and select the workspace and project for the new table.
2. Choose **Import CSV…** in the sidebar, then select `companies.csv` (or use
   **Paste data instead** to paste its contents).
3. On **Map your columns**, keep the first row as headers. Review the column
   names and types: use Text for the company, website, research, and source fields,
   and Date for `Checked At`. Exclude any columns you do not want to import.
4. Name the table and choose **Create table**. Check that the row count and source
   columns match your CSV before adding more enrichment.

CSV import creates a new table. The imported facts are a snapshot; rerun the
research and review the sources when you need an update. Keep the source columns
alongside any later enrichment so teammates can check where the facts came from.

## Troubleshooting and cleanup

- If `parallel-search` is missing, run `claude mcp get parallel-search` from the
  same research directory and check `/mcp` in a new terminal Claude Code session.
- If a tool reports a rate limit, follow its retry guidance or try a smaller batch
  later. An empty or failed result is not evidence that a company has no relevant
  information. See [Parallel's setup and limits](https://docs.parallel.ai/integrations/mcp/search-mcp).
- If the import preview splits a quote across columns, fix the CSV quoting before
  creating the table. Commas inside a value need enclosing double quotes; a literal
  double quote inside a quoted value must be written as `""`.
- To remove this local MCP configuration, run the following from the research
  directory. Your research files and imported table remain available.

  ```bash
  claude mcp remove --scope local parallel-search
  ```
