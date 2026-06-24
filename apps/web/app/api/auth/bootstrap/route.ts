import { NextResponse } from "next/server";
import { isMultiUserEnabled, getBootstrapState } from "../../../../lib/workflow-runtime";

/** Tells the /login page whether the instance is unclaimed (→ show the context-aware
 *  claim screen) and whether the default account already owns a library (→ "接管"
 *  copy vs "创建"). Read-only; safe before any auth. */
export async function GET() {
  if (!isMultiUserEnabled()) {
    return NextResponse.json({ needsClaim: false, hasExistingLibrary: false });
  }
  return NextResponse.json(await getBootstrapState());
}
