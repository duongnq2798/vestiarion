import "server-only";

import { cookies } from "next/headers";
import { AGENT_SESSION_COOKIE, agentSessionProof, secureTokenMatches } from "./agent-security";

const SESSION_MAX_AGE_SECONDS = 60 * 60;

/**
 * Deliberately not part of `VestiarionConfig`, and deliberately still read from
 * the environment.
 *
 * `AGENT_API_TOKEN` guards *this deployment's HTTP surface* — its routes, its
 * cookies, its Server Actions. It says nothing about a business's treasury, and
 * a business is what a config describes. An MCP server or a Slack bot embedding
 * Vestiarion authenticates its own callers by its own means and never consults
 * this; putting it in the config would invite the opposite, a library handing
 * out an authentication decision that belongs to whoever owns the endpoint.
 *
 * `server-only` at the top of this file is the other half of that boundary.
 */
function configuredToken(): string | undefined {
  return process.env.AGENT_API_TOKEN;
}

export async function hasAgentControlSession(): Promise<boolean> {
  const token = configuredToken();
  if (!token) return false;
  const proof = (await cookies()).get(AGENT_SESSION_COOKIE)?.value;
  return secureTokenMatches(proof, agentSessionProof(token));
}

export async function createAgentControlSession(candidate: string): Promise<boolean> {
  const token = configuredToken();
  if (!secureTokenMatches(candidate, token) || !token) return false;

  (await cookies()).set(AGENT_SESSION_COOKIE, agentSessionProof(token), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return true;
}
