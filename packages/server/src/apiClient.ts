import axios, { type AxiosInstance } from "axios";
import { getApiUrl } from "@agenfk/telemetry";

/**
 * Build the axios client the MCP server uses to reach the AgEnFK API server.
 *
 * The API server binds to whatever port is free (bumping off 3000 when it is
 * busy) and records the ACTUAL port in ~/.agenfk/server-port. The MCP server is
 * a long-lived stdio process, so it must resolve that port on EVERY request
 * rather than caching it once at module load — otherwise it keeps talking to a
 * stale port after the API server (re)starts on a different one. A request
 * interceptor re-runs getApiUrl() per request to guarantee that.
 */
export function createApiClient(timeout = 30000): AxiosInstance {
  const client = axios.create({ timeout });
  client.interceptors.request.use((config) => {
    config.baseURL = getApiUrl();
    return config;
  });
  return client;
}
