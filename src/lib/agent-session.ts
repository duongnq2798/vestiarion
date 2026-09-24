import "server-only";

import { cookies } from "next/headers";
import { AGENT_SESSION_COOKIE, agentSessionProof, secureTokenMatches } from "./agent-security";

const SESSION_MAX_AGE_SECONDS = 60 * 60;

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
