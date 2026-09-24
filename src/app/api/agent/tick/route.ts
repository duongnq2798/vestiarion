import { NextResponse } from "next/server";
import { runAgentCycle } from "@/lib/agent/orchestrator";

export async function POST() {
  try {
    const result = await runAgentCycle();
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
