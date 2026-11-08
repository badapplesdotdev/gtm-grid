// Updater errors that are never worth an error report: the next scheduled check
// recovers on its own, and nothing in our release can fix them.

// Plain connectivity blips — expected on laptops.
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|net::/i;

// GitHub's releases feed briefly returning a gateway error. electron-updater
// wraps it as "Unable to find latest version ... ensure a production release
// exists", which wrongly reads as a broken release.
const UPSTREAM_GATEWAY = /HttpError: 50[234]\b/;

export const isTransientUpdaterError = (msg: string): boolean => OFFLINE.test(msg) || UPSTREAM_GATEWAY.test(msg);
