/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as cells from "../cells.js";
import type * as credentials from "../credentials.js";
import type * as credentialsData from "../credentialsData.js";
import type * as crons from "../crons.js";
import type * as extensions from "../extensions.js";
import type * as http from "../http.js";
import type * as model_auth from "../model/auth.js";
import type * as model_crypto from "../model/crypto.js";
import type * as model_grid from "../model/grid.js";
import type * as model_meter from "../model/meter.js";
import type * as model_seats from "../model/seats.js";
import type * as model_usage from "../model/usage.js";
import type * as projects from "../projects.js";
import type * as tables from "../tables.js";
import type * as usage from "../usage.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  billing: typeof billing;
  cells: typeof cells;
  credentials: typeof credentials;
  credentialsData: typeof credentialsData;
  crons: typeof crons;
  extensions: typeof extensions;
  http: typeof http;
  "model/auth": typeof model_auth;
  "model/crypto": typeof model_crypto;
  "model/grid": typeof model_grid;
  "model/meter": typeof model_meter;
  "model/seats": typeof model_seats;
  "model/usage": typeof model_usage;
  projects: typeof projects;
  tables: typeof tables;
  usage: typeof usage;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
