/**
 * Convex HTTP router (T3).
 *
 * `auth.addHttpRoutes(http)` registers the Convex Auth HTTP endpoints
 * (`/api/auth/*`) the client uses for sign-in / sign-out / OAuth callbacks.
 * Future non-auth HTTP actions can be added to this same router.
 */

import { httpRouter } from "convex/server";
import { auth } from "./auth.js";

const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
