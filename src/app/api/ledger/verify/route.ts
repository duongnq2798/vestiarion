import { NextResponse } from "next/server";
import { verifyLedger } from "@/lib/ledger";

export async function GET() {
  try {
    return NextResponse.json(await verifyLedger());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
