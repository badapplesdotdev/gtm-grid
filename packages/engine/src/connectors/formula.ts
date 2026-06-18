// Built-in "Formula" connector. A formula column is a function column with
// provider "formula" / method "eval" and its expression in `params.expression`. This
// entry exists so the formula appears in the function catalog (UI browser, MCP
// `list_functions`) and so `add_column` validation recognises `formula.eval`.
//
// Its `run` is never dispatched: the execution engine compiles the expression into a
// self-contained sandbox body (see formula.ts + execute.ts) rather than calling the sdk.

import type { Connector } from "../types.js";

export const formulaConnector: Connector = {
  id: "formula",
  name: "Formula",
  category: "formula",
  auth: null,
  // Pure-local expression evaluation — exempt from the safety-default rate limit.
  local: true,
  methods: [
    {
      id: "eval",
      label: "Formula",
      description:
        "Evaluate a JavaScript expression per row. Reference other columns with {{Column Name}}. " +
        "Standard JS plus Lodash (_), Moment (moment), and Excel/Sheets functions " +
        "(VLOOKUP, IF, SUM, CONCATENATE, …) are available.",
      inputSchema: {
        type: "object",
        required: ["expression"],
        properties: {
          expression: {
            type: "string",
            description: 'JS expression, e.g. {{Email}}.split("@")[1] or UPPER({{Name}}).',
          },
        },
      },
      batchSize: 500,
      credits: 0,
      run: async () => {
        // Formula columns are compiled and evaluated inline by the engine; the method is
        // never dispatched through the sdk. Surfaced as a clear error if it ever is.
        throw new Error("formula.eval is evaluated inline by the engine, not via the sdk");
      },
    },
  ],
};
