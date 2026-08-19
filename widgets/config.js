/*
 * Single source of truth for the API base URL and key.
 *
 * The URL was previously pasted into three widgets, the mobile app, the
 * dashboard, and both bots, each with a different placeholder value
 * ("https://family-api-xxxxxx.a.run.app", "http://localhost:8000", ...).
 * Deploying meant editing seven files and missing one.
 *
 * SECURITY: the key below ships to the browser. Treat it as public. It must be
 * a free-tier, rate-limited key -- never the business-tier one. Anything that
 * must stay secret belongs behind the API, not in front of it.
 */

const fromEnv = (name, fallback) => {
  // Works under Create React App / webpack DefinePlugin, and degrades to the
  // fallback anywhere `process` is not defined (plain <script> usage).
  if (typeof process !== "undefined" && process.env && process.env[name]) {
    return process.env[name];
  }
  return fallback;
};

export const API_URL = fromEnv("REACT_APP_SCOUTFOX_API_URL", "http://localhost:8000");

export const API_KEY = fromEnv("REACT_APP_SCOUTFOX_API_KEY", "");

export const authHeaders = () => ({ "X-API-Key": API_KEY });

/** Absolute URL for an API path, e.g. apiUrl("/recommend?state=CA"). */
export const apiUrl = (path) => `${API_URL.replace(/\/$/, "")}${path}`;
